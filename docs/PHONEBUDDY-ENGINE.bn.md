# PhoneBuddy ইঞ্জিন — background wake ও surfaced message (বাংলা)

> **কেন এই ডকুমেন্ট:** pinned `capacitor-native-agent` 0.5.2 generation-এ দুটো আধুনিক সুবিধা নেই —
> *OS-level background wake* (`scheduleBackgroundWakes`) আর *surfaced message*
> (`loadSurfacedMessages`)। আগে bridge-এ ওগুলোর জায়গায় সৎ কিন্তু অচল `{supported:false}`
> envelope ছিল। এখন ওগুলো **আসলেই কাজ করে** — public Apache-2.0 **PhoneBuddy SDK**
> (`v0.2.0`) দিয়ে, যা ৪টি Android ABI-তেই নিজেরাই build করা যায় (আপনার 32-bit
> `armeabi-v7a` ফোনসহ), কোনো private repo বা prebuilt `.so` ছাড়া।

সংশ্লিষ্ট ফাইল: `plugins/phonebuddy-agent/`, `bridge/nativekit.ts`, `app.config.json`,
`tools/agent-ffi/build-phonebuddy-*.sh`, `.github/workflows/phonebuddy-{ffi,ios}.yml`।

---

## ১. কেন আলাদা ইঞ্জিন?

| দরকার | 0.5.2 (agent plugin) | PhoneBuddy engine |
| --- | --- | --- |
| LLM turn, tool call, session, cron | ✅ (44টি API) | ✅ (chat/chat_v2/session) |
| OS-level wake scheduler | ❌ নেই | ✅ host-এর কাজ — আমরা JobScheduler/BGTask লিখেছি |
| Surfaced message store | ❌ নেই | ✅ `surfaced.json` (দুই প্ল্যাটফর্মে একই JSON) |
| সোর্স public? | ✅ tag `v0.5.2`-এ পুরো crate | ✅ tag `v0.2.0`, Apache-2.0 |
| সব ABI-তে build? | ✅ ৪টি ABI | ✅ ৪টি ABI (`armeabi-v7a` = 6.8 MB) |

তাই **দুই ইঞ্জিন পাশাপাশি** থাকে: বাকি ৪৪টি API আগের মতোই `capacitor-native-agent`
দেয়, আর wake + surfaced দেয় `@nativekit/phonebuddy-agent`। bridge-এর
`phoneBuddyCall()` একমাত্র জায়গা যেখানে PhoneBuddy plugin-এর সাথে কথা হয়।

---

## ২. স্থাপত্য (কে কী করে)

```
JS/TS  ── NativeKit.agent.scheduleBackgroundWakes()
           │
           ├─ (bridge/nativekit.ts) phoneBuddyCall(...)  ← fallback: supported:false + reason
           ▼
Android:  PhoneBuddyAgentPlugin (Kotlin, Capacitor name = "PhoneBuddyAgent")
           ├─ PhoneBuddyFfi.kt      → JNA 5.14.0 → libphone_buddy_ffi.so (Rust)
           ├─ PhoneBuddyStore.kt    → SharedPreferences: engine config + interval + job flag
           ├─ PhoneBuddySchedule.kt → JobScheduler (jobId 4871, min ১৫ মিনিট)
           ├─ PhoneBuddyWakeService.kt → JobService (worker thread, ঠিক একবার jobFinished)
           ├─ PhoneBuddyWakeRunner.kt  → ইঞ্জিন headless rebuild → scheduler.json task চালায়
           └─ PhoneBuddySurfaced.kt → surfaced.json (সর্বোচ্চ 500টি, পুরোনো বাদ)

iOS:      PhoneBuddyAgentPlugin.swift (Capacitor name = "PhoneBuddyAgent")
           ├─ PhoneBuddyBackgroundTask.swift → BGTaskScheduler + BGTaskSchedulerPermittedIdentifiers
           ├─ PhoneBuddySurfacedStore.swift  → একই surfaced.json ফরম্যাট, একই 500-সীমা
           └─ phone_buddy_ffi (SwiftPM C shim) → PhoneBuddyFFI.xcframework (CI-তে build করা)
```

ইঞ্জিন নিজে থেকে জাগে না — SDK-র নিজের ভাষায়: `scheduler` tool কাজগুলো
`scheduler.json`-এ লিখে রাখে এবং host-কে `scheduler_registered` **host event** পাঠায়;
ঘড়ি ধরে জাগানো **host-এর দায়িত্ব**। তাই ওই প্লাম্বিং আমরা লিখেছি, আর host event-গুলো
`scheduler_registered` / `scheduler_cancelled` / `notification_send` /
`notification_schedule` / `monitor` — এগুলো *fire-and-forget*, এর উত্তর
`pb_engine_host_tool_result` দিয়ে দেওয়া **যাবে না** (protocol error)।

---

## ৩. একটা wake-এ ঠিক কী হয় (Android)

1. JobScheduler `PhoneBuddyWakeService` চালু করে (app চালু না থাকলেও)।
2. আলাদা thread-এ `PhoneBuddyWakeRunner.run()`:
   * `PhoneBuddyStore` থেকে সংরক্ষিত EngineConfig পড়ে → `pb_engine_new()` দিয়ে
     ইঞ্জিন আবার তৈরি করে (process মরে গেলে আর কিছু টেকে না, তাই config আগেই সেভ করা);
   * `pb_engine_set_host_tools()` → `pb_engine_set_host_callbacks()` (host event ধরার জন্য);
   * `<rootDir>/scheduler.json`-এ `status: scheduled` যে task গুলো আছে, প্রতিটির
     `prompt` দিয়ে `pb_engine_chat(session = "sched-<id>")`;
   * ফলাফল → নোটিফিকেশন (`phonebuddy_agent` channel) **এবং** `surfaced.json`-এ নতুন record;
   * task-টিকে `completed` করে `scheduler.json` আবার লেখা হয় (ওটা ইঞ্জিনের নিজের ফাইল);
   * শেষে `pb_engine_free()` — `finally` ব্লকে, ব্যর্থ হলেও।
3. `jobFinished(params, false)`; `onStopJob` → `true` (OS CPU ফিরিয়ে নিলে আবার চেষ্টা করবে)।
4. telemetry: `lastWakeAt`, `lastWakeSource`, `lastWakeSummary`, `pendingTasks`
   → `getWakeStatus()`-এ ফেরত আসে।

iOS-এ একই ধারা, শুধু wake আসে `BGProcessingTask` থেকে (`io.t6x.phonebuddy.wake`)।

> **সততা:** Android periodic job-এর সর্বনিম্ন ব্যবধান ১৫ মিনিট — তাই API
> *অনুমোদিত* interval (jobScheduled/intervalMinutes) ফেরত দেয়, চাওয়া সংখ্যাটা নয়।
> Doze/battery-saver থাকলে OS পরে চালাতে পারে; এটা Android-এর নিয়ম, আমরা
> নোটিফিকেশনে মিথ্যা "সময়মতো চলেছে" দাবি করি না।

---

## ৪. JS API (bridge)

| API | প্রকৃত রিটার্ন | ব্যর্থ হলে |
| --- | --- | --- |
| `agent.scheduleBackgroundWakes(min)` | `{supported:true, jobScheduled, intervalMinutes, nextRunApproxMs?, engineGeneration}` | `{supported:false, reason, alternative}` |
| `agent.cancelBackgroundWakes()` | `{supported:true, jobScheduled:false, jobCancelled}` | `{supported:false, reason}` |
| `agent.getWakeStatus()` | `{supported:true, jobScheduled, intervalMinutes, lastWakeAt, lastWakeSource, lastWakeSummary, pendingTasks}` | `{supported:false, reason}` |
| `agent.loadSurfacedMessages(limit)` | `{supported:true, messagesJson, count, unread}` | `{supported:false, messagesJson:'[]', reason}` |
| `agent.clearSurfacedMessages()` | `{supported:true, cleared}` | `{supported:false, reason}` |
| `agent.phonebuddy.checkAvailability()` | `{available:true, abi, is64Bit, version}` | `{available:false, reason}` (throw করে **না**) |
| `agent.phonebuddy.initialize({...})` | `{initialized, rootDir, model, defaultsApplied}` | `{supported:false, reason}` |
| `agent.phonebuddy.sendMessage({text})` | `{sessionId, finalText, turnsUsed, resultJson}` | `{supported:false, reason}` |
| `agent.phonebuddy.handleWake('manual')` | `{ran, summary, failures}` — এখনই due task চালায় | `{supported:false, ran:0, reason}` |
| `agent.phonebuddy.onEvent(fn)` | `{remove()}` — `TextDelta`/`ToolCallStart`/`Completed` … স্ট্রিম | — |

কোনো শাখাতেই reject হয় না (web build, অসমর্থিত ABI, feature off — সব ক্ষেত্রেই
`supported:false` + কারণ)। একমাত্র ব্যতিক্রম: ইঞ্জিন موجود কিন্তু কাজ ফেল করলে সেই
ব্যর্থতা `{supported:true, jobScheduled:false, reason}` হিসেবে আসে — অর্থাৎ
`supported` মানে *ইঞ্জিন আছে*, সফলতা বোঝায় না।

`app.config.json`:

```json
"phonebuddy": {
  "enabled": true,
  "wakeIntervalMinutes": 30,
  "surfacedLimit": 50,
  "markSurfacedRead": true,
  "notifyOnWake": true,
  "maxTurns": 8,
  "minIntervalMinutes": 15
}
```

`wakeIntervalMinutes` সর্বনিম্ন ১৫-এ clamp হয়, `surfacedLimit` সর্বোচ্চ ৫০০-এ।

---

## ৫. ডিভাইস ও নির্ভরতা (আপনার ফোনসহ)

| ABI | `libphone_buddy_ffi.so` | অবস্থা |
| --- | --- | --- |
| `arm64-v8a` | ১০.৭ MB | ✅ |
| **`armeabi-v7a`** (আপনার 32-bit ফোন) | ৬.৮ MB | ✅ |
| `x86` | ১২.০ MB | ✅ |
| `x86_64` | ১২.৩ MB | ✅ |

APK-তে ইঞ্জিন ঢুকেই যায় — ব্যবহারকারীর কিছু install করার নেই। Android 7.0+
(`minSdk 24`)। iOS-এ arm64 device + arm64 simulator (x86_64 sim slice নেই)।

---

## ৬. নিজে rebuild করার নিয়ম (কোনো private repo নয়)

**Android (.so, ৪টি ABI):**

```bash
npm run ffi:build:phonebuddy            # tools/agent-ffi/build-phonebuddy-all-abis.sh
npm run ffi:verify:phonebuddy           # প্রতিটি ABI-তে lib যাচাই
```
স্ক্রিপ্টটি public `github.com/APUS-AI-Lab/PhoneBuddySDK`-এর tag `v0.2.0` clone করে
(`.ffi-cache/`), NDK clang দিয়ে চারটি target build করে, তারপর
`plugins/phonebuddy-agent/android/src/main/jniLibs/<abi>/`-তে slice + sha256 manifest লেখে।
CI-তে: **Actions → PhoneBuddy FFI → Run workflow** (`abis`, `vendor_source`, `build_apk`)।

**iOS (xcframework):**

```bash
# macOS + Xcode লাগবে
bash tools/agent-ffi/build-phonebuddy-ios-xcframework.sh
```
স্ক্রিপ্টটি একই সোর্স build করে, cbindgen header পুনরায় তৈরি করে এবং
`native/include/phone_buddy.h`-এর সাথে **byte-identical** না হলে build ফেল করায়
(নইলে repo আর binary ভিন্ন ABI বর্ণনা করত), তারপর
`plugins/phonebuddy-agent/ios/Frameworks/PhoneBuddyFFI.xcframework` বানায় ও
`tools/agent-ffi/machocheck.py` দিয়ে যাচাই করে: committed header-এ ঘোষিত **সব**
`pb_*` function প্রতিটি slice-এ *defined* আছে কি না (শুধু-উল্লেখ `U` entry কখনো
export হিসেবে গোনা হয় না), slice-এর header একই ABI বর্ণনা করে কি না,
`module.modulemap` আছে কি না, আর `MinimumOSVersion` (থাকলে) 15.0 কি না।
যাচাইয়ে কোনো পাইপ নেই (`nm | grep -q` + `set -o pipefail` মিলে সত্যিকারের
library-কেও "symbol নেই" বলে ভুল করত) এবং `nm` কীভাবে রেজলভ হয় সেটাও স্পষ্ট।

> **টুলচেইন শর্ত:** rustc যে LLVM দিয়ে object বানায় তার চেয়ে পুরনো `nm` হলে
> সেটি archive-টাই পড়তে পারে না — Xcode 15.4 (LLVM 15) Rust 1.94 (LLVM 21)
> অবজেক্টে `Unknown attribute kind (86)` দেয়। তাই CI runner `macos-26`
> (Clang/LLVM 21), যা অ্যাপ link করা Xcode 26-এর সাথে মেলে। দরকার হলে
> machocheck.py নিজেই Rust toolchain-এর `llvm-nm`-এ fallback করে
> (`rustup component add llvm-tools-preview`)।

CI-তে: **Actions → PhoneBuddy FFI — iOS xcframework → Run workflow** — শেষে
xcframework নিজেই `main`-এ commit হয় (এখন কমিট করা অবস্থায় আছে: arm64 device +
arm64 simulator slice, প্রতিটিতে 21/21 C-ABI symbol যাচাই করা)।
মনে রাখুন: `GITHUB_TOKEN` দিয়ে করা ওই commit নতুন workflow run ট্রিগার করে না —
xcframework বসার পর iOS build যাচাই করতে হলে **Actions → iOS validation and IPA →
Run workflow** (`create_ipa` = false) চালান।

---

## ৭. যাচাই (এখন কী প্রমাণিত)

```bash
npm run check          # 181 test (এর 32টি নতুন: tests/phonebuddy-api.test.ts)
npm run check:abis     # ৪টি ABI-তেই সব প্রয়োজনীয় native lib
```

`tests/phonebuddy-api.test.ts` নিজেই দাবিগুলো ধরে রাখে:

* Kotlin / Swift / TS — তিন জায়গায় **একই method list**;
* দুটি binding-ই শুধু `phone_buddy.h`-এ ঘোষিত `pb_*` symbol ডাকে;
* jniLibs-এর প্রতি slice-এর **sha256 manifest-এর সাথে মেলে** (বাসি `.so` ধরা পড়বে);
* JobService ঠিক একবার `jobFinished` ডাকে, `setPersisted(true)` নেই
  (তাই `RECEIVE_BOOT_COMPLETED`-এর মিথ্যা প্রতিশ্রুতিও নেই);
* iOS `BGTaskScheduler`-এর আসল API ব্যবহার করে এবং identifier-টি ঠিক যেটা
  `scripts/configure-native.mjs` Info.plist-এ whitelist করে;
* bridge-এর shim গুলো সত্যিই PhoneBuddy-কে ডাকে **এবং** ব্যর্থতায়
  `supported:false` + কারণ রাখে (fake success নয়, reject নয়)।

---

## ৮. সীমাবদ্ধতা (লুকানো নেই)

1. **iOS-এ ইঞ্জিন আসে CI-তে build করা framework দিয়ে।** ওই workflow একবার চলার আগে
   iOS-এ `available:false` + কারণ দেখাবে (Swift-এর `#else` অংশ) — মিথ্যা সফলতা নয়।
   Android-এ এই সীমা নেই: `.so` repo-তেই আছে।
2. wake চালাতে অন্তত একবার `initialize()` লাগে (config সেভ হওয়া চাই), নইলে wake
   "engine was never initialised" বলে সৎভাবে ফিরে আসে।
3. ফোনের ঘুম/Doze, iOS-এর BGTask বাজেট — OS সময় নির্ধারণ করে; ১৫ মিনিট চাওয়া মানে
   ১৫ মিনিটে চলবে এমন গ্যারান্টি নয়।
4. Notification permission (Android 13+) না দিলে ফলাফল `surfaced.json`-এ থাকবে,
   নোটিফিকেশন দেখাবে না।
5. LLM খরচ/নেটওয়ার্ক: ইঞ্জিন `api_key` + `base_url` ছাড়া turn চালাতে পারে না
   (SDK-র `LlmMode::Host` দিয়ে অ্যাপ নিজে transport হওয়াও সম্ভব, সেটি ভবিষ্যতের কাজ)।
6. রিবুটের পর নিজে নিজে wake চালু হবে না — `setPersisted(true)` ব্যবহার করিনি
   (boot receiver লিখিনি, তাই সেটা দাবি করাও ঠিক নয়)। অ্যাপ আবার চালু হলে job
   স্বাভাবিকভাবেই armed থাকে।
