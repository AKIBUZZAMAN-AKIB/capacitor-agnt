# `app.config.json` reference

`app.config.json` হলো app-specific সিদ্ধান্তের একমাত্র editable source। `app.config.schema.json` structure/type সীমা দেয়; `scripts/validate-config.mjs` cross-field, security ও policy checks চালায়। `npm run native:sync` থেকে Android manifest/build এবং iOS Info.plist/project/AppDelegate পুনরায় generate হয়। Generated native setting হাতে বদলে রাখার বদলে config/generator বদলান।

## `app`

| Field | অর্থ |
|---|---|
| `name` | launcher/display name |
| `id` | Android application ID ও iOS bundle ID; যেমন `com.company.product` |
| `versionName` | Android version name ও iOS marketing version; semver pattern |
| `versionCode` | Android-এর increasing integer |
| `buildNumber` | iOS `CFBundleVersion`/current project version |
| `description` | project metadata |
| `defaultLanguage` | default language tag; যেমন `bn`, `en` |
| `urlScheme` | deep-link custom scheme; lowercase scheme syntax |

App ID পরিবর্তনকে নতুন app identity হিসেবে বিবেচনা করুন; signing/provisioning/store record-ও বদলাতে হবে।

## `web`

| Field | অর্থ |
|---|---|
| `mode` | `static` বা `framework` |
| `staticDir` | ready static source; default `www` |
| `framework.workDir` | framework project root |
| `framework.buildCommand` | trusted shell command; native/web stage-এর আগে চলে |
| `framework.outputDir` | framework root-এর relative static output |
| `nativeStagingDir` | generated native bundle; source নয় |
| `webOutputDir` | separately served web/PWA output |
| `injectBridge` | `window.NativeKit` bundle inject; normal use-এ `true` |
| `serviceWorker.enabledForWebTarget` | শুধু web target-এ SW generate |
| `serviceWorker.cacheName` | cache namespace |
| `serviceWorker.offlineFallback` | navigation offline fallback, সাধারণত `index.html` |

সব path repository root-এর ভেতরের safe relative path হতে হয়; `..`, absolute path ও backslash নিষিদ্ধ। Native target-এ generated Service Worker রাখা হয় না।

## `network`

| Field | অর্থ |
|---|---|
| `nativeHttp` | native platform-এ `CapacitorHttp` ব্যবহার |
| `patchFetch` | Capacitor global fetch/XHR patch অন করার intent |
| `patchXMLHttpRequest` | একই global patch-এর XHR intent |
| `allowCleartext` | `http://` ও platform cleartext exception; production-এ false রাখুন |
| `allowedHostnames` | bridge request allowlist; খালি মানে যেকোনো HTTP(S) hostname |
| `connectTimeoutMs` | explicit `NativeKit.http` default connect timeout |
| `readTimeoutMs` | explicit request read timeout |

বর্তমান Capacitor global patch fetch ও XHR একসঙ্গে enable করে; দুই flag-এর যেকোনো একটি true হলে patch সক্রিয় হয় এবং validator warning দিতে পারে। বেশি predictable control চাইলে দুইটি false রেখে explicit `NativeKit.http.*`/`http.stream` ব্যবহার করুন।

Hostname entry exact (`api.example.com`) অথবা one-level/descendant suffix pattern (`*.example.com`) হতে পারে। Wildcard root `example.com`-কে নিজে match করে না; প্রয়োজন হলে দুটোই দিন। Allowlist CORS/security-এর পূর্ণ বিকল্প নয়; CSP `connect-src`-ও মিলতে হবে।

## `features`

প্রতিটি boolean bridge feature gate। Disabled feature call সাধারণত explanatory error দেয়। Native plugin package project-এ থাকতে পারে, কিন্তু generated permissions policy অনুযায়ী যোগ/বাদ যায়।

| Field | Feature |
|---|---|
| `camera` | camera/photo picker |
| `location` | foreground geolocation |
| `backgroundLocation` | custom native background tracking; policy-sensitive |
| `haptics` | impact/notification/vibration |
| `localNotifications` | reminders/local notification |
| `pushNotificationsReady` | push JS/native plugin surface; credentials নয় |
| `advancedAlarms` | Android exact/inexact/full-screen adapter, iOS AlarmKit/fallback |
| `backgroundRunner` | OS-scheduled background task |
| `agent` | on-device Rust agent (chat/cron/skills/MCP) + OS-শিডিউলড background wake ও surfaced-message ইনবক্স |
| `appBrowser` | uploaded third-party static app-এর sandboxed runtime ও broker |
| `sqlite` | native SQLite |
| `secureStorage` | Android AES-GCM/Keystore ও iOS Keychain |
| `filesystem` | sandbox filesystem |
| `fileTransfer` | progress upload/download |
| `sharing` | native share sheet |
| `networkStatus` | current network/listener |
| `nativeSSE` | native SSE/text/NDJSON stream |
| `inAppBrowser` | external URL খোলার Capgo In-App Browser plugin surface |
| `preferences` | সাধারণ key-value স্টোর |
| `nearby` | অফলাইন Nearby Connections P2P (বিস্তারিত নিচে) |

Safe defaults policy-sensitive `advancedAlarms` ও `backgroundLocation` off রাখে; feature implementation project-এ আছে এবং justified app-এ config দিয়ে enable করা যায়।

## `permissions`

`camera`, `photos`, `locationWhenInUse`, `locationAlways`, `notifications`, `alarmKit` হলো user-facing purpose string। Generic placeholder নয়—কেন, কখন, কী value দেয় তা app-specific ভাষায় লিখুন। iOS Info.plist generation-এ প্রয়োজনমতো বসে। Android runtime request-এর আগে UI rationale দেওয়াও app code-এর দায়িত্ব।

## `android`

| Field | অর্থ |
|---|---|
| `minSdk` | minimum Android API; Capacitor 8 baseline 24 |
| `targetSdk` / `compileSdk` | current template baseline 36 |
| `exactAlarmPermissionMode` | `schedule`, `use`, বা `none` |
| `fullScreenAlarm` | full-screen intent permission/component behavior |
| `backgroundLocationForegroundService` | location FGS permissions/service eligibility |
| `alarmSoundName` | Android raw resource name বা `default` |
| `notificationChannelId` | general notification channel ID |
| `alarmChannelId` | alarm/ringing channel ID |

`SCHEDULE_EXACT_ALARM` user-controlled special access; adapter access না পেলে inexact fallback report করতে পারে। `USE_EXACT_ALARM` এবং full-screen intent Play policy-restricted—শুধু eligible core alarm/calendar/calling behavior-এর জন্য। Channel ID release-এর পরে বদলালে পুরোনো user channel settings migrate হয় না।

## `ios`

| Field | অর্থ |
|---|---|
| `deploymentTarget` | minimum iOS; baseline `15.0` |
| `teamId` | optional 10-character Apple Team ID; secret নয়, কিন্তু blank রেখে CI override করা যায় |
| `alarmKitOnIOS26` | iOS 26+ AlarmKit path; `advancedAlarms`-ও true হতে হবে |
| `backgroundFetch` | `UIBackgroundModes: fetch` |
| `backgroundProcessing` | background processing mode ও runner support |
| `backgroundLocation` | location background mode; policy-sensitive |
| `pushCapabilityConfigured` | remote-notification mode ইতিমধ্যে provisioning/capability-তে configured কিনা |

`pushCapabilityConfigured=true` শুধু plist mode যোগ করে; APNs entitlement/profile/certificate ও provider/Firebase setup নিজে করে না। AlarmKit unavailable/denied হলে Local Notifications fallback ব্যবহৃত হয়। বর্তমান AlarmKit adapter fixed-date alarm নেয়; recurrence fallback path-এ Local Notifications interval হিসেবে থাকে।

## `appBrowser`

`features.appBrowser` ও `appBrowser.enabled` একই হতে হবে। এটি third-party package importer/runtime; trusted host bundle-এর security model বদলায় না।

| Field | অর্থ |
|---|---|
| `enabled` | host management API ও package runtime চালু |
| `maxApps` | IndexedDB-তে সর্বোচ্চ installed package |
| `maxPackageBytes` | package expanded/installed byte limit |
| `maxFiles` | package file-count limit |
| `auditLogLimit` | device-local bounded API audit record |
| `maxRequestsPerMinute` | প্রতি running app session-এর broker RPC rate limit |
| `defaultCapabilities` | manifest-requested capability-র মধ্যে initial `allow`; zero-trust default `[]` |
| `permissionPrompts.enabled` | `ask` decision-এ trusted call-time consent UI চালু; false হলে `ask` call fail-closed |
| `permissionPrompts.requestTimeoutMs` | pending consent-এর 5000–110000 ms deadline; default 90000 |
| `permissionPrompts.requestedCapabilityDefault` | manifest-requested capability-র initial `ask`, `allow` বা `block` |
| `permissionPrompts.unrequestedCapabilityDefault` | manifest-এ না চাওয়া capability-র initial decision; recommended `block` |
| `allowDirectWebNetwork` | installed package renderer-এ policy host-এর browser `fetch`/XHR/WebSocket ও image/media traffic; false হলে শুধু audited NativeKit HTTP |
| `urlMode.enabled` | remote HTTPS page-এর আলাদা browser-only, bridge-free controller চালু |
| `urlMode.allowedHosts` | optional global exact/`*.` host এবং optional port allowlist; খালি হলে initial URL-এর host navigation boundary |
| `renderer` | `isolated` (native maximum-isolation path) বা explicit `iframe` |
| `isolated.enabled` | native isolated renderer ও private package staging চালু |
| `isolated.fallbackToIframe` | native isolation unavailable/launch-failed হলে opaque iframe fallback অনুমোদন; false হলে fail-closed |
| `isolated.stageChunkBytes` | IndexedDB package থেকে private native store-এ প্রতি base64 staging chunk-এর raw byte size; 65536–524288 |
| `isolated.androidMinApi` | Android separate-process data-directory path-এর minimum API; বর্তমানে নিরাপদ floor 28–36 |
| `isolated.hangTerminationDelayMs` | renderer unresponsive হওয়ার পরে Android termination/iOS heartbeat replacement delay; 1000–30000 ms |

`renderer="isolated"` হলে `isolated.enabled=true`, `androidMinApi>=28`, এবং native target-এ staging/open plugin প্রয়োজন। Browser web target, পুরোনো Android, unsupported System WebView বা native launch failure-এ fallback কেবল `fallbackToIframe=true` হলে চলে; manager/session status-এ renderer identity দেখা যায়। সবচেয়ে কঠোর deployment-এ fallback false রাখুন।

Android native path fixed `:nativekit_isolated` app process, authenticated/chunked Messenger IPC, WebView renderer watchdog এবং recovery UI ব্যবহার করে। System WebView multi-profile feature থাকলে প্রতি app-এ আলাদা persistent profile; না থাকলে আলাদা registrable virtual site, disabled third-party cookies এবং site-scoped cleanup path ব্যবহার হয়। iOS-এ JavaScript/Web content WebKit process-এ থাকে; heartbeat ব্যর্থ হলে WebView fresh process pool-সহ বদলানো হয়। iOS 17+ stable per-app `WKWebsiteDataStore`; iOS 15–16 isolation অক্ষুণ্ণ রাখতে nonpersistent store ব্যবহার করে।

Capability enum: `permissions`, `http`, `camera`, `location`, `backgroundLocation`, `haptics`, `notifications`, `alarms`, `background`, `preferences`, `secureStorage`, `sqlite`, `filesystem`, `fileTransfer`, `sharing`, `networkStatus`, `appInfo`, `pushNotifications`, `browser`। Installed app-এর `browser.open` brokered native method; এটি `appBrowser.openUrl()` remote browsing tier-এর সমার্থক নয়। Global feature বন্ধ থাকলে default grant validation fail করে বা runtime global gate deny করে।

`urlMode` শুধু trusted host-এর `NativeKit.appBrowser.openUrl()`-এর জন্য। URL অবশ্যই credential-বিহীন `https:`। Remote document-এ NativeKit object, broker transport, injected bootstrap/script handler বা native API prompt নেই। Android-এ supported হলে stable dedicated remote profile এবং iOS 17+-এ stable named persistent website-data store ব্যবহার হয়; এগুলো session close-এ ইচ্ছাকৃতভাবে retained থাকে যেন browser cookie/storage usable হয়। iOS 15–16 public arbitrary named store না থাকায় default persistent store ব্যবহৃত হয়। এটি installed app profile নয়।

Config limits ছাড়াও hard bounds আছে: broker RPC JSON payload 2,097,152 UTF-8 bytes, Preferences/Secure Storage প্রতি app 64 key, SQLite প্রতি app 8 DB ও প্রতি DB 64 MiB, filesystem মোট 64 MiB/512 file, filesystem encoded read/write string 1,835,008 bytes (encoding ছাড়া base64 read source সর্বোচ্চ 1,376,256 bytes), transfer file 32 MiB, notification/alarm প্রতি app 16 এবং সব broker app মিলিয়ে 32। Quota scan/stat অনিশ্চিত হলে broker fail-closed হয়; installed `filesystem.getUri` exposed নয়। পূর্ণ table: [`API-REFERENCE.bn.md`](./API-REFERENCE.bn.md)।

Policy semantics-এ durable state `ask`, `allow`, `block`। App disable ও capability `block` absolute master revocation; stale method `allow` capability block bypass করতে পারে না। Capability `ask/allow` হলে method decision থাকলে সেটি precedence পায়, না থাকলে capability decision inherit করে। Effective `ask` call pending হয় এবং host `allow_once`, `allow_always`, `block_once`, বা `block_always` দেয়; `*_always` method decision persist করে। Global feature gate, hard-coded façade allowlist, ownership/quota/host validation এবং OS permission কখনো override হয় না।

## `backgroundRunner`

| Field | অর্থ |
|---|---|
| `label` | Capacitor Background Runner label |
| `event` | runner event name |
| `repeat` | recurring request |
| `intervalMinutes` | requested minimum; 15–10080 |
| `autoStart` | plugin auto scheduling |
| `taskIdentifier` | iOS permitted task identifier; label-এর সমান হতে হবে |
| `defaultSyncUrl` | optional direct sync endpoint; খালি থাকলে runner no-op/metadata update |

`runners/background-runner.js` bounded কাজ করে এবং isolated synchronous `CapacitorKV` ব্যবহার করে। Interval exact নয়; OS power/network/user behavior অনুযায়ী defer/skip করতে পারে। Owned backend বাধ্যতামূলক নয়—URL খালি রাখা বৈধ।

## `agent`

`features.agent` চালু থাকলে এজেন্টের OS-শিডিউলড wake ও surfaced-message ইনবক্সের ডিফল্ট।
প্ল্যাটফর্মের floor কখনো লঙ্ঘন করা হয় না — Android-এ WorkManager periodic work ১৫ মিনিটের নিচে
নেয় না, আর `minWakeIntervalMinutes`-এর schema সর্বনিম্ন ১৫; OS যদি চাওয়ার চেয়ে বেশি দেয়, সেটাই
`scheduleBackgroundWakes()`-এর উত্তরে `intervalMinutes` হিসেবে ফেরে (চাওয়া মান থাকে
`requestedIntervalMinutes`-এ)।

| Field | অর্থ |
|---|---|
| `wakeIntervalMinutes` | interval না দেওয়া হলে এই মান অনুরোধ করা হয় (15–1440, ডিফল্ট 30) |
| `minWakeIntervalMinutes` | floor, schema-তে 15–1440 (ডিফল্ট 15) |
| `surfacedLimit` | `loadSurfacedMessages()`-এর ডিফল্ট page size (1–500, ডিফল্ট 50) |
| `markSurfacedRead` | পড়ার সময় `read` flag বসাবে কি না (ডিফল্ট false) |

`requiresCharging` এখানে নেই — সেটা ইঞ্জিনের নিজের `scheduler_config.runOnCharging` থেকেই আসে
(Android-এ `setRequiresCharging`, iOS-এ `requiresExternalPower`), কারণ একটি wake মানে পূর্ণ
agent turn + LLM কল = নেটওয়ার্ক ও ব্যাটারি খরচ। প্ল্যাটফর্ম-বাস্তবতাসহ বিস্তারিত:
[`BACKGROUND-WAKES.bn.md`](./BACKGROUND-WAKES.bn.md)।

## `security`

| Field | অর্থ |
|---|---|
| `trustedLocalContentOnly` | schema-তে বাধ্যতামূলক `true` |
| `allowNavigation` | WebView-এ extra top-level navigation; default খালি |
| `contentSecurityPolicy` | staged `index.html`-এ inject করা CSP |

`allowNavigation` request allowlist নয় এবং remote code-কে safe করে না। External script অনুমতি দিলে সেই script NativeKit access পেতে পারে—default CSP-তে remote scripts নিষিদ্ধ রাখুন। `unsafe-inline` বর্তমান replaceable static app compatibility-এর জন্য আছে; production app সম্ভব হলে nonce/hash/external local script দিয়ে কঠোর করুন।

## Validation

```bash
npm run validate:config
```

Validator schema ছাড়াও অন্তত এসব সম্পর্ক দেখে:

- background label/task identifier match
- sensitive feature ও platform mode alignment
- native HTTP patch intent consistency
- cleartext/navigation/security warning
- trusted local content invariant
- sync URL/host/protocol suitability
- App Browser prompt defaults/timeout, URL-mode HTTPS host syntax এবং isolated-renderer dependency

`npm run check` config validation-এর সঙ্গে typecheck, tests ও staging-ও চালায়।

---

## `features.nearby` (24 আগস্ট 2026 সংযোজন)

- schema ডিফল্ট: `false` (বর্তমান TestLab কনফিগে `true`) — `true` দিলে **Nearby Connections P2P** সক্রিয় হয় (TestLab-এ "📡 Nearby P2P" কার্ড)।
- কনফিগ-ফ্লো: `capacitor.config.ts`-এ `plugins.NearbyConnections = { endpointName: app.name, serviceID: app.id }` অটো-জেনারেট; strategy runtime-এ `NativeKit.nearby.initialize({ strategy })`-তে যায় (UI-তে বদলানো যায় — পরিবর্তনে Reset → Start)।
- **Android নিয়ম:** প্লাগিনটা ফাঁকা manifest শিপ করে — `configure-native.mjs` টেমপ্লেটেই BLUETOOTH(_ADMIN)/SCAN(neverForLocation)/ADVERTISE/CONNECT, NEARBY_WIFI_DEVICES(neverForLocation), ACCESS/CHANGE_WIFI_STATE, CHANGE_NETWORK_STATE জেনারেট হয়; BLUETOOTH/BLUETOOTH_ADMIN `android:maxSdkVersion="30"`-সীমিত, আর bluetooth/bluetooth_le/wifi.aware-এর `uses-feature … required="false"` বসে — যাতে হার্ডওয়্যার-বিহীন ডিভাইসেও ইনস্টল চলে (শিক্ষা: ম্যানিফেস্ট হাতে এডিট হারায় — টেমপ্লেটেই করুন)।
- **iOS:** `NSBluetoothAlwaysUsageDescription` + `NSLocalNetworkUsageDescription` প্লিস্টে বসে (দুটোই টেমপ্লেটের নির্দিষ্ট বাংলা usage-স্ট্রিং — `permissions.*` ম্যাপের আলাদা কী নয়)।
- **মিনি-অ্যাপ এক্সপোজার: নেই।** `nearby` trusted `www/`-এরই; installed App Browser mini-app-এর broker capability তালিকায় (`APP_BROWSER_CAPABILITIES`, ১৯টা) নেই — তাই মিনি-অ্যাপ এই API ডাকতেই পারে না। বিস্তারিত: API-REFERENCE-এর নিকট সেকশন।
- **GMS আবশ্যক** — Play Services-বিহীন ডিভাইসে `initialize` ব্যর্থ হবে; অ্যাপের বাকি সব ফিচার তখনও ঠিকঠাক চলে।
