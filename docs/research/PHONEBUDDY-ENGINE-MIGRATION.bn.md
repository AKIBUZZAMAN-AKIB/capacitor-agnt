# PhoneBuddy SDK-তে মাইগ্রেশন প্লান (native agent engine বদলানো)

> **কেন এই ডক:** বর্তমান agent engine (`capacitor-native-agent` → `libnative_agent_ffi.so`) একটি **private** GitLab ক্রেটের উপর নির্ভরশীল, রিপো-তে সোর্স নেই, `.gitmodules` আছে কিন্তু কোনো submodule gitlink নেই, আর শিপ করা `.so` কেবল `arm64-v8a`-র জন্য। ফলে আপনার 32-bit ফোন (`armeabi-v7a`) সহ সব budget/এমুলেটর ডিভাইসে `available:false`। এই ডক একটি **public, Apache-2.0, multi-ABI** ইঞ্জিনে যাওয়ার পুরো পরিকল্পনা দেয় — সব তথ্য ২০২৬-০৯-১৯ তারিখে যাচাই করা।

---

## ০. সংক্ষেপে সিদ্ধান্ত

| বিষয় | সিদ্ধান্ত |
|---|---|
| নতুন ইঞ্জিন | **PhoneBuddy SDK** (`APUS-AI-Lab/PhoneBuddySDK`) |
| লাইসেন্স | **Apache-2.0** (LICENSE + NOTICE রাখতে হবে) — বাণিজ্যিক/স্টোর বিল্ডের জন্য ব্যবহারযোগ্য |
| সোর্স | **পাবলিক GitHub** → কোনো secret, token বা কারও অনুমতি লাগে না |
| 32-bit ARM | `rust-toolchain.toml`-এ `armv7-linux-androideabi` **আগেই লিস্টেড**, upstream বিল্ড স্ক্রিপ্টে `--all` = `arm64-v8a x86_64 armeabi-v7a x86` |
| পিন করা ভার্সন | tag **`v0.2.0`** (HEAD `c2fc7ea`, ২০২৬-০৯-১৩) |
| ইন্টিগ্রেশন পথ | **JNA দিয়ে সরাসরি C ABI** (অ্যাপে C কোড কম্পাইল করা লাগবে না, NDK-at-app-build লাগবে না) |
| ফল | আপনার ফোনে এবং সব ABI-তে `available: true`; বিল্ড এখন **যেকোনো সময়, যে কারও দ্বারা** পুনরুৎপাদনযোগ্য |

---

## ১. যাচাই করা তথ্য (evidence)

| দাবি | যাচাই |
|---|---|
| Apache-2.0 | GitHub API `license: Apache License 2.0`; রিপোতে `LICENSE` + `NOTICE` |
| ৩২-bit ARM টার্গেট | `rust-toolchain.toml`: `aarch64-linux-android`, **`armv7-linux-androideabi`**, `i686-linux-android`, `x86_64-linux-android` |
| multi-ABI বিল্ড স্ক্রিপ্ট | `scripts/build-android-sdk.sh --all` → `arm64-v8a x86_64 armeabi-v7a x86`; আউটপুট `dist/android/jniLibs/<abi>/libphone_buddy_ffi.so` |
| 32-bit সম্ভাবনা বেশি | workspace-এ `git2`/`rusqlite`/`jemalloc`/`tree-sitter` নেই; `reqwest+rustls(ring)`, `tokio` (process feature ছাড়া), `boa_engine`, `htmd` — সবই pure Rust/ARMv7-সাপোর্টেড |
| C ABI আছে | `crates/phone-buddy-ffi/include/phone_buddy.h` (৪১২ লাইন): engine/runtime, chat, sessions, host tools, web-view callback, logging |
| Kotlin রেফারেন্স | `examples/android/NativeAgent.kt` (JNI wrapper) + `phonebuddy_jni.c` + Compose ডেমো |
| Rust ভার্সন | workspace `rust-version = 1.94` |

**পুরনো ইঞ্জিনের সাথে পার্থক্য (যা আমাদের সুবিধা):** no `std::process::Command`/`fork` (স্টোর-স্যান্ডবক্স সেফ), in-memory busybox applets, embedded JS (`boa_engine`), jailed file sandbox, SSRF-protected web fetch, doom-loop detection, context compaction, provider fallback, host LLM delegation.

---

## ২. আর্কিটেকচার: কীভাবে জুড়বে

```text
www/ + bridge/nativekit.ts          (অপরিবর্তিত API: window.NativeKit.agent.*)
        │  Capacitor
plugins/phonebuddy-agent/           (নতুন প্লাগইন — পুরনো টা আর ব্যবহার হবে না)
 ├── dist/esm/*.js|d.ts             (TS wrapper — পুরনো method নাম ধরে রাখা)
 ├── android/src/main/java/.../PhoneBuddyAgentPlugin.kt   (Capacitor @CapacitorPlugin)
 ├── android/src/main/java/.../PhoneBuddyFfi.kt           (JNA ↔ C ABI)
 └── android/src/main/jniLibs/<abi>/libphone_buddy_ffi.so (৪টি ABI — আমরা বিল্ড করি)
        │  JNA (com.sun.jna)  ← রিপোতে আগেই ডিপেন্ডেন্সি; AAR-এ armeabi-v7a আছে (যাচাই করা)
libphone_buddy_ffi.so  (PhoneBuddy SDK core, Apache-2.0)
```

**কেন JNA, upstream-এর JNI wrapper নয়?**
- upstream `NativeAgent.kt` `external fun` + `phonebuddy_jni.c` ব্যবহার করে → **অ্যাপ বিল্ডে CMake/NDK** দরকার হয়।
- JNA দিয়ে হলে অ্যাপের Kotlin কোড থেকে সরাসরি C ABI কল করা যায় → **কোনো C কম্পাইল লজিক নেই**, Capacitor প্লাগইনে অনেক পরিষ্কার, এবং JNA-র `libjnidispatch.so` সব ABI-তে আছে (ক্যাপাসিটর রিপোতে যাচাই করা: `x86/x86_64/armeabi-v7a/armeabi/arm64-v8a`).
- বিকল্প (চাইলে): upstream wrapper + CMake — আরও "official", কিন্তু প্রতিটি অ্যাপ বিল্ডে NDK লাগবে।

---

## ৩. API ম্যাপিং (পুরনো → নতুন)

পুরনো প্লাগইনের বাইরের চুক্তি (`plugins/native-agent/dist/esm/definitions.d.ts`) অপরিবর্তিত রেখে ভেতরে নতুন ইঞ্জিন বসানো হবে — তখন `bridge/nativekit.ts` ও `www/agent-lab.js`-এ সামান্য পরিবর্তনই লাগে।

| পুরনো API (NativeKit.agent) | PhoneBuddy C ABI | মন্তব্য |
|---|---|---|
| `checkAvailability()` | `pb_version()`, `pb_capabilities()` + `Native.load("phone_buddy_ffi")` | একই রিটার্ন শেপ (`abi`, `is64Bit`, `available`, `reason`) রাখলে `agent-lab.js` সেই রকমই দেখাবে |
| `initialize({dbPath, workspacePath, authProfilesPath, defaultProvider, defaultModel})` | `pb_runtime_new(routingJson, rootDir, err)` → `pb_engine_new_with_runtime(runtime, configJson, err)` | session/db হ্যান্ডলিং upstream নিজেই করে; `rootDir` = `workspacePath` |
| `setAuthKey/provider config` | routing/engine config JSON (`apiKey`, `baseUrl`, `model`, `apiBackend`: `chat_completions`\|`responses`\|`messages`) | provider mapping টেবিল বানাতে হবে (docs: `docs/llm-routing-and-one-shot-design.md`, `docs/client_profiles.md`) |
| `sendMessage({sessionId, text})` + event `text_delta/tool_use/tool_result/…` | `pb_engine_chat_v2(engine, sessionId, userInput, cb, userData)` → `PbEventCallback(event_json)` | ইভেন্ট JSON → পুরনো ইভেন্ট শেপে রূপান্তর (নিচে ৩.১) |
| `abort({sessionId})` | `pb_engine_cancel(engine, sessionId)` | ১:১ |
| `listSessions()`, `getSession(id)`, `deleteSession(id)` | `pb_engine_list_sessions`, `pb_engine_get_session`, `pb_engine_delete_session` | ১:১ |
| cron / heartbeat / skills | engine-এর `scheduler` টুল + আমাদের `NativeAgentJobService`-এর মতো `JobService` | কাজ: background entry point পুনর্লিখন |
| background execution | একই `JobService`, engine config SharedPreferences-এ সেভ/রিস্টোর | পুরনো আর্কিটেকচার কপি করা যায় |
| tools (file/git/grep/shell/fetch) | `read_file`, `write_file`, `edit_file`, `list_dir`, `grep` + in-memory busybox + `run_script` (JS) + `web_search`/`web_fetch` | ⚠️ **`git` টুল নেই**, real shell নেই → প্রম্পট/স্কিল আপডেট লাগবে |
| host-side tools (alarm, notification ইত্যাদি) | `pb_engine_set_host_tools(toolsJson)` + `pb_engine_host_tool_result(...)` | Capacitor side-এ alarm/share/notification expose করা যাবে |
| Memory/LanceDB | নেই | বাদ, বা host tool দিয়ে রাখা |
| `pb_string_free(ptr)` | সব `char*` রিটার্নের জন্য | মেমরি লিক এড়াতে বাধ্যতামূলক |

### ৩.১ ইভেন্ট রূপান্তর (একটি টেবিল বানিয়ে রাখুন)

PhoneBuddy `PbEventCallback`-এ JSON envelope পাঠায় (turn শুরু, টেক্সট ডেল্টা, টুল কল, টুল ফলাফল, সমাপ্তি, ত্রুটি)। Capacitor-এর `addListener('nativeAgentEvent', …)`-এ আপনার অ্যাপ যে শেপ খোঁজে সেটাই emit করুন — `{ eventType, payloadJson }`। শুরুতে **raw JSON দুটোই `console.log` করে** ম্যাপিং টেবিল স্থির করুন, তারপর রূপান্তর লিখুন। এটি এক দিনের কাজ ও সবচেয়ে কম-রিস্ক উপায় (map ভুল হলে থেরাপি করার সহজ উপায় থাকে)।

---

## ৪. কোড স্কেচ (শুরু করার জন্য)

### ৪.১ JNA ↔ C ABI (`PhoneBuddyFfi.kt` — ন্যূনতম)

```kotlin
package dev.nativekit.phonebuddy

import com.sun.jna.*
import com.sun.jna.ptr.PointerByReference

const val LIB = "phone_buddy_ffi"

interface PbEventCallback : Callback { fun invoke(eventJson: String, userData: Pointer?) }
interface PbLogCallback   : Callback { fun invoke(level: Int, target: String?, message: String?) }

/** phone_buddy.h থেকে হাতে ম্যাপ করা — শুধু যেটুকু লাগে। */
interface PhoneBuddyLib : Library {
    fun pb_version(): Pointer
    fun pb_capabilities(): Pointer
    fun pb_string_free(p: Pointer)

    fun pb_runtime_new(routingConfigJson: String?, rootDir: String?, errOut: PointerByReference): Pointer?
    fun pb_runtime_free(runtime: Pointer?)
    fun pb_engine_new_with_runtime(runtime: Pointer?, configJson: String?, errOut: PointerByReference): Pointer?
    fun pb_engine_free(engine: Pointer?)

    fun pb_engine_chat_v2(engine: Pointer?, sessionId: String?, userInput: String?,
                          cb: PbEventCallback?, userData: Pointer?): Pointer?
    fun pb_engine_cancel(engine: Pointer?, sessionId: String?)
    fun pb_engine_list_sessions(engine: Pointer?, errOut: PointerByReference): Pointer?
    fun pb_engine_get_session(engine: Pointer?, sessionId: String?, errOut: PointerByReference): Pointer?
    fun pb_engine_delete_session(engine: Pointer?, sessionId: String?): Int
    fun pb_engine_set_host_tools(engine: Pointer?, toolsJson: String?, errOut: PointerByReference): Int
    fun pb_engine_host_tool_result(engine: Pointer?, callId: String?, ok: Int, output: String?): Int
    fun pb_engine_set_agent_name(engine: Pointer?, name: String?)
    fun pb_engine_set_system_prompt_extra(engine: Pointer?, extra: String?)
    fun pb_init_logging(cb: PbLogCallback?, minLevel: Int)

    companion object {
        /** ABI probe: lib না থাকলে UnsatisfiedLinkError — অবশ্যই Throwable ধরুন। */
        val INSTANCE: PhoneBuddyLib? by lazy {
            runCatching {
                Native.load(LIB, PhoneBuddyLib::class.java, mapOf(Library.OPTION_STRING_ENCODING to "UTF-8"))
            }.getOrNull()
        }
        fun version(): String? = INSTANCE?.let { it.pb_version().getString(0) }   // UTF-8 Pointer → String
    }
}
```

যা মনে রাখবেন: (ক) প্রতিটি কল `catch (t: Throwable)`-এ মুড়ে JS reject করান (আগের প্লাগইনের C1 বাগ থেকে শিক্ষা); (খ) রিটার্ন করা `char*` শেষে `pb_string_free` করুন; (গ) callback thread native → JS-এ পাঠানোর আগে main-thread-এ মার্শাল করুন (Capacitor `bridge.getActivity()`/`Handler`); (ঘ) `pb_version()`/`pb_capabilities()` দিয়ে প্রথমেই smoke test।

### ৪.২ Capacitor প্লাগইন হাড়গোড়

```kotlin
@CapacitorPlugin(name = "PhoneBuddyAgent")
class PhoneBuddyAgentPlugin : Plugin() {
    @PluginMethod fun checkAvailability(call: PluginCall) { /* abi, is64Bit, available, reason */ }
    @PluginMethod fun initialize(call: PluginCall) { /* routing+engine config JSON তৈরি → runtime+engine */ }
    @PluginMethod fun sendMessage(call: PluginCall) { /* pb_engine_chat_v2 + event pump → notifyListeners */ }
    @PluginMethod fun abort(call: PluginCall) { /* pb_engine_cancel */ }
    @PluginMethod fun listSessions(call: PluginCall) { }
    @PluginMethod fun getSession(call: PluginCall) { }
    @PluginMethod fun deleteSession(call: PluginCall) { }
    @PluginMethod fun setHostTools(call: PluginCall) { }
    override fun handleOnDestroy() { /* pb_engine_free + pb_runtime_free */ }
}
```

`checkAvailability()` বাস্তবায়ন (এটাই আসল "সব ডিভাইসে চলবে কি না" সূচক):

```kotlin
val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
val ok = PhoneBuddyFfi.INSTANCE != null && runCatching { PhoneBuddyFfi.version() }.isSuccess
// available=ok, reason = ok?"" : "libphone_buddy_ffi.so could not be loaded on ABI '$abi'"
```

---

## ৫. কাজের ভাঙন (WBS) ও সময়

| ফেজ | কাজ | সময় (একজন ডেভ) | ঝুঁকি |
|---|---|---|---|
| **P0** | `tools/agent-ffi/build-phonebuddy-all-abis.sh` + CI দিয়ে ৪ ABI `.so` বিল্ড ও যাচাই (অ্যাপের কোড ছোঁয়া হয় না) | ৩০–৬০ মিন | কম |
| **P1** | `PhoneBuddyFfi.kt` JNA ম্যাপিং + `pb_version/pb_capabilities` smoke + `checkAvailability` | ১–২ দিন | মাঝারি (header↔JNA ভুল হলে crash — তাই stepped smoke test) |
| **P2** | প্লাগইন core: initialize/chat/cancel/sessions + ইভেন্ট পাম্প + TS wrapper (পুরনো method নাম) | ২–৪ দিন | মাঝারি |
| **P3** | `bridge/nativekit.ts`, `www/agent-lab.js`, `app.config.json`, docs, tests আপডেট + পুরনো প্লাগইন feature-flag করে পাশে রাখা | ১–২ দিন | কম |
| **P4** | Background (`JobService`) + notifications + host tools (alarm/share) bridge | ১–২ দিন | মাঝারি |
| **P5** | iOS (upstream Swift SDK + `scripts/build-ios-sdk.sh`) | ২–৩ দিন | মাঝারি |

**মোট (Android, টেস্টিং সহ):** ≈ ১ সপ্তাহ; iOS আলাদা।

---

## ৬. ঝুঁকি ও সতর্কতা

1. **`panic` profile** — upstream workspace-এ `[profile.release] panic = "abort"`। কিন্তু engine-এর C লেয়ার `catch_unwind` দিয়ে প্যানিক ধরে JS error বানানোর কথা বলে; `abort` থাকলে আগে একটি প্যানিক পুরো অ্যাপ মেরে ফেলবে। তাই আমাদের বিল্ড স্ক্রিপ্ট ডিফল্টে `--config profile.release.panic="unwind"` ব্যবহার করে (`--panic upstream` দিলে upstream-এর সেটিংই থাকবে)।
2. **ভার্সন churn** — SDK এখন `v0.2.0`, খুব নতুন। তাই: tag পিন (`--ref v0.2.0`), এবং `--vendor` দিয়ে সোর্স `third_party/PhoneBuddySDK`-তে রাখা → অফলাইন, reproducible বিল্ড; আপগ্রেড আলাদা PR-এ।
3. **`sccache` / `.cargo/config.toml`** — upstream config-এ `rustc-wrapper = "sccache"`; না থাকলে বিল্ড ফেল করে। আমাদের স্ক্রিপ্ট নিজেই shim বসায়, CI-তে `sccache` প্যাকেজ ইনস্টল হয়।
4. **টুল মডেল বদলাবে** — `git` এবং real shell থাকবে না (in-memory busybox + JS + jailed files)। এজেন্ট প্রম্পট/স্কিল/ডক্স আপডেট করুন; app-store দিক থেকে এটি **উন্নতি** (no subprocess, no fork)।
5. **Web search** — host WebView লাগে (`enableSystemWebView(context)` / `pb_engine_set_webview_callback`); Android-এ `WebView` ইনিশিয়ালাইজ করা আমাদেরই দায়িত্ব।
6. **প্রোভাইডার** — `chat_completions`/`messages`/`responses` সাপোর্টেড → OpenAI/Anthropic/xAI-সদৃশ endpoint চলবে; OAuth রিফ্রেশ-ফ্লো নিজেদের লিখতে হবে (API key সহজ পথ)।
7. **লাইসেন্স** — Apache-2.0: `LICENSE` + `NOTICE` রাখুন; `third_party/`-তে ভেন্ডর করলে NOTICE অটুট রাখুন এবং অ্যাপের "Open source licenses" স্ক্রিনে যোগ করুন।
8. **JNA ম্যাপিং** — হাতে লেখা, তাই V1-এ শুধু কয়েকটি কল; প্রতিটি কলের পরে `err_out` চেক; সব `Throwable` ধরা; মেমরি ফ্রি নিশ্চিত।
9. **32-bit পারফরম্যান্স** — armv7-এ CPU দুর্বল; বড় কনটেক্সট/ভারী টুল ধীর হবে (তবে streaming থাকায় UX ঠিক থাকে)। `--jobs 1` দিয়ে বিল্ড করুন মেমরি কম হলে।
10. **পুরনো প্লাগইন** — একবারে মুছবেন না। `app.config.json`-এ `features.agentEngine: "phonebuddy" \| "legacy"` রেখে ধাপে ধাপে সরান; কোনো ডিভাইসে সমস্যা হলে দ্রুত ফিরতে পারবেন।

---

## ৭. টেস্ট প্ল্যান

- **CI (প্রতিটি বিল্ডে):** `verify-abis.sh --require-lib libphone_buddy_ffi.so --strict` (৪ ABI), `elfcheck.py` symbol/ABI/16 KB check, APK-এর ভেতরে assertion।
- **ডিভাইস (৩২-bit ফোন — আপনার টার্গেট):** ইনস্টল → `checkAvailability()` = `available:true, abi:"armeabi-v7a"` → ছোট একটা চ্যাট (সস্তা মডেল) → `text_delta` স্ট্রিম agent-lab-এ দেখা → `abort` → session list/get/delete → অ্যাপ ব্যাকগ্রাউন্ডে JobService ট্রিগার।
- **ডিভাইস (arm64 ফোন + এমুলেটর):** একই স্ক্রিপ্ট — রিগ্রেশন আটকাতে।
- **নেগেটিভ:** ফ্লাইট-মোডে চ্যাট (এরর হ্যান্ডলিং), ভুল API key, বিশাল ডিরেক্টরি grep, cancel mid-stream।

---

## ৮. চেকলিস্ট

- [ ] `tools/agent-ffi/build-phonebuddy-all-abis.sh --vendor` চালিয়ে ৪টি `.so` + `abi-manifest.json`
- [ ] `verify-abis.sh --require-lib libphone_buddy_ffi.so --strict` পাস (jniLibs + APK)
- [ ] `.github/workflows/phonebuddy-ffi.yml` একবার `workflow_dispatch` চালিয়ে artifact নিশ্চিত
- [ ] `PhoneBuddyFfi.kt` — `pb_version()` smoke ৩২-bit ডিভাইসে পাস
- [ ] `checkAvailability()` নতুন প্লাগইনে `available:true`
- [ ] ইভেন্ট ম্যাপিং টেবিল + রূপান্তর; `agent-lab.js` আগের মতোই স্ট্রিম দেখায়
- [ ] `app.config.json` engine flag; পুরনো প্লাগইন নিষ্ক্রিয় কিন্তু উপস্থিত
- [ ] Background + notifications + host tools
- [ ] LICENSE/NOTICE + attribution স্ক্রিন
- [ ] `docs/`-এ নতুন engine-এর জন্য API রেফারেন্স আপডেট

---

## ৯. সম্পর্কিত ফাইল

- `tools/agent-ffi/README.bn.md` — ABI বিল্ড/ভেরিফাই টুলকিটের মূল গাইড
- `tools/agent-ffi/build-phonebuddy-all-abis.sh` — এই ইঞ্জিনের ৪-ABI বিল্ডার
- `.github/workflows/phonebuddy-ffi.yml` — CI (public source, কোনো secret নেই)
- `.github/workflows/native-agent-ffi.yml` — পুরনো (private) ইঞ্জিনের জন্য বিল্ড পাইপলাইন (ভেন্ডর করা সোর্স থাকলে কাজ করবে)
