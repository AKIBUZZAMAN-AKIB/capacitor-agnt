# NativeKit সম্পূর্ণ API, Architecture ও Permission রেফারেন্স

> **Source-verified Bangla reference**
> Repository: `AKIBUZZAMAN-AKIB/capacitor-agnt`
> মূল source baseline: `523c277c5cca27436c1d762fd62eaeb945ce5f79` + Mini App UI artifact feature changes
> যাচাইয়ের তারিখ: ১১ নভেম্বর ২০২৬
> Mini App ডেভেলপার হলে পাশাপাশি [`MINI-APP-API-GUIDE.bn.md`](./MINI-APP-API-GUIDE.bn.md) পড়ুন।

এই নথি বর্তমান **runtime source code** দেখে লেখা—শুধু পুরোনো README বা type declaration দেখে নয়। মূল উৎস: `bridge/nativekit.ts`, `bridge/app-browser.ts`, `bridge/device-tools.ts`, `bridge/mcp-client.ts`, `plugins/*`, `scripts/configure-native.mjs`, `app.config.json` ও `app.config.schema.json`।

## 1. সবচেয়ে গুরুত্বপূর্ণ বিষয়: API কার জন্য

একই `window.NativeKit` নাম ব্যবহৃত হলেও তিনটি trust tier-এর ক্ষমতা সমান নয়।

| Trust tier | কোড কোথা থেকে আসে | কী পায় |
|---|---|---|
| **Trusted host/main app** | সম্পাদকের reviewed `www/` bundle | এই নথির পূর্ণ host facade; প্রয়োজনে raw Capacitor plugin-ও import করা যায় |
| **Installed Mini App** | ZIP/static files/web component | শুধু token-bound, per-app policy-নিয়ন্ত্রিত brokered subset; কোনো raw plugin নয় |
| **Remote HTTPS URL** | `appBrowser.openUrl()` দিয়ে খোলা remote page | **কোনো `NativeKit` API নেই**; browser-only session |

Mini App-এর পূর্ণ method matrix আলাদা নথিতে দেওয়া হয়েছে। Mini App-এর কোড trusted `www/`-তে বসালে সেটি host-এর সব native ক্ষমতা পেয়ে যেতে পারে—তৃতীয় পক্ষের কোড সেখানে বসাবেন না।

## 2. Architecture সংক্ষেপে

- **Shell:** Capacitor 8, Android/iOS এবং hosted web target।
- **Bridge build:** `scripts/build-bridge.mjs` `bridge/nativekit.ts` bundle করে এবং `types/nativekit.d.ts.template` থেকে declaration তৈরি করে।
- **Native configure:** `scripts/configure-native.mjs` `app.config.json` থেকে Android manifest, iOS `Info.plist`, `AppDelegate`, widget provider ও native version/config লেখে।
- **Main bridge:** `bridge/nativekit.ts` Capacitor official plugins + local native plugins-কে `window.NativeKit` facade-এ সাজায়।
- **Mini App broker:** `bridge/app-browser.ts` IndexedDB-তে package/policy/audit রাখে; iframe বা isolated renderer-এ ছোট bootstrap inject করে; প্রতিটি native call token, app policy, feature flag, quota ও rate limit দিয়ে যায়।
- **Agent:** `plugins/native-agent` Java/Kotlin/Swift → UniFFI → Rust engine। LLM provider, tool loop, session, cron, memory ও document index এখানে থাকে।
- **Device MCP:** `bridge/device-tools.ts` native device কাজগুলোকে in-process MCP server হিসেবে দেয়; tool নাম হয় `device__<tool>`।
- **Remote MCP:** `bridge/mcp-client.ts` Streamable HTTP JSON-RPC client; `2026-07-28` current protocol আগে, প্রয়োজনে legacy `2025-06-18` fallback।

### বর্তমান config snapshot

`app.config.json`-এ সব feature flag `true`; Android `minSdk=24`, `targetSdk=36`, `compileSdk=36`; iOS deployment target `15.0`। App Browser renderer `isolated`, Android isolated minimum API 28, iframe fallback `true`। Push code আছে, কিন্তু `ios.pushCapabilityConfigured=false` এবং Firebase/APNs credentials নেই।

---

## 3. Trusted host bridge ব্যবহারের মূলনীতি

```js
window.addEventListener('nativekitready', async () => {
  const NK = await window.NativeKit.ready();
  console.log(NK.platform, NK.isNative, NK.capabilities());
}, { once: true });

// Script load-এর আগে থেকেই bridge থাকলে:
const NK = await window.NativeKit.ready();
```

### সাধারণ gate

- `features.<name>=false` হলে সংশ্লিষ্ট facade method `Error` throw/reject করে: `NativeKit feature disabled in app.config.json: <name>`।
- `agent` ও `widget` method-এ native build বাধ্যতামূলক; web-এ `requireNative()` error হয়।
- `capabilities()` feature flag রিপোর্ট করে; এটি OS permission বা native ABI availability-এর নিশ্চয়তা নয়।
- Listener/watch/stream শেষে `remove()`/`close()` করুন।

```js
const listener = await NK.network.onChange(console.log);
await listener.remove();

const watch = await NK.location.watch((position, error) => {
  console.log(position, error);
});
await watch.remove();
```

### JSON-string ফলাফল

Agent-এর অনেক low-level ফলাফল `sessionsJson`, `jobsJson`, `permissionsJson`, `modelsJson`, `recordJson` ইত্যাদি string হিসেবে আসে। এগুলো `JSON.parse()` করতে হবে। `agent.getRuntimeConfig()`, `getSchedulerConfig()` ও `memory.*` উপযুক্ত জায়গায় parsed object দেয়।

---

## 4. সম্পূর্ণ top-level `NativeKit` map

| Member | ধরন/কাজ |
|---|---|
| `version` | bridge version string; বর্তমানে `1.0.0` |
| `config` | build-time config-এর frozen top-level object |
| `platform`, `isNative` | `android`/`ios`/`web` এবং native কিনা |
| `ready()` | DOM প্রস্তুত হলে একই facade resolve করে |
| `capabilities()` | platform + feature flags + caveats |
| `biometric` | trusted biometric verification |
| `permissions` | camera/location/notification/push/alarm status ও request |
| `http` | request/get/post এবং SSE/text/NDJSON stream |
| `camera` | photo capture/gallery picker |
| `location` | current position/watch |
| `backgroundLocation` | native tracking, buffer ও event |
| `haptics` | impact/notification/vibrate |
| `notifications` | local notification সম্পূর্ণ facade |
| `alarms` | exact/inexact/advanced alarm facade |
| `background` | headless Background Runner dispatch |
| `preferences` | string/JSON key-value storage |
| `secureStorage` | Keystore/Keychain-backed storage |
| `sqlite` | native SQLite connection ও query |
| `filesystem` | native/web filesystem facade |
| `transfer` | download/upload |
| `browser` | in-app browser বা web popup |
| `share` | native share sheet |
| `network` | status ও change listener |
| `app` | app info/state/deep link/exit |
| `push` | FCM/APNs API; credentials আলাদা |
| `nearby` | Nearby Connections P2P |
| `serviceWorker` | web target registration cleanup |
| `widget` | home-screen ও floating widget |
| `agent` | on-device Rust AI agent, MCP, memory, cron, skills |
| `appBrowser` | Mini App install/launch/policy/audit—শুধু host manager |

---

## 5. Core, biometric ও permission API

### 5.1 Core

```ts
NK.ready(): Promise<typeof NK>
NK.capabilities(): {
  platform: string;
  native: boolean;
  serviceWorker: boolean;
  // সব config.features key;
  caveats: { cors: string; background: string; alarms: string };
}
```

### 5.2 `NK.biometric`

```ts
await NK.biometric.verify(reason?: string): Promise<{ verified: boolean }>
```

- Android-এ AndroidX BiometricPrompt ব্যবহৃত হয়; API 30+ `BIOMETRIC_STRONG`, আগের version-এ `BIOMETRIC_WEAK`।
- `always_ask_biometric` agent approval-এর আগে workspace এটি ডাকে।
- Hardware/enrollment/activity না থাকলে বা user বাতিল করলে reject—approval **fail closed**।
- **iOS implementation নেই:** custom iOS plugin-এ `verifyBiometric` registered নয়, তাই iOS-এ call reject করবে এবং biometric-gated approval দেওয়া যাবে না।
- Mini App-এ এই facade exposed নয়।

### 5.3 `NK.permissions`

| Method | কাজ |
|---|---|
| `check()` | camera, location, local notifications, push, alarm capability, background-location snapshot |
| `requestCamera()` | Capacitor Camera permission request |
| `requestLocation(coarseOnly = false)` | `['location']` অথবা শুধু `['coarseLocation']` |
| `requestNotifications()` | local notification permission |
| `requestPush()` | push receive permission |
| `openAppSettings()` | Android app details/iOS app settings |

`check()` feature-disabled অংশে `disabled`/false-like snapshot দেয়। Permission state string plugin অনুযায়ী `prompt`, `prompt-with-rationale`, `granted`, `denied`, `limited` ইত্যাদি হতে পারে।

---

## 6. HTTP ও streaming

### 6.1 `NK.http`

```ts
NK.http.request<T>(options): Promise<{ data: T; status: number; headers: Record<string,string>; url: string }>
NK.http.get<T>(url, options?)
NK.http.post<T>(url, data?, options?)

NK.http.stream(options, {
  onMessage?(message),
  onError?(error),
  onEnd?({ status })
}): Promise<{
  id: string;
  close(): Promise<void>;
  done: Promise<{ status?: number }>;
}>
```

`request` options: `url`, `method`, `params`, `data`, `headers`, `connectTimeout`, `readTimeout`, `disableRedirects`, `responseType`, `webFetchExtra`, `shouldEncodeUrlParams`, `dataType`। Stream options: `url`, `method`, `headers`, `body`, `format: 'sse'|'text'|'ndjson'`, `disableRedirects`।

### 6.2 Dispatch ও network policy

- Native-এ `network.nativeHttp=true` হলে `CapacitorHttp.request`; নইলে `window.fetch`।
- Web-এ Capacitor web adapter/fetch ব্যবহৃত হয় এবং server-এর CORS policy প্রযোজ্য।
- Native HTTP/SSE WebView CORS এড়ায়; upstream TLS/auth/WAF/rate-limit বাতিল করে না।
- `network.allowCleartext=false` হলে `http:` reject; বর্তমান config-এ false।
- শুধু `http:`/`https:` scheme allowed।
- `network.allowedHostnames=[]` হলে যেকোনো HTTP(S) host allowed; non-empty হলে exact host বা `*.example.com` wildcard। Wildcard apex `example.com`-কে অন্তর্ভুক্ত করে না।
- Same-origin request hostname allowlist-এর exception।
- Default timeout: connect 30 সেকেন্ড, read 120 সেকেন্ড; caller override করতে পারে।
- Native stream custom plugin-এর OkHttp/URLSession events ব্যবহার করে; web stream Fetch Reader ব্যবহার করে।
- `done` normal end/intentional close-এ resolve, transport/server failure-এ reject করে।

```js
const stream = await NK.http.stream({
  url: 'https://api.example.com/events',
  format: 'sse'
}, {
  onMessage: msg => console.log(msg.data, msg.event, msg.id),
  onError: console.error,
  onEnd: info => console.log('ended', info)
});
// পরে
await stream.close();
```

---

## 7. Camera, location ও background location

### 7.1 `NK.camera`

| Method | ফলাফল/নোট |
|---|---|
| `getPhoto(options?)` | default `quality:85`, `resultType:'uri'`, `source:'PROMPT'`; caller override পারে |
| `pickImages(options?)` | gallery images; quality/size/limit/presentation options |

### 7.2 `NK.location`

```ts
NK.location.current(options?): Promise<Position>
NK.location.watch(callback, options?): Promise<{ id: string; remove(): Promise<void> }>
```

`current()` default `enableHighAccuracy:true`, `timeout:15000`; watch default high accuracy। Options: `enableHighAccuracy`, `timeout`, `maximumAge`, `minimumUpdateInterval`।

### 7.3 `NK.backgroundLocation`

| Method | কাজ |
|---|---|
| `start(options?)` | custom native tracking শুরু |
| `stop()` | tracking বন্ধ |
| `status()` | running/permission/platform snapshot |
| `buffered()` | stored location points |
| `clearBuffered()` | buffer মুছে দেয় |
| `onLocation(callback)` | `nativeLocation` listener |

Options: `minTimeMs`, `minDistanceM`, `maxBuffer`, `desiredAccuracy:'high'|'balanced'|'low'`। Android-এ আগে foreground location এবং তারপর Settings থেকে **Allow all the time** দরকার; `start()` নিজে background grant তৈরি করে না। iOS-এ Always authorization এবং configured background location mode লাগে। OS execution/store approval guaranteed নয়।

---

## 8. Haptics, local notification ও advanced alarm

### 8.1 `NK.haptics`

```ts
NK.haptics.impact('LIGHT'|'MEDIUM'|'HEAVY' = 'MEDIUM')
NK.haptics.notification('SUCCESS'|'WARNING'|'ERROR' = 'SUCCESS')
NK.haptics.vibrate(durationMs = 300)
```

### 8.2 `NK.notifications`

| Method | কাজ |
|---|---|
| `check()`, `request()` | permission |
| `schedule(notifications)` | একাধিক local notification schedule |
| `cancel(numberIds)` | pending বাতিল |
| `pending()` | pending list |
| `delivered()` | delivered list |
| `removeDelivered(numberIds)` | শুধু matching delivered item remove |
| `createChannel(channel)` | Android notification channel |
| `onReceived(cb)` | foreground receive event |
| `onAction(cb)` | notification action event |

Notification fields: numeric `id`, `title`, `body`, `schedule`, `sound`, `attachments`, `actionTypeId`, `extra`, `channelId`, icons/group/ongoing/autoCancel ইত্যাদি। Schedule: `at`, `repeats`, `every`, `on`, `count`, `allowWhileIdle`।

### 8.3 `NK.alarms`

| Method | কাজ |
|---|---|
| `capabilities()` | `exact`, `fullScreen`, `alarmKit`, fallback/platform |
| `requestExactAccess()` | Android exact-alarm settings/iOS AlarmKit বা notification authorization |
| `requestFullScreenAccess()` | Android 14+ full-screen settings; iOS-এ fullScreen false |
| `schedule(options)` | `id`, `title`, `at` প্রয়োজন; `body`, repeat/fullScreen/sound/extra optional |
| `cancel(id)` | owned alarm বাতিল |
| `list()` | persisted alarms |
| `stop(id?)` | ringing alarm stop; id না দিলে সব |
| `onFired(cb)` | `nativeAlarmFired` event |

`at` ISO/date-compatible string, `Date` বা epoch milliseconds। Android exact access না থাকলে adapter inexact native fallback রিপোর্ট করতে পারে। iOS 26 + AlarmKit compile/authorization থাকলে fixed-date AlarmKit; নইলে Local Notification fallback। `USE_EXACT_ALARM` ও full-screen intent store-policy sensitive।

---

## 9. Background Runner

```ts
NK.background.dispatch(details?)
NK.background.runSyncNow(details?)
NK.background.checkPermissions()
NK.background.requestPermissions(['geolocation', 'notifications'])
```

- Config: `backgroundRunner.label`, `event`, `repeat`, `intervalMinutes`, `autoStart`, `taskIdentifier`, `defaultSyncUrl`।
- Runner file: `runners/background-runner.js`; staged copy `www/runners/background-runner.js`।
- `runSyncNow(details)` `defaultSyncUrl` যোগ করে একই configured event dispatch করে।
- Runner-এর `CapacitorKV` আলাদা headless KV context; এটিকে trusted `Preferences` facade-এর interchangeable API ভাববেন না।
- Headless context-এ DOM/`window.NativeKit` নেই। উপলব্ধ standard APIs-এর মধ্যে `console`, TextEncoder/Decoder, timers, crypto, `fetch`; custom APIs-এর মধ্যে `CapacitorKV`, `CapacitorNotifications`, `CapacitorGeolocation`, `CapacitorDevice`, `CapacitorApp` রয়েছে।
- প্রতিটি event handler অবশ্যই `resolve()` বা `reject()` করবে। Task short/idempotent রাখুন; OS timing guarantee নেই।

বর্তমান runner `nativekit.sync` event শোনে, HTTPS `syncUrl` পেলে POST/নির্দেশিত method-এ request করে এবং `CapacitorKV`-তে `nativekit.sync.lastResult` লেখে।

---

## 10. Storage API

### 10.1 `NK.preferences`

```ts
set(key, value: string): Promise<void>
get(key): Promise<string | null>
remove(key): Promise<void>
clear(): Promise<void>
keys(): Promise<{ keys: string[] }>
setJSON(key, value): Promise<void>
getJSON<T>(key): Promise<T | null>
```

### 10.2 `NK.secureStorage`

```ts
set(key, value: string): Promise<void>
get(key): Promise<string | null>
remove(key): Promise<void>
clear(): Promise<void>
```

Android-এ Keystore-backed AES-GCM, iOS-এ Keychain। Web implementation bundled নয়। এটি Mini App-এর namespaced secure storage থেকে আলাদা—Mini App broker নিজের key prefix তৈরি করে।

### 10.3 `NK.sqlite`

```ts
open(name, { version?, encrypted?, mode? }?)
execute(name, statements, transaction = true)
run(name, statement, values = [], transaction = true)
query(name, statement, values = [])
close(name)
delete(name)
```

- Native SQLite only; web-এ `jeep-sqlite` bundled নয় বলে `open()` error দেয়।
- Default `encrypted:false`, mode `no-encryption`, version 1।
- SQL values parameterize করুন। Host database Mini App database থেকে আলাদা; broker per-app logical-to-native database mapping করে।

---

## 11. Filesystem ও file transfer

### 11.1 `NK.filesystem`

Directories: `Documents`, `Data`, `Library`, `Cache`, `External`, `ExternalStorage`।

```ts
readFile({ path, directory?, encoding? })
writeFile({ path, directory?, data, encoding?, recursive? })
appendFile(options)
deleteFile(options)
mkdir({ path, directory?, recursive? })
rmdir({ path, directory?, recursive? })
readdir(options)
stat(options)
getUri(options)
```

`writeFile({recursive:true})` এবং transfer download parent directory তৈরি করে। App-scoped `Data`/`Cache` ব্যবহার করলে legacy public-storage permission দরকার হয় না।

### 11.2 `NK.transfer`

```ts
download({ url, path, directory = 'Data', headers?, disableRedirects?, onProgress? })
upload({ url, path, directory = 'Data', headers?, method?, mimeType?, disableRedirects?, onProgress? })
```

URL global `assertNetworkUrl()` দিয়ে validate হয়। Progress listener স্বয়ংক্রিয়ভাবে remove হয়। Mini App facade-এ progress callback ও `disableRedirects` caller control নেই—broker redirects বন্ধ রাখে।

---

## 12. Browser, Share, Network, App, Push ও Service Worker

### 12.1 `NK.browser`

```ts
NK.browser.open('https://example.com')
NK.browser.open({ url: 'https://example.com' })
```

Native-এ Capgo InAppBrowser, web-এ `window.open(..., '_blank', 'noopener,noreferrer')`। URL global network policy মেনে চলে।

### 12.2 `NK.share`

```ts
NK.share.canShare(): Promise<{ value: boolean }>
NK.share.show({ title?, text?, url?, files?, dialogTitle? })
```

### 12.3 `NK.network`

```ts
NK.network.status(): Promise<{ connected, connectionType }>
NK.network.onChange(callback): Promise<{ remove() }>
```

### 12.4 `NK.app`

| Method | কাজ |
|---|---|
| `info()` | host app `name`, `id`, `build`, `version` |
| `state()` | `{ isActive }` |
| `onStateChange(cb)` | active/inactive event |
| `onUrlOpen(cb)` | deep-link event |
| `exit()` | native app exit; web-এ উপযুক্ত নয় |

### 12.5 `NK.push`

| Method | কাজ |
|---|---|
| `register()` | প্রয়োজনে prompt, তারপর native registration |
| `unregister()` | registration বাতিল |
| `delivered()` | delivered push list |
| `removeAllDelivered()` | সব delivered push remove |
| `onRegistration(cb)` | token event |
| `onRegistrationError(cb)` | registration failure |
| `onReceived(cb)` | foreground push |
| `onAction(cb)` | notification action |

**বর্তমান repository delivery-ready নয়:** Android-এ `google-services.json`/Firebase project/server credentials নেই; iOS-এ APNs entitlement/profile/credentials নেই। `pushNotificationsReady=true` শুধু API feature flag। Mini App-এ register/token API নেই, শুধু app-tagged received/action subscription সম্ভব।

### 12.6 `NK.serviceWorker`

- `supported`: native নয় এবং browser-এ service worker থাকলে true।
- `unregisterAll()`: সব registration unregister করে boolean array দেয়।
- Native startup-এ পুরোনো PWA worker unregister করার cleanup আলাদাভাবে চালু থাকে।

---

## 13. `NK.nearby` — Offline P2P API

### 13.1 Constants/helpers

- `MAX_PAYLOAD_BYTES = 1_047_552` (Google Connections BYTES payload limit)।
- `encodeBase64Utf8(text)`, `decodeBase64Utf8(base64)`।
- `sendPayload()` default-এ plain string UTF-8 → base64 করে; `alreadyBase64:true` দিলে পুনরায় encode করে না। Received `payload` base64 থাকে—decode করতে helper ব্যবহার করুন।

### 13.2 Methods

| Group | Methods |
|---|---|
| Lifecycle | `initialize(options?)`, `reset()` |
| Visibility | `startAdvertising(options?)`, `stopAdvertising()`, `startDiscovery(options?)`, `stopDiscovery()` |
| Connection | `requestConnection({endpointID, endpointName?})`, `acceptConnection({endpointID})`, `rejectConnection({endpointID})`, `disconnect({endpointID})` |
| Payload | `sendPayload({endpointID?|endpointIDs?, payload, alreadyBase64?})`, `cancelPayload({payloadID})` |
| Status | `status()` |
| Permission | `checkPermissions()`, `requestPermissions(groups?)` |
| Event | `addListener(eventName, callback)` |

Permission groups: `wifiNearby`, `wifiState`, `bluetoothNearby`, `bluetoothLegacy`, `location`, `locationCoarse`। Empty/omitted groups মানে সব group request।

### 13.3 ১২টি event

1. `onPermissionChanged`
2. `onBluetoothStateChanged`
3. `onEndpointFound`
4. `onEndpointLost`
5. `onEndpointInitiated`
6. `onEndpointConnected`
7. `onEndpointRejected`
8. `onEndpointFailed`
9. `onEndpointDisconnected`
10. `onEndpointBandwidthChanged`
11. `onPayloadReceived`
12. `onPayloadTransferUpdate`

`capacitor.config.ts`-এ endpoint name app name, service ID app id; strategy runtime-এ বদলানো যায়। Mini App-এ nearby API নেই; agent device tools-এর মাধ্যমে সীমিত P2P tool আছে।

---

## 14. `NK.widget` — Home-screen ও floating widget

### 14.1 Methods

| Method | কাজ |
|---|---|
| `supported()` | feature enabled + native platform |
| `listConfigs()` | সব saved kind/config |
| `getConfig(kind)` | একটি kind |
| `setConfig(kind, config)` | save, automatic reload নয় |
| `update(kind, config)` | save + reload |
| `reload(kind?)` | এক/সব widget refresh |
| `getWidgetIds(kind)` | Android IDs; iOS-এ `[]` |
| `requestPin(kind)` | Android pin prompt/hint; iOS-এ `{requested:false}` |
| `checkFloatingPermission()` | Android overlay grant |
| `requestFloatingPermission()` | Android overlay settings |
| `showFloating(options?)` | floating WebView overlay |
| `hideFloating()` | overlay বন্ধ |
| `isFloatingVisible()` | visible state |
| `updateFloating(options?)` | running overlay update |
| `runFloatingJavascript(script)` | overlay WebView-এ JS |
| `sendToFloating(data)` | page-এ data |
| `onWidgetTap(cb)` | native widget action |
| `onFloatingMessage(cb)` | floating page message |

### 14.2 Home-screen config fields

`layout:'small'|'medium'|'large'|custom`, `value`, `title`, `subtitle`, `backgroundColor`, `valueColor`/`accentColor`, `titleColor`, `subtitleColor`, `buttonColor`, `buttonTextColor`, text sizes, `align`, `progress`, `progressMax`, `icon`, `image`, `imageData`, `action`, `actionValue`, `buttonLabel`।

`render:'native'` RemoteViews/WidgetKit preset; Android-এ `render:'html'` + `html`/`page`, `htmlBaseUrl`, `widthPx`, `heightPx` দিয়ে **static snapshot** তৈরি হয়। এটি live interactive WebView নয়। Floating overlay-তেই live HTML/CSS/JS।

### 14.3 Floating options

`title`, `page`, `html`, `width`, `height`, `collapsed`, `fullscreen`, `focusable`, `touchThrough`, `chrome:'bar'|'none'`, `draggable`, `position:{gravity,align,x,y,marginX,marginY}`, `data`।

### 14.4 Platform সত্য

- **Android:** home-screen AppWidgetProvider, pin, native/HTML snapshot এবং overlay—সব implementation আছে। Floating-এর জন্য `SYSTEM_ALERT_WINDOW` + foreground service প্রয়োজন।
- **iOS:** plugin config/reload আছে, কিন্তু WidgetKit extension **example/manual integration**; App Group app ও extension দুটোতেই configure করতে হবে। Floating unsupported। `updateFloating` ও `runFloatingJavascript` iOS plugin method list-এ নেই। `requestPin()` programmatically pin করে না।
- Widget data SharedPreferences/App Group-এ যায়; sensitive data রাখবেন না।

---

## 15. `NK.agent` — On-device AI Agent API

সব Agent method `features.agent` এবং native build প্রয়োজন। `supported()` শুধু config/native বলে; ABI/native library usable কিনা জানতে `checkAvailability()` ব্যবহার করুন। Engine generation `0.5.2-public`।

### 15.1 Lifecycle, diagnostics ও runtime config

| Method | কাজ |
|---|---|
| `supported()` | feature + native boolean |
| `checkAvailability()` | ABI, 64-bit, loadable native library, reason; probe reject করে না |
| `initWorkspace(config)` | workspace তৈরি/প্রস্তুত |
| `initialize(config)` | engine handle তৈরি ও persisted config লেখা |
| `getRuntimeConfig()` | parsed persisted runtime config |
| `setRuntimeConfig(patch)` | merge patch, parsed full config ফেরত |

`config`: `{ dbPath, workspacePath, authProfilesPath }`। Relative path native bridge app-private root-এ resolve হয়। Provider/auth config দেওয়ার আগে initialize প্রয়োজন।

Provider IDs: `anthropic`, `openai`, `gemini`, `openrouter`, `ovhcloud`, `aihorde`, `llm7`, `opencode_zen`, `kilo`, `pollinations`, `webllm`; default routing-এ `auto`-ও আছে।

Runtime tuning: `temperature`, `maxTokens`, `defaultMaxTurns`, `contextCharBudget`, `mcpToolTimeoutMs`, retry delays/count, cron/heartbeat turn ও timeout, `defaultProvider`, `defaultModels`, `providerBaseUrls`, `providerModelProtocols`, `providerToolCapabilities`, `providerModelAuthRequirements`, `providerModelStreamingCapabilities`, `autoRouting`। Sandbox/approval/SSRF/output cap/wake budget arbitrary runtime setting দিয়ে শিথিল করা যায় না।

### 15.2 Agent turn ও approvals

```ts
sendMessage({
  prompt, sessionKey, model?, provider?, systemPrompt?, maxTurns?,
  allowedTools?, priorMessages?
}): Promise<{ runId: string }>
followUp(prompt)
abort()
steer(text)
respondToApproval(toolCallId, approved, reason?)
respondToMcpTool(toolCallId, resultJson, isError = false)
respondToProviderRequest(requestId, responseJson, isFinal = false, isError = false)
respondToCronApproval(requestId, approved)
onEvent(callback): Promise<{ remove() }>
```

- `allowedTools` omitted = unrestricted, `[]` = কোনো tool নয়। `allowedTools` এবং legacy `allowedToolsJson` একসঙ্গে দেওয়া যাবে না।
- `priorMessages` ও legacy `priorMessagesJson` একসঙ্গে দেওয়া যাবে না।
- `maxTurns` integer 1–100।
- Event envelope: `{ eventType, payloadJson }`; `payloadJson` সাধারণত parse করতে হবে।
- Event types: provider routing/request/bridge delta, `text_delta`, `thinking`, `tool_use`, `tool_result`, `mcp_tool_call`, `user_message`, `approval_request`, `retry`, search lifecycle, context compaction/trim/repair, completion/error, wake/cron/heartbeat lifecycle। সম্পূর্ণ union `plugins/native-agent/src/definitions.ts`-এ আছে।

### 15.3 Auth

| Method | কাজ |
|---|---|
| `getAuthToken(provider='anthropic')` | token + OAuth flag |
| `setAuthKey(key, provider='anthropic', authType='api_key')` | secret save |
| `deleteAuth(provider)` | auth delete |
| `refreshToken(provider)` | OAuth refresh |
| `getAuthStatus(provider)` | masked status |
| `exchangeOAuthCode(tokenUrl, bodyJson, contentType?)` | native token endpoint exchange |

Facade-এ `refresh`/`expiresAt` parameters রাখলে engine 0.5.2 সেগুলো support না করার কারণে স্পষ্ট error দেয়; silent drop করে না। Secret source code/audit log/MCP config-এ রাখবেন না।

### 15.4 Sessions

```ts
listSessions(agentId = 'main')
loadSession(sessionKey, agentId = 'main')
resumeSession({ sessionKey, agentId?, messagesJson?, provider?, model? })
clearSession()
```

### 15.5 Cron, heartbeat ও background wake

| Method | কাজ |
|---|---|
| `addCronJob(input)` | object বা legacy JSON string |
| `updateCronJob(id, patch)` | schedule/prompt/delivery/enable patch |
| `removeCronJob(id)` | delete |
| `listCronJobs()` | `jobsJson` |
| `runCronJob(jobId)` | এখন run |
| `listCronRuns(jobId?, limit?)` | `runsJson` |
| `handleWake(source='manual')` | foreground-এ সব due job catch-up |
| `getSchedulerConfig()` | raw JSON strings + parsed `scheduler`/`heartbeat` |
| `setSchedulerConfig(config)` | scheduler settings |
| `setHeartbeatConfig(config)` | heartbeat settings |
| `scheduleBackgroundWakes(intervalMinutes?)` | Android WorkManager/iOS BGProcessingTask |
| `cancelBackgroundWakes()` | OS task বাতিল |
| `getWakeStatus()` | OS task + last wake + due/enabled counts |
| `loadSurfacedMessages(limit?)` | background result inbox |
| `clearSurfacedMessages()` | inbox clear |

Cron schedule: `{kind:'at', atMs}` অথবা `{kind:'every', everyMs, anchorMs?}`। Delivery: `notification`, `webhook`, `silent`, `none`। Active hours local time বা fixed UTC offset।

Wake interval request 15–1440 মিনিটে clamp হয়; default 30, configured minimum 15। Android periodic floor 15 মিনিট; iOS `earliestBeginDate` floor, exact timer নয়। Wake/surfaced wrappers native scheduler unreachable হলে reject না করে `supported:false`, `reason`, `alternative` দেয়। Background-এ `webviewOnly` বা interactive approval-এর tool চলে না।

### 15.6 Skills

```ts
addSkill(input)
updateSkill(id, patch)
removeSkill(id)
listSkills()
startSkill(skillId, config = {}, provider?)
endSkill(skillId)
```

Skill input: `id?`, `name`, `allowedTools?`, `systemPrompt?`, `model?`, `maxTurns?`, `timeoutMs?`।

### 15.7 Agent tool permission

```ts
seedToolPermissions(defaults)
setToolPermission(toolName, 'always_allow'|'always_ask'|'always_ask_biometric', enabled = true)
listToolPermissions()
resetToolPermissions()
```

- `enabled:false` tool block করে।
- Facade শুধু তিনটি canonical policy গ্রহণ করে; ভুল string fail-fast।
- Persisted user policy catalogue-এর `approvalPolicy`-এর চেয়ে অগ্রাধিকার পায়।
- Built-in read-only tools সাধারণত default allow; mutation/network tools default ask।
- Default ask: `write_file`, `edit_file`, `delete_file`, `execute_command`, `git_init`, `git_add`, `git_commit`, `web_fetch`, `manage_cron`, `memory_store`, `memory_forget`, `index_document`, `forget_document`।
- Unknown/MCP tools default ask। Approval response 10 মিনিট unanswered থাকলে timeout; background wake-এ interactive approval চলে না।

### 15.8 MCP

```ts
connectMcp(servers, { withDeviceTools?: boolean } = {})
startMcp(tools)       // additive catalogue
restartMcp(tools)     // replace catalogue
setMcpTools(tools)    // high-level alias -> restartMcp
getModels(provider = 'anthropic')
invokeTool(toolName, args = {})
```

Server config: `{ name, url, headers?, protocolVersion?, approvalPolicy?, timeoutMs? }`। Real remote URL credential-free HTTPS হতে হবে; timeout 1–120 সেকেন্ড। Tool নাম `<server>__<tool>`। প্রতিটি remote tool `webviewOnly:true` এবং default `always_ask`। Connection result: `{clients, toolCount, failures, dispose()}`।

`startMcp`/`restartMcp` নিজেরা MCP server-এর সঙ্গে যোগাযোগ করে না; actual JSON-RPC client হলো `connectMcp`। Raw plugin-এ `setMcpTools` নেই—এটি শুধু high-level facade alias।

### 15.9 Memory facade

```ts
NK.agent.memory.store({ text, key?, category?, metadata? })
NK.agent.memory.recall({ query, limit? })
NK.agent.memory.search({ query, maxResults? | limit? })
NK.agent.memory.forget({ key? | query? })
NK.agent.memory.list({ prefix?, limit? } = {})
```

- `recall`/`search`: `{results, truncated}`।
- `forget({query})` শুধু candidates দেয়, মুছে না; exact `key` দরকার।
- `list()` key array বা bounded error object দিতে পারে।
- Store/forget default approval চায়; current search lexical/token-overlap, embeddings নয়।

### 15.10 Rust built-in tools — `invokeTool()` ও model-এর জন্য

| Tool | প্রধান input/কাজ |
|---|---|
| `read_file` | `path`, optional `offset_bytes`, `limit_bytes`; UTF-8 workspace read |
| `write_file` | `path`, `content`, `create_only?`; atomic write |
| `edit_file` | `path`, `old_text`, `new_text` |
| `delete_file` | `path`; regular file only |
| `list_files` | `path`, `include_skipped?` |
| `find_files` | `pattern`, `path?`, `include_skipped?` |
| `grep_files` | `pattern`, `path?`, `case_insensitive?` |
| `execute_command` | `command`, `cwd?`, `timeout_ms?`/`timeoutMs?`; **Android only**, minimal toybox, iOS unsupported |
| `git_init` | workspace git init |
| `git_status` | status |
| `git_add` | `path` |
| `git_commit` | `message`, optional author name/email |
| `git_log` | `max_count?` |
| `git_diff` | `path?` |
| `web_fetch` | `url`, optional method/headers/body/timeout; public HTTP(S), SSRF protections |
| `manage_cron` | `action` + schedule/job fields |
| `memory_recall` | `query`, `limit?` |
| `memory_store` | `text`, `key?`, `category?`, `metadata?` |
| `memory_forget` | `key?` or `query?` |
| `memory_search` | `query`, `maxResults?`/`limit?` |
| `memory_list` | `prefix?`, `limit?` |
| `index_document` | `title`, `content?`/`path?`, `doc_id?`, `source?` |
| `search_documents` | `query`, `limit?`, `doc_id?`; SQLite FTS5/BM25 |
| `list_documents` | `prefix?`, `limit?` |
| `forget_document` | `doc_id` |

File tools workspace-relative; file size/output/scan limits `tool_runner.rs`-এ enforced। Android shell থাকলেও এটি OS-level filesystem sandbox নয়; iOS-এ `execute_command` catalogue থেকেই বাদ।

### 15.11 Built-in device MCP tools

`connectMcp([], {withDeviceTools:true})` দিলে in-process `device` server যোগ হয় এবং নাম হয় `device__<name>`। User-এর নিজের `device` server দিলে built-in duplicate inject হয় না। সবগুলো `webviewOnly` + default `always_ask`; feature-disabled tools catalogue-এই থাকে না।

| Tools | Feature/platform gate |
|---|---|
| `notify` | `localNotifications` |
| `take_photo` | `camera`; workspace `photos/` |
| `get_location` | `location` |
| `vibrate` | `haptics` |
| `share` | `sharing` |
| `network_status` | `networkStatus` |
| `schedule_alarm`, `list_alarms`, `cancel_alarm`, `stop_ringing` | `advancedAlarms` |
| `open_url` | public HTTPS; agent isolated browser বা external browser |
| `web_search` | public web search; bounded results |
| `download_file`, `upload_file` | `fileTransfer`; workspace downloads/files |
| `toast`, `app_info` | UI/app info |
| `show_floating_ui`, `update_floating_ui`, `hide_floating_ui` | `widget`, **Android only** |
| `set_widget`, `pin_widget` | `widget` |
| `speak`, `stop_speaking`, `listen` | **Android only**; `listen` microphone permission চায় |
| `scan_qr` | `camera`, **Android only** |
| `dial_phone`, `compose_sms` | **Android only**; user dial/send করে, automatic call/SMS নয় |
| `torch`, `battery_status` | **Android only** |
| `pick_file` | `filesystem`, **Android only**, document picker |
| `ask_user` | trusted workspace question card |
| `zip_files`, `unzip_file` | `filesystem`; bounded archive protections |
| `sql_query` | `sqlite`; private `agent_tools` DB |
| `nearby_status`, `nearby_advertise`, `nearby_discover`, `nearby_connect`, `nearby_accept`, `nearby_send` | `nearby` |
| `stage_miniapp`, `list_miniapps`, `stop_miniapps` | `appBrowser` |
| `clipboard_write`, `clipboard_read` | **Android only** native first |
| `save_records`, `read_records`, `query_scratchpad`, `update_notes`, `clear_scratchpad` | agent SQLite scratchpad/notes |
| `compress_text` | deterministic text compaction helper |
| `extract_data` | workspace file/HTTPS source থেকে JSON/CSV extraction |
| `browser_snapshot` | `appBrowser`; current session snapshot metadata |

মোট **৫৩টি device tool spec** আছে (`nativekit-device-tools` নামটি MCP server declaration, অতিরিক্ত tool নয়)। Rate limits tool ধরনভেদে 60 সেকেন্ডে 3–20 call; যেমন SQL 20, notification 4, vibrate 3, Mini App 3, clipboard 10, search 6। এটি agent tool rate limit—Mini App broker-এর 120 req/min থেকে আলাদা।

---

## 16. `NK.appBrowser` — Host-only Mini App manager

Mini App এই manager পায় না। Install/launch করার আগে `features.appBrowser=true` এবং `appBrowser.enabled=true` দরকার। `NK.appBrowser.capabilities` read-only **২২টি** supported capability-এর list দেয়—পূর্বের ১৯টির সঙ্গে `miniUI`, `floatingUI`, `homeWidget`।

### 16.1 Install/read/lifecycle

```ts
install({ files: [{path, data, type?}], manifest? })
installWebComponent({ fileName, data?|source?, tag?, name?, id?, description? })
installFromFiles(FileList|File[], manifest?)
installFromZip(Blob, manifest?)
list()
get(appId)
usage(appId)
cleanup(appId) // data/state clear, package থাকে
remove(appId)  // package + data + policy remove
launch(appId, targetHTMLElement, { replace?, className? })
stop(sessionId)
stopAll()
sessions()
```

### 16.2 Remote URL mode

```ts
openUrl(url, { title? })
closeUrl(sessionId)
urlSessions()
```

Remote page-এ `nativeKit:false`; bootstrap বা broker পাওয়া যায় না। Current `urlMode.allowedHosts=[]` হলে initial HTTPS host navigation boundary হিসেবে কাজ করে—validator warning-ও এটি বলে।

### 16.3 Policy ও consent

```ts
getPolicy(appId)
listPendingPermissions()
resolvePermissionRequest(requestId,
  'allow_once'|'allow_always'|'block_once'|'block_always')
setEnabled(appId, enabled)
setCapabilityDecision(appId, capability, 'ask'|'allow'|'block')
setCapability(appId, capability, enabled) // legacy boolean helper
setMethodDecision(appId, method, 'inherit'|'ask'|'allow'|'block')
setMethodPermission(appId, method, boolean|null) // legacy helper
setAllowedHosts(appId, hosts) // manifest requested hosts-এর subset only
setNetworkMode(appId, 'sandboxed'|'hosts'|'full')
setMediaAutoplay(appId, enabled)
networkStats(appId?)
```

Policy-তে `capabilityDecisions`, `methodDecisions`, legacy mirrors `grants`/`methodOverrides`, `allowedHosts`, `networkMode`, `mediaAutoplay`, `colorScheme`, `enabled` থাকে। Capability `block` master revocation— stale method `allow` দিয়ে bypass করা যায় না।

### 16.4 `NK.appBrowser.artifacts` — owner-bound UI artifact manager

Mini App নিজের মূল UI থেকে আলাদা `miniUI`, `floatingUI`, `homeWidget` HTML publish করতে পারে। প্রতিটি আলাদা native store-এ source ID/name/version, revision, byte count, SHA-256, timestamps ও config-সহ থাকে। Raw global `NK.widget` kind Mini App-কে দেওয়া হয়নি।

```ts
const a = NK.appBrowser.artifacts;
a.publish(kind, input) // host-authored artifact
a.list({ sourceType?, appId?, kind? })
a.read({ sourceType?, appId?, kind, artifactId })
a.remove({ sourceType?, appId?, kind, artifactId })
a.removeOwner(appId)
a.mountMiniUI({ sourceType?, appId?, artifactId, target, replace?, className? })
a.activateHomeWidget({ sourceType?, appId?, artifactId })
a.requestPinHomeWidget({ sourceType?, appId?, artifactId })
a.showFloatingUI({ sourceType?, appId?, artifactId })
a.hideFloatingUI(selector?) // selector ছাড়া trusted host emergency stop
a.activations()
a.limits / a.kinds / a.storage
```

- Mini App common methods: `publish`, `list`, `get`, `remove`; floating-এ `checkPermission`, `requestPermission`, `show`, `hide`; home-এ `activate`, `requestPin`।
- Source authenticated `ctx.app` থেকে আসে। একই artifact ID-ও owner ও kind namespace আলাদা।
- Mini UI broker-less offline sandboxed iframe; Android floating live sandboxed WebView; Android home **static snapshot**, live WebView নয়।
- Default আটটি reserved Android provider slot (`nativekit-miniapp-slot-01`…`08`), `appBrowser.maxActiveHomeWidgets` দিয়ে 1–32 configured।
- Artifact limits: প্রতি source/kind 8, মোট 4 MiB; Mini UI 512 KiB, floating/home 256 KiB, config 32 KiB।
- Durable publish-এর পরে active refresh ব্যর্থ হলে `nativekitappbrowserstatus` state `artifactRefreshFailed`; committed artifact হারায় না।
- Remove, capability/method revoke, app disable/update/uninstall-এর সঙ্গে active surface cleanup যুক্ত।
- Native installed package bytes-ও Filesystem `Data/nativekit-object-store/packages/`–এ যায়; IndexedDB metadata-only। Legacy package native commit-এর পরে migrate হয়।
- iOS-এ native persistence/Mini UI preview আছে, arbitrary HTML floating/home activation নেই। Hosted web artifact API নেই।

সম্পূর্ণ contract, storage commit protocol, security, platform matrix, host UI ও stopwatch sample: [`MINI-APP-UI-ARTIFACTS.bn.md`](./MINI-APP-UI-ARTIFACTS.bn.md)।

### 16.5 Audit

```ts
NK.appBrowser.audit.list({ appId?, capability?, outcome?, limit? })
NK.appBrowser.audit.summary(appId?)
NK.appBrowser.audit.clear(appId?)
```

Outcome: `success`, `error`, `denied`, `rate_limited`, `cancelled`, `timeout`। Audit-এ app/method/capability/timing/error code যায়; raw argument value নয়। Pending summary শুধু type/size/key metadata দেখায়।

---

## 17. Low-level local plugin surface

এগুলো facade-এর পেছনের internal/native APIs। Trusted host code চাইলে import করতে পারে, কিন্তু সাধারণত high-level `NativeKit` ব্যবহার করা নিরাপদ। **Mini App-এর জন্য exposed নয়।**

| Plugin | Methods/নোট |
|---|---|
| `@nativekit/custom-native` | alarm, SSE, secure store, background location, settings/openUrl; Android extras: biometric, TTS, speech, QR, dial/SMS, torch, battery, document picker, clipboard |
| `@nativekit/isolated-browser` | `runtimeInfo`, stage begin/write/commit/abort/remove, `open`, remote `openUrl`/`closeUrl`, native consent UI, `postMessage`, `close`; App Browser-এর internal transport |
| `@nativekit/widget` | widget facade-এর raw native methods |
| `capacitor-native-agent` | Agent raw methods; `setMcpTools` ও friendly object/memory wrappers high-level bridge-এ যোগ হয়েছে |
| Official Capacitor packages | App, Camera, Filesystem, File Transfer, Geolocation, Haptics, Keyboard, Local/Push Notifications, Network, Preferences, Share, Background Runner, SQLite, Nearby, InAppBrowser—host facade-এর backing |

iOS custom plugin-এ Android-only extras registered নয়। Raw declaration file-এ method থাকা মানেই দুই platform-এ implementation আছে—এমন নয়।

### 17.1 Raw `NativeKitCustom` methods

```text
checkAlarmCapabilities, requestExactAlarmAccess, requestFullScreenIntentAccess,
scheduleAlarm, cancelAlarm, listAlarms, stopRinging,
startSSE, stopSSE,
secureSet, secureGet, secureRemove, secureClear,
startBackgroundLocation, stopBackgroundLocation, getBackgroundLocationStatus,
getBufferedLocations, clearBufferedLocations, openAppSettings, openUrl,
verifyBiometric,
ttsSpeak, ttsStop, listenSpeech, scanQrCode, dialPhone, composeSms,
setTorch, batteryStatus, pickDocument, clipboardSetText, clipboardGetText,
addListener
```

Events: `nativeSSEData`, `nativeSSEEnd`, `nativeSSEError`, `nativeLocation`, `nativeAlarmFired`। `verifyBiometric` এবং শেষের hardware/speech/QR/dial/SMS/torch/battery/document/clipboard methods Android-only; `openUrl` declared হলেও high-level facade সাধারণত InAppBrowser ব্যবহার করে।

### 17.2 Raw `NativeKitIsolatedBrowser` methods

```text
runtimeInfo, isStaged, beginStage, writeStageChunk, commitStage, abortStage,
removeStagedApp, open, openUrl, closeUrl,
requestPermission, dismissPermission, postMessage, close, addListener
```

Events: `isolatedBrowserRequest`, `isolatedBrowserStatus`, `remoteBrowserStatus`। এগুলো internal package staging, isolated RPC ও trusted consent plumbing; untrusted Mini App সরাসরি ডাকতে পারে না।

### 17.3 Raw `NativeKitWidget` methods

```text
setConfig, getConfig, listConfigs, getWidgetIds, reload, requestPin,
checkOverlayPermission, requestOverlayPermission,
showFloating, hideFloating, isFloatingVisible,
updateFloating, runFloatingJavascript, sendToFloating, addListener
```

Events: `nativeWidgetTap`, `nativeFloatingMessage`। High-level facade argument unwrapping ও feature/native gates যোগ করে। iOS-এ floating এবং `updateFloating`/`runFloatingJavascript` সীমাবদ্ধতা আগের Widget অংশ প্রযোজ্য।

### 17.4 Raw `NativeAgent` method contract

Raw plugin options সাধারণত `{...Json}` string নেয় এবং `{...Json}` string ফেরত দেয়। High-level facade-এর সঙ্গে মিলিয়ে raw names:

```text
checkAvailability, initWorkspace, initialize, getRuntimeConfig, setRuntimeConfig,
sendMessage, followUp, abort, steer, respondToApproval, respondToMcpTool,
respondToProviderRequest, respondToCronApproval,
getAuthToken, setAuthKey, deleteAuth, refreshToken, getAuthStatus, exchangeOAuthCode,
listSessions, loadSession, resumeSession, clearSession,
addCronJob, updateCronJob, removeCronJob, listCronJobs, runCronJob, listCronRuns,
handleWake, getSchedulerConfig, setSchedulerConfig, setHeartbeatConfig,
scheduleBackgroundWakes, cancelBackgroundWakes, getWakeStatus,
loadSurfacedMessages, clearSurfacedMessages,
addSkill, updateSkill, removeSkill, listSkills, startSkill, endSkill,
seedToolPermissions, setToolPermission, listToolPermissions, resetToolPermissions,
startMcp, restartMcp, getModels, invokeTool, addListener
```

`setMcpTools`, parsed runtime/memory helpers এবং `connectMcp` raw plugin-এর method নয়—সেগুলো JS high-level integration।

---

# Permission সম্পূর্ণ গাইড

## 18. Permission-এর স্তর

একটি native call সফল হতে সাধারণত নিচের স্তরগুলো লাগে:

1. **Build feature:** `app.config.json → features.*` এবং প্রয়োজনীয় native configuration।
2. **Trust-tier policy:** Mini App হলে manifest requested capability + per-app/per-method host decision। Agent tool হলে enabled + approval policy।
3. **OS permission/access:** Android runtime/special settings বা iOS authorization।
4. **External readiness:** Firebase/APNs, App Group, network server, ABI, hardware, store eligibility ইত্যাদি।

Manifest-এ `<uses-permission>` থাকা মানে user grant আছে—এমন নয়। `Info.plist` purpose string থাকাও authorization নয়।

## 19. Android permission কোথায় ও কীভাবে আসে

### 19.1 App manifest generator

মূল ফাইল: `scripts/configure-native.mjs → androidPermissions()/androidManifest()`। Output: `android/app/src/main/AndroidManifest.xml`। `npm run native:sync` চালালে output config অনুযায়ী পুনরায় লেখা হয়।

| Config condition | App manifest-এ যোগ হয় |
|---|---|
| সবসময় | `INTERNET`, `ACCESS_NETWORK_STATE` |
| `features.camera` | `CAMERA`; optional camera hardware feature |
| `features.location || backgroundLocation` | `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`; optional GPS feature |
| local/push/alarm/backgroundLocation | `POST_NOTIFICATIONS` |
| `advancedAlarms` | `VIBRATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` |
| `android.exactAlarmPermissionMode='schedule'` | `SCHEDULE_EXACT_ALARM` |
| mode `'use'` | `USE_EXACT_ALARM` |
| `android.fullScreenAlarm` | `USE_FULL_SCREEN_INTENT` |
| background location FGS enabled | `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` |
| `features.filesystem` | `READ_EXTERNAL_STORAGE maxSdkVersion=32`, `WRITE_EXTERNAL_STORAGE maxSdkVersion=28` |
| `features.nearby` | legacy/current Bluetooth, nearby Wi-Fi, Wi-Fi state/change permissions + optional hardware features |
| floating widget enabled | `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE` |

Current app manifest-এ `exactAlarmPermissionMode:'schedule'`, full-screen alarm, background location FGS, nearby এবং floating—সব enabled।

### 19.2 Plugin manifests থেকে manifest merge

**গুরুত্বপূর্ণ:** feature flag শুধু app-এর generated manifest conditional entry নিয়ন্ত্রণ করে। Dependency plugin এখনো project-এ থাকলে তাদের নিজস্ব permission final merged manifest-এ যুক্ত হতে পারে। তাই feature false করাকে final APK থেকে সব permission অপসারণের নিশ্চয়তা ভাববেন না।

| Source | Permission |
|---|---|
| `@capacitor/background-runner` | network state, exact alarm, coarse/fine/background location, post notifications |
| `@capacitor/local-notifications` | boot completed, wake lock, post notifications, exact alarm |
| `@capacitor/haptics` | vibrate |
| `@capgo/capacitor-inappbrowser` | camera |
| `plugins/custom-native` | `RECORD_AUDIO`; plus alarm/location services, boot receiver |
| `plugins/native-agent` | post notifications, boot completed, wake lock, foreground service, internet, network state |
| `@capacitor/push-notifications` | Firebase messaging service declaration |
| Nearby plugin | manifest empty—তার BT/Wi-Fi permissions app generator দেয় |

Final release-এ Gradle-এর merged manifest/APK analyzer দিয়ে effective permission যাচাই করুন। সম্পূর্ণ strip দরকার হলে unused dependency বাদ দিন অথবা সচেতন manifest-merge removal strategy ব্যবহার করুন; শুধু facade gate যথেষ্ট নয়।

### 19.3 Runtime/special access mapping

| কাজ | Request/check পদ্ধতি |
|---|---|
| Camera photo | `permissions.requestCamera()`; Camera plugin call-ও prompt করতে পারে |
| QR scan | custom Android plugin alias `camera` দিয়ে request করে |
| Speech recognition | custom Android plugin alias `recordAudio` দিয়ে `RECORD_AUDIO` request করে |
| Foreground location | `permissions.requestLocation(coarseOnly?)` |
| Background location | আগে foreground grant; Android 10+ Settings-এ **Allow all the time**; custom `start()` grant ছাড়া reject |
| Local notification | `notifications.request()`; Android 13+ runtime permission |
| Push | `permissions.requestPush()`/`push.register()` + Firebase config |
| Exact alarm | `alarms.capabilities()` → `requestExactAccess()` → Settings; ফিরে capability আবার দেখুন |
| Full-screen alarm | Android 14+ special settings; valid alarm/call use-case |
| Floating overlay | `widget.checkFloatingPermission()` → `requestFloatingPermission()` → `SYSTEM_ALERT_WINDOW` settings |
| Nearby | `nearby.checkPermissions()`/`requestPermissions(groups)`; Android version অনুযায়ী BT/Wi-Fi groups |
| Biometric | system BiometricPrompt; enrolled biometric দরকার |
| Internet/network state/wake/boot/FGS | সাধারণ manifest declaration; user runtime dialog নয় |
| App-private Data/Cache filesystem | runtime storage permission দরকার নেই |

`requestExactAccess()`, full-screen ও overlay request সাধারণত Settings খোলায়—returned Promise resolve হওয়া grant-এর প্রমাণ নয়। ফিরে এসে status re-check করুন।

## 20. iOS permission ও capability কোথায়

মূল generated file: `ios/App/App/Info.plist`; generator: `scripts/configure-native.mjs → infoPlist()`। Purpose text `app.config.json → permissions` থেকে আসে।

| Feature | `Info.plist` key/config |
|---|---|
| Camera/photos | `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription` |
| Foreground location | `NSLocationWhenInUseUsageDescription` |
| Background location | `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationAlwaysUsageDescription` + `UIBackgroundModes: location` (দুই config flag প্রয়োজন) |
| AlarmKit enabled | `NSAlarmKitUsageDescription`; current `alarmKitOnIOS26=false`, তাই key বর্তমানে নেই |
| Background Runner | `BGTaskSchedulerPermittedIdentifiers` এ `backgroundRunner.taskIdentifier`; `fetch`/`processing` config |
| Agent wake | identifier `io.t6x.nativeagent.wake`; `features.agent` enabled থাকলে `processing` mode যোগ হয় |
| Nearby | `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription` |
| Push configured | `UIBackgroundModes: remote-notification`; APNs entitlement/profile আলাদা |
| Cleartext enabled | `NSAppTransportSecurity → NSAllowsArbitraryLoads`; current false |

Notification authorization-এর জন্য Android-এর মতো custom `NS...UsageDescription` দরকার নেই; UserNotifications framework permission prompt ব্যবহার হয়। Agent `initialize()` iOS-এ notification authorizationও চায়।

### বর্তমান iOS সীমাবদ্ধতা

- Microphone speech recognition implementation নেই এবং `NSMicrophoneUsageDescription` নেই।
- Face ID/LocalAuthentication biometric implementation নেই এবং `NSFaceIDUsageDescription` নেই।
- Floating overlay API নেই।
- Home-screen WidgetKit extension manually add + একই App Group app/extension দুটোতে configure করতে হবে; generated Xcode project-এ ready target নয়।
- Push capability/credentials বর্তমানে অনুপস্থিত।

---

## 21. Source/declaration ও runtime-এর যাচাইকৃত পার্থক্য

এই পার্থক্যগুলো জানা না থাকলে TypeScript বা পুরোনো doc দেখে ভুল সিদ্ধান্ত হতে পারে:

1. Runtime `NativeKit`-এ `capabilities`, `biometric`, `nearby` আছে, কিন্তু `types/nativekit.d.ts.template → NativeKitAPI`-এ ঘোষিত নয়।
2. Runtime App Browser-এ `networkMode`, `mediaAutoplay`, `colorScheme`, `setNetworkMode`, `setMediaAutoplay`, `networkStats` আছে; template-এর host/policy types অসম্পূর্ণ।
3. Runtime `connectMcp(servers, {withDeviceTools})` second argument নেয়; template-এ declaration শুধু servers দেখায়।
4. Raw agent runtime definitions-এ `providerModelAuthRequirements` ও `providerModelStreamingCapabilities` আছে; template-এর runtime type-এ নেই।
5. Raw custom/widget declarations সব method list করলেও iOS implementation সব method-এর নয়—বিশেষ করে biometric ও floating update/JS।
6. Agent ABI schema description পুরোনো জায়গায় Android arm64-only লেখা থাকতে পারে; বর্তমান tree-এ `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` `.so` আছে। প্রকৃত device-এ `checkAvailability()` চালান।

সঠিক contract প্রয়োজন হলে এই নথির commit-এর runtime source এবং generated build output—দুটোই যাচাই করুন।

## 22. Verification ও যা device-এ আলাদা পরীক্ষা দরকার

এই audit-এ চালানো হয়েছে:

- `npm run validate:config` — পাস।
- `npm run typecheck` — পাস।
- `npm test` / Node 22-এ `npm run check` — **22 files, 372 tests পাস**।
- `npm run build:bridge` ও generated declarations — পাস।
- Android `:nativekit-widget:compileDebugJavaWithJavac` (JDK 21, SDK 36) — **BUILD SUCCESSFUL**; আটটি reserved provider, manifest ও resources generate হয়েছে।
- Local initial environment Node 20/JDK 11 ছিল; verification-এর জন্য temporary Node 22/JDK 21 ও Android SDK 36 ব্যবহার করা হয়েছে। Project-এর declared requirement **Node 22+**, CI-এর Java **21**।

এগুলো JS/unit/config validation; real Android/iOS device proof নয়। Release-এর আগে merged manifest, Android APK, iOS Xcode build, native ABI, OS prompt, exact alarm, background location/wake, FCM/APNs, WidgetKit App Group, isolated process ও iframe fallback device/emulator-এ যাচাই করতে হবে।

## 23. দ্রুত source map

| বিষয় | Source |
|---|---|
| Host facade | `bridge/nativekit.ts` |
| Mini App broker/host manager | `bridge/app-browser.ts` |
| Native package/artifact persistence | `bridge/native-object-store.ts` |
| Artifact preview/activation/ownership | `bridge/mini-app-artifacts.ts` |
| UI artifact guide | `docs/MINI-APP-UI-ARTIFACTS.bn.md` |
| Device tools | `bridge/device-tools.ts` |
| MCP client | `bridge/mcp-client.ts` |
| Generated declarations | `types/nativekit.d.ts.template` |
| Feature/native config | `app.config.json`, `app.config.schema.json`, `scripts/configure-native.mjs` |
| Android permissions | generated app + প্রতিটি plugin-এর `android/src/main/AndroidManifest.xml` |
| iOS permissions | `ios/App/App/Info.plist` + manual entitlements/capabilities |
| Agent public types | `plugins/native-agent/src/definitions.ts` |
| Agent built-in tools | `plugins/native-agent/rust/native-agent-ffi/src/tool_runner.rs`, `agent_loop.rs` |
| Custom native implementation | `plugins/custom-native/{android,ios}` |
| Widget implementation | `plugins/widget/{android,ios}` |
| Isolated renderer | `plugins/isolated-browser/{android,ios}` |
