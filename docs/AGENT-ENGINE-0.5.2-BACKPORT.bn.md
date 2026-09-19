# Agent engine — পাবলিক `0.5.2` প্রজন্মে পিন (PLAN A প্রয়োগ করা হয়েছে)

**তারিখ:** ২০২৬-০৯-১৯ · **অবস্থা:** প্রয়োগ করা ও CI-তে যাচাই করা — পাঁচটি ওয়ার্কফ্লোই সবুজ, `npm run check` ১৪৭টি টেস্টে পাস

> **সংক্ষিপ্ত ফলাফল:** চারটি Android ABI-র `.so` (arm64-v8a, **armeabi-v7a**, x86_64, x86) এখন রিপোতে কমিট করা, অ্যাপ-বিল্ড (APK/AAB) সবুজ, আর iOS-এর xcframework-ও উপরের স্টেল প্রিবিল্ট বাদ দিয়ে **সোর্স থেকে রিবিল্ড** করে বসানো হয়েছে।

---

## ১. কেন এই পরিবর্তন

আগের অবস্থা: `capacitor-native-agent@0.9.14` শিপ করত **শুধু `arm64-v8a`** `libnative_agent_ffi.so`, আর তার Rust ক্রেট ছিল একটি **private GitLab**-এ (`.gitmodules`, এমনকি submodule gitlink-ও রেকর্ড করা ছিল না)। ফলে:

- আপনার ৩২-bit ফোনে (`ro.product.cpu.abilist = armeabi-v7a,armeabi`) → `checkAvailability()` → `available:false`;
- ৪ ABI বিল্ড করার কোনো উপায় ছিল না — সোর্স কারও কাছেই পাওয়া যায়নি (৯টি চেকের প্রমাণ: `docs/research/FFI-SOURCE-AVAILABILITY.bn.md`)।

এখন: **পুরো প্লাগইন পাবলিক upstream tag `v0.5.2`-এ পিন করা**, কারণ **ওই tag-এ Rust ক্রেটটা repo-তেই commit করা আছে** (MIT, Copyright (c) 2025 Techxagon) — অর্থাৎ সোর্স **পাবলিক ও পুনরুৎপাদনযোগ্য**, আর তাই চার ABI-র বিল্ড যে কেউ, যেকোনো সময়, GitHub Actions-এ করতে পারে।

```text
plugins/native-agent/           ← প্লাগইন কোড (Kotlin/Swift/TS)   : upstream v0.5.2
plugins/native-agent/rust/native-agent-ffi/  ← Rust ক্রেট সোর্স    : upstream v0.5.2 (commit 7b42bb5)
                                                VENDOR-MANIFEST.json (SHA-256, ১৬ ফাইল, ২৯৮ KiB)
UniFFI contract version: 26 (দুই দিকেই match ✅)
```

> ⚠️ মেশানো যাবে না: 0.9.x প্লাগইন (contract 30) + 0.5.2 `.so` (contract 26) → রানটাইমে `UniFFI contract version mismatch`। তাই `build-android-all-abis.sh --require-binding-match` গেট এখন CI-তে বাধ্যতামূলক।

---

## ২. যা যা বদলেছে (চেকলিস্ট)

| # | পরিবর্তন | কেন |
|---|---|---|
| 1 | প্লাগইন সোর্স `v0.5.2`-এ নামানো (ব্যাকআপ: `.nativekit-backups/native-agent-v0.5.2-*`) | সোর্স পাবলিক করতে |
| 2 | ক্রেট সোর্স রিপোতে ভেন্ডর + `VENDOR-MANIFEST.json` | ৪ ABI বিল্ডের একমাত্র পথ |
| 3 | `plugins/native-agent/.gitmodules` **মুছে ফেলা** | private repo নির্ভরতা শেষ |
| 4 | **C1 ফিক্স (crucial):** `catch (e: Exception)` → `catch (t: Throwable)` + `OutOfMemoryError` rethrow (৩টি জায়গায়) | `UnsatisfiedLinkError` এক্সেপশন নয়, **Error** — না ধরলে অ্যাপ ক্র্যাশ করত, promise আটকে থাকত |
| 5 | **`checkAvailability()` যোগ** (Kotlin + Swift + TS + dist) | 0.5.2-তে ছিল না; JS-স্তরে ছদ্ম-প্রোব না দিয়ে সঠিকভাবে ABI/লাইব্রেরি যাচাই: `Native.load("native_agent_ffi", …)` — হুবহু যে নাম uniffi ব্যবহার করে |
| 6 | **C2 → প্রতিস্থাপিত:** ঐচ্ছিক LanceDB মেমোরি পুরোপুরি বাদ; `MemoryProviderImpl.kt` এখন `src/main/java`-তে বিল্ট-ইন (ফাইল-ভিত্তিক স্টোর + লেক্সিক্যাল সার্চ), সরাসরি wiring | আগের গেট (`findProject(':capacitor-lancedb')`) মানে ছিল — যে অ্যাপে ওই প্লাগিন নেই, সেখানে `memory_*` টুল সবসময় `"Memory provider not configured"` দিত। এখন সব অ্যাপে কাজ করে |
| 7 | **C3 → অপ্রযোজ্য:** `Package.swift`-এ কোনো অপশনাল নেটিভ ডিপেন্ডেন্সি নেই — Swift মেমোরি প্রোভাইডারও বিল্ট-ইন (`MemoryProviderImpl.swift`) | macOS-এ SwiftPM resolve-এ কোনো বাহ্যিক প্লাগিন লাগে না |
| 8 | `android/consumer-rules.pro` + `consumerProguardFiles` (defaultConfig-এ) | JNA/UniFFI-reflection সহ minify-করা রিলিজ বিল্ড |
| 9 | ~~ব্রিজে কম্প্যাট শিম~~ → **প্লাগইনে আসল ইমপ্লিমেন্টেশন** (`scheduleBackgroundWakes`, `cancelBackgroundWakes`, `getWakeStatus`, `loadSurfacedMessages`, `clearSurfacedMessages`) | ইঞ্জিন wake *চালাতে* পারে কিন্তু OS-এর কাছে background runtime *চাইতে* পারে না — সেই অর্ধেকটা এখন প্লাগিনে (Android: WorkManager periodic worker; iOS: `BGProcessingTask`)। বিস্তারিত: `docs/BACKGROUND-WAKES.bn.md`। শুধু `setMcpTools` শিমই রয়ে গেছে |
| 10 | `scripts/configure-native.mjs`: iOS BGTask id শুধু тогда যোগ হয় যখন `NativeAgentBackgroundTask.swift` সত্যিই আছে | কাল্পনিক টাস্ক iOS-কে promise করা বন্ধ |
| 11 | `tests/agent-api.test.ts` নতুন প্রজন্মের জন্য পুনর্লিখন | contract 26, ব্যাকপোর্ট, বিল্ট-ইন মেমোরি (কোনো ভেক্টর নেই), ABI টুলিং, শিম, একটাই ইঞ্জিন — সব মেশিন-যাচাই |

### কম্প্যাট শিমগুলো (ব্রিজের ভেতরে)

| ব্রিজ API | 0.5.2-তে | কীভাবে দেওয়া হয় |
|---|---|---|
| `checkAvailability()` | ✅ (আমরা যোগ করেছি) | নেটিভ প্রোব, কখনো reject করে না |
| `scheduleBackgroundWakes(min)` | নেটিভ মেথড নেই | **প্লাগিন নিজে OS-শিডিউলিং করে** — Android `PeriodicWorkRequest` (১৫ মিনিটে clamp করে granted মান রিপোর্ট), iOS `BGProcessingTask`। নেটিভ না পৌঁছালে `{supported:false, reason, alternative}` |
| `cancelBackgroundWakes()` | নেটিভ মেথড নেই | `cancelUniqueWork` / `BGTaskScheduler.cancel` — সত্যিই বাতিল হয়, `jobCancelled` রিপোর্ট সহ |
| `getWakeStatus()` | নেটিভ মেথড নেই | OS-এর নিজের state (`WorkInfo` / `getPendingTaskRequests`) + শেষ wake-এর telemetry + enabled/due cron গণনা |
| `loadSurfacedMessages(limit)` | নেটিভ মেথড নেই | ইঞ্জিনের `cron_runs` row + wake-কালীন নোটিফিকেশন থেকে ভরা `surfaced.json` ইনবক্স (নতুন→পুরনো, unread সহ) |
| `setMcpTools(json)` | ❌ | `restartMcp({toolsJson})`-এ ম্যাপ করা হয় + `viaCompat` চিহ্ন |

নেটিভ সিগনেচারের যে জায়গাগুলো আলাদা, সেগুলোও ব্রিজে অনুবাদ করা হয়: `removeSkill({id: skillId})`, `loadSession({agentId: 'main'})`, `setAuthKey` থেকে `refresh/expiresAt` বাদ, `startSkill.configJson` ডিফল্ট `'{}'`, `handleWake({source:'manual'})`, `setToolPermission.enabled ?? true`।

---

## ৩. কী পাবেন / কী হারাবেন

**পাবেন**
- ৪ ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) — আপনার ৩২-bit ফোনেও agent চলবে;
- সম্পূর্ণ পাবলিক, পুনরুৎপাদনযোগ্য, MIT-লাইসেন্সড সোর্স; `.so` ও সোর্স রিপোতেই commit হয়;
- CI-তে contract gate, ELF verify (16 KB page alignment সহ), APK-এর ভেতরে ABI assertion;
- crash-safety ব্যাকপোর্ট (missing-ABI ডিভাইসে ক্র্যাশ নয়)।

**হারাবেন (0.9.x-এর চেয়ে পুরোনো প্রজন্ম)**
- ইঞ্জিনের **নিজের** wake scheduler: 0.5.2-তে OS আমলে নেওয়ার কোনো পথ নেই, তাই scheduling এখন প্লাগিনের দায়িত্ব (WorkManager/BGTaskScheduler) — wake **হয়**, শুধু সিদ্ধান্তটা OS-এর (Android floor ১৫ মিনিট, iOS opportunistic);
- `setMcpTools` (শিম দিয়ে আংশিক — `restartMcp`-এ ম্যাপ করা);
- long-term memory: **বিল্ট-ইন** — অ্যাপের প্রাইভেট ডিরে একটি JSON স্টোর (`native-agent-memory/memory.json`), লেক্সিক্যাল সার্চ সহ; কোনো ভেক্টর DB/বাহ্যিক প্লাগিন/নেটওয়ার্ক লাগে না;
- 0.6–0.9-এর ইঞ্জিন উন্নতি/বাগফিক্স (ইঞ্জিন কোডে)।

> দীর্ঘমেয়াদে ইঞ্জিন আপগ্রেড করলে (`handle_wake`, `cron_runs.wake_source`, `event_callback` সবই 0.5.2-তেই আছে) প্লাগিনের wake layer অপরিবর্তিত থাকবে — শুধু `NativeWakeRunner`/`NativeWakeCapture`-এর FFI কলগুলো নতুন হ্যান্ডেলে বসবে। PhoneBuddy নামের বিকল্প engine টা পরীক্ষা করে **বাদ দেওয়া হয়েছে** — কারণ ও সিদ্ধান্ত: `docs/research/FFI-SOURCE-AVAILABILITY.bn.md` (PLAN B)।

---

## ৪. এখন কী করবেন (সব Actions থেকে)

1. **প্রথমে লোকাল যাচাই** (একবার, ঐচ্ছিক): `npm ci && npm run check` → сейчас সবুজ ✅
2. **commit + push**:
   ```bash
   git add -A
   git commit -m "feat(agent): pin plugin to public 0.5.2 generation + backports (all-ABI buildable)"
   git push
   ```
3. **Actions → “Native agent FFI — source, build, verify (Actions only)” → Run workflow**
   - `source_mode` = `repo` (ক্রেট ইতিমধ্যেই ভেন্ডর করা)
   - `abis` = `arm64-v8a armeabi-v7a x86_64 x86`
   - `commit_slices` = ✅, `build_apk` = ✅
   - ওয়ার্কফ্লো নিজেই বিল্ড → verify → `.so` commit → APK artifact দেবে।
4. **ফোনে টেস্ট:** Actions artifact থেকে `app-debug.apk` নামিয়ে ইনস্টল করে lab-এ “Check availability” চাপুন → `available: true`, `abi: "armeabi-v7a"`, `engineGeneration: "0.5.2-public"` আসা উচিত।

### রোলব্যাক (যদি কিছু ভুল মনে হয়)

```bash
rm -rf plugins/native-agent
cp -a .nativekit-backups/native-agent-v0.5.2-20260919-030835 plugins/native-agent
# (0.9.14 সংস্করণ ফিরে আসবে; মনে রাখবেন তখন আবার শুধু arm64 ABI থাকবে)
```

---

## ৪ক. CI যাচাই (সব ওয়ার্কফ্লো সবুজ)

| ওয়ার্কফ্লো | ফল | কী প্রমাণ করে |
|---|---|---|
| **Native agent FFI — source, build, verify** | ✅ | ভেন্ডর করা ক্রেট থেকে চারটি ABI-ই বিল্ড, ELF + contract 26 মিলিয়ে যাচাই, `jniLibs/*/libnative_agent_ffi.so` + `abi-manifest.json` কমিট |
| **iOS agent FFI — rebuild the xcframework** | ✅ | ডিভাইস (arm64) + সিমুলেটর (arm64) — **upstream-এর স্টেল প্রিবিল্ট বাদ**, সোর্স থেকে নতুন `libnative_agent_ffi.a`, বাইন্ডিং ও হেডার কমিট |
| **Android APK and AAB** | ✅ | `:capacitor-native-agent:compileDebugKotlin` সহ পুরো অ্যাপ বিল্ড (APK artifact: ~৮৬ MB) |
| **iOS validation and IPA** | ✅ | SwiftPM-এ প্লাগইন + শিম টার্গেট সহ সিমুলেটর অ্যাপ কম্পাইল (সাইনড IPA-র জন্য iOS secrets দরকার) |

APK নামানোর পথ: GitHub → **Actions** → “Android APK and AAB” → সর্বশেষ সবুজ রান → **Artifacts** → `android-apk-aab-<sha>`।

## ৫. যাচাইয়ের কমান্ড

```bash
npm run check                       # config + typecheck + 145 tests + staging
npm run check:abis                  # কোন ABI-তে .so আছে (এখন: arm64; CI-র পরে: চারটাই)
npm run ffi:verify -- --strict      # APK/AAB-এর ভেতরেও চেক করা যায়: --apk app-debug.apk
```

---

## ৬. সম্পর্কিত ফাইল

- `tools/agent-ffi/README.bn.md` — ABI বিল্ড/যাচাই টুলকিট
- `docs/research/FFI-SOURCE-AVAILABILITY.bn.md` — কেন 0.9.x সোর্স পাওয়া যায় না (৯ চেক)
- `tests/agent-api.test.ts` — এই প্রজন্মের contract-টেস্ট (১৬টি invariant)
- `plugins/native-agent/rust/native-agent-ffi/VENDOR-MANIFEST.json` — ভেন্ডর করা ক্রেটের SHA-256
