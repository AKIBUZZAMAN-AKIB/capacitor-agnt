# FFI সোর্স কি সত্যিই পাওয়া যায়? — গভীর খোঁজের রিপোর্ট

**তারিখ:** ২০২৬-০৯-১৯ · **লক্ষ্য:** `libnative_agent_ffi.so` এর Rust সোর্স (v0.9.x) পাবলিক কোথাও পাওয়া যায় কি না, আর না পেলে Actions-এর ভেতর থেকে সব ABI বিল্ড করার সবচেয়ে ভালো উপায় কী।

---

## ১. ফলাফল এক নজরে

| # | যে জায়গায় খুঁজেছি | ফল |
|---|---|---|
| 1 | আপনার নিজের রিপোর পুরো ইতিহাস (`git rev-list --all`) | `rust/native-agent-ffi/` **কোনো দিনও commit হয়নি**; jniLibs-এ একমাত্র entry `arm64-v8a/libnative_agent_ffi.so` |
| 2 | আপনার দ্বিতীয় রিপো `akibuzzaman999/Capacitor` | `plugins/native-agent` নেই |
| 3 | GitHub repo search (`native_agent_ffi`, `libnative_agent_ffi`, `capacitor-native-agent`, `native-agent-ffi`) | `libnative_agent_ffi` → **0 টা রিপো**; অন্যগুলোতে শুধু আপনার রিপো, upstream প্লাগইন, আর সম্পর্কহীন প্রজেক্ট |
| 4 | `rogelioRuiz/capacitor-native-agent` — **forks: 0**, releases: 0, সব tag (`v0.5.2 … v0.9.13`) | প্রতিটি tag-এ `rust/native-agent-ffi` = **submodule pointer** → private GitLab; ব্যতিক্রম **`v0.5.2`** |
| 5 | private GitLab (`gitlab.k8s.t6x.io`) anonymous + public API | anonymous clone → credential চায়; `projects?search=native-agent-ffi` → `[]` (কোনো পাবলিক প্রজেক্ট নেই) |
| 6 | Software Heritage archive (origin search) | `native-agent-ffi` → `[]`; `t6x` → শুধু অন্য কিছু; **কোনো snapshot নেই** |
| 7 | npm registry (সব ভার্সনের tarball) | `capacitor-native-agent@0.5.2` ও `0.9.16` — দুটোতেই **শুধু `android/src/main/jniLibs/arm64-v8a/libnative_agent_ffi.so`**, `rust/` নেই |
| 8 | crates.io (`native-agent-ffi`) | **0 টা ক্রেট** — কখনো পাবলিশ হয়নি |
| 9 | Wayback Machine | `gitlab.k8s.t6x.io/rruiz/native-agent-ffi` → **কোনো স্ন্যাপশট নেই** |

**সিদ্ধান্ত:** v0.9.x সোর্স **পাবলিক কোথাও নেই**। যার মানে: ০.৯.x-এর জন্য সোর্স আসতে হবে কারও কাছ থেকে (source drop / release asset)। এটাই #1 প্লান।

**কিন্তু** — ৫ নম্বর সারির ব্যতিক্রমটা বড় খবর 👇

---

## 2. বড় আবিষ্কার: `v0.5.2` tag-এ সোর্স **সম্পূর্ণ পাবলিক**

`rogelioRuiz/capacitor-native-agent` রিপোতে **`v0.5.2`** tag-এ Rust ক্রেটটা repo-তেই commit করা আছে (submodule নয়):

```text
rust/native-agent-ffi/
├── Cargo.toml (native-agent-ffi 0.1.0, [lib] name = native_agent_ffi)   ← ঠিক যে নামটা Kotlin লোড করে
├── Cargo.lock (uniffi 0.28.3 pinned)
├── .cargo/config.toml
├── build.rs, uniffi-bindgen.rs
└── src/ agent_loop.rs db.rs event_bus.rs lib.rs llm_driver.rs tool_runner.rs types.rs workspace.rs auth.rs config_store.rs
        (মোট ~244 KB Rust সোর্স)
```

- **লাইসেন্স:** ওই রিপোর `LICENSE` = **MIT** (Copyright (c) 2025 Techxagon) → মোবাইল অ্যাপ/স্টোর বিল্ডে ব্যবহারযোগ্য, শুধু copyright notice রাখতে হবে।
- **যাচাই করেছি:** এই সোর্স `resolve-ffi-source.sh --mode public-upstream --ref v0.5.2` দিয়ে আসলে ডাউনলোড হয় এবং ভেন্ডর হয় (১৫টি ফাইল, SHA-256 ম্যানিফেস্ট সহ)।
- **সীমা:** `v0.9.0` থেকে উপরের দিকে ক্রেটটা submodule হয়ে গেছে → ওই দিকের কোনো সোর্স নেই।

### 2.1 কিন্তু একটা রাশিফল-হিসাব আছে: UniFFI contract

`.so` আর Kotlin binding-এর মধ্যে **contract version** মিলতে হয় (`uniffiCheckContractApiVersion`)। যাচাই করা সংখ্যাগুলো:

| সোর্স | uniffi | contract version | আপনার রিপোর committed Kotlin binding |
|---|---|---|---|
| public `v0.5.2` ক্রেট | 0.28.3 | **26** | চায় **30** ❌ |
| আপনার প্লাগইন (0.9.14) | 0.30.x | 30 | — ✅ |
| public রিপোর `v0.5.2` **প্লাগইন code** | 0.28.3 | 26 | এর নিজের binding = 26 ✅ |

অর্থাৎ **০.৫.২ ক্রেট + ০.৯.১৪ প্লাগইন মেশানো যায় না** — ডিভাইসে `UniFFI contract version mismatch` ছুড়বে। যেটা যায়: **পুরো স্ট্যাক একই প্রজন্মে** রাখা।

### 2.2 আরও এক সুসংবাদ: API প্রায় হুবহু একই

`NativeAgentPlugin` ইন্টারফেস দুটোর তুলনা (`v0.5.2` vs `0.9.14`) — যাচাই করা:

- **মোট মিল:** ৪৪টি মেথড
- **কেবল 0.9.14-এ আছে (v0.5.2-তে নেই): ৫টি** → `checkAvailability`, `scheduleBackgroundWakes`, `cancelBackgroundWakes`, `loadSurfacedMessages`, `setMcpTools`
- **কেবল v0.5.2-তে আছে:** **০টি** — অর্থাৎ 0.9.14 API পুরোনোটার superset

আপনার shell যে মেথডগুলো ব্যবহার করে (`bridge/nativekit.ts`, `www/agent-lab.js`) সেগুলোর প্রায় সবই v0.5.2-তেও আছে। মোকাবিলা করতে হবে শুধু ওই ৫টা।

---

## 3. তিনটি প্লান (Actions থেকেই চলে)

### PLAN 0 — ০.৯.x-এর আসল সোর্স, Actions-only পথে (সবচেয়ে ভালো, যদি সোর্স জোগাড় হয়)

"লোকাল কমান্ড লাগবে না" — সোর্সটা কেউ একবার GitHub Release-এ asset আকারে আপলোড করলেই আমরা Actions থেকে সব করব:

```text
GitHub → Releases → "ffi-source" tag → asset: native-agent-ffi-src-0.9.14.tar.gz
       (আপলোডটা ফোন/ব্রাউজার থেকেই হয়; বিল্ড/কম্পাইল কিছুই লোকালে করতে হয় না)

Actions → "Native agent FFI — source, build, verify (Actions only)" → Run workflow
   source_mode        = release-asset
   asset_tag          = ffi-source
   asset_pattern      = native-agent-ffi-src-*.tar.gz
   commit_source      = ✅ (এবারই শেষ — সোর্স রিপোতে ঢুকে যাবে)
   commit_slices      = ✅ (৪ ABI .so রিপোতে ঢুকে যাবে)
   build_apk          = ✅ (APK-এর ভেতরে ABI assertion)
```

এরপর `allow_binding_mismatch=false` রেখে দিলে **contract gate** নিশ্চিত করবে যে `.so` আর committed binding (v30) হুবহু মেলে — ভুল ভার্সনের `.so` রিপোতে ঢুকতেই পারবে না।

**না করলে:** সোর্সহীন অবস্থায় ০.৯.x টার্গেট করা যাবে না — এটা কেবলই বাস্তব সীমা (reverse engineering ছাড়া উপায় নেই, আর সেটা ঠিক পথ নয়)।

### PLAN A — পুরো স্ট্যাক public `v0.5.2` প্রজন্মে পিন (সোর্স ১০০% পাবলিক, আজই করা যায়)

যা পাবেন: **৪ ABI `.so`, সম্পূর্ণ পুনরুৎপাদনযোগ্য, কোনো private repo/secret ছাড়া**।
যা হারাবেন: ০.৯.x-এর নতুন ফিচার/ফিক্স (background wakes, surfaced messages, MCP tools, crash-safety audit ইত্যাদি) এবং `checkAvailability` (JS-এ ছোট শিম দিয়ে সারানো যায়)।

ধাপ (সব Actions/ব্রাউজার থেকে):

```bash
# ১) পাবলিক প্লাগইন প্রজন্ম নিয়ে আসা (একবার, রিপোতে commit)
tools/agent-ffi/switch-agent-generation.sh --ref v0.5.2 --apply
#    (স্ক্রিপ্টটি: পাবলিক রিপো থেকে plugins/native-agent-এর v0.5.2 সংস্করণ নামায়,
#     বর্তমানটা plugins/.native-agent-backup-<ref>/ এ ব্যাকআপ রাখে, API diff দেখায়)

# ২) Actions → "Native agent FFI…" → source_mode = public-upstream, source_ref = v0.5.2
#    → ক্রেট ভেন্ডর + ৪ ABI বিল্ড + verify + slices commit (contract 26 ↔ binding 26 ✅)

# ৩) JS শিম (bridge/nativekit.ts) — নতুন ৫টা মেথড যেহেতু নেই:
```

```js
// v0.5.2 প্রজন্মে checkAvailability() নেই — native call দিয়ে availability প্রোব:
const avail = async () => {
  try { await NativeAgent.listSessions();                    // লোকাল, নেটওয়ার্ক লাগে না
        return { available: true, abi: 'unknown', is64Bit: undefined, reason: '' } }
  catch (e) { return { available: false, abi: 'unknown', is64Bit: false,
                       reason: `native library not loadable: ${e?.message ?? e}` } }
}
// scheduleBackgroundWakes/cancelBackgroundWakes → সরিয়ে দিন বা no-op
// loadSurfacedMessages → ইঞ্জিনের session history দিয়ে দিন
// setMcpTools → পুরোনো startMcp/restartMcp ব্যবহার করুন
```

### PLAN B — PhoneBuddy SDK (পরীক্ষা করা হয়েছে, **বাদ দেওয়া হয়েছে**)

`APUS-AI-Lab/PhoneBuddySDK` (Apache-2.0, সম্পূর্ণ পাবলিক, ৪ ABI বিল্ড হয়) একসময়
বিকল্প ইঞ্জিন হিসেবে এই রিপোতে বসানো হয়েছিল — OS wake scheduler আর surfaced
messages-এর জন্য। পরে **সম্পূর্ণ সরিয়ে ফেলা হয়েছে**, কারণ:

* **খরচ বনাম লাভ:** Android-এ ৪ ABI মিলিয়ে ৪০ MB `.so` + iOS-এ ৫৯ MB xcframework,
  অথচ যেই দুটো ক্ষমতার জন্য আনা হয়েছিল সেগুলো (`scheduleBackgroundWakes`,
  `loadSurfacedMessages`) এই অ্যাপের UI-তে ব্যবহারযোগ্য ছিল না;
* **দুটো ইঞ্জিন = দুটো সত্যের সেট:** native-agent-এর SQLite/cron/skill/MCP/approval
  আর PhoneBuddy-র সেশন/টাস্ক আলাদা স্টোরে থাকত — কোন ইতিহাস কে রাখছে তা নিয়ে
  বিভ্রান্তি;
* **সিদ্ধান্ত:** অ্যাপ এখন **একটাই ইঞ্জিন** (native-agent 0.5.2-public) চালায়, আর
  যে ক্ষমতা এই প্রজন্মে নেই (OS-scheduled wake, surfaced store) সেটা ব্রিজ
  লুকিয়ে না রেখে `supported:false` + কারণ + বিকল্প জানায়।

বিকল্প হিসেবে বাকি থাকে: শুধু cron + `handleWake()` (অ্যাপ/নিজের JobService থেকে
ডাকা), অথবা ভবিষ্যতে নতুন প্রজন্মের সোর্স পাবলিক হলে ইঞ্জিন আপগ্রেড।

## 4. কোনটা বেছে নেবেন — সিদ্ধান্ত টেবিল

| | PLAN 0 (exact 0.9.x) | PLAN A (public v0.5.2) — **গৃহীত** | ~~PLAN B (PhoneBuddy)~~ — বাদ |
|---|---|---|---|
| সোর্স | কারও কাছ থেকে source drop লাগবে | **পাবলিক, আজই** | **পাবলিক, আজই** |
| ৩২-bit ফোনে চলবে? | ✅ (৪ ABI বিল্ড) | ✅ (৪ ABI বিল্ড) | ✅ (৪ ABI বিল্ড) |
| ফিচার | আপডেটের সবচেয়ে ভালো (0.9.14) | পুরোনো প্রজন্ম (0.5.2) | নতুন ইঞ্জিন (feat. ভিন্ন) |
| কোড পরিবর্তন | **জিরো** | প্লাগইন ডাউনগ্রেড + ৫ মেথডের শিম | নতুন প্লাগইন লেখা |
| Actions-only? | ✅ | ✅ | ✅ |
| সময় | সোর্স পেলে ১ ঘণ্টা | ২–৪ ঘণ্টা | ≈১ সপ্তাহ |
| ঝুঁকি | সোর্স না পেলে কিছুই না | পুরোনো বাগ/ফিচার | মাইগ্রেশন বাগ |

**পরামর্শ:** PLAN 0 চেষ্টা করুন (একটা মেসেজ, একটা আপলোড)। না হলে — আজকের সমস্যা মেটাতে PLAN A, আর দীর্ঘমেয়াদে PLAN B।

---

## 5. Actions থেকে যা যা করা যায় (এই রিপোতে এখন যা আছে)

`.github/workflows/native-agent-ffi.yml` — **একটাই বাটন**:

| ইনপুট | মান | মানে |
|---|---|---|
| `source_mode` | `repo` | রিপোতে আগেই ভেন্ডর করা সোর্স ব্যবহার করবে |
| | `public-upstream` | পাবলিক রিপো থেকে `rust/native-agent-ffi` নামাবে (`source_ref=v0.5.2`) |
| | `release-asset` | আপনার Release-এ রাখা সোর্স tarball নামাবে (PLAN 0-এর পথ) |
| | `git` | যেকোনো git URL (+ `FFI_SOURCE_TOKEN` ঐচ্ছিক) |
| `abis` | `arm64-v8a armeabi-v7a x86_64 x86` | কোন ABI-গুলো বিল্ড হবে |
| `cargo_features` | যেমন `--no-default-features` | ৩২-bit-এ কোনো ডিপেন্ডেন্সি ফেল করলে সেটা বাদ দেওয়া |
| `commit_source` / `commit_slices` | ✅ | সোর্স ও `.so` রিপোতে bot-commit হবে (পরেরবার কিছু আনতেই হবে না) |
| `allow_binding_mismatch` | ❌ | চালু না করলে **contract gate** ভুল ভার্সনের `.so` আটকে দেবে |
| `build_apk` | ✅ | শেষে debug APK বানিয়ে ভেতরে ৪ ABI আছে কি না assert করবে |

ওয়ার্কফ্লো তিন ধাপে চলে: **resolve-source → build-slices → packaged-apk**। প্রতিটি ধাপে আর্টিফ্যাক্ট (jniLibs, `abi-manifest.json`, APK) আপলোড হয়, তাই একবার চালালেই ফোনে টেস্ট করার মতো APK হাতে আসে — লোকাল কিছু চালানো লাগে না।

---

## 6. যাচাইয়ের কমান্ড (এখন এই রিপোতে চালানো রাখা টুল)

```bash
# কোন ABI-তে ইঞ্জিন আছে/নেই (pure Node)
npm run check:abis
# বিশদ চেক, ব্যর্থ হলে exit 1
npm run ffi:verify -- --strict
# APK/AAB-এর ভেতরে সত্যিই আছে কি না
npm run ffi:verify -- --strict --apk app-debug.apk
# সোর্স resolve (Actions-এ যেটা চলে)
tools/agent-ffi/resolve-ffi-source.sh --mode public-upstream --ref v0.5.2 --dry-run
```

---

## 7. প্রমাণের ফাইল

- `tools/agent-ffi/resolve-ffi-source.sh` — উপরের ৪ মোডের সাথে সোর্স আনে/ভেন্ডর করে (দ্রুত পরীক্ষা করা: v0.5.2 থেকে ১৫টি ফাইল নামে)
- `tools/agent-ffi/build-android-all-abis.sh` — ৪ ABI বিল্ড, ELF verify, contract gate (`--require-binding-match`)
- `tools/agent-ffi/switch-agent-generation.sh` — PLAN A-র জন্য পাবলিক প্রজন্মে নামার সহায়ক
- `.github/workflows/native-agent-ffi.yml` — Actions-only পাইপলাইন
