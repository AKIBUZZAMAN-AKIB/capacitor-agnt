# Native Agent FFI — build ও যাচাই নির্দেশিকা

**বর্তমান অবস্থা: ২০২৬-১০-০৭।** এই নথি রিপোজিটরির বর্তমান source ও native artifact অনুযায়ী হালনাগাদ। পুরোনো “শুধু arm64 library আছে” নির্দেশনা আর প্রযোজ্য নয়।

## এখন রিপোতে যা আছে

| অংশ | বর্তমান অবস্থা |
|---|---|
| Rust crate | `plugins/native-agent/rust/native-agent-ffi/`-এ vendored; `Cargo.toml` উপস্থিত |
| Android FFI | `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`—চার ABI-র `.so` আছে |
| Android manifest | `plugins/native-agent/android/src/main/jniLibs/abi-manifest.json`; manifest-এর `generatedAt` হলো `2026-09-25` এবং প্রতিটি `.so`-র SHA-256/size নথিভুক্ত |
| iOS FFI | `NativeAgentFFI.xcframework`-এ `ios-arm64` device ও `ios-arm64-simulator` slice আছে |
| ABI coverage | `npm run check:abis -- --strict` দিয়ে source `jniLibs` যাচাই করা হয়েছে; চার ABI-তেই `libnative_agent_ffi.so` পাওয়া যায় |

**গুরুত্বপূর্ণ:** ABI coverage পরীক্ষা শুধু library ফাইল আছে কি না দেখে। এটি Rust source ও prebuilt binary একই revision-এর কি না, runtime load হয় কি না, বা release APK/AAB-তে সব slice ঢুকেছে কি না—এসব প্রমাণ করে না। Android manifest ২৫ সেপ্টেম্বরের build চিহ্নিত করে। এর পরে `db.rs`-এ করা Rust পরিবর্তনগুলো prebuilt Android/iOS library-তে নেই; তাই পুনর্নির্মাণ ও native build verification না হওয়া পর্যন্ত এই source snapshot-কে release-ready ধরা যাবে না।

বর্তমান পরিবর্তনে UniFFI interface বদলানো হয়নি—Rust-এর internal DB logic-ই বদলেছে। তবু নতুন logic app-এ কার্যকর করতে Android-এর চার ABI এবং iOS-এর XCFramework library পুনর্নির্মাণ আবশ্যক।

## যাচাই

```bash
# Android source jniLibs-এ প্রত্যাশিত ABI ও library আছে কি না
npm run check:abis -- --strict

# একই coverage check-এর Python wrapper
bash tools/agent-ffi/verify-abis.sh --strict

# একটি ELF slice-এর ABI, 16 KB alignment ও UniFFI symbol পরীক্ষা
python3 tools/agent-ffi/elfcheck.py \
  --expect-abi arm64-v8a \
  --require-symbol uniffi_native_agent_ffi_checksum_func_init_workspace \
  --require-page-align 16384 \
  plugins/native-agent/android/src/main/jniLibs/arm64-v8a/libnative_agent_ffi.so

# Rust regression/unit test
cargo test --manifest-path plugins/native-agent/rust/native-agent-ffi/Cargo.toml
```

Release package তৈরি হলে source-tree check-এর বদলে APK/AAB-ও পরীক্ষা করুন:

```bash
bash tools/agent-ffi/verify-abis.sh --apk android/app/build/outputs/apk/debug/app-debug.apk
bash tools/agent-ffi/verify-abis.sh --aab android/app/build/outputs/bundle/release/app-release.aab
```

APK/AAB path আপনার build output অনুযায়ী বদলান। `check-native-abis.mjs`-ও ব্যবহার করা যায়: `node tools/agent-ffi/check-native-abis.mjs --apk <path>` বা `--aab <path>`।

## Android FFI rebuild

প্রয়োজন: Rust `rustup`/`cargo`, Android NDK (স্ক্রিপ্টের বার্তায় r27 সুপারিশ করা আছে), এবং `cargo-ndk`। চার ABI-ই default target।

```bash
# NDK-এর আসল install path দিন; উদাহরণটি নিজের SDK path অনুযায়ী বদলান
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"

# সব Android ABI rebuild; UniFFI binding contract-ও মিলিয়ে দেখে
tools/agent-ffi/build-android-all-abis.sh --require-binding-match

# build script প্রতিটি slice-এর ELF machine ও UniFFI symbol যাচাই করে;
# এরপর source-tree ABI coverage আবার পরীক্ষা করুন
npm run check:abis -- --strict
bash tools/agent-ffi/verify-abis.sh --strict
```

নির্দিষ্ট ABI-র জন্য `--abis "arm64-v8a armeabi-v7a"` ব্যবহার করা যায়। ইচ্ছাকৃতভাবে binding regeneration করতে হলে `--write-bindings` অপশন আছে; Rust public API বদলালে generated binding-সহ সংশ্লিষ্ট Kotlin/Swift plugin source ও package output-ও পর্যালোচনা করতে হবে। শুধু internal Rust logic বদলালে binding পুনর্লিখবেন না—প্রথমে `--require-binding-match` দিয়ে contract অপরিবর্তিত নিশ্চিত করুন।

## iOS XCFramework rebuild

এটি macOS, Xcode, `xcodebuild` এবং প্রয়োজনীয় Rust Apple targets-সহ চালাতে হবে:

```bash
tools/agent-ffi/build-ios-xcframework.sh
```

স্ক্রিপ্টটি `NativeAgentFFI.xcframework` এবং generated Swift/C binding artifacts তৈরি/স্থাপন করে। Build শেষে Xcode/SwiftPM plugin build-ও চালিয়ে নিশ্চিত করুন যে device ও simulator slice লিংক হয়।

## এই workspace-এ যাচাইয়ের সীমা

এই workspace-এ `node` থাকায় ২০২৬-১০-০৭ তারিখে `npm run check:abis` সফল হয়েছে। কিন্তু `cargo`/`rustc`/`rustfmt`, Kotlin compiler ও Swift/Xcode toolchain নেই। ফলে Rust tests/build, Android compile এবং iOS compile এই পরিবেশে সম্পন্ন করা যায়নি। Native FFI binaries-ও এখানে rebuild করা হয়নি।