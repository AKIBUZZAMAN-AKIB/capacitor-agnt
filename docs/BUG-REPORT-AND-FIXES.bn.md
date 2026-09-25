# capacitor-agnt — গভীর কোড অডিট রিপোর্ট

**রিপো:** `https://github.com/akibuzzaman999/capacitor-agnt/` (branch `main`, commit `4d92144`)
**ফোকাস:** Agent অংশ — সব agent API, configuration, tool ও engine internals
**তারিখ:** ২২ সেপ্টেম্বর ২০২৬

---

## ০. এক নজরে (Executive Summary)

এই রিপো একটা Capacitor 8 ভিত্তিক "universal NativeKit shell" অ্যাপ, যার প্রধান আকর্ষণ `plugins/native-agent` — একটা **on-device AI agent engine** যেটা Rust-এ লেখা (`native-agent-ffi` crate), UniFFI দিয়ে Android (Kotlin) ও iOS (Swift)-এ bind করা, আর TypeScript bridge (`window.NativeKit.agent`) দিয়ে WebView-এ এক্সপোজ করা।

### যা আসলেই ভালো আছে ✅

আগে ভালো দিকগুলো বলি, কারণ রিপোর্টটা বড় হবে:

| এলাকা | অবস্থা |
|---|---|
| JS/TS layer | `npx tsc --noEmit` সম্পূর্ণ clean |
| Test suite | `npx vitest run` → **১৬৭/১৬৭ pass** |
| Config validation | `npm run validate:config` → exit 0 (৮টা warning) |
| Android `.so` binaries | চারটা ABI-র sha256 `abi-manifest.json`-এর সাথে **হুবহু মেলে** |
| UniFFI contract | **৫৬টা checksum symbol** arm64 `.so`, `.a`, Kotlin binding ও Swift binding — চারটাতেই অভিন্ন; contract version **26** দুই পাশে এক |
| API surface parity | Kotlin ৪৯ method ≡ Swift ৪৯ method ≡ TS ৪৯ method (+ `addListener`) — **কোনো mismatch নেই** |
| Header integrity | `native_agent_ffiFFI.h`-এর তিনটা কপি byte-identical |
| CI | iOS xcframework ও Android ABI দুটোই vendored crate থেকে reproducibly rebuild হয় |

**অর্থাৎ FFI plumbing আর build tooling চমৎকার।** সমস্যাগুলো অন্য জায়গায় — **Rust engine-এর logic**, **scheduler/cron**, **নিরাপত্তা**, আর **demo UI wiring**-এ।

### সংখ্যায় ফলাফল

মোট **৪১টি নিশ্চিত সমস্যা** পাওয়া গেছে:

| তীব্রতা | সংখ্যা | মানে |
|---|---|---|
| 🔴 **Critical** | ৯ | crash, data loss, বা feature সম্পূর্ণ অকেজো |
| 🟠 **High** | ১৪ | মূল কাজ ভুল করে বা নীরবে ব্যর্থ হয় |
| 🟡 **Medium** | ১২ | ভুল আচরণ, edge case, বা নিরাপত্তা দুর্বলতা |
| 🔵 **Low** | ৬ | রক্ষণাবেক্ষণ ও ভবিষ্যৎ drift ঝুঁকি |

### সবচেয়ে গুরুতর তিনটা এক লাইনে

1. **`manage_cron` টুল সম্পূর্ণ ভাঙা** — এটা যে টেবিলে query করে সেই কলামগুলো database schema-তে **অস্তিত্বই নেই**। এজেন্ট cron টুল ব্যবহার করলেই SQL error।
2. **Heartbeat feature কোড-ই নেই** — `heartbeat_config` লেখা-পড়া হয়, কিন্তু `handle_wake` কখনো heartbeat চালায় না। ডকুমেন্টেড ফিচারটা ০% কাজ করে।
3. **`execute_command`-এ UTF-8 panic** — ৫০ কিলোবাইটের বেশি বাংলা/emoji আউটপুট এলে Rust panic → FFI boundary পার হয়ে অ্যাপ crash।

---

# ১. 🔴 CRITICAL — এগুলো আগে ঠিক করুন

## BUG-01 — `manage_cron` টুল সম্পূর্ণ অকার্যকর (schema mismatch)

**ফাইল:** `rust/native-agent-ffi/src/tool_runner.rs:811-900` বনাম `src/db.rs:92-120`

এটাই সবচেয়ে বড় আবিষ্কার। `tool_manage_cron()` নিজে থেকে একটা **আলাদা SQLite connection** খোলে আর `cron_jobs` টেবিলে query করে:

```rust
// tool_runner.rs — "list" action
"SELECT id, name, prompt, schedule, status, last_run_at, run_count FROM cron_jobs ORDER BY name"

// "create" action
"INSERT INTO cron_jobs (id, name, prompt, schedule, status, run_count)
 VALUES (?, ?, ?, ?, 'active', 0)"

// "pause"
"UPDATE cron_jobs SET status = 'paused' WHERE id = ?"
```

কিন্তু `db.rs`-এ আসল schema-টা এরকম:

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    session_target TEXT NOT NULL DEFAULT 'isolated',
    wake_mode TEXT NOT NULL DEFAULT 'next-heartbeat',
    schedule_kind TEXT,
    schedule_every_ms INTEGER,
    schedule_anchor_ms INTEGER,
    schedule_at_ms INTEGER,
    ...
);
```

আমি grep দিয়ে নিশ্চিত করেছি — **`schedule`, `status`, `run_count` — এই তিনটা কলামের একটাও `db.rs`-এ নেই**:

```console
$ grep -n "run_count\|schedule TEXT\|status TEXT NOT NULL" src/db.rs
(কোনো ফলাফল নেই — exit code 1)
```

**পরিণতি:** LLM যখনই `manage_cron` টুল কল করবে (আর AGENTS.md prompt তাকে **সরাসরি উৎসাহ দেয়**: *"Use the cron tool for any delayed or recurring task"*), তখনই SQLite `no such column: schedule` ছুঁড়বে। অর্থাৎ:
- `list` → error
- `create` → error (এজেন্ট reminder সেট করতে পারবে না)
- `pause` / `resume` → error
- `delete` / `history` → শুধু এই দুটো টিকে যাবে, কারণ এগুলো শুধু `id`, `job_id` ব্যবহার করে

**আরও খারাপ:** `tool_manage_cron` database path নিজে অনুমান করে —

```rust
let db_path = Path::new(workspace).parent().unwrap_or(...).join("mobile-claw.db");
```

কিন্তু demo `www/agent-lab.js:100` init করে `dbPath: 'files://agent/agent.db'` দিয়ে। নামই মেলে না (`mobile-claw.db` ≠ `agent.db`)। তাই টুলটা **একটা সম্পূর্ণ খালি নতুন DB ফাইল তৈরি করবে**, তাতে `cron_jobs` টেবিলই থাকবে না → `no such table: cron_jobs`। যে cron job JS API (`addCronJob`) দিয়ে তৈরি হয়েছে, এজেন্ট সেগুলো কখনোই দেখতে পাবে না।

**ঠিক করার উপায়:** `tool_manage_cron`-কে বাদ দিয়ে `db.rs`-এর আসল ফাংশনগুলো (`add_cron_job`, `list_cron_jobs`, `update_cron_job`, `remove_cron_job`) reuse করুন, এবং handle-এর existing connection pass করুন — নতুন connection খোলা বন্ধ করুন।

---

## BUG-02 — Heartbeat ফিচারটা আসলে বিদ্যমানই নয়

**ফাইল:** `src/db.rs::handle_wake`, `get_heartbeat_config`, `set_heartbeat_config`

`heartbeat_config` টেবিলে `enabled`, `every_ms`, `prompt`, `skill_id`, `next_run_at`, `last_hash` — সব ফিল্ড আছে। `setHeartbeatConfig` / `getHeartbeatConfig` API দুটোও TS, Kotlin, Swift — সব জায়গায় এক্সপোজড। Demo UI-তে "Set heartbeat" বোতামও আছে।

কিন্তু `handle_wake()` **শুধু `get_due_jobs()` কল করে**, যেটা কেবল `cron_jobs` টেবিল দেখে। heartbeat-এর `next_run_at` কখনো চেক হয় না, heartbeat prompt কখনো চলে না, `last_hash` কখনো লেখা হয় না।

**পরিণতি:** heartbeat কনফিগার করলে সেটা DB-তে সুন্দরভাবে সেভ হবে, `getHeartbeatConfig` দিয়ে ফেরতও আসবে — কিন্তু জীবনেও চলবে না। এটা pure write-only storage।

---

## BUG-03 — Scheduler `enabled` ও সব active-hours সীমা উপেক্ষিত

**ফাইল:** `src/db.rs::handle_wake`, `get_scheduler_config` (line 389)

`scheduler_config`-এ আছে `enabled`, `scheduling_mode`, `run_on_charging`, `global_active_hours_start/end/tz`। প্রতিটা `cron_jobs` row-তেও আছে `active_hours_start/end/tz`।

`handle_wake` এদের **একটাও পড়ে না**। `get_due_jobs`-এর WHERE clause পুরোটা:

```sql
WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
```

**পরিণতি:**
- Scheduler globally disable করলেও প্রতিটা wake-এ job চলবে
- "রাত ১১টা থেকে সকাল ৭টা চুপ থাকো" সেট করলেও ভোর ৩টায় notification আসবে
- `run_on_charging` কখনো enforce হয় না — battery drain

---

## BUG-04 — `execute_command`-এ UTF-8 boundary panic (crash)

**ফাইল:** `src/tool_runner.rs:492-497`

```rust
let stdout = String::from_utf8_lossy(&output.stdout);
let max_len = 50_000;
"stdout": if stdout.len() > max_len { &stdout[..max_len] } else { &stdout },
```

Rust-এ `str[..n]` **byte index** নেয়, character index নয়। যদি ৫০,০০০তম byte একটা multi-byte character-এর মাঝখানে পড়ে (বাংলা অক্ষর ৩ byte, emoji ৪ byte), তাহলে:

```
thread panicked at 'byte index 50000 is not a char boundary'
```

**একই বাগ `web_fetch`-এও:** `tool_runner.rs:797` — `&body[..50_000]`।
**এবং `grep_file`-এও:** line 500 — `&line[..500]`।

**পরিণতি:** বাংলা ব্যবহারকারীর জন্য এটা বিশেষভাবে মারাত্মক — বাংলা টেক্সট output করে এমন যেকোনো কমান্ড বা যেকোনো বাংলা webpage fetch করলেই panic। Rust panic FFI boundary পেরিয়ে যায় → **অ্যাপ crash**।

**সমাধান:** `char_indices()` দিয়ে নিরাপদ boundary খুঁজুন, বা `stdout.chars().take(n).collect()` ব্যবহার করুন।

---

## BUG-05 — `execute_command`-এ কোনো timeout নেই → turn চিরকাল আটকে যায়

**ফাইল:** `src/tool_runner.rs:481-486`

```rust
let output = tokio::process::Command::new("sh").arg("-c").arg(command)
    .current_dir(&work_dir).output().await?;
```

কোনো `tokio::time::timeout` নেই, কোনো `select!` নেই। `sleep 999999`, `cat` (stdin থেকে পড়তে চাইবে), বা একটা hung network কমান্ড — যেকোনোটাই টার্নকে **অনির্দিষ্টকালের জন্য** ঝুলিয়ে রাখবে।

আরও খারাপ: `wall_clock_timeout_ms` এই await-টাকে কেটে দিতে পারে না, কারণ tool execution `select!`-এর ভেতরে নেই। Cron job-এ `wall_clock_timeout_ms: Some(25_000)` সেট থাকা সত্ত্বেও একটা hung কমান্ড পুরো background wake-টাকে খেয়ে ফেলবে — Android-এ WorkManager সেটাকে ANR হিসেবে মেরে ফেলবে।

---

## BUG-06 — Wall-clock timeout অসম্পূর্ণ conversation তৈরি করে → পরের request invalid

**ফাইল:** `src/agent_loop.rs` (`wall_clock_timeout_reached`)

Tool-loop-এর মাঝখানে timeout hit করলে কোড `break` করে। কিন্তু Anthropic Messages API-র কঠোর নিয়ম: প্রতিটা `tool_use` block-এর জন্য পরের user message-এ ঠিক একটা matching `tool_result` থাকতেই হবে।

Timeout-এ break করলে assistant message-টা `tool_use` নিয়ে সেভ হয়, কিন্তু `tool_result` কখনো যোগ হয় না। এরপর ব্যবহারকারী যখন সেই session-এ আবার মেসেজ পাঠাবে:

```
400 invalid_request_error: messages.N: tool_use ids were found without tool_result blocks
```

**পরিণতি:** session **স্থায়ীভাবে নষ্ট** — ওই session আর কোনোদিন ব্যবহার করা যাবে না। একবার timeout = একটা মৃত conversation।

---

## BUG-07 — Error path পুরো conversation history মুছে দেয়

**ফাইল:** `src/lib.rs::spawn_main_turn` (error handling)

Turn fail করলে error path session row-তে `"[]"` লিখে দেয় — অর্থাৎ **খালি message array**। আগের সব conversation history চিরতরে হারিয়ে যায়।

একটা transient network error (যেটা খুবই স্বাভাবিক মোবাইলে) = ব্যবহারকারীর পুরো কথোপকথন ডিলিট। কোনো backup নেই, কোনো recovery নেই।

---

## BUG-08 — `openai` provider বেছে নিলে সবসময় fail করে

**ফাইল:** `src/agent_loop.rs::create_driver` + `default_model` + `src/workspace.rs::get_models_json`

তিনটা জায়গা পরস্পরবিরোধী:

| ফাংশন | `"openai"`-এর জন্য কী বলে |
|---|---|
| `create_driver()` | শুধু `anthropic` ও `openrouter` চেনে → `Err("Unsupported provider: openai")` |
| `default_model()` | `"gpt-4o"` ফেরত দেয় ✅ |
| `get_models_json()` | পুরো OpenAI মডেল তালিকা বিজ্ঞাপন দেয় ✅ |

**পরিণতি:** UI ব্যবহারকারীকে OpenAI মডেল দেখাবে, বেছে নিতে দেবে, default মডেলও ঠিক করে দেবে — তারপর প্রথম মেসেজেই hard error। API surface মিথ্যা বলছে।

---

## BUG-09 — SSE parsing CRLF stream-এ সম্পূর্ণ ব্যর্থ + unbounded memory

**ফাইল:** `src/llm_driver.rs` (streaming loop)

```rust
while let Some(pos) = buffer.find("\n\n") { ... }
```

SSE spec অনুযায়ী event separator `\r\n\r\n`-ও বৈধ, আর অনেক corporate proxy/CDN LF-কে CRLF-এ রূপান্তর করে। এমন কোনো stream এলে:

1. কোনো frame কখনো parse হবে না → **পুরো উত্তরটা হারিয়ে যাবে** (কোনো error ছাড়াই, নীরবে)
2. `buffer` সীমাহীনভাবে বাড়তে থাকবে → দীর্ঘ উত্তরে **OOM**, মোবাইলে বিপজ্জনক

---

# ২. 🟠 HIGH — মূল কাজ ভুল হয় বা নীরবে ব্যর্থ হয়

## BUG-10 — Approval system: শুধু একটা slot, `tool_call_id` উপেক্ষিত

**ফাইল:** `src/lib.rs:109` (`approval_sender`, `cron_approval_sender`)

```rust
approval_sender: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
```

একটামাত্র `Option<Sender>`। `respond_to_approval(tool_call_id, approved)` তার `tool_call_id` প্যারামিটারটা **সম্পূর্ণ উপেক্ষা** করে — যা-ই আসুক, বর্তমান slot-এ পাঠিয়ে দেয়।

**পরিণতি:** LLM একই turn-এ দুটো টুল চাইলে (parallel tool use — Claude নিয়মিত করে) দ্বিতীয় request প্রথমটাকে overwrite করে দেয়। ব্যবহারকারী "টুল A approve" চাপলে সেটা **টুল B-তে** apply হতে পারে। নিরাপত্তার দিক থেকে এটা মারাত্মক — ব্যবহারকারী `read_file` ভেবে approve করে `execute_command` চালিয়ে দিতে পারে।

`respond_to_cron_approval(_request_id, ...)`-এও একই — প্যারামিটারের নামের সামনে `_` prefix দেওয়াই প্রমাণ যে ডেভেলপার জানতেন এটা ব্যবহৃত হচ্ছে না।

---

## BUG-11 — `tool_use` ইভেন্ট approval check-এর **আগে** emit হয়

**ফাইল:** `src/agent_loop.rs`

ইভেন্টের ক্রমটা এরকম:

```
emit("tool_use")  ←── UI এখানে "চলছে..." দেখায়
   ↓
disabled check    ←── এখানে reject হতে পারে
   ↓
approval check    ←── এখানে ব্যবহারকারী deny করতে পারে
```

**পরিণতি:** UI দেখাবে "execute_command চালানো হচ্ছে…" তারপর ব্যবহারকারী deny করবে — কিন্তু UI-তে কোনো cancel signal যাবে না। ব্যবহারকারীর মনে হবে টুলটা চলেছে যদিও চলেনি। Audit log-ও ভুল হবে।

---

## BUG-12 — Tool permission seed করলেও প্রতিবার approval চায়

**ফাইল:** `src/agent_loop.rs:440` বনাম `www/agent-lab.js`

Rust-এ চেক:
```rust
policy != "always_allow"  → approval লাগবে
```

কিন্তু demo lab seed করে `"allow"` / `"ask"` স্ট্রিং দিয়ে। `"allow" != "always_allow"` → **true** → approval চাইবে।

**পরিণতি:** allow-list পুরোপুরি অকেজো। ব্যবহারকারী সব টুল pre-approve করলেও প্রতিবার prompt আসবে। কোথাও enum validation নেই বলে ভুলটা নীরব।

---

## BUG-13 — Steering ভুল turn-এ পৌঁছাতে পারে

**ফাইল:** `src/lib.rs` (`steer_rx`)

একটাই shared receiver, per-turn নয়। Turn A চলাকালীন steer করলে, যদি A ইতিমধ্যে শেষ হয়ে গিয়ে থাকে, message-টা turn B-তে delivered হবে। Race condition, non-deterministic।

---

## BUG-14 — `resume_session` কনফিগ hardcode করে

**ফাইল:** `src/lib.rs::resume_session`

```rust
max_turns: Some(25),
allowed_tools_json: None,
```

আসল session যে `max_turns` আর যে tool restriction নিয়ে শুরু হয়েছিল, resume করলে সেসব হারিয়ে যায়। একটা skill যদি ৫টা টুলে সীমাবদ্ধ থাকে, resume করার পর **সব ২১টা টুল** unlocked।

**নিরাপত্তা সমস্যা:** tool sandbox resume-এর মাধ্যমে bypass করা যায়।

---

## BUG-15 — `start_skill` array-আকারের `allowedTools` চুপচাপ ফেলে দেয়

**ফাইল:** `src/lib.rs::start_skill`

```rust
skill["allowedTools"].as_str()
```

শুধু string হলে পড়বে। কিন্তু JSON-এ এটা স্বাভাবিকভাবে array — `["read_file", "grep_files"]`। Array এলে `as_str()` → `None` → **সব restriction উধাও** → skill-টা unrestricted চলবে।

আবারও: security control নীরবে fail-open করছে। Fail-closed হওয়া উচিত।

---

## BUG-16 — `start_skill` shared session state নষ্ট করে

**ফাইল:** `src/lib.rs::start_skill`

Skill run shared `current_session`-এ লেখে (ব্যবহারকারীর চলমান conversation-এর উপর), এবং `agent.completed` ইভেন্টে `"runId": ""` — খালি স্ট্রিং পাঠায়।

**পরিণতি:** UI কোন run শেষ হলো বুঝতে পারে না; background skill চললে ব্যবহারকারীর active chat দূষিত হয়।

---

## BUG-17 — Cron: `webhook` delivery mode কখনো dispatch হয় না

**ফাইল:** `src/db.rs::handle_wake`

`delivery_mode` column-এ `"webhook"` লেখা যায়, `delivery_webhook_url`-ও সেভ হয়। `handle_wake` শুধু `"notification"` handle করে। `grep -rn "webhook" src/*.rs` চালিয়ে দেখলাম — শুধু তিনটা hit, সবকটাই schema/SQL-এ, **কোনো HTTP call নেই**।

**পরিণতি:** webhook job নীরবে কিছুই delivered করে না। কোনো error, কোনো log, কোনো ইঙ্গিত নেই।

---

## BUG-18 — De-duplication ও error-backoff কলাম আছে, logic নেই

**ফাইল:** `src/db.rs` (INSERT at line 620-628)

```sql
VALUES (..., NULL, NULL, 0, ?19, ?20)
       --      ↑     ↑    ↑
       --  last_response_hash, last_response_sent_at, consecutive_errors
```

তিনটা কলামই hardcoded NULL/0 দিয়ে insert হয়। `grep -rn "last_response_hash" src/*.rs` — শুধু schema আর INSERT-এ, **কোথাও পড়া হয় না**।

**পরিণতি:**
- একই উত্তর বারবার এলেও duplicate notification যাবে (de-dup অকেজো)
- `consecutive_errors` শুধু বাড়ে, কখনো কমে না, আর কেউ চেক করে না — একটা চিরস্থায়ীভাবে ব্যর্থ job (যেমন invalid API key) **অনন্তকাল** প্রতি wake-এ চলতে থাকবে, ব্যাটারি খেয়ে

---

## BUG-19 — `session_target` ও `wake_mode` সেট করা যায়, কাজ করে না

**ফাইল:** `src/db.rs::handle_wake`

দুটো কলামেই default আছে (`'isolated'`, `'next-heartbeat'`), API দিয়ে patch-ও করা যায়। কিন্তু `handle_wake` সবসময় hardcoded:

```rust
session_key = format!("cron-{}", id)
```

**পরিণতি:** `sessionTarget: "main"` দিয়ে job বানালে সেটা main conversation-এ কিছুই যোগ করবে না। `wakeMode` তো পুরোটাই decorative।

---

## BUG-20 — Cron schedule-এ drift জমে + `at` job চিরতরে আটকে যায়

**ফাইল:** `src/db.rs::mark_job_completed`

```rust
next_run_at = now + every_ms
```

`now` = **শেষ হওয়ার** সময়, scheduled সময় নয়। প্রতিটা run-এ execution duration যোগ হতে থাকে। "প্রতি ঘণ্টায়" job যদি গড়ে ৩০ সেকেন্ড নেয়, ২৪ ঘণ্টা পরে ১২ মিনিট পিছিয়ে যাবে; এক সপ্তাহে দেড় ঘণ্টা।

`schedule_anchor_ms` কলামটা ঠিক এই সমস্যার জন্য বানানো — কিন্তু কখনো পড়া হয় না।

**আর `kind == "at"` job-এর ক্ষেত্রে:** `next_run_at = NULL` সেট হয় কিন্তু `enabled` `1`-ই থাকে। Job তালিকায় "enabled" দেখাবে, কিন্তু `get_due_jobs`-এর `next_run_at IS NOT NULL` filter-এর কারণে আর কোনোদিন চলবে না — একটা zombie job।

---

## BUG-21 — মুছে ফেলা skill-এর দিকে তাক করা job unrestricted চলে

**ফাইল:** `src/db.rs::get_due_jobs`

```rust
let sp: Option<String> = conn.query_row("SELECT system_prompt FROM cron_skills WHERE id = ?", ...)
    .ok().flatten();   // ← skill নেই? কোনো সমস্যা নেই!
```

Skill row মুছে গেলে `.ok().flatten()` → `None` → job default prompt আর **unrestricted tool access** নিয়ে চলে।

**নিরাপত্তা সমস্যা:** যে skill-টা ৩টা read-only টুলে সীমাবদ্ধ ছিল, সেটা delete করলে job-টা পুরো ২১-টুল arsenal পেয়ে যায়। Skill মোছা = privilege escalation।

এছাড়া প্রতিটা skill-বাহী job-এর জন্য লুপের ভেতর **দুটো আলাদা SELECT** — N+1 query pattern।

---

## BUG-22 — Cron skill-এর model/turns/timeout সেটিং উপেক্ষিত

**ফাইল:** `src/db.rs::run_cron_job`

`cron_skills` টেবিলে `model`, `max_turns` (default 3), `timeout_ms` (default 60000) — সব আছে। কিন্তু cron turn hardcoded:

```rust
max_turns: Some(10),
wall_clock_timeout_ms: Some(25_000),
model: None,       // → সবসময় anthropic default
provider: None,
```

**পরিণতি:** background task-এর জন্য সস্তা/দ্রুত মডেল (Haiku) বেছে নেওয়ার কোনো উপায় নেই — সব cron run সবচেয়ে দামি default মডেলে চলে।

---

## BUG-23 — OpenRouter-এ Anthropic-নির্দিষ্ট header ও server-tool inject হয়

**ফাইল:** `src/llm_driver.rs::AnthropicDriver`

Key `sk-ant-oat` দিয়ে শুরু হলে driver যোগ করে:
- `web_search_20250305` server tool
- Claude-Code identity headers
- Anthropic beta headers

কিন্তু **base URL চেক করা হয় না**। `openrouter` provider-ও একই `AnthropicDriver` ব্যবহার করে (`https://openrouter.ai/api/v1/messages`)। OAuth-আকৃতির key দিলে OpenRouter অজানা server tool ও beta header নিয়ে request reject করবে।

---

# ৩. 🟡 MEDIUM — নিরাপত্তা ও সঠিকতার সমস্যা

## BUG-24 — Path traversal সুরক্ষা fail-open

**ফাইল:** `src/tool_runner.rs:21-56`

```rust
let clean = clean.trim_start_matches('/');   // ← absolute path reject না করে "সংশোধন" করে
...
if let (Ok(canon_ws), Ok(canon_full)) = (...) {
    if !canon_full.starts_with(&canon_ws) { return Err(...) }
}
// ← if-এর বাইরে কোনো else নেই: canonicalize ব্যর্থ হলে চেকটা পুরোপুরি বাদ
```

দুটো আলাদা দুর্বলতা:

1. **Absolute path silently rewritten** — `/etc/passwd` → `workspace/etc/passwd`। Reject করা উচিত, চুপচাপ বদলে দেওয়া নয়।
2. **`canonicalize()` fail হলে containment check সম্পূর্ণ skip** — symlink, permission error, বা অস্তিত্বহীন parent থাকলে পথটা যাচাই ছাড়াই পাশ হয়ে যায়।

`..` check আছে ঠিকই, কিন্তু symlink-ভিত্তিক escape এই check এড়িয়ে যায় — আর সেই ক্ষেত্রেই canonicalize-নির্ভর দ্বিতীয় স্তরটা দরকার ছিল, যেটা fail-open।

---

## BUG-25 — API key plaintext-এ, Keychain/Keystore ব্যবহার হয় না

**ফাইল:** `src/auth.rs`

সব auth profile — API key, OAuth token সহ — `auth-profiles.json`-এ **plain text**-এ লেখা হয়। iOS Keychain বা Android Keystore কোথাও ব্যবহৃত হয় না।

Rooted/jailbroken ডিভাইসে, বা ভুল configured backup-এ (Android auto-backup by default চালু), key সরাসরি পড়ে ফেলা যায়।

---

## BUG-26 — Key masking-এ UTF-8 panic

**ফাইল:** `src/auth.rs::get_auth_status`

```rust
&key[..7]  ... &key[len-4..]
```

BUG-04-এর মতোই byte slicing। Non-ASCII character-যুক্ত key (ভুল করে paste করা, বা কোনো provider-এর key) দিলে panic।

---

## BUG-27 — Corrupt auth ফাইল নীরবে সব key মুছে দেয়

**ফাইল:** `src/auth.rs::load_profiles`

```rust
.unwrap_or_default()
```

JSON corrupt হলে (interrupted write, disk full) — কোনো error নেই, কোনো log নেই, শুধু **খালি profile set**। ব্যবহারকারীর সব API key হঠাৎ "নেই" হয়ে যাবে, কোনো ব্যাখ্যা ছাড়া। আর পরের save সেই corrupt ফাইলটা খালি দিয়ে overwrite করে দেবে — **recovery অসম্ভব**।

---

## BUG-28 — `setAuthKey` দিয়ে তৈরি OAuth profile কখনো refresh হয় না

**ফাইল:** `src/auth.rs::set_auth_key`

```rust
refresh: None,   // সবসময়
```

আর `exchangeOAuthCode` token JSON-টা JS-এ ফেরত দেয় কিন্তু refresh token **persist করে না**। তাই:

- `setAuthKey` দিয়ে সেট করা OAuth key → expire হলেই মৃত
- `exchangeOAuthCode` → refresh token হারিয়ে যায়

`refresh_oauth_token` শুধু Anthropic-এর জন্য hardcoded — অন্য কোনো provider-এর OAuth কাজ করবে না।

---

## BUG-29 — 429/529-এ `retry-after` header উপেক্ষিত

**ফাইল:** `src/llm_driver.rs::handle_error_response` + `agent_loop.rs::call_with_retry`

```rust
retry_after_ms: 5000   // hardcoded
```

সার্ভার `retry-after: 60` পাঠালেও কোড ৫ সেকেন্ড পরে retry করবে → আবার 429 → rate limit আরও দীর্ঘায়িত। আর `call_with_retry` তো এই ৫০০০ মানটাও ব্যবহার করে না, নিজের exponential backoff চালায় — অর্থাৎ ফিল্ডটা সম্পূর্ণ dead code।

---

## BUG-30 — `extraToolsJson` প্যারামিটার কোথাও পৌঁছায় না

**ফাইল:** `src/definitions.ts:48`

TS interface-এ `extraToolsJson?: string` আছে, কিন্তু Rust-এর `SendMessageParams` struct-এ ৮টা ফিল্ড, Kotlin-এও ৮টা — এই ফিল্ডটা **কোথাও নেই**।

**পরিণতি:** ডেভেলপার custom tool পাঠাবে, TypeScript compile হবে, কোনো error আসবে না, কিন্তু টুলগুলো নীরবে ফেলে দেওয়া হবে।

---

## BUG-31 — MCP support আসলে নকল

**ফাইল:** `src/lib.rs` (`start_mcp`, `restart_mcp`, `set_mcp_tools`)

`startMcp` আর `restartMcp` — দুটোই শুধু `set_mcp_tools` কল করে। কোনো MCP server process spawn হয় না, কোনো stdio/SSE transport নেই, কোনো handshake নেই, কোনো lifecycle management নেই।

আর demo lab `startMcp("[]")` কল করে — যা কার্যত `set_mcp_tools([])` → **আগের সব MCP টুল মুছে দেয়**।

MCP wait-এ hardcoded ৩০ সেকেন্ড timeout, configurable নয়।

---

## BUG-32 — Demo lab অস্তিত্বহীন টুল কল করে

**ফাইল:** `www/agent-lab.js:385`

```js
window.NativeKit.agent.invokeTool('list_directory', JSON.stringify({ path: '.' }))
```

Builtin টুলের নাম `list_files`, `list_directory` নয়। "Invoke tool" বোতামটা **সবসময় error দেয়**।

---

## BUG-33 — Demo-র event handler ভুল ইভেন্টের নাম শোনে

**ফাইল:** `www/agent-lab.js` (event switch)

| Demo যা handle করে | Engine যা emit করে |
|---|---|
| `tool_approval_request` | `approval_request` |
| `cron_approval_request` | — |
| `turn_complete` | `agent.completed` |
| `run_complete` | — |
| `error` | `agent.error` |

Engine-এর আসল ইভেন্ট: `approval_request`, `tool_use`, `tool_result`, `text_delta`, `mcp_tool_call`, `thinking`, `web_search_*`, `retry`, `user_message`, `max_turns_reached`, `agent.completed`, `agent.error`।

**একটা নামও মেলে না।** ফলে demo-তে approval dialog কখনো দেখা যায় না, completion UI কখনো update হয় না। Demo-টা কার্যত অকেজো।

---

## BUG-34 — `manage_cron` history-তে SQL injection

**ফাইল:** `src/tool_runner.rs:876-880`

```rust
format!("SELECT ... WHERE job_id = '{}' ORDER BY started_at DESC LIMIT {}", jid, limit)
```

`jid` সরাসরি LLM-এর tool argument থেকে আসে, কোনো escaping ছাড়াই string interpolation। বাকি সব query parameterized (`params![]`), শুধু এখানেই নয়।

LLM (বা prompt injection-এ প্রভাবিত LLM) `id: "' OR 1=1 --"` পাঠালে arbitrary SQL চলবে। BUG-01-এর কারণে টুলটা এমনিতেই ভাঙা, কিন্তু সেটা ঠিক করার সময় এটাও ঠিক করতে হবে।

---

## BUG-35 — iOS notification permission কখনো চাওয়া হয় না

**ফাইল:** `ios/Sources/NativeAgentPlugin/NativeNotifierImpl.swift` (২৫ লাইন)

```swift
// trigger: nil, completion error discarded
UNUserNotificationCenter.current().add(request)
```

তিনটা সমস্যা:
1. `UNUserNotificationCenter.requestAuthorization` কোথাও কল হয় না → permission না থাকলে সব notification নীরবে drop
2. `add()`-এর completion error উপেক্ষিত → ব্যর্থতা invisible
3. `trigger: nil` — অ্যাপ foreground-এ থাকলে iOS ডিফল্টে banner দেখায় না

**পরিণতি:** ব্যবহারকারী যদি কখনো অন্য কোনো কারণে notification permission না দিয়ে থাকে, সব cron notification নীরবে হারিয়ে যাবে।

---

## BUG-36 — iOS background task cancel করতে পারে না

**ফাইল:** `ios/Sources/NativeAgentPlugin/NativeAgentBackgroundTask.swift`

`expirationHandler` সেট করা আছে, কিন্তু ভেতরে চলমান **blocking Rust call**-টা cancel করার কোনো উপায় নেই। iOS যখন সময় শেষে task মারবে, Rust call মাঝপথে কাটা পড়বে — সম্ভবত DB-তে half-written state রেখে।

তাছাড়া `NativeAgentWakeRunner` কোনো event callback সেট করে না, তাই সব wake event `PendingEventWriter` (DB queue)-এ যায় — কিন্তু iOS-এ Android-এর `NativeWakeCapture`-এর মতো কোনো drain path নেই। **Event গুলো DB-তে জমতে থাকবে, কেউ পড়বে না।**

---

# ৪. 🔵 LOW — রক্ষণাবেক্ষণ ও drift ঝুঁকি

## BUG-37 — Hardcoded ব্যক্তিগত NDK path

**ফাইল:** `rust/native-agent-ffi/.cargo/config.toml`

```toml
linker = "/home/rruiz/Android/Sdk/ndk/.../aarch64-linux-android21-clang"
```

উপরের রিপো মালিকের (`rruiz`) মেশিনের absolute path committed। অন্য যেকোনো ডেভেলপারের মেশিনে aarch64 build সাথে সাথে fail করবে। CI-তে env var দিয়ে override হয় বলে ধরা পড়েনি।

## BUG-38 — `NativeAgentWakeWorker` কোনো manifest-এ declared নয়

Plugin module-এ `AndroidManifest.xml` নেই; WorkManager auto-initialization-এর উপর পুরোপুরি নির্ভরশীল। Host app যদি auto-init disable করে থাকে (`androidx.startup` remove করা — performance optimization হিসেবে সাধারণ), **সব background wake নীরবে কাজ করা বন্ধ করে দেবে**।

## BUG-39 — `NativeWakeCapture` late notification মিস করে

`restoreDefaultNotifier()` `finally` block-এ চলে, `capture()`-এর **আগে**। Run শেষ হওয়ার পর আসা notification গুলো record হয় না।

## BUG-40 — Surfaced message scan window সীমিত

`capture()` শুধু সবচেয়ে নতুন `RUN_SCAN_LIMIT = 200` রান স্ক্যান করে, `wakeSource` + `startedAt` দিয়ে filter করে। অনেকগুলো job একসাথে থাকলে বা ঘন ঘন wake হলে পুরনো result inbox-এ পৌঁছানোর আগেই জানালার বাইরে চলে যাবে।

## BUG-41 — `dist/` git-এ committed, drift check নেই

`plugins/native-agent/dist/` version control-এ আছে, `src/` ও আছে। `dist/esm/*.js` আর `src/*.ts`-এর মধ্যে সামঞ্জস্য যাচাই করার কোনো CI step নেই। `src` এডিট করে rebuild ভুলে গেলে consumer পুরনো কোড পাবে — আর কেউ টের পাবে না।

## BUG-42 — iOS-এ libgit2 নিয়ে কোড-কমেন্ট বিভ্রান্তিকর

`tool_runner.rs:504-508`-এর কমেন্ট দাবি করে iOS `--no-default-features` দিয়ে build হয়, তাই libgit2 বাদ যায়। কিন্তু আমি committed xcframework-টা binary-level-এ পরীক্ষা করেছি:

```console
$ ar t ios-arm64/libnative_agent_ffi.a | grep git2 | head -3
native_agent_ffi-...git2...cgu.00.rcgu.o.rcgu.o
native_agent_ffi-...git2...cgu.01.rcgu.o.rcgu.o

$ python3 (Mach-O symbol parse) → ___chkstk_darwin
('43a19b30e9e69d8f-repository.o', '___chkstk_darwin', 'UNDEF')
('43a19b30e9e69d8f-clone.o',      '___chkstk_darwin', 'UNDEF')
... মোট ১৪টা UNDEF reference
```

অর্থাৎ **libgit2 device slice-এ আছেই**, আর `___chkstk_darwin` ১৪টা object file-এ **undefined** রয়ে গেছে। `build-ios-xcframework.sh` কোথাও `--no-default-features` pass করে না (grep করে নিশ্চিত হয়েছি) — `IPHONEOS_DEPLOYMENT_TARGET=14.0` সেট করে সমস্যাটা কাটানো হয়েছে।

মজার ব্যাপার: simulator slice-এ `chkstk` **০টা** — শুধু device slice-এ ১৪টা। এটা কাজ করছে বলেই মনে হয় (iOS SDK-র compiler-rt এই symbol সরবরাহ করে), কিন্তু **কোড কমেন্ট আর বাস্তবতা সম্পূর্ণ আলাদা** — যা পরের ডেভেলপারকে ভুল পথে পরিচালিত করবে। iOS-এ git টুলগুলো আসলে libgit2 দিয়েই চলে, stub দিয়ে নয়।

---

# ৫. যেসব "বাগ" যাচাই করে **বাতিল** করেছি

স্বচ্ছতার জন্য — আগে সন্দেহ করেছিলাম কিন্তু পরীক্ষায় ঠিক পাওয়া গেছে:

| সন্দেহ | যাচাইয়ের ফলাফল |
|---|---|
| Swift-এ duplicate `initWorkspace` | ❌ **False positive.** `CAPPluginMethod` count = ৪৯, কোনো duplicate নেই (`uniq -d` খালি)। লাইন ১০০৭-১০১০-এর `initWorkspaceGlobal` wrapper-টা UniFFI global function-এর সাথে Swift নাম-সংঘর্ষ এড়ানোর জন্য — **সঠিক ও ইচ্ছাকৃত** সমাধান। |
| Android/iOS API surface mismatch | ❌ ঠিক আছে। `comm` diff খালি — ৪৯ ≡ ৪৯। |
| UniFFI checksum drift | ❌ ঠিক আছে। ৫৬টা symbol চারটা artifact-এ অভিন্ন। |
| Event name mismatch (plugin ↔ TS) | ❌ ঠিক আছে। দুই পাশেই `nativeAgentEvent`। |
| Demo action ↔ HTML button mismatch | ❌ ঠিক আছে। `agentwake` তিনবার আছে কারণ দুটো card থেকে reachable — ইচ্ছাকৃত UX। |
| `.so` binary tampering | ❌ ঠিক আছে। চারটা ABI-র sha256 manifest-এর সাথে মেলে। |

---

# ৬. অগ্রাধিকার অনুযায়ী করণীয়

### এখনই (অ্যাপ অকেজো / crash করে)

1. **BUG-01** — `tool_manage_cron` পুরোটা `db.rs` API দিয়ে replace করুন (একই সাথে BUG-34 SQL injection মিটে যাবে)
2. **BUG-04** — সব byte-slicing (`&s[..n]`) safe truncation দিয়ে বদলান — ৩ জায়গায়: `execute_command`, `web_fetch`, `grep_file`; `auth.rs`-এও (BUG-26)
3. **BUG-06 + BUG-07** — timeout/error path-এ conversation integrity রক্ষা করুন: `tool_use`-এর জন্য synthetic `tool_result` ইনজেক্ট করুন, আর `"[]"` overwrite বন্ধ করুন
4. **BUG-05** — `execute_command`-এ `tokio::time::timeout` মোড়ান

### এই স্প্রিন্টে (feature অকেজো / নিরাপত্তা)

5. **BUG-10** — approval-এ `HashMap<tool_call_id, Sender>` ব্যবহার করুন
6. **BUG-12** — policy string enum হিসেবে normalize করুন, ও validation যোগ করুন
7. **BUG-14 / BUG-15 / BUG-21** — সব tool-restriction path **fail-closed** করুন
8. **BUG-02 / BUG-03** — heartbeat আর active-hours হয় implement করুন, নয়তো API থেকে সরিয়ে দিন
9. **BUG-08** — `openai` হয় implement করুন, নয়তো `get_models_json` ও `default_model` থেকে বাদ দিন
10. **BUG-09** — SSE parser-এ CRLF support + buffer cap

### পরের ধাপে

11. **BUG-25** — Keychain / Android Keystore-এ migrate করুন
12. **BUG-17 / BUG-18 / BUG-19 / BUG-20 / BUG-22** — scheduler-এর dead column গুলো হয় ব্যবহার করুন, নয়তো schema থেকে সরান
13. **BUG-31** — MCP হয় সত্যিকারের implement করুন, নয়তো API-তে স্পষ্টভাবে "not implemented" বলুন
14. **BUG-32 / BUG-33** — demo lab ঠিক করুন (এটা আপনার প্রধান showcase)
15. **BUG-37** — `.cargo/config.toml` থেকে ব্যক্তিগত path সরান

---

# ৭. একটা সামগ্রিক পর্যবেক্ষণ

এই কোডবেসে একটা স্পষ্ট প্যাটার্ন আছে, যেটা আলাদা করে বলা দরকার:

> **Database schema আর API surface যা প্রতিশ্রুতি দেয়, engine তার বড় একটা অংশ implement করে না।**

গুনে দেখুন — `scheduler_config.enabled`, সব `active_hours_*`, `run_on_charging`, `delivery_webhook_url`, `last_response_hash`, `last_response_sent_at`, `consecutive_errors`, `session_target`, `wake_mode`, `schedule_anchor_ms`, `cron_skills.model`, `cron_skills.max_turns`, `cron_skills.timeout_ms`, পুরো `heartbeat_config` টেবিল, `extraToolsJson` — **১৫টিরও বেশি ফিল্ড** যা লেখা যায়, পড়া যায়, API-তে দেখা যায়, কিন্তু runtime-এ **কোনো প্রভাব ফেলে না**।

এটা আলাদা আলাদা বাগের চেয়েও খারাপ, কারণ:
- ব্যবহারকারী/ডেভেলপার সেট করে, confirm করে, বিশ্বাস করে যে কাজ করছে
- কোনো error নেই, কোনো warning নেই — **নীরব ব্যর্থতা**
- Test suite এগুলো ধরতে পারে না, কারণ test গুলো source-level contract যাচাই করে (Kotlin ≡ Swift ≡ TS), **behavior** নয়

**সুপারিশ:** প্রতিটা persisted field-এর জন্য একটা behavioral integration test লিখুন — "এই ফিল্ডটা সেট করলে engine-এর আচরণ বদলায় কি?" যেগুলোর উত্তর "না", সেগুলো হয় implement করুন, নয়তো সরিয়ে ফেলুন। মাঝামাঝি অবস্থাটাই সবচেয়ে বিপজ্জনক।

দ্বিতীয় প্যাটার্ন: **নিরাপত্তা নিয়ন্ত্রণগুলো সবসময় fail-open** — `allowedTools` parse না হলে unrestricted, skill না পাওয়া গেলে unrestricted, resume করলে unrestricted, canonicalize fail করলে containment check skip। প্রতিটাই উল্টো দিকে হওয়া উচিত।

---

---

# ৮. ফিক্স রাউন্ড — কী কী ঠিক করা হয়েছে

রিপোর্ট দেওয়ার পর **৪১টির মধ্যে ৩৯টি বাগ বাস্তবে ঠিক করা হয়েছে**, একটি কঠিন শর্ত মেনে:

> **FFI/UniFFI surface একটুও বদলানো যাবে না** — কারণ repo-তে prebuilt `.so` আর `.xcframework` committed আছে, আর এখানে Android NDK / Xcode নেই, তাই সেগুলো rebuild করা অসম্ভব। signature বদলালেই generated binding-এর checksum বদলে যেত এবং অ্যাপ চালু হওয়ার সময়েই `UniffiInternalError` দিয়ে crash করত।

### যাচাই (zero-drift প্রমাণ)

| পরীক্ষা | ফল |
|---|---|
| `cargo build --release --lib` | ✅ Finished, **০ warning** |
| Kotlin binding diff (committed vs regenerated) | ✅ **হুবহু অভিন্ন** |
| `native_agent_ffiFFI.h` diff | ✅ **হুবহু অভিন্ন** |
| ৫৬টি UniFFI checksum (Kotlin ≡ Swift ≡ committed) | ✅ **৫৬/৫৬ মিল** |
| `npx tsc --noEmit` | ✅ clean |
| `npx vitest run` | ✅ **১৬৭/১৬৭ pass** |

অর্থাৎ committed `.so` / `.a` / xcframework **এখনও বৈধ** — কোনো নেটিভ rebuild ছাড়াই এই ফিক্সগুলো ব্যবহার করা যাবে।

### গুরুত্বপূর্ণ আবিষ্কার: doc comment-ও checksum-এ ঢোকে

ফিক্স করার সময় দুবার drift ধরা পড়েছে, দুটোই শিক্ষণীয়:

1. `lib.rs`-এ একটা helper function ভুল করে `/// Long-lived handle…` doc comment আর `#[derive(uniffi::Object)]`-এর **মাঝখানে** বসে গিয়েছিল → doc comment চুরি হয়ে generated Kotlin বদলে গিয়েছিল।
2. `steer()` / `start_mcp()` / `restart_mcp()`-এর **doc comment (`///`) উন্নত করতেই checksum বদলে গেল** — UniFFI doc comment-কে signature-এর অংশ ধরে।

**সমাধান:** মূল `///` লাইন হুবহু রেখে সব ব্যাখ্যা সাধারণ `//` কমেন্টে সরানো হয়েছে। ফলে ডকুমেন্টেশনও উন্নত হলো, checksum-ও অক্ষত থাকল। **function body যত খুশি বদলানো যায় — checksum শুধু signature + doc comment থেকে তৈরি হয়।**

### উল্লেখযোগ্য ফিক্স

- **BUG-01/34** — `tool_manage_cron` সম্পূর্ণ নতুন করে লেখা: আসল `db.rs` API ব্যবহার করে (নিজের আলাদা `mobile-claw.db` খোলা বন্ধ), SQL injection দূর।
- **BUG-02/03/17–22** — heartbeat সত্যিকারের implement, `active_hours`/`run_on_charging`/`enabled` gate কার্যকর, webhook delivery, dedup (FNV-1a hash), backoff (`MAX_CONSECUTIVE_ERRORS = 5`), drift-free schedule anchoring, `at` job আর zombie হয় না, N+1 query একটা `LEFT JOIN`-এ পরিণত।
- **BUG-04/26** — সব UTF-8 byte-slice panic char-safe truncation দিয়ে প্রতিস্থাপিত।
- **BUG-05/06** — `execute_command`-এ timeout + `Stdio::null()` stdin; timeout হলে এখন synthesised error `ToolResult` পাঠানো হয়, তাই session আর স্থায়ীভাবে 400 দেয় না।
- **BUG-08** — **OpenAI driver সত্যিকারের লেখা হয়েছে** (~৩৩০ লাইন): Chat Completions, Anthropic-shaped block → OpenAI wire format অনুবাদ, `tool_calls` streaming accumulation, সঠিক error mapping।
- **BUG-09/23/29** — SSE frame parser CRLF সমর্থন করে + buffer bound, provider-ভিত্তিক header, `retry-after` মানা হয়।
- **BUG-10/11/12** — approval `tool_call_id` দিয়ে keyed, `tool_use` approval gate-এর পরে emit, permission string canonical।
- **BUG-13** — cron আর skill এখন নিজস্ব detached steer channel পায়; ব্যবহারকারীর steer আর background job চুরি করতে পারে না।
- **BUG-14/15/16/21/24** — সব fail-open নিরাপত্তা গর্ত **fail-closed**।
- **BUG-31/32/33** — `startMcp` আর catalogue মুছে ফেলে না (additive), demo-র ভুল tool নাম (`list_directory`→`list_files`) ও ভুল event নাম (`turn_complete`→`agent.completed` ইত্যাদি) ঠিক।
- **BUG-35/38/39** — iOS notification permission চাওয়া হয়, Android-এ `AndroidManifest.xml` যোগ + WorkManager auto-init ব্যর্থ হলে fallback, recording notifier এখন `capture()` শেষ হওয়া পর্যন্ত টিকে থাকে।
- **BUG-30/37/42** — মিথ্যা `extraToolsJson` সরানো, ব্যক্তিগত NDK path মুছে ফেলা, ভুল libgit2 কমেন্ট সংশোধন।

### যা ইচ্ছাকৃতভাবে করা হয়নি

- **BUG-25 (plaintext auth store)** — Keychain / Keystore-এ migrate করতে হলে নতুন FFI method লাগবে, যা উপরের শর্ত ভাঙে। এটা নেটিভ rebuild করার সুযোগ থাকলে পরের ধাপে করার জন্য রাখা হলো।
- **BUG-36 (iOS expiration handler)** — blocking Rust call বাতিল করার জন্যও নতুন cancellation FFI দরকার।
- **BUG-41** — `dist/` এখন `src/`-এর সাথে rebuild করে sync করা হয়েছে, তবে drift ধরার CI job যোগ করা বাকি।

---

# ৯. গবেষণা-যাচাই রাউন্ড — ডকুমেন্টেশনের বিপরীতে মিলিয়ে দেখা

ফিক্সগুলো স্মৃতি থেকে না লিখে **প্রকৃত API ডকুমেন্টেশন ও vendor স্পেসিফিকেশনের বিপরীতে যাচাই** করা হয়েছে। এতে **৬টি বাড়তি বাগ** ধরা পড়েছে — যার মধ্যে **৩টি আমার নিজের ফিক্সেই ঢোকানো ত্রুটি**।

### ৯.১ OpenAI reasoning model সম্পূর্ণ অচল ছিল (নতুন, গুরুতর)

`getModels` **`o4-mini`** advertise করে। কিন্তু reasoning model-গুলো (`o1`/`o3`/`o4`/`gpt-5`) `temperature` পাঠালে **HTTP 400 `unsupported_value`** দেয় — শুধু default `1` গ্রহণযোগ্য। আমার ড্রাইভার unconditionally `temperature` পাঠাচ্ছিল, ফলে `o4-mini`-তে **প্রতিটি রিকোয়েস্ট ব্যর্থ** হতো।

**ফিক্স:** `is_reasoning_model()` — family **prefix** দিয়ে ম্যাচ করে (তাই `o4-mini-2025-04-16` ও কভার হয়, কিন্তু `gpt-4o`/`o1x-turbo` ভুল করে ধরা পড়ে না), এবং reasoning model হলে `temperature` **বাদ দেওয়া হয়, ১.০ বসানো হয় না** — কারণ ব্যবহারকারী যে মান দেননি সেটা আবিষ্কার করে বসানো মিথ্যাচার।

যাচাই করে আরও নিশ্চিত হলাম `max_completion_tokens` পছন্দটা সঠিক ছিল: reasoning model পুরোনো `max_tokens` **প্রত্যাখ্যান** করে, আর আধুনিক chat model দুটোই মানে — তাই একটাই key সব মডেলে চলে।

### ৯.২ Streaming-এর শেষ chunk-এ `choices` খালি থাকে (আমার ফিক্সের ত্রুটি)

`stream_options.include_usage` চালু থাকলে শেষ chunk-এ usage থাকে কিন্তু **`choices: []`**। আমার কোড `json["choices"][0]` করছিল, যা Null দেয় — নীরব ভুল। এখন `.get(0)` দিয়ে guard করা।

### ৯.৩ `ToolUseStart` ইভেন্ট ডুপ্লিকেট হতো (আমার ফিক্সের ত্রুটি)

শুধু প্রথম delta-তে `id`/`name` আসে; continuation-এ কিছু OpenAI-compatible gateway `"name": ""` পাঠায়। আমার কোড নাম পেলেই ইভেন্ট emit করত। এখন **একবারই** emit হয় (`entry.1.is_empty()` guard)।

### ৯.৪ iOS notification foreground-এ কখনো দেখাত না (নতুন)

আগের ফিক্সে permission চাওয়া যোগ করেছিলাম, কিন্তু grep করে দেখলাম পুরো কোডবেসে **কোনো `UNUserNotificationCenterDelegate` নেই**। iOS অ্যাপ foreground-এ থাকলে banner **suppress** করে যদি না `willPresent` delegate option ফেরত দেয়। অর্থাৎ অ্যাপ খোলা অবস্থায় cron result নীরবে হারিয়ে যেত।

**ফিক্স:** `ForegroundPresenter` যোগ করে `AppDelegate`-এ register করা হয়েছে (iOS 14+ এ `.banner` **এবং** `.list` দুটোই লাগে)। হোস্ট অ্যাপের delegate থাকলে সেটা **overwrite করা হয় না**।

### ৯.৫ WorkManager fallback-এ race (আমার ফিক্সের ত্রুটি)

আমার প্রথম fallback `initialize()` কল করত, কিন্তু দুবার ডাকলে **"WorkManager is already initialized"** throw করে। এখন `isInitialized()` চেক + `synchronized` + racing initializer-এর জন্য recovery। কল সাইটগুলো `null` handle করে স্পষ্ট reason ফেরত দেয়। `build.gradle`-এ **minimum 2.8.0** নথিভুক্ত (ওখানেই `isInitialized()` এসেছে)।

### ৯.৬ সবচেয়ে বড় আবিষ্কার: Rust টেস্ট কখনোই কম্পাইল হয়নি

`cargo test` চালিয়ে দেখা গেল **আমার পরিবর্তনের আগেও ৫টি কম্পাইল এরর** ছিল — মানে এই রিপোর্টারিতে Rust ইউনিট টেস্ট **একবারও চলেনি**। CI শুধু `cargo build` করত, `cargo test` নয়। পুরোনো টেস্টগুলো struct-এ ফিল্ড যোগ হওয়া আর ফাংশন signature বদলের সাথে তাল মেলায়নি।

৯টি এরর (৫টি পুরোনো + ৪টি আমার পরিবর্তনজনিত) ঠিক করে এখন **১৮/১৮ টেস্ট পাস**। নতুন টেস্ট যোগ করেছি:
- OpenAI wire-format (৫টি) — reasoning detection, temperature omission, token key, usage chunk
- `concurrent_approvals_are_routed_by_tool_call_id` — BUG-10 যে race ঠিক করেছিল সেটা লক করে

**সুপারিশ:** CI-তে `cargo test --lib` যোগ করুন, নাহলে এটা আবার নীরবে ভেঙে যাবে।

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **১৮/১৮** (আগে: কম্পাইলই হতো না) |
| Kotlin binding diff | ✅ হুবহু অভিন্ন |
| C header diff | ✅ হুবহু অভিন্ন |
| ৫৬টি checksum | ✅ ৫৬/৫৬ |
| `tsc` / `vitest` | ✅ clean / ১৬৭ পাস |

---

# ১০. দ্বিতীয় গবেষণা রাউন্ড — আরও ৪টি বাগ, সব প্রমাণসহ

দ্বিতীয় দফায় যেসব জায়গা এখনো স্পেসিফিকেশনের সাথে মেলানো হয়নি সেগুলো ধরা হলো: SSE framing, `Retry-After`, cron/scheduler গণিত, path sandbox, আর auth store। এবার **যাচাই কেবল পড়ে নয় — চালিয়ে** করা হয়েছে।

### ১০.১ 🔴 বাংলা/ইমোজি টেক্সট স্ট্রিমিংয়ে নষ্ট হতো (নতুন, গুরুতর)

**এটি আপনার অ্যাপের জন্য সবচেয়ে প্রাসঙ্গিক বাগ।** দুটো স্ট্রিম লুপেই প্রতিটি নেটওয়ার্ক chunk আলাদাভাবে `String::from_utf8_lossy()` দিয়ে decode হতো। কিন্তু chunk-এর সীমানা একটা multi-byte অক্ষরের **মাঝখানে** পড়তে পারে — তখন অক্ষরের দুই অর্ধেক আলাদাভাবে decode হয়ে `U+FFFD` (�) হয়ে যায়।

প্রমাণ (সত্যিই চালিয়ে দেখা):
```
"আমি" → byte 16-এ split → "���মি"
```

বাংলা (৩ বাইট), ইমোজি (৪ বাইট), CJK — সবই এলোমেলো জায়গায় নষ্ট হতো। ব্যবহারকারী দেখতেন মডেল ভুল অক্ষর লিখছে।

**ফিক্স:** buffer এখন `Vec<u8>`; বাইট জমা হয়, আর decode হয় **কেবল সম্পূর্ণ frame** — যার শেষ সবসময় character boundary-তে। নতুন `find_frame_end_bytes()` বাইট স্তরেই LF/CRLF দুটো terminator খোঁজে।

### ১০.২ IANA timezone নীরবে ভুল zone-এ চলত

`active_hours` এর `tz` ফিল্ড শুধু fixed offset (`+06:00`) বোঝে। `"Asia/Dhaka"` দিলে `None` ফেরত যেত, মানে **নীরবে device-এর local time** ব্যবহার হতো — ব্যবহারকারী ভাবতেন Dhaka সময়ে চলছে, আসলে অন্য zone-এ।

**ফিক্স:** "tz দেওয়াই হয়নি" আর "tz দেওয়া হয়েছে কিন্তু বোঝা যায়নি" — এখন আলাদা। দ্বিতীয় ক্ষেত্রে `tracing::warn!` লগ হয়। (পূর্ণ IANA সাপোর্টে `chrono-tz` dependency লাগবে।)

### ১০.৩ Auth store world-readable ছিল

`auth-profiles.json`-এ API key আর OAuth refresh token থাকে, অথচ default permission-এ লেখা হতো — ডিভাইসের অন্য অ্যাপ/ইউজার পড়তে পারত।

### ১০.৪ Auth store লেখা atomic ছিল না

`std::fs::write` আগে ফাইল truncate করে। লেখার মাঝপথে crash/disk-full হলে অর্ধেক ফাইল থাকত — যা পরে "corrupt" হিসেবে ধরা পড়ে **সব key হারাত**।

**ফিক্স (দুটোই):** temp ফাইলে লিখে, `0600` permission বসিয়ে, তারপর atomic `rename`. ফলে গন্তব্য ফাইল হয় পুরোনো নয় নতুন — কখনো অর্ধেক নয়।

### ১০.৫ যা যাচাই করে **সঠিক** পাওয়া গেছে

শুধু বাগ নয় — যেগুলো ঠিক ছিল সেগুলোও নিশ্চিত করা হলো:

| যাচাই | ফল |
|---|---|
| `Retry-After` — IMF-fixdate ও numeric offset | ✅ chrono দুটোই parse করে (চালিয়ে দেখা) |
| Anthropic headers (`x-api-key`, `anthropic-version: 2023-06-01`) | ✅ স্পেক অনুযায়ী সঠিক |
| OpenRouter-এ beta header/server-tool gating | ✅ সঠিক |
| FNV-1a 64 dedup hash | ✅ known vector মেলে (`cbf29ce484222325`) |
| OAuth refresh token ধরে রাখা | ✅ RFC 6749 §5.1 অনুযায়ী সঠিক |
| Symlink দিয়ে workspace থেকে পালানো | ✅ সত্যিকারের symlink বানিয়ে **ব্লক প্রমাণিত** |

### ১০.৬ টেস্ট: ১৮ → ৪২

নতুন ২৪টি টেস্ট যোগ হয়েছে, প্রতিটি **আসল বাগ reproduce করে তারপর ফিক্স প্রমাণ করে**:

- **SSE**: বাংলা অক্ষর chunk-সীমানায় ভাঙা (পুরোনো পথ নষ্ট করে তা-ও assert করা), LF/CRLF
- **Scheduler**: ২৪ ঘণ্টা সিমুলেট করে **drift-মুক্ততা প্রমাণ**, midnight-wrap window, Dhaka (+06:00) offset, outage-এর পর backlog না চালানো
- **Path sandbox**: ৮ রকম traversal/absolute, **সত্যিকারের symlink escape**, fail-closed
- **Truncation**: বাংলা/ইমোজি/CJK-তে প্রতিটি সম্ভাব্য cut point (পুরোনো কোডে panic হতো)
- **Auth**: `0600` permission, atomic write, refresh token সংরক্ষণ, corrupt backup
- **Approval**: দুটো concurrent approval সঠিক tool-এ যায় (BUG-10 lock)

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **৪২/৪২** (শুরুতে: কম্পাইলই হতো না) |
| Kotlin binding / C header | ✅ হুবহু অভিন্ন |
| ৫৬টি checksum | ✅ ৫৬/৫৬ |
| `tsc` / `vitest` | ✅ clean / ১৬৭ পাস |

**মোট: ৪১ → ৫১টি বাগ চিহ্নিত, ৪৯টি ঠিক করা।** বাকি দুটি (BUG-25 Keychain, BUG-36 iOS cancellation) নতুন FFI method চায়।

---

# ১১. তৃতীয় গবেষণা রাউন্ড — Anthropic স্ট্রিম ও SSRF

এবার যাচাই হলো Anthropic SSE accumulator (ডিফল্ট প্রোভাইডারের মূল পথ) এবং `web_fetch`। **৩টি নতুন বাগ**, একটি নিরাপত্তা-গুরুতর।

### ১১.১ 🔴 `web_fetch` একটি উন্মুক্ত SSRF ছিদ্র ছিল (নতুন, নিরাপত্তা)

`web_fetch`-এর URL **মডেল ঠিক করে** — অর্থাৎ prompt injection দিয়ে নিয়ন্ত্রণ করা যায়। কোনো যাচাই ছিল না:

- `http://169.254.169.254/latest/meta-data/` → **cloud instance metadata** (credential চুরি)
- `http://127.0.0.1:8080/` → ডিভাইসে localhost-এ চলা যেকোনো সার্ভিস
- `http://192.168.1.1/` → ব্যবহারকারীর রাউটার ও পুরো LAN স্ক্যান
- `file:///etc/passwd` → scheme-ও যাচাই হতো না

ফলাফল সরাসরি transcript-এ ফিরত, অর্থাৎ ডেটা বেরিয়ে যেত। কোনো approval gate নেই, তাই এটি নীরবে চলত।

**ফিক্স:** `ensure_url_is_fetchable()` — শুধু http/https; hostname **DNS resolve** করে দেখা হয় (তাই `localtest.me`-ধাঁচের নামও ধরা পড়ে) এবং **প্রতিটি** resolved address public হতে হবে। loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16), CGNAT, IPv6 unique-local, আর `::ffff:127.0.0.1` ধাঁচের IPv4-mapped bypass — সব ব্লকড। **Redirect-ও প্রতি hop-এ পুনরায় যাচাই হয়** (সর্বোচ্চ ৫), নাহলে একটা public URL 302 করে metadata endpoint-এ পাঠিয়ে দিতে পারত।

### ১১.২ Token হিসাব ফুলে যেত (নতুন)

Anthropic-এর ডকুমেন্টেশন অনুযায়ী `message_delta`-র usage **cumulative** — প্রতিটি event চলমান মোট পুনরাবৃত্তি করে। কোড `+=` দিয়ে যোগ করছিল:

```
message_start: 3 → delta: 50 → delta: 120 → delta: 200
ভুল হিসাব: 3+50+120+200 = 373   |   সঠিক: 200
```

অর্থাৎ ব্যবহারকারীকে দেখানো token সংখ্যা (ও খরচের হিসাব) প্রায় **দ্বিগুণ** দেখাত।

**ফিক্স:** যোগ না করে গ্রহণ (`max`)।

### ১১.৩ Thinking block-এর ঝুঁকি নথিভুক্ত করা

যাচাই করে দেখা গেল thinking block **স্ট্রিপ করা হয়** — যা স্পেক অনুযায়ী নিরাপদ। কিন্তু এটি ভঙ্গুর: accumulator `signature_delta` ধরে না, তাই কেউ ভবিষ্যতে "উন্নতি" করে thinking ফেরত পাঠালে **400 `Invalid signature`** দিয়ে পুরো session স্থায়ীভাবে নষ্ট হবে। তাই কোডে বিস্তারিত সতর্কতা + টেস্ট যোগ করা হয়েছে।

### ১১.৪ টেস্ট: ৪২ → ৫১

- SSRF (৫): metadata/loopback/private/IPv6-mapped শ্রেণিবিন্যাস, scheme, malformed URL
- Anthropic stream (৪): cumulative token (পুরোনো ভুল ৩৭৩ বনাম সঠিক ২০০), seed double-count, thinking স্ট্রিপ, tool_use normalisation

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **৫১/৫১** |
| Kotlin / header / ৫৬ checksum | ✅ সব অভিন্ন |
| `tsc` / `vitest` | ✅ clean / ১৬৭ |

**মোট: ৫৪টি বাগ চিহ্নিত, ৫২টি ঠিক করা।**

---

# ১২. চতুর্থ গবেষণা রাউন্ড — migration, orchestration, concurrency

গত রাউন্ডে যে তিনটি অংশ "এখনো যাচাই করিনি" বলে চিহ্নিত করেছিলাম, এবার সেগুলোই দেখা হলো। **৩টি নতুন বাগ**, দুটিই concurrency-ঘটিত।

### ১২.১ 🔴 `max_turns` ছুঁলে session স্থায়ীভাবে নষ্ট হতো (নতুন, গুরুতর)

BUG-06-এ timeout পথের orphan `tool_use` ঠিক করেছিলাম, কিন্তু **`max_turns` পথে ঠিক একই বাগ রয়ে গিয়েছিল** — আমার নিজের ফিক্সের ঠিক পাশে।

turn limit ছুঁলে কোড সরাসরি `break` করত, অথচ assistant message-এ ইতিমধ্যে `tool_use` block বসে গেছে যার কোনো `tool_result` নেই। Anthropic API এমন transcript প্রত্যাখ্যান করে (`tool_use ids were found without tool_result blocks`) — ফলে **সেই session আর কখনো resume করা যেত না**, প্রতিটি পরের বার্তা 400 দিত।

**ফিক্স:** timeout পথের মতোই প্রতিটি বাকি call-এর জন্য synthetic error result তৈরি করে transcript বৈধ রাখা হয়।

### ১২.২ দুটি একসাথে `sendMessage` → নীরবে কথোপকথন হারানো (নতুন)

`spawn_main_turn`-এ কোনো re-entrancy guard ছিল না। দুটি turn একসাথে চললে **দুটোই একই history থেকে শাখা করত**, আর যেটা পরে শেষ হতো সেটা আগেরটার বার্তা **নীরবে মুছে দিত** (`current_session` overwrite + একই session row-তে লেখা)।

**ফিক্স:** `AtomicBool` + `compare_exchange` — দ্বিতীয় কলার স্পষ্ট error পায়। ফ্ল্যাগ ছাড়ে **RAII `TurnGuard`**, তাই task panic করলেও (unwind পথেও) ফ্ল্যাগ আটকে থাকে না — নাহলে অ্যাপ স্থায়ীভাবে "turn already running"-এ জমে যেত। ডেমো UI-তেও guard বসানো হয়েছে যাতে double-click-এ বিভ্রান্তিকর error না আসে।

**গুরুত্বপূর্ণ:** এটি একটি **private field** — FFI surface অপরিবর্তিত, ৫৬/৫৬ checksum অক্ষত।

### ১২.৩ `handle` দুই প্ল্যাটফর্মেই data race (নতুন)

Kotlin-এ `handle` লেখা হয় `Dispatchers.IO` coroutine থেকে, পড়া হয় main thread থেকে — **কোনো memory barrier ছাড়াই**। Java Memory Model অনুযায়ী reader thread অনির্দিষ্টকাল পুরোনো `null` দেখতে পারে, অর্থাৎ সফল `initialize()`-এর পরেও "NativeAgent not initialized" আসতে পারত। দ্রুত ডিভাইসে প্রায় ধরা পড়ে না, কিন্তু load-এ দেখা দেয়।

Swift-এ হুবহু একই সমস্যা (`DispatchQueue.global` থেকে লেখা, main thread থেকে পড়া)।

**ফিক্স:** Kotlin-এ `@Volatile`, Swift-এ `NSLock`-guarded accessor (nested access নেই, তাই deadlock-মুক্ত)।

### ১২.৪ যা যাচাই করে **সঠিক** পাওয়া গেছে

| যাচাই | পদ্ধতি | ফল |
|---|---|---|
| Schema migration | GitHub থেকে **মূল `db.rs` নামিয়ে** column-by-column তুলনা | ✅ কেবল `sessions`-এ ২টি নতুন column, দুটোতেই guard আছে |
| পুরোনো DB upgrade | v0.5.2 schema বানিয়ে তার উপর `ensure_schema` চালানো | ✅ column যোগ হয়, পুরোনো row টেকে |
| Migration idempotency | ৫ বার পরপর চালানো | ✅ কোনো error নেই |
| fresh vs upgraded DB | দুটোর `PRAGMA table_info` তুলনা | ✅ অভিন্ন |
| WAL + busy_timeout | `PRAGMA` পড়ে দেখা | ✅ প্রয়োগ হয়েছে |
| `abort()` / `end_skill` | কোড পর্যালোচনা | ✅ আলাদা flag, সঠিক ডিজাইন |

### ১২.৫ টেস্ট: ৫১ → ৬৩

- Migration (৪): পুরোনো DB upgrade, idempotency, fresh≡upgraded, WAL pragma
- Transcript invariant (৪): orphan `tool_use` শনাক্তকরণ (পুরোনো কোডের shape-এ fail করে), সম্পূর্ণ/আংশিক বন্ধ, multi-turn ভারসাম্য
- Turn guard (৪): একজনই দাবি করতে পারে, drop-এ মুক্তি, **panic-unwind-এও মুক্তি**, পরপর turn

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **৬৩/৬৩** |
| Kotlin / header / ৫৬ checksum | ✅ সব অভিন্ন |
| `tsc` / `vitest` | ✅ clean / ১৬৭ |

**মোট: ৫৭টি বাগ চিহ্নিত, ৫৫টি ঠিক করা।**

> **পরিবেশ নোট:** এই রাউন্ডে workspace snapshot থেকে `~/.cargo`, `.git` আর `node_modules`/`dist` বাদ পড়েছিল (এগুলো cache/build ডিরেক্টরি)। Rust toolchain পুনঃইনস্টল, `npm ci` ও plugin `dist` rebuild করে সব যাচাই আবার চালানো হয়েছে। **সোর্স কোডের কোনো পরিবর্তন হারায়নি** — যাচাই করা হয়েছে।

---

# ১৩. পঞ্চম রাউন্ড — persistence durability

বাকি অদেখা অংশগুলো (`types.rs`, `config_store.rs`, `bridge/app-browser.ts`) যাচাই করা হলো। **৩টি নতুন বাগ**, তিনটিই একই মূল কারণে।

### ১৩.১ 🔴 `edit_file` ব্যবহারকারীর ফাইল মুছে ফেলতে পারত (নতুন, গুরুতর)

`std::fs::write` আগে ফাইল **truncate** করে, তারপর লেখে। `edit_file` সবে ফাইলটা পড়েছে — এই দুইয়ের মাঝে প্রসেস মারা গেলে (ফোনে OOM-kill, ব্যাটারি শেষ, force-quit) ব্যবহারকারীর সোর্স ফাইল **খালি** থেকে যেত, আর আসল কনটেন্ট চিরতরে হারাত।

`write_file` একই ঝুঁকিতে ছিল।

**ফিক্স:** `write_file_atomic()` — **একই ডিরেক্টরিতে** temp ফাইল (cross-filesystem rename atomic নয়) লিখে তারপর rename। গন্তব্য ফাইল সবসময় হয় পুরোনো, নয় সম্পূর্ণ নতুন — কখনো অর্ধেক নয়।

### ১৩.২ Config corrupt হলে সব background job স্থায়ীভাবে বন্ধ

`persist_config`-ও non-atomic ছিল। এই ফাইলটাই `handle_wake` পড়ে background-এ engine পুনর্গঠন করতে — তাই truncate হলে **প্রতিটি cron job ব্যর্থ** হতো, আর সেই পথে কোনো UI নেই যে error দেখাবে বা মেরামত করবে।

### ১৩.৩ প্যাটার্নটি স্বীকার করা

তিনটিই একই কারণ: **গুরুত্বপূর্ণ state-এর non-atomic write**। আগের রাউন্ডে `auth.rs`-এ এটি ঠিক করেছিলাম কিন্তু **একই প্যাটার্ন অন্য কোথায় আছে খুঁজিনি**। এবার `grep` দিয়ে সব `fs::write` স্ক্যান করে বাকিগুলো পাওয়া গেল। (`workspace.rs:241` ইচ্ছাকৃতভাবে বাদ — সেটি `write_if_missing`, শুধু নতুন ফাইল তৈরি করে, কিছু নষ্ট করার সুযোগ নেই।)

### ১৩.৪ যা যাচাই করে **সঠিক** পাওয়া গেছে

| যাচাই | ফল |
|---|---|
| সব `ContentBlock` variant JSON round-trip | ✅ কোনোটিই হারায় না |
| `MessageContent` untagged enum সংঘর্ষ | ✅ Blocks কখনো Text হিসেবে ভুল পড়া হয় না |
| `Role` lowercase serde (DB এই বানানেই match করে) | ✅ সঠিক |
| App Browser iframe sandbox | ✅ `allow-scripts` only, `allow-same-origin` **নেই** |
| `postMessage(..., '*')` | ✅ বাগ নয় — opaque origin-এ wildcard বাধ্যতামূলক; token-ভিত্তিক যাচাই আছে |
| RPC listener | ✅ channel + token + `event.source` তিনটিই যাচাই করে |
| CSP injection | ✅ আক্রমণকারীর `base`/CSP ট্যাগ সরিয়ে নিজেরটা বসায় |
| Session token | ✅ `crypto.randomUUID()` |
| `innerHTML` / `eval` | ✅ একটিও নেই |

### ১৩.৫ টেস্ট: ৬৭ → ৭৬

- Atomic write (৫): কনটেন্ট, সম্পূর্ণ overwrite, temp leak নেই, temp sibling কিনা, ব্যর্থতায় মূল ফাইল অক্ষত
- Serde round-trip (৪): সব block variant, untagged সংঘর্ষ, পূর্ণ assistant turn, Role বানান

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **৭৬/৭৬** |
| Kotlin / header / ৫৬ checksum | ✅ সব অভিন্ন |
| `tsc` / `vitest` | ✅ clean / ১৬৭ |

**মোট: ৬০টি বাগ চিহ্নিত, ৫৮টি ঠিক করা।**

---

# ১৪. ষষ্ঠ রাউন্ড — background wake path

Wake path সম্পূর্ণ (Kotlin worker → Rust `handle_wake` → capture) যাচাই করা হলো। **২টি নতুন বাগ।**

### ১৪.১ 🔴 অতিরিক্ত job থাকলে OS পুরো wake মেরে ফেলত (নতুন, গুরুতর)

প্রতিটি job আলাদাভাবে bounded (`wall_clock_timeout_ms`), কিন্তু **পুরো loop-এর কোনো সময়সীমা ছিল না**। N টা due job × ৬০ সেকেন্ড = সহজেই WorkManager-এর **১০ মিনিটের সীমা** পার।

OS মাঝপথে মেরে ফেললে সবচেয়ে খারাপ অবস্থা হতো:
- চলমান `cron_runs` row চিরকাল `'running'` অবস্থায় আটকে থাকত
- বাকি job-গুলোর `next_run_at` আর এগোত না → **পরের wake-এও একই overload** (স্থায়ী backlog)
- `recordWake` পর্যন্ত পৌঁছাত না → `getWakeStatus()` কিছুই দেখাত না, **ব্যর্থতা সম্পূর্ণ অদৃশ্য**

**ফিক্স:** ৮ মিনিটের total budget (WorkManager-এর ১০ মিনিটের নিচে margin)। যাচাই হয় **কেবল job-এর মাঝখানে** — শুরু হওয়া job সবসময় শেষ করে নিজের row finalize করে, তাই zombie row হয় না। বাকি job due থেকেই যায়, পরের wake-এ চলে। নতুন `wake.budget_exhausted` event emit হয়, আর heartbeat (সর্বনিম্ন অগ্রাধিকার) budget ফুরালে নিজে থেকে সরে যায়।

### ১৪.২ `cron_runs` অসীম বাড়ত

মোছা হতো **শুধু job delete করলে**। ১৫ মিনিটের একটা job = বছরে ~৩৫,০০০ row, প্রতিটিতে `response_text` (সম্পূর্ণ মডেল উত্তর, প্রায়ই কয়েক KB) → ফোনে **কয়েকশো MB**, আর প্রতিটি `listCronRuns` scan ধীর হতো। এখন newest ২০০০ row-তে সীমাবদ্ধ।

### ১৪.৩ যা যাচাই করে **সঠিক/অপ্রয়োজনীয়** পাওয়া গেছে

| বিষয় | সিদ্ধান্ত |
|---|---|
| **BUG-40** (`RUN_SCAN_LIMIT = 200`) | ✅ **ক্ষতিকর নয়** — `list_cron_runs` `started_at DESC` করে, তাই wake-এর নিজের run সবসময় window-এর ভিতরে; আর নতুন budget একক wake-এ ২০০ job হওয়াই আটকায় |
| `system_events` টেবিল | ✅ **সম্পূর্ণ মৃত** — কোথাও read/write নেই (Rust/Kotlin/Swift/TS grep)। বাড়তে পারে না, তাই retention অপ্রয়োজনীয়। DB WebView-এর সাথে শেয়ার্ড বলে drop না করে কমেন্টে নথিভুক্ত |
| `NativeWakeRunner` / `WakeWorker` | ✅ exception-safe, `finally`-তে handle close; periodic work fail state-এ শেষ হতে পারে না বলে `Result.success()` সঠিক |
| `MemoryProviderImpl` (Kotlin ও Swift) | ✅ lock + atomic rename, early-return leak নেই |
| App Browser (`app-browser.ts`, ২৬৮৫ লাইন) | ✅ iframe `allow-scripts` only, token `crypto.randomUUID()`, RPC-তে channel+token+`event.source` যাচাই, CSP injection সুরক্ষিত, `innerHTML`/`eval` একটিও নেই |

### ১৪.৪ নিজের একটা ভুল সংশোধন

প্রথমে ভেবেছিলাম Android slice auto-rebuild হয় না (iOS হয়)। **ভুল** — `native-agent-ffi.yml`-এ push trigger আগে থেকেই ছিল, ফাইলের শেষে। একটা duplicate `push:` key যোগ করে ফেলেছিলাম যা YAML নীরবে উপেক্ষা করত; সেটা revert করা হয়েছে।

### ১৪.৫ শিপ করা বাইনারি যাচাই

CI সব slice **নতুন Rust সোর্স থেকে rebuild** করেছে, আর আমি প্রতিটিতে fix-গুলোর উপস্থিতি যাচাই করেছি:

| Slice | অবস্থা |
|---|---|
| arm64-v8a / armeabi-v7a / x86 / x86_64 | ✅ সব fix + ৫৬ checksum |
| ios-arm64 (+ simulator) | ✅ সব fix + ৫৬ checksum |
| `abi-manifest.json` sha256 | ✅ সব মিলে যায় |
| committed bindings | ✅ rebuild-এ অপরিবর্তিত |

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **৮৪/৮৪** |
| Kotlin / header / ৫৬ checksum | ✅ সব অভিন্ন |
| `tsc` / `vitest` | ✅ clean / ১৬৭ |
| GitHub CI (৫টি workflow) | ✅ সব সবুজ |

**মোট: ৬২টি বাগ চিহ্নিত, ৬০টি ঠিক করা।**

---

# ১৫. সপ্তম রাউন্ড — MCP connector (স্পেসিফিকেশনের বিপরীতে)

MCP অংশটি **Model Context Protocol স্পেসিফিকেশন (2025-06-18 schema)** মিলিয়ে যাচাই করা হলো। **৫টি বাগ**, একটি MCP-র মূল নিরাপত্তা-গ্যারান্টিই উল্টে দিচ্ছিল।

### ১৫.১ 🔴 MCP-র নিজের `isError` উপেক্ষা করা হতো (নতুন, গুরুতর)

`respondToMcpTool(id, resultJson, isError)` — `isError` আলাদা প্যারামিটার। কিন্তু আসল MCP `CallToolResult`-এ `isError` **ভিতরে** থাকে:

```json
{ "content": [{"type":"text","text":"rate limited"}], "isError": true }
```

একজন ডেভেলপার সার্ভারের উত্তর হুবহু ফরোয়ার্ড করলে (সবচেয়ে স্বাভাবিক কাজ) ভিতরের `isError` **নীরবে হারিয়ে যেত** → **ব্যর্থ tool মডেলের কাছে সফল হিসেবে** পৌঁছাত।

স্পেক স্পষ্ট বলে: tool-এর ব্যর্থতা result-এর ভিতরে `isError: true` দিয়ে জানাতে হবে **ঠিক এই কারণেই যেন মডেল দেখে নিজেকে সংশোধন করতে পারে**। উপেক্ষা করায় ফিল্ডটার একমাত্র উদ্দেশ্যই ব্যর্থ হতো।

**ফিক্স:** ভিতরের `isError` এখন মানা হয়, আর প্যারামিটারের সাথে **OR** করা হয় — তাই স্পষ্ট error কখনো নিচে নামে না।

### ১৫.২ `content[]` block সমান করা হতো না

পুরো JSON blob-টাই tool result-এর টেক্সট হয়ে যেত — মডেল দেখত `{"content":[{"type":"text","text":"16C"}]}`, `16C` নয়। বেশি token, বেশি noise, আর image/resource block তো অর্থহীন।

**ফিক্স:** text block জোড়া লাগে; image/audio/resource **বর্ণনা** করা হয় (base64 inline হয় না); textual resource-এর টেক্সট ঢোকে; অজানা (ভবিষ্যৎ) block টাইপ raw JSON হিসেবে **রাখা হয়, ফেলা হয় না**। `structuredContent` **error পথেও** সংরক্ষিত — সেখানেই সার্ভার error code ও retry hint রাখে।

### ১৫.৩ অচেনা tool নাম ৩০ সেকেন্ড turn আটকে রাখত

Dispatch ছিল "builtin, নাহলে MCP" — registered catalogue-এর সাথে **কোনো যাচাই ছাড়াই**। মডেল একটা নাম বানিয়ে ফেললে সেটা MCP পথে গিয়ে ৩০ সেকেন্ড অপেক্ষা করত এমন উত্তরের জন্য যা কখনো আসবে না, তারপর বিভ্রান্তিকর "timed out" বলত।

**ফিক্স:** এখন সাথে সাথে ব্যর্থ হয় আর মডেলকে **কোন tool গুলো আসলে আছে** তা বলে দেয়। `BUILTIN_TOOL_NAMES` একক সত্যের উৎস হলো, তাই membership test আর তালিকা আলাদা হয়ে যেতে পারে না।

### ১৫.৪ ডেমো কখনো MCP call-এর উত্তর দিতে পারত না

`mcp_tool_call` event **একেবারেই handle করা হতো না**, আর বাটনটা `lastToolCallId` পুনর্ব্যবহার করত — যা কেবল `approval_request` সেট করে। ফলে হয় "no pending call" থ্রো করত, নয় **সম্পর্কহীন একটা approval-এর উত্তর** দিয়ে দিত।

**ফিক্স:** MCP call আলাদা ট্র্যাক হয়, আর উত্তর যায় আসল `CallToolResult` আকারে।

### ১৫.৫ 🔴 CI: Android slice push-এ কখনো commit হতো না (নতুন)

সবচেয়ে গুরুত্বপূর্ণ প্রক্রিয়াগত আবিষ্কার। প্রতিটি push-এ workflow চারটি ABI build করত, binding identity যাচাই করত, artefact upload করত — **তারপর "Commit rebuilt slices back" ধাপ skip করে success বলত।**

কারণ: `if: inputs.commit_slices != false`. Push-এ input থাকে না, GitHub খালি মানকে `false`-এ রূপ দেয় → `false != false` → **false** → skip।

ফল ছিল একটা **অদৃশ্য অসামঞ্জস্য**: iOS workflow-এ এমন guard নেই, তাই Rust ফিক্স সাথে সাথে iOS-এ পৌঁছাত, কিন্তু Android `.so` আগের build নিয়ে বসে থাকত। কিছুই fail করত না — বাইনারি শুধু নীরবে পুরোনো হয়ে যেত, আর প্রতি রাউন্ডে আমাকে হাতে dispatch করতে হতো।

**ফিক্স:** `github.event_name == 'push' || inputs.commit_slices != false`. যাচাই করা হয়েছে — পরের push-এ ধাপটি **success** দেখিয়েছে এবং চারটি ABI-ই নতুন বাইনারি পেয়েছে।

### ১৫.৬ গুরুত্বপূর্ণ স্থাপত্য স্পষ্টীকরণ

এই প্লাগইন **MCP client নয়**। কোনো JSON-RPC স্তর নেই, কোনো stdio/Streamable-HTTP transport নেই, `tools/list`/`tools/call` বলার কিছু নেই — grep করে নিশ্চিত। এটি শুধু tool **catalogue** রাখে আর call গুলো WebView-এ ফেরত পাঠায়; **MCP client আপনাকেই লিখতে হবে**।

আগে এটা পাঠকের অনুমানের উপর ছাড়া ছিল। এখন `definitions.ts`-এ পূর্ণ ৪-ধাপের wiring সহ স্পষ্ট লেখা আছে।

### ১৫.৭ টেস্ট: ৮৪ → ৯২

MCP wire-format-এর ৮টি টেস্ট: ভিতরের `isError`, OR আচরণ, text flatten, non-text block, `structuredContent` error পথে, খালি content, backward-compat pass-through, অজানা block টাইপ।

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` | ✅ ০ warning |
| `cargo test --lib` | ✅ **৯২/৯২** |
| Kotlin / header / ৫৬ checksum | ✅ সব অভিন্ন |
| `tsc` / `vitest` | ✅ clean / ১৬৭ |
| GitHub CI (৫টি workflow) | ✅ সব সবুজ |
| শিপ করা বাইনারি (৪ Android + iOS) | ✅ সব fix উপস্থিত, ৫৬ checksum |

**মোট: ৬৭টি বাগ চিহ্নিত, ৬৫টি ঠিক করা।**

---

# ১৬. অষ্টম রাউন্ড — বাকি gap গুলো বন্ধ করা

### ১৬.১ ✅ BUG-36 বন্ধ — OS থামতে বললে wake এখন থামে (FFI বদলানো ছাড়াই)

আগে ধরে নিয়েছিলাম এর জন্য নতুন FFI method লাগবে। **সেটা ভুল ছিল।** `handle_wake` ইতিমধ্যে job-এর মাঝখানে engine-এর abort flag পড়ে, আর `abort()` সেই flag-ই তোলে — অর্থাৎ API আগে থেকেই ছিল, শুধু কেউ ব্যবহার করত না।

**iOS:** `BGProcessingTask`-এর expiration handler শুধু failure রিপোর্ট করে সরে যেত, সাথে কমেন্ট লেখা ছিল "Rust call cancel করা যায় না"। যায়। ফলে iOS task ফেরত নেওয়ার পরেও Rust ব্যাকগ্রাউন্ড thread-এ কাজ চালিয়ে যেত — **ঠিক সেই ব্যাটারিই পুড়িয়ে যেটা বাঁচাতে expiration limit আছে।**

**Android:** উল্টো দিক থেকে একই গর্ত — `onStopped()` **একেবারেই implement করা ছিল না**। WorkManager worker কেড়ে নিলে (১০ মিনিট পার, constraint ভাঙল, বা cancel) blocking Rust call চলতেই থাকত আর row লিখত, এমন thread-এ যার হিসাব WorkManager আর রাখে না।

দুটোই এখন abort flag তোলে → পরের job boundary-তে loop পরিষ্কারভাবে ফেরে। চলমান job নিজের row finalize করে, বাকিগুলো due থেকে পরের wake-এ চলে।

### ১৬.২ ✅ সত্যিকারের MCP client লেখা হয়েছে (`bridge/mcp-client.ts`)

গত রাউন্ডে বলেছিলাম প্লাগইনে কোনো MCP client নেই — শুধু catalogue আর callback bridge। এবার **অনুপস্থিত অর্ধেকটা লিখে দেওয়া হলো**, স্পেক (2025-06-18) মেনে:

- **`McpClient`** — JSON-RPC 2.0: `initialize` + বাধ্যতামূলক `notifications/initialized`, **paginated** `tools/list` (প্রথম page-এ থামলে tool নীরবে লুকিয়ে যেত), `tools/call`, আর id-mismatch guard যাতে ভুল response ভুল call-এ না মেলে।
- **`HttpMcpTransport`** — Streamable HTTP: `application/json` ও `text/event-stream` দুটোই, `Mcp-Session-Id` ধরে রেখে পরের request-এ ফেরত পাঠায়, notification-এর 202 সামলায়, আর **প্রতি request bounded** — নাহলে ঝুলে থাকা server engine-এর ৩০ সেকেন্ড timeout পর্যন্ত turn আটকে রাখত।
- **`connectMcpServers`** — পুরো wiring: handshake → tools merge → `startMcp` → প্রতিটি `mcp_tool_call`-কে `tools/call` বানিয়ে উত্তর।

**দুটো ইচ্ছাকৃত সিদ্ধান্ত:** tool নাম `server__tool` আকারে namespaced — দুটো server-ই `search` দিতে পারে, flat catalogue-এ একটা আরেকটাকে নীরবে ঢেকে দিত আর call ভুল process-এ যেত। আর **প্রতিটি ব্যর্থতার পথও উত্তর দেয়** — engine turn আটকে রাখে, তাই হারিয়ে যাওয়া error মানে ৩০ সেকেন্ড stall + বিভ্রান্তিকর timeout।

`NativeKit.agent.connectMcp([...])` দিয়ে পাওয়া যায়; raw hook গুলো যেমন ছিল তেমনই আছে।

### ১৬.৩ CI আমার একটা ভুল ধরেছে

`connectMcp` যোগ করার পর আমি শুধু `tsc` আর bundler চালিয়েছিলাম, **পূর্ণ টেস্ট স্যুট নয়**। CI ধরল: repo-তে একটা চমৎকার contract test আছে — bridge-এর প্রতিটি agent API-র demo-lab টেস্ট থাকতেই হবে, আর প্রতিটি demo action-এর button (ও উল্টোটা)। `connectMcp`-এর কোনোটাই ছিল না।

ঠিক করে demo-তে `agentconnectmcp` action + URL input + button যোগ করা হয়েছে (আগের connection dispose করে, নাহলে পুরোনো listener এমন tool-এর call-এর উত্তর দিতে থাকত যেগুলো আর publish করা নেই)।

**শিক্ষা:** শেষ সম্পাদনার পরেও পূর্ণ স্যুট চালাতে হয় — আংশিক যাচাই যথেষ্ট নয়।

### ১৬.৪ BUG-25 (Keychain/Keystore) — সৎ মূল্যায়ন

এটি **ইচ্ছাকৃতভাবে করা হয়নি**, এবং কারণটা স্পষ্ট বলা দরকার।

এর জন্য একটা নতুন UniFFI **callback interface** (`SecretStore`) দরকার, তারপর Rust-এ encryption, Android Keystore impl, আর iOS Keychain impl। CI এখন দুই প্ল্যাটফর্মের বাইনারি rebuild করে, তাই **FFI বাধাটা আর নেই** — কিন্তু সমস্যা অন্যখানে: এই পরিবেশে আমি Android/iOS কোড **চালিয়ে দেখতে পারি না**, শুধু compile হয় কিনা দেখতে পারি।

Credential storage-এ untested কোড পাঠানোর ঝুঁকি বাস্তব: Keystore impl throw করলে **ব্যবহারকারী সম্পূর্ণ auth হারাবেন**, আর ফাইলটা encrypted হওয়ায় ফেরানোও যাবে না। বর্তমান অবস্থা (file `0600`, atomic write, corrupt backup) নিরাপদ নয় — কিন্তু **ভাঙা নয়**।

সুপারিশ: এটি এমন একজনের করা উচিত যিনি সত্যিকারের ডিভাইসে migration path (plaintext → encrypted, এবং rollback) পরীক্ষা করতে পারবেন।

### চূড়ান্ত অবস্থা

| পরীক্ষা | ফল |
|---|---|
| `cargo check` / `cargo test --lib` | ✅ ০ warning / **৯২** |
| `vitest` | ✅ **১৯৭** (নতুন ৩০টি MCP client টেস্ট) |
| `tsc` / config / bridge bundle | ✅ সব clean |
| Kotlin / header / ৫৬ checksum | ✅ অভিন্ন |
| GitHub CI | ✅ সব সবুজ (iOS ও Android build সহ — অর্থাৎ Swift/Kotlin পরিবর্তন সত্যিই compile হয়) |

**মোট: ৬৯টি বাগ চিহ্নিত, ৬৮টি ঠিক করা। বাকি ১টি — BUG-25।**

---

*রিপোর্ট শেষ।*
