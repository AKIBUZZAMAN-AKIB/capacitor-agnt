# Native agent FFI — সব Android ABI-তে চালানোর গাইড

> **হালনাগাদ (২০২৬-০৯-১৯): PLAN A প্রয়োগ করা হয়েছে** — `plugins/native-agent` এখন পাবলিক `v0.5.2` প্রজন্মে পিন করা, ক্রেট সোর্স রিপোতে ভেন্ডর করা (contract 26), আর `npm run check` সবুজ। বিস্তারিত: [`docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md`](../../docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md)। নিচের চেকলিস্টের ১ম ধাপ ইতিমধ্যেই সম্পন্ন।

> এই ফোল্ডারের টুলগুলো একটি নির্দিষ্ট সমস্যার সমাধান করে: **`libnative_agent_ffi.so` রিপো-তে শুধু `arm64-v8a` থাকে**, তাই 32-bit ফোন (`armeabi-v7a`), x86/x86_64 এমুলেটর — এসব ডিভাইসে agent engine লোড হয় না। এখানে সেই স্লাইসগুলো বানানো, যাচাই করা, এবং ভবিষ্যতে যেকোনো সময় rebuild করার পুরো পথ আছে — **কোনো private repo-র উপর নির্ভরতা ছাড়াই**।

---

## ০. সব কিছু Actions থেকেই (কোনো লোকাল কমান্ড ছাড়া)

GitHub → **Actions → “Native agent FFI — source, build, verify (Actions only)” → Run workflow**। এক বাটনে: সোর্স আনা → ৪ ABI বিল্ড → ELF+binding যাচাই → `.so` রিপোতে commit → (চাইলে) debug APK বানিয়ে ভেতরে ABI assertion। `source_mode` ড্রপডাউনে বেছে নিন সোর্স কোথা থেকে আসবে:

| `source_mode` | কোথা থেকে | কখন ব্যবহার করবেন |
|---|---|---|
| `repo` | রিপোতে ভেন্ডর করা `plugins/native-agent/rust/native-agent-ffi` | সোর্স একবার ঢুকে গেলে (দ্বিতীয়বার থেকে এটাই) |
| `release-asset` | এই রিপোর Releases-এ রাখা সোর্স tarball | **০.৯.x-এর আসল সোর্স পেলে** — ফোন/ব্রাউজার থেকে asset আপলোড, বাকি সব Actions |
| `public-upstream` | পাবলিক `rogelioRuiz/capacitor-native-agent` @ `source_ref` (যেমন `v0.5.2`) | সম্পূর্ণ পাবলিক সোর্স চাইলে (তখন প্লাগইনও ওই প্রজন্মে হতে হবে — `switch-agent-generation.sh`) |
| `git` | যেকোনো git URL (+ ঐচ্ছিক `FFI_SOURCE_TOKEN`) | private GitLab-এ আপনার অ্যাক্সেস থাকলে |

আর **PhoneBuddy ইঞ্জিন** (Apache-2.0, পাবলিক) বেছে নিলে: **Actions → “PhoneBuddy FFI — build every Android ABI” → Run workflow** — সেটাও সম্পূর্ণ Actions-ভিত্তিক, কোনো secret লাগে না।

> গভীর গবেষণার পূর্ণ বিবরণ (কোথায় কী খুঁজেছি, কী পেলাম, তিনটি প্লান): [`docs/research/FFI-SOURCE-AVAILABILITY.bn.md`](../../docs/research/FFI-SOURCE-AVAILABILITY.bn.md)

---

## ১. আসল কারণ (root cause)

আপনার ডিভাইস:

```text
getprop ro.product.cpu.abilist  →  armeabi-v7a,armeabi
```

অর্থাৎ ডিভাইসটি **32-bit only**। কিন্তু রিপো-তে যা আছে:

```text
plugins/native-agent/android/src/main/jniLibs/
└── arm64-v8a/libnative_agent_ffi.so     ← শুধু এই একটা
```

তাই `NativeAgent.checkAvailability()` যা রিপোর্ট করে:

```json
{ "abi": "armeabi-v7a", "is64Bit": false, "available": false,
  "reason": "native library not loadable on ABI 'armeabi-v7a': ... libnative_agent_ffi.so not found ..." }
```

ঘটনাটা ধাপে ধাপে:

1. `uniffi/native_agent_ffi/native_agent_ffi.kt` → JNA দিয়ে `Native.register("native_agent_ffi")` করে।
2. JNA প্ল্যাটফর্ম বুঝে `.so`-র নাম ঠিক করে: 64-bit ARM-এ `android-aarch64/libnative_agent_ffi.so`, **32-bit ARM-এ `android-arm/libnative_agent_ffi.so`**।
3. 32-bit স্লাইস প্যাকেজে নেই → `dlopen failed ... not found` → `UnsatisfiedLinkError`।
4. প্লাগইন এটা `Throwable` হিসেবে ধরে ফেলে, তাই **অ্যাপ ক্র্যাশ করে না** — শুধু `available:false` দেখায়। (এটাই BUGS-AND-FIXES.md-এর C1 ফিক্স।)

দুটো ভুল ধারণা দ্রুত বাদ দিই:

- **JNA দোষ নয়।** `net.java.dev.jna:jna:5.14.0@aar`-এর ভেতরে `jni/armeabi-v7a/libjnidispatch.so` সহ সব ABI-র লাইব্রেরি আছে (যাচাই করা)।
- **Gradle config দোষ নয়।** কোনো `abiFilters`/`splits` কোনো ABI বাদ দিচ্ছে না — লাইব্রেরিটাই কেবল একটাই ABI-র জন্য আছে।

### সোর্স কোথায়? (এটাই আসল বাধা)

`plugins/native-agent/.gitmodules` বলছে ক্রেটটি এখানে:

```text
[submodule "rust/native-agent-ffi"]
    path = rust/native-agent-ffi
    url  = https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi.git   ← private
```

কিন্তু তিনটি বাস্তবতা:

| যা দেখা গেছে | ফলাফল |
|---|---|
| `git ls-tree`-এ `rust/`-এর কোনো gitlink নেই (`.gitmodules` ফাইলটা আছে, কিন্তু সাবমডিউল রেজিস্টার করা নেই) | `git submodule update --init` কিছুই নামাবে না |
| upstream GitLab private (anonymous clone-এ username চায়) | `gitlab.k8s.t6x.io` থেকে সোর্স আনা যাবে না |
| npm-এর সর্বশেষ `capacitor-native-agent@0.9.16` টার্বলেও শুধু `arm64-v8a/libnative_agent_ffi.so` (Rust সোর্স নেই) | npm থেকেও 32-bit বিল্ড পাওয়া যাবে না |

**তাই:** 32-bit/x86 সাপোর্ট পেতে হলে ক্রেটের সোর্স একবার হাতে আসতেই হবে — এরপর এই টুলকিট দিয়ে সেটা একবার রিপো-তে ভেন্ডর করে ফেললে **চিরতরে private repo-র ঝামেলা শেষ**।

---

## ২. কৌশল — তিন স্তরে সমাধান

| স্তর | কী | কত সময় |
|---|---|---|
| **L0 · আজই** | UI গেট: unsupported ABI-তে agent সংক্রান্ত বাটন/ট্যাব disable + স্পষ্ট মেসেজ। অ্যাপ ক্র্যাশ করছে না, শুধু ফিচার নেই — সেটা ইউজারকে জানানো। | ১০ মিনিট |
| **L1 · আসল সমাধান** | ক্রেট সোর্স একবার ভেন্ডর (`vendor-ffi-source.sh`) → ৪টি ABI-র জন্য `.so` বিল্ড (`build-android-all-abis.sh`) → যাচাই (`verify-abis.sh`) → commit। | ৩০–৬০ মিনিট (একবার) |
| **L2 · ভবিষ্যৎ** | GitHub Actions workflow: সোর্স/টুল বদলালে বা `workflow_dispatch` চাপলে ৪ ABI rebuild → artifact + auto-commit, তারপর debug APK বানিয়ে ভেতরে ABI assertion। | ১ ক্লিক |

### L0 স্ক্রিপ্ট (আপনার `www/agent-lab.js` বা যেকোনো UI-তে)

```js
// 32-bit ফোনে native agent নেই — ইউজারকে সৎভাবে জানান, বাটন লুকান।
async function gateAgentUI() {
  const { available, abi, reason } = await window.NativeKit.agent.checkAvailability();
  document.querySelectorAll('[data-agent-action]').forEach((el) => {
    if (!available) {
      el.disabled = true;
      el.title = `এই device (${abi}) এ native agent engine নেই: ${reason}`;
    }
  });
  return available;
}
```

---

## ৩. এই ফোল্ডারে কী আছে

| ফাইল | কাজ |
|---|---|
| `build-android-all-abis.sh` | ৪টি ABI-র জন্য `.so` বিল্ড → `jniLibs/<abi>/`-তে বসায় → প্রতিটি ELF যাচাই করে → `abi-manifest.json` (SHA-256) লেখে |
| `vendor-ffi-source.sh` | private GitLab/npm-নির্ভরতা শেষ করে ক্রেট সোর্সকে সাধারণ ফাইল হিসেবে রিপো-তে বসায় + `.gitmodules` নিষ্ক্রিয় করে |
| `verify-abis.sh` → `verify_abis.py` | jniLibs / APK / AAB স্ক্যান করে দেখায় কোন ABI-তে agent engine আছে, কোনটায় নেই (`--strict` = ব্যর্থ হলে exit 1) |
| `check-native-abis.mjs` | একই চেক, pure Node (Python ছাড়া) — `npm run check:abis` হিসেবে ব্যবহারযোগ্য |
| `elfcheck.py` | নির্ভরতা-মুক্ত ELF ইন্সপেক্টর: ABI/machine, 16 KB page alignment, ARM softfp ABI, UniFFI symbol আছে কি না |
| `resolve-ffi-source.sh` | **Actions-এর প্রথম ধাপ**: `repo` / `public-upstream` / `release-asset` / `git` — চার উপায়ে ক্রেট সোর্স এনে ভেন্ডর করে |
| `switch-agent-generation.sh` | পুরো প্লাগইনকে পাবলিক প্রজন্মে (যেমন `v0.5.2`) নামায় — API diff, UniFFI contract তুলনা, শিম কোড, ব্যাকআপ সহ (ডিফল্টে dry-run) |
| `.github/workflows/native-agent-ffi.yml` | CI: **Actions-only** — source resolve → ৪ ABI বিল্ড → verify → slices commit → ঐচ্ছিক APK assertion (contract gate সহ) |
| `build-phonebuddy-all-abis.sh` + `.github/workflows/phonebuddy-ffi.yml` | **বিকল্প ইঞ্জিন রাস্তা**: PhoneBuddy SDK (public, Apache-2.0) থেকে ৪ ABI `.so` বিল্ড — কোনো secret লাগে না। বিস্তারিত: [`docs/research/PHONEBUDDY-ENGINE-MIGRATION.bn.md`](../../docs/research/PHONEBUDDY-ENGINE-MIGRATION.bn.md) |

`package.json`-এ যোগ হওয়া স্ক্রিপ্ট:

```bash
npm run check:abis          # কোন ABI-তে agent আছে/নেই
npm run ffi:vendor -- --from-dir /path/to/native-agent-ffi
npm run ffi:build:android   # সব ABI বিল্ড
```

---

## ৪. ধাপে ধাপে

### Step 1 — ক্রেট সোর্স আনা (একবার, যেকোনো একটি উপায়ে)

```bash
# (a) কারও কাছ থেকে ফোল্ডার/জিপ পেলে
tools/agent-ffi/vendor-ffi-source.sh --from-dir ~/native-agent-ffi

# (b) tarball হলে
tools/agent-ffi/vendor-ffi-source.sh --from-tar ~/native-agent-ffi.tar.gz

# (c) আপনার নিজের GitLab অ্যাক্সেস থাকলে (token সহ)
FFI_SOURCE_TOKEN=<read-only-token> \
tools/agent-ffi/vendor-ffi-source.sh --from-git https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi.git --ref main

# (d) সাবমডিউল আকারে কখনো ক্লোন করা থাকলে সেটাকে প্লেইন ফাইলে রূপান্তর
tools/agent-ffi/vendor-ffi-source.sh --from-submodule
```

স্ক্রিপ্টটি যা করে: ফাইল কপি → SHA-256 ম্যানিফেস্ট (`VENDOR-MANIFEST.json`) → `[lib] name` যাচাই (`native_agent_ffi` হতে হবে, নইলে Kotlin লোডার ভাঙবে) → `.gitmodules` কে `.gitmodules.disabled` করে দেওয়া → পরের কমান্ডগুলো প্রিন্ট করা।

তারপর অবশ্যই commit:

```bash
git add plugins/native-agent/rust plugins/native-agent/.gitmodules.disabled
git rm --cached plugins/native-agent/.gitmodules 2>/dev/null || true
git commit -m "vendor native-agent-ffi crate (no private-repo dependency)"
```

> ⚖️ **লাইসেন্স:** ক্রেটটি আপনার ডিপেন্ডেন্সির সোর্স। পাবলিশ/স্টোর বিল্ডের আগে upstream LICENSE দেখে নিন (ফর্ক/রিডিস্ট্রিবিউশনের শর্ত থাকতে পারে)।

### Step 2 — চারটি ABI-র জন্য বিল্ড

```bash
# প্রয়োজন: rustup + NDK r27 + cargo-ndk (cargo install cargo-ndk --locked)
tools/agent-ffi/build-android-all-abis.sh

# বা নির্দিষ্ট ABI
tools/agent-ffi/build-android-all-abis.sh --abis "arm64-v8a armeabi-v7a"

# 32-bit টার্গেট কোনো ডিপেন্ডেন্সির কারণে ফেল করলে
tools/agent-ffi/build-android-all-abis.sh --best-effort

# UniFFI Kotlin binding সোর্স বদলেছে কি না দেখে নেওয়া / লিখে ফেলা
tools/agent-ffi/build-android-all-abis.sh --write-bindings

# contract না মিললে বিল্ড আটকে দেওয়া (CI-তে এটাই ডিফল্ট):
tools/agent-ffi/build-android-all-abis.sh --require-binding-match

# ৩২-bit-এ কোনো অপশনাল C ডিপেন্ডেন্সি ফেল করলে সেটা বাদ দিয়ে বিল্ড:
tools/agent-ffi/build-android-all-abis.sh --no-default-features
tools/agent-ffi/build-android-all-abis.sh --features libgit2
```

> **কেন `--require-binding-match`:** `lib` আর Kotlin binding-এর UniFFI **contract version** না মিললে ডিভাইসে `UniFFI contract version mismatch` আসে। উদাহরণ (যাচাই করা): পাবলিক `v0.5.2` ক্রেট = contract **26**, আপনার committed প্লাগইন = **30** → মেশানো যাবে না।

স্ক্রিপ্ট যা করবে:

- NDK খুঁজে বের করা (`ANDROID_NDK_HOME`, `$ANDROID_HOME/ndk/*`, …), r27 অগ্রাধিকার
- `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android`
- `cargo-ndk` না থাকলে raw NDK clang wrapper দিয়ে বিল্ড (`--no-cargo-ndk`)
- ছোট প্রোফাইল: `opt-level=s`, `lto=thin`, `codegen-units=1`, `strip=symbols`
  (⚠️ `panic=abort` কখনো নয় — UniFFI প্যানিককে JS exception-এ রূপান্তর করে `catch_unwind` দিয়ে)
- বিল্ড শেষে প্রতিটি `.so` যাচাই: সঠিক machine, `arm64-v8a`-তে **16 KB page alignment**, ARM-এ softfp ABI, এবং UniFFI symbol (`ffi_..._uniffi_contract_version`, checksum ফাংশন) উপস্থিতি
- `jniLibs/<abi>/libnative_agent_ffi.so` + `jniLibs/abi-manifest.json`

### Step 3 — যাচাই (এটা বাদ দেবেন না)

```bash
tools/agent-ffi/verify-abis.sh --strict                   # সোর্স ট্রি
npm run check:abis                                        # একই কাজ, Node-এ

# বিল্ড করা APK/AAB-এর ভেতরে সত্যিই চার ABI আছে কি না
tools/agent-ffi/verify-abis.sh --strict --apk android/app/build/outputs/apk/debug/app-debug.apk
tools/agent-ffi/verify-abis.sh --strict --aab android/app/build/outputs/bundle/release/app-release.aab
```

সফল অবস্থায় আউটপুট এমন হবে:

```text
  arm64-v8a    FULL      libnative_agent_ffi.so, libjnidispatch.so, …
  armeabi-v7a  FULL      libnative_agent_ffi.so, libjnidispatch.so, …
  x86_64       FULL      …
  x86          FULL      …
```

### Step 4 — CI দিয়ে যখন-তখন rebuild

GitHub → **Actions → “Native agent FFI — build every Android ABI” → Run workflow**।
ইনপুট: ABIs লিস্ট, `best_effort`, `commit_slices` (ডিফল্ট চালু → নতুন `.so` গুলো bot commit করে দেয়), `build_apk` (ডিফল্ট চালু → APK-এর ভেতরে ABI assertion)।

সোর্স ভেন্ডর করা থাকলে **কোনো secret লাগবে না**। কেবল upstream থেকে সরাসরি টানতে চাইলে এই দুটো লাগবে:

```text
vars.FFI_SOURCE_URL      = https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi.git
secrets.FFI_SOURCE_TOKEN = read-only token
```

### Step 5 — অ্যাপ বিল্ড ও রিলিজ

```bash
npm run native:sync && npm run android:debug      # লোকাল ডিবাগ APK
git tag v1.4.7-testlab && git push --tags         # বিদ্যমান android.yml APK/AAB + Release বানাবে
```

---

## ৫. সোর্স না থাকলে কী করবেন

সৎভাবে বলি: **সোর্স ছাড়া 32-bit `.so` বানানো অসম্ভব** (এটা reverse engineering ছাড়া কোনো উপায় নেই, এবং সেটা করাও ঠিক পথ নয়)। তিনটি বাস্তব অপশন:

**Option A — upstream-এর কাছে চাওয়া (দ্রুততম, সঠিক পথ)।** নিচের মেসেজটা কপি করে pathao (rogelioRuiz / t6x.io / যিনি ক্রেটটির মালিক):

```text
Subject: native-agent-ffi — request for source access (or multi-ABI build)

Hi,
I maintain a Capacitor app (NativeKit shell) that embeds capacitor-native-agent and
libnative_agent_ffi.so. So far the package only ships an arm64-v8a slice, so on
armeabi-v7a (32-bit) phones and x86/x86_64 emulators the plugin reports
checkAvailability() -> available:false (dlopen: libnative_agent_ffi.so not found).

Could you please either
  1) grant me read access to the crate (https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi) at the
     commit matching the current binding (UniFFI contract version 30, package capacitor-native-agent
     0.9.14/0.9.16), or
  2) publish/provide prebuilt libnative_agent_ffi.so for:
       arm64-v8a, armeabi-v7a, x86_64, x86
     (NDK r27, minSdk 24, stripped / -C lto=thin, opt-level=s)?

I only need the crate source for that tag — happy to follow whatever licence/NDA terms apply.
Thanks!
```

**Option B — ক্রেটের বদলে শুধু `.so` চাওয়া।** উপরের ২ নম্বর রাস্তা। এতে rebuild-এর freedom থাকবে না, কিন্তু আজকের সমস্যা মিটে যাবে (এবং `abi-manifest.json` দিয়ে integrity রাখা যাবে)।

**Option C — সম্পূর্ণ ভিন্ন open-source ইঞ্জিন (এই রিপোতে এখন যন্ত্রপাতি আছে)।** `APUS-AI-Lab/PhoneBuddySDK` (Apache-2.0, public, `--all` ABI বিল্ড) — Actions → “PhoneBuddy FFI — build every Android ABI” চালালেই ৪ ABI `.so`।

**Option C2 — পুরো প্লাগইন পাবলিক `v0.5.2` প্রজন্মে পিন করা — ✅ ইতিমধ্যেই প্রয়োগ করা হয়েছে** (ব্যাকআপ: `.nativekit-backups/native-agent-v0.5.2-*`)। ওই tag-এ প্লাগইন কোড + পূর্ণ Rust ক্রেট দুটোই পাবলিক (MIT), UniFFI contract দুই দিকেই 26 → mismatch নেই। API diff মাত্র ৫টি মেথড (`checkAvailability`, `scheduleBackgroundWakes`, `cancelBackgroundWakes`, `loadSurfacedMessages`, `setMcpTools`) — JS শিম দিয়ে সারানো যায়:

```bash
tools/agent-ffi/switch-agent-generation.sh --ref v0.5.2          # dry run: কী বদলাবে দেখুন
tools/agent-ffi/switch-agent-generation.sh --ref v0.5.2 --apply  # ব্যাকআপ রেখে বদল করুন
# তারপর Actions → Native agent FFI → source_mode = repo (ক্রেট ভেন্ডর হয়ে গেছে) → Run
``` (pure Rust mobile agent engine, C-FFI + Kotlin/Swift binding, multi-ABI build flag আছে)। ⚠️ এটা **drop-in replacement নয়** — Wrapper/Bridge + Kotlin plugin + TS layer পুরো লিখতে হবে। শুধু তখনই বেছে নিন যখন upstream সোর্স কখনোই পাওয়া যাবে না, এবং একই সময়ে 32-bit সাপোর্ট অপরিহার্য।

**Option D — 32-bit বাদ।** শুধু arm64 ফোন টার্গেট করলে L0 গেট দিয়ে ফিচার লুকিয়ে রাখুন। মনে রাখবেন বাজেট/পুরনো ফোনে `armeabi-v7a` তখনও আছে, তাই এটা সাধারণত কাঙ্ক্ষিত নয়।

---

## ৬. UniFFI contract — ভুল করলে যা হয়

- কমিট করা Kotlin binding প্রত্যাশা করে: **`bindings_contract_version = 30`**, সাথে `uniffi_native_agent_ffi_checksum_*` ফাংশনের নির্দিষ্ট ভ্যালু (যেমন `init_workspace` = `313`, `…abort` = `58908`)।
- ভিন্ন ভার্সনের ক্রেট থেকে বিল্ড করা `.so` দিলে রানটাইমে আসবে:
  `UniFFI contract version mismatch` বা `UniFFI API checksum mismatch`।
- সমাধান: `build-android-all-abis.sh --write-bindings` → নতুন binding কমিট করুন → `dist/` ও TS টাইপ সিংক করুন (`npm --prefix plugins/native-agent run build`)। সম্ভব হলে upstream-এর ঠিক সেই ট্যাগ/কমিট থেকেই সোর্স নিন, তাহলে binding অপরিবর্তিত থাকবে।

বাকি দুটো platform-সতর্কতা (স্ক্রিপ্ট নিজেই চেক করে):

- **16 KB page alignment (arm64-v8a)** — Android 15+ ডিভাইসের শর্ত। আধুনিক NDK (r27) ডিফল্টে ঠিক রাখে; `elfcheck` `--require-page-align 16384` দিয়ে যাচাই হয়।
- **ARM softfp ABI (armeabi-v7a)** — hard-float ফ্ল্যাগ দিয়ে বিল্ড হলে Android-এ লোড হবে না; `elfcheck` সেটাও ধরে ফেলে (`--allow-hard-float` না দিলে ব্যর্থ)।

---

## ৭. ফোনে (Termux) বিল্ড করা যায়?

- **চেক/যাচাই চালানো: হ্যাঁ, সহজ।** `pkg install python3 nodejs` → `verify-abis.sh`, `check-native-abis.mjs`, `elfcheck.py` সবই চলবে।
- **বিল্ড: কার্যত না।** Rust + `cargo-ndk` + Android NDK (≈1–2 GB) + SQLite/git2/rustls কম্পাইল = ৬–৮ GB RAM আর ~১.৫–৩ GB ডিস্ক, এক-দুই ঘণ্টা সময়; অনেক ফোনে OOM হবে। দরকার হলে: `--jobs 1`, swap বাড়ানো, এবং `--best-effort`।
- **সেরা পথ:** এই রিপো GitHub Actions-এ চালান (উপরের workflow) — বিনামূল্যে, দ্রুত, আর artifact/commit আকারে `.so` আপনার রিপো-তেই ফিরে আসে। ফোন থেকে শুধু `git pull`।

---

## ৮. ট্রাবলশুটিং

| উপসর্গ | কারণ ও সমাধান |
|---|---|
| `error: …/rust/native-agent-ffi/Cargo.toml not found` | ক্রেট ভেন্ডর করা হয়নি → Step 1 |
| `arm64-v8a is mandatory` / বিল্ড ফেল | NDK/target নেই → `ANDROID_NDK_HOME` সেট করুন, `rustup target add…`; বিল্ড লগে কোন ক্রেট ফেল করছে দেখুন |
| `armeabi-v7a` টার্গেটে কোনো ডিপেন্ডেন্সি ফেল | `--best-effort` দিয়ে বাকিগুলো রাখুন; তারপর ওই ডিপেন্ডেন্সির 32-bit সাপোর্ট/ফিচার-ফ্ল্যাগ খুঁজুন (উদাহরণ: `ring`, `git2`, নেটিভ crypto) |
| ডিভাইসে এখনো `available:false` | (১) `getprop ro.product.cpu.abilist` ← `armeabi-v7a` কি আছে? (২) `verify-abis.sh --apk …` দিয়ে APK-তে লাইব্রেরি আছে কি না দেখুন; (৩) অ্যাপ **uninstall** করে নতুন APK ইনস্টল করুন (পুরনো `.so` ক্যাশ থাকতে পারে); (৪) `logcat`-এ `dlopen` লাইন দেখুন |
| `UniFFI contract/API checksum mismatch` | binding আর `.so`-র ভার্সন মিলছে না → `--write-bindings` + `dist/` rebuild |
| `16 KB` alignment check fail | NDK আপডেট করুন (r27+), `--require-page-align` যাচাই চালান |
| APK সাইজ বেড়ে গেল (৪ ABI ≈ ৪× `.so`) | Play-এ AAB দিলে per-device split হয়; APK-তে চাইলে `ndk { abiFilters … }` বা `splits { abi { … } }` (নিচে) |

```groovy
android {
  defaultConfig {
    ndk { abiFilters 'arm64-v8a', 'armeabi-v7a' }   // শুধু দরকারি ABI
  }
  // বা আলাদা APK per ABI:
  splits {
    abi { enable true; reset(); include 'arm64-v8a', 'armeabi-v7a'; universalApk false }
  }
}
```

---

## ৯. চেকলিস্ট

- [ ] ক্রেট সোর্স হাতে এসেছে (upstream access / source drop / signed tarball)
- [ ] `vendor-ffi-source.sh` চালিয়ে রিপো-তে ভেন্ডর করা হয়েছে এবং commit করা হয়েছে
- [ ] `build-android-all-abis.sh` → ৪টি `.so` + `abi-manifest.json`
- [ ] `verify-abis.sh --strict` ও `npm run check:abis` পাস
- [ ] `--write-bindings` লাগলে সেটা কমিট করা হয়েছে (contract version অপরিবর্তিত)
- [ ] CI workflow একবার চালিয়ে দেখেছেন (artifact + APK assertion)
- [ ] `armeabi-v7a` ফোনে ইনস্টল করে `checkAvailability()` → `available: true`
- [ ] L0 UI গেট যুক্ত হয়েছে (ভবিষ্যতের unsupported ডিভাইসের জন্য)
