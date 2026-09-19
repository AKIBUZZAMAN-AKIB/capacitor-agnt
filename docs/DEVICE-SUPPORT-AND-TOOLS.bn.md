# কোথায় চলবে, কী কী আছে, কী করতে পারবেন — এক পাতার গাইড

**অ্যাপ:** `dev.nativekit.shell` v1.4.6-testlab (এটি একটি **টেস্ট-ল্যাব শেল**, স্টোরের অ্যাপ নয়)
**সর্বশেষ যাচাই:** CI-র সবুজ APK (`app-release.apk` / `app-debug.apk`) ভেতর থেকে খুলে দেখা হয়েছে
**তৈরি:** ২০২৬-০৯-১৯

---

## ১. শুধু APK ইনস্টল করলেই হবে? — **হ্যাঁ**

| প্রশ্ন | উত্তর |
|---|---|
| ইনস্টল করলেই চলবে? | **হ্যাঁ** — অ্যাপ নিজের ভেতরে ৪টি ABI-র নেটিভ ইঞ্জিন বহন করে, তাই আলাদা কিছু ডাউনলোড/সেটআপ লাগে না |
| কোন ফাইল? | **`app-debug.apk`** (৫১ MB) — টেস্ট করার জন্য সবচেয়ে নিরাপদ<br>**`app-release.apk`** (৪৯ MB) — এটাও ডিজিটালি সাইন করা (APK Signing Block v2/v3 আছে), ইনস্টল হয় |
| কোথায় পাবেন? | GitHub → **Actions** → “Android APK and AAB” → সর্বশেষ ✅ রান → **Artifacts** → `android-apk-aab-…` (ভেতরে SHA256SUMS.txt সহ) |
| ফোনে ইনস্টল | ফাইলটা ফোনে নামিয়ে ফাইল ম্যানেজার দিয়ে খুলুন → “অজানা সোর্স থেকে ইনস্টল” অনুমতি দিন। Play Protect সতর্কতা দিলে “Install anyway” |
| ইন্টারনেট লাগবে? | অ্যাপ চলতে না; কিন্তু AI এজেন্ট কাজ করতে API key ও নেট লাগবে (Settings/lab-এ key দিতে হবে) |
| আপডেট | ভবিষ্যতে একই signature-এর APK ইনস্টল করলে পুরোনোটা replace হবে |

> ⚠️ এটা debug-সাইন করা/পরীক্ষামূলক বিল্ড। Play Store-এ দিতে হলে নিজের keystore দিয়ে release সাইন + আসল app id (`dev.nativekit.shell` নামটা placeholder) লাগবে।

---

## ২. কোন কোন ডিভাইসে চলবে (APK খুলে যাচাই করা)

| ডিভাইস | চলবে? | কারণ |
|---|---|---|
| ৩২-bit ARM ফোন (আপনার ফোন: `armeabi-v7a`) | ✅ | `lib/armeabi-v7a/` — ৮টি লাইব্রেরি, এজেন্ট ইঞ্জিনসহ (৪.৭ MB) |
| ৬৪-bit ARM ফোন/ট্যাব (প্রায় সব নতুন ফোন) | ✅ | `lib/arm64-v8a/` — এজেন্ট ইঞ্জিন (৬.৪ MB) |
| Android এমুলেটর (৬৪-bit/আধুনিক, e.g. Pixel) | ✅ | `lib/x86_64/` |
| Android এমুলেটর (৩২-bit x86) | ✅ | `lib/x86/` |
| ARM64 Mac-এর Android এমুলেটর | ✅ | `arm64-v8a` স্লাইস ব্যবহার করে |
| Chromebook (x86_64) | ✅ (সাধারণত) | x86_64 স্লাইস আছে |
| **Android 6.0 বা নিচে** | ❌ | অ্যাপের `minSdk 24` = **Android 7.0 (Nougat)** সর্বনিম্ন |
| **armeabi / mips / mips64 (আদিম ABI)** | ❌ | স্লাইস নেই — তবে এমন ডিভাইস কার্যত নেই (Android 5+ এই ABI বাদ দিয়েছে) |
| iPhone/iPad (iOS 15+) | ⚠️ Mac + Xcode + Apple signing লাগবে | iOS-এ APK সাইডলোড হয় না; xcframework এখন **সোর্স থেকে রিবিল্ড** করা আছে (arm64 device + arm64 simulator) |
| Intel Mac-এর iOS সিমুলেটর (x86_64) | ❌ | স্লাইস নেই (arm64-only সিমুলেটর) |

**প্রযুক্তিগত সীমা:** `minSdk 24`, `targetSdk 36` (= Android 16), Kotlin 2.2.0, চারটি ABI-তে মোট ৩২টি `.so`।

**অ্যাপে দেখা যাবে:** lab-এ **Check availability** চাপলে আপনার ফোনে আসবে —
`available: true`, `abi: "armeabi-v7a"`, `is64Bit: false`, `engineGeneration: "0.5.2-public"`।

---

## ৩. ভেতরে কী কী টুল আছে

### ক) AI এজেন্ট ইঞ্জিন (৪৪টি API — `NativeKit.agent.*`)
44টি native মেথড + ব্রিজের ৫টি কম্প্যাট শিম। ভাগ করা যায় এভাবে:

| দল | APIs |
|---|---|
| সেটআপ/অবস্থা | `checkAvailability`, `initialize`, `initWorkspace` |
| চ্যাট/রান | `sendMessage`, `followUp`, `steer`, `abort`, `handleWake` |
| অনুমোদন (approval) | `respondToApproval`, `respondToMcpTool`, `respondToCronApproval` |
| সেশন | `listSessions`, `loadSession`, `resumeSession`, `clearSession` |
| Cron/শিডিউল | `addCronJob`, `updateCronJob`, `removeCronJob`, `listCronJobs`, `runCronJob`, `listCronRuns`, `getSchedulerConfig`, `setSchedulerConfig`, `setHeartbeatConfig` |
| Skill | `addSkill`, `updateSkill`, `removeSkill`, `listSkills`, `startSkill`, `endSkill` |
| টুল-অনুমতি | `seedToolPermissions`, `setToolPermission`, `listToolPermissions`, `resetToolPermissions` |
| MCP সার্ভার | `startMcp`, `restartMcp` |
| লগইন/কী | `setAuthKey`, `getAuthToken`, `getAuthStatus`, `refreshToken`, `deleteAuth`, `exchangeOAuthCode` |
| অন্যান্য | `getModels`, `invokeTool` |

### খ) শেলের অন্যান্য ফিচার (২১টি — `app.config.json`-এ সব সক্রিয়)
`agent`, camera, location, backgroundLocation, haptics, localNotifications, push (তৈরি, key বসানো বাকি), advancedAlarms, backgroundRunner, sqlite, secureStorage, filesystem, fileTransfer, sharing, networkStatus, nativeSSE, appBrowser, inAppBrowser, preferences, nearby (Bluetooth/local network), widget (হোম-স্ক্রিন উইজেট)

### গ) ডেমো ল্যাব — ৫১টি বাটন (`www/agent-lab.js` + `www/index.html`)
সব API হাতে-কলমে চালিয়ে দেখার UI: availability, init, auth, chat, approval, session, cron, skill, permission, MCP, models, tool invoke।
**এটাই টেস্ট করার মূল জায়গা** — APK ইনস্টল করে অ্যাপ খুললেই পাবেন।

### ঘ) হোস্ট-সাইড টুলিং (GitHub Actions-এ, ফোন থেকে চালানো যায়)
| ওয়ার্কফ্লো | কাজ |
|---|---|
| Native agent FFI | ভেন্ডর করা ক্রেট থেকে ৪ ABI `.so` বিল্ড → verify → commit → APK |
| iOS agent FFI | সোর্স থেকে iOS xcframework + বাইন্ডিং রিবিল্ড |
| Android APK and AAB | পুরো অ্যাপ (APK + AAB) |
| iOS validation and IPA | iOS সিমুলেটর কম্পাইল (সাইনড IPA-র জন্য secrets) |

লোকাল কমান্ড (ঐচ্ছিক): `npm run check` (149 টেস্ট), `npm run check:abis`, `npm run ffi:build:android`, `npm run ffi:verify -- --strict --apk app-debug.apk`

---

## ৪. কী কী করতে পারবেন (আসল কাজের উদাহরণ)

1. **নিজের ফোনে অফলাইন এজেন্ট** — API key (OpenAI/Anthropic/Gemini ইত্যাদি) দিয়ে চ্যাট, টুল চালানো, workspace-এ ফাইল লেখা/পড়া।
2. **সময়-নির্ভর কাজ** — cron job যোগ করে (`addCronJob`) নির্দিষ্ট সময়ে কাজ চালানো; অ্যাপ-লঞ্চ/ম্যানুয়াল wake (`handleWake`), heartbeat কনফিগ।
3. **Skill** — নিজের প্রম্পট/টাস্কসংখ্যা skill হিসেবে বানিয়ে রাখা, দরকারে চালু/বন্ধ করা।
4. **নিরাপত্তা** — কোন টুল এজেন্ট ব্যবহার করতে পারবে তার অনুমতি সেট করা, ঝুঁকিপূর্ণ কাজে approval চাওয়া।
5. **MCP** — বাইরের MCP সার্ভার/টুল যুক্ত করা।
6. **মাল্টি-সেশন** — কথোপকথন সেভ/লোড/রিজিউম, আগের কনটেক্সট নিয়ে চালিয়ে যাওয়া।
7. **অন্য ফিচার** — ক্যামেরা, লোকেশন (ব্যাকগ্রাউন্ডসহ), শেয়ার, SQLite, secure storage, হোম-স্ক্রিন উইজেট, nearby ডিভাইস কানেকশন, ইন-অ্যাপ ব্রাউজার।

---

## ৫. যা এখনো নেই / সীমাবদ্ধতা (সৎ তালিকা)

| বিষয় | অবস্থা |
|---|---|
| iOS-এর OS-scheduled background wake (BGTaskScheduler) | ❌ নেই — ব্রিজ `supported:false` দেয়; বিকল্প: **cron + `handleWake`** |
| `loadSurfacedMessages`, `clearSurfacedMessages`, `scheduleBackgroundWakes`, `cancelBackgroundWakes`, `getWakeStatus` | ⚠️ এই প্রজন্মে নেই — ব্রিজ **সৎভাবে** `supported:false` + কারণ + বিকল্প দেয় (নিচে ৫ নম্বর দেখুন) |
| Long-term memory (`memory_*` টুল) | ✅ **বিল্ট-ইন** — ফাইল-ভিত্তিক স্টোর + লেক্সিক্যাল সার্চ, কোনো ভেক্টর DB/প্লাগিন লাগে না |
| Push notification | ⚠️ কোড আছে, কিন্তু APNs/Firebase key বসানো নেই → register সফল হবে না |
| Play Store-এ প্রকাশ | ⚠️ আসল app id + নিজের keystore + privacy policy দরকার |
| এজেন্ট নিজে নিজে (screen দেখা/ট্যাপ করা) | ❌ এটি সেফটি-স্কোপে রাখা হয়নি — অ্যাপে/ফাইলে কাজ করে, UI অটোমেশন করে না |
| iOS ডিভাইসে ইনস্টল | ⚠️ Mac/Xcode/Apple signing লাগবে (CIDR/TrollStore ব্যতীত) |

---

## ৬. এখন করবেন কী

1. Actions → “Android APK and AAB” → latest ✅ → `android-apk-aab-…` নামান।
2. ফোনে **`app-debug.apk`** ইনস্টল করুন → অ্যাপ খুলুন → **Check availability** → `available: true` দেখা উচিত।
3. Lab-এ **Init workspace** → **Set auth key** (আপনার API key) → **Send message** — এটাই প্রথম সফল রান।
4. এরপর: cron দিয়ে সময়নির্ভর কাজ, skill বানানো, টুল-অনুমতি কসটমাইজ।
