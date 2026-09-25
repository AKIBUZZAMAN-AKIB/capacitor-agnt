# Agent Internals — Tools, Files ও Customization (গভীর বিশ্লেষণ)

এই ডকুমেন্টের প্রতিটি দাবি সোর্স কোড থেকে যাচাই করা, স্মৃতি বা অনুমান থেকে নয়।
যেখানে কিছু **কাজ করে না**, সেটাও স্পষ্ট লেখা আছে।

---

## ১. এজেন্ট কোন কোন ফোল্ডার/ফাইল বানায়

### ১.১ আপনি তিনটি path দেন, বাকিটা এজেন্ট বানায়

`initialize()` / `initWorkspace()`-এ তিনটি path **বাধ্যতামূলক**
(`types.rs` → `InitConfig`):

| প্যারামিটার | ডেমোতে যা দেওয়া হয় |
|---|---|
| `dbPath` | `files://agent/agent.db` |
| `workspacePath` | `files://agent/workspace` |
| `authProfilesPath` | `files://agent/auth-profiles.json` |

`files://` prefix প্ল্যাটফর্ম অনুযায়ী resolve হয়:

- **Android** → `context.filesDir` → `/data/data/<pkg>/files/…`
- **iOS** → `Library/` ডিরেক্টরি → `<App>/Library/…`

`files://` না দিলে path হুবহু absolute হিসেবে ব্যবহৃত হয়।

### ১.২ সম্পূর্ণ ডিরেক্টরি গাছ

`workspace.rs → ensure_workspace_dirs()` ঠিক এই পাঁচটি ডিরেক্টরি বানায়:

```
<filesDir|Library>/
├── agent/
│   ├── agent.db                      ← SQLite (আপনার dbPath)
│   ├── auth-profiles.json            ← API key + OAuth token (0600)
│   ├── .native-agent-config.json     ← background wake-এর জন্য config
│   ├── .openclaw/
│   │   └── openclaw.json             ← engine-এর নিজস্ব config
│   └── workspace/                    ← এজেন্টের sandbox root
│       ├── AGENTS.md
│       ├── SOUL.md
│       ├── IDENTITY.md
│       ├── USER.md
│       ├── TOOLS.md
│       ├── HEARTBEAT.md
│       ├── MEMORY.md
│       └── agents/main/
│           ├── agent/
│           └── sessions/
└── native-agent-memory/
    └── memory.json                   ← long-term memory (plugin-owned)
```

**লক্ষণীয়:** `.native-agent-config.json` আর `.openclaw/` বসে **workspace-এর
parent**-এ (`config_store.rs` → `default_config_path` = `workspace.parent()`),
workspace-এর ভিতরে নয়। কারণ workspace হলো এজেন্টের sandbox — তার ভিতরে config
রাখলে এজেন্ট নিজের config পড়তে/বদলাতে পারত।

### ১.৩ কোন ফাইল কখন, কেন তৈরি হয়

| ফাইল | কখন | কেন | পুনরায় লেখা হয়? |
|---|---|---|---|
| ৭টি `.md` | `initWorkspace()` | system prompt-এর উপাদান | ❌ `write_if_missing` — **আপনার সম্পাদনা টিকে থাকে** |
| `auth-profiles.json` | `initWorkspace()` | credential | ❌ শুধু না থাকলে |
| `.openclaw/openclaw.json` | `initWorkspace()` | engine config | ❌ শুধু না থাকলে |
| `agent.db` | প্রথম DB access | সব persistent state | — |
| `.native-agent-config.json` | `initialize()` → `persistConfig()` | background wake-এ WebView থাকে না, তাই তিনটি path ডিস্ক থেকে পড়তে হয় | ✅ প্রতি `initialize()`-এ (atomic) |
| `native-agent-memory/memory.json` | প্রথম `memory_store` | long-term memory | ✅ atomic rewrite |

### ১.৪ SQLite-এর ১০টি টেবিল

```
sessions          messages           tool_permissions   pending_events
cron_jobs         cron_runs          cron_skills
scheduler_config  heartbeat_config   system_events ⚠
```

⚠ `system_events` **সম্পূর্ণ অব্যবহৃত** — Rust/Kotlin/Swift/TS কোথাও read/write
নেই (grep-যাচাইকৃত)। DB WebView-এর সাথে শেয়ার্ড বলে drop করা হয়নি।

**Retention:** `cron_runs` → newest ২০০০, `pending_events` → newest ৫০০।
`messages`/`sessions`-এর কোনো সীমা নেই — দীর্ঘ কথোপকথন অনির্দিষ্টভাবে বাড়বে।

---

## ২. ২০টি tool — কোনটা সত্যিই কাজ করে

### ২.১ ফাইল tools (৬) — ✅ দুই প্ল্যাটফর্মেই নির্ভরযোগ্য

`read_file` `write_file` `edit_file` `list_files` `find_files` `grep_files`

সবগুলো **native Rust**, কোনো shell লাগে না। সীমা:

- সব path **workspace-এর ভিতরে বাধ্যতামূলক** — absolute path, `..`,
  Windows drive (`C:`), UNC — সব প্রত্যাখ্যাত; **symlink দিয়ে পালানোও ব্লকড**
  (canonicalize করে যাচাই, এবং workspace অ্যাক্সেস না করা গেলে **fail-closed**)
- `MAX_FILE_SIZE` = ১০ MB, `MAX_MATCHES` = ২০০, output ৫০ KB-তে কাটা
- `write_file`/`edit_file` **atomic** (temp + rename) — crash-এ ফাইল খালি হয় না
- সব truncation **char-safe** — বাংলা/ইমোজি ভাঙে না

### ২.2 git tools (৬) — ✅ সব slice-এ কাজ করে

`git_init` `git_status` `git_add` `git_commit` `git_log` `git_diff`

**libgit2 লিঙ্ক করা, git binary লাগে না** — যাচাই করেছি: চারটি Android ABI ও
iOS slice, সবগুলোতে libgit2 উপস্থিত। তাই iOS-এও git কাজ করে।

### ২.৩ `execute_command` — ⚠ এখানেই আসল সীমাবদ্ধতা

| প্ল্যাটফর্ম | অবস্থা |
|---|---|
| **Android** | ✅ চলে (`sh -c`, `/system/bin/sh`) |
| **iOS** | ❌ **কখনোই চলবে না** |

**iOS কেন পারে না:** sandboxed অ্যাপে iOS `fork`/`exec`/`posix_spawn`
সম্পূর্ণ নিষিদ্ধ করে, আর `NSTask` iOS SDK-তেই নেই। এটা এই প্লাগইনের bug নয় —
OS-এর নীতি। কোনো workaround নেই।

**Android-এ কী কী চলে:** userland হলো **toybox** — `ls`, `cat`, `echo`, `grep`,
`sed`, `mkdir`, `cp`, `mv` ইত্যাদি আছে। **নেই:** `git`, `python`, `node`, `curl`
(সাধারণত), `bash` (শুধু `sh`/mksh)। তাই version control-এর জন্য `git_*` tool
ব্যবহার করুন।

**আচরণ:**
- timeout ডিফল্ট ৩০ s, `timeout_ms` দিয়ে সর্বোচ্চ ৩০০ s
- timeout হলে **error নয়, একটা result** ফেরে (`timedOut: true`) — মডেল
  নিজেকে সংশোধন করতে পারে
- **stdin = `/dev/null`** — interactive command EOF পায়, ঝুলে থাকে না
- `cwd` অবশ্যই workspace-relative

> **এই রাউন্ডে ঠিক করা:** আগে iOS-এ মডেল পেত `Operation not permitted (os error 1)` —
> যা থেকে বোঝা যায় না সমস্যাটা **স্থায়ী**, তাই মডেল বারবার চেষ্টা করে turn নষ্ট করত।
> এখন স্পষ্ট বলা হয় "iOS-এ সম্ভব নয়, retry কোরো না, এই tool গুলো ব্যবহার করো"।
> Tool description-ও এখন সত্য বলে।

### ২.৪ `web_fetch` — ✅ তবে ইচ্ছাকৃতভাবে সীমিত

শুধু `http`/`https`। **SSRF বন্ধ:** hostname DNS-resolve করে প্রতিটি address
public কিনা যাচাই হয় — loopback, private (10/172.16/192.168), link-local
(169.254 = cloud metadata), CGNAT, IPv6 ULA, IPv4-mapped — সব ব্লকড, এবং
**প্রতিটি redirect hop আবার যাচাই** হয় (সর্বোচ্চ ৫)।

### ২.৫ memory tools (৫) — ✅ কিন্তু "semantic" নয়

`memory_store` `memory_recall` `memory_search` `memory_forget` `memory_list`

Tool description বলে *"semantically similar"*, কিন্তু বাস্তবায়ন **lexical
scoring** — কোনো embedding বা vector DB নেই। কাজ করে, তবে প্রতিশব্দ বোঝে না
("gari" লিখলে "car" খুঁজে পাবে না)। Provider কনফিগার না থাকলে tool গুলো
"Memory provider not configured" বলে — তাই foreground ও background **দুই
জায়গাতেই** wire করা আছে।

### ২.৬ `manage_cron` — ✅ পুরোপুরি কার্যকর

এজেন্ট নিজেই নিজের schedule বানাতে/বদলাতে পারে। আসল `db.rs` API ব্যবহার করে
(আগে আলাদা DB খুলত ও SQL injection ছিল — ঠিক করা)।

---

## ৩. Customization — কী বদলানো যায়, কী যায় না

### ৩.১ ✅ যা API দিয়ে বদলানো যায়

| জিনিস | কীভাবে |
|---|---|
| Provider / model | `sendMessage({ provider, model })` |
| System prompt | `sendMessage({ systemPrompt })` **অথবা** ৭টি `.md` ফাইল সম্পাদনা |
| Turn limit | `sendMessage({ maxTurns })` |
| **কোন tool চলবে** | `sendMessage({ allowedToolsJson: '["read_file"]' })` |
| Tool approval | `setToolPermission(name, 'always_allow'\|'always_ask'\|'always_ask_biometric')` |
| অতিরিক্ত tool | `startMcp` / `setMcpTools` / `connectMcp` |
| Cron / skill / heartbeat | `addCronJob`, `addSkill`, `setSchedulerConfig`, `setHeartbeatConfig` |
| Auth | `setAuthKey`, `exchangeOAuthCode`, `refreshToken` |

**সবচেয়ে শক্তিশালী customization হলো `.md` ফাইলগুলো** — এগুলো system prompt-এ
যুক্ত হয়, আর `write_if_missing` বলে **আপনার সম্পাদনা কখনো মুছে যায় না**।
`AGENTS.md` = নিয়ম, `SOUL.md`/`IDENTITY.md` = ব্যক্তিত্ব, `USER.md` = ব্যবহারকারী
সম্পর্কে, `TOOLS.md` = tool নির্দেশনা, `HEARTBEAT.md` = periodic কাজ।

### ৩.২ ❌ যা hardcoded (API নেই)

| মান | বর্তমান | কোথায় |
|---|---|---|
| `temperature` | **0.0** (fixed) | `agent_loop.rs:138` |
| `max_tokens` | 8192 | `DEFAULT_MAX_TOKENS` |
| ডিফল্ট max turns | 25 | `DEFAULT_MAX_TURNS` |
| Retry | 2 বার, 2s→30s backoff | `MAX_RETRIES` |
| MCP timeout | 30 s | `agent_loop.rs` |
| Command timeout | 30 s / সর্বোচ্চ 300 s | ✅ per-call `timeout_ms` আছে |
| Output cap | 50 KB | `MAX_OUTPUT_BYTES` |
| Wake budget | 8 মিনিট | `WAKE_BUDGET_MS` |
| Cron error limit | পরপর 5 | `MAX_CONSECUTIVE_ERRORS` |

**সবচেয়ে উল্লেখযোগ্য ফাঁক:** `temperature` শূন্যে স্থির — সৃজনশীল লেখার জন্য
বদলানোর কোনো উপায় নেই। এটা যোগ করতে `SendMessageParams`-এ ফিল্ড লাগবে, যা FFI
signature বদলায় (এখন CI দুই প্ল্যাটফর্মের বাইনারি rebuild করে, তাই সম্ভব)।

---

## ৪. নিরাপত্তা সারসংক্ষেপ

| নিয়ন্ত্রণ | অবস্থা |
|---|---|
| Path sandbox | ✅ fail-closed, symlink escape ব্লকড |
| SSRF | ✅ DNS + প্রতি redirect যাচাই |
| SQL injection | ✅ সব query parameterised |
| Auth ফাইল | ✅ `0600`, atomic, corrupt backup, iCloud backup থেকে বাদ |
| Auth encryption | ❌ **plaintext** (FBE/Data Protection-এর উপর নির্ভরশীল) |
| Tool approval | ✅ unknown policy → fail-closed ("ask") |

---

## ৫. এক নজরে সীমাবদ্ধতা

1. **iOS-এ `execute_command` কাজ করে না** — OS নিষেধ, workaround নেই
2. **Android-এ শুধু toybox** — git/python/node নেই
3. **memory "semantic" নয়** — lexical matching
4. **`temperature` বদলানো যায় না**
5. **MCP client আলাদা** — `connectMcp` ব্যবহার করুন (plugin নিজে MCP client নয়)
6. **auth plaintext** — OS-স্তরের encryption-এর উপর নির্ভরশীল
7. **`messages` টেবিলের retention নেই** — দীর্ঘ কথোপকথন বাড়তেই থাকবে
