# NativeKit পূর্ণ API রেফারেন্স — ওয়েব ডেভেলপার সংস্করণ

> **সর্বশেষ source-audit:** 25 আগস্ট 2026 (সম্পূর্ণ নথি কোডের সঙ্গে re-verify) · সংশোধন: 24 আগস্ট 2026 (`NativeKit.nearby` যোগ)  
> **Runtime:** trusted bridge `1.0.0`, installed-package façade `app-browser-1.1.0`  
> **Pinned stack (security maintenance 11 October 2026):** Capacitor Core/Android/iOS/CLI `8.5.3` এবং `package.json`-এ থাকা plugin version-সমূহ

এই নথিটি trusted main app, installed HTML/CSS/JavaScript/Web Component এবং remote URL—তিনটি trust tier-এর ব্যবহার, method, argument, result, event, permission, error, quota ও platform caveat এক জায়গায় দেয়। সাধারণ ওয়েব ডেভেলপমেন্টের জন্য repository-র implementation source পড়া প্রয়োজন নেই।

---

## 1. আগে trust tier বুঝুন

| Content | `window.NativeKit` | Native call-এর পথ |
|---|---|---|
| Trusted `www/` বা framework static output | পূর্ণ `NativeKitAPI` | সরাসরি host bridge; mini-app policy prompt নয় |
| Installed ZIP/static/Web Component | ছোট কিন্তু ergonomic `NativeKitInstalledAPI` | authenticated main-app broker → policy/consent → audit → native API |
| `appBrowser.openUrl()`-এ remote HTTPS page | **নেই** | browser-only; transport, bootstrap, script handler ও native prompt-ও নেই |

Installed page-এ `Capacitor`, `Capacitor.Plugins` বা raw plugin object দেওয়া হয় না। Page JavaScript-দৃশ্যমান token একা identity নয়: native side-এর session/app identity ও renderer credential-ও মিলতে হয়। Remote URL-কে installed package ধরে নেবেন না।

---

## 2. TypeScript, readiness ও সাধারণ pattern

Generated declaration:

```text
.nativekit/bridge/nativekit.d.ts
```

Trusted code:

```js
await window.NativeKit.ready();
const NK = window.NativeKit;
console.log(NK.version, NK.platform, NK.isNative);
console.table(NK.capabilities());
```

```ts
const NK: Window['NativeKit'] = window.NativeKit;
```

- `window.NativeKit` non-writable ও non-configurable।
- `ready()` DOM ready হওয়ার পরে একই NativeKit object resolve করে।
- trusted `nativekitready` event detail: `{ platform, version }`।
- installed package-এর `nativekitready` detail: `{ app: { id, name, version }, brokered: true }`।
- listener/watch/subscription শেষ হলে `await handle.remove()` করুন।
- feature flag বন্ধ method সাধারণত `NativeKit feature disabled in app.config.json: <feature>` error দেয়।
- `capabilities()` availability summary; এটি OS permission grant নয়।

### Listener cleanup pattern

```js
const handle = await NK.network.onChange(status => console.log(status));
try {
  // screen/module active
} finally {
  await handle.remove();
}
```

### Error pattern

Trusted call underlying `Error`/`CapacitorException` reject করতে পারে:

```js
try {
  await NK.camera.getPhoto();
} catch (error) {
  console.error(error?.code, error?.message ?? String(error));
}
```

Installed broker error page-এ `Error` হিসেবে reconstruct হয়; `error.code` থাকতে পারে। গুরুত্বপূর্ণ code:

| Code | অর্থ |
|---|---|
| `POLICY_DENIED` | stored policy block |
| `POLICY_BLOCKED_ONCE` | host এই call block করেছে |
| `POLICY_BLOCKED_ALWAYS` | host block করেছে এবং method block persist করেছে |
| `PERMISSION_TIMEOUT` | configured সময়ের মধ্যে consent হয়নি |
| `PERMISSION_CANCELLED` | session/package/policy বদল, close, revoke বা renderer failure |
| `PERMISSION_UI_FAILED` | trusted native consent UI settle করতে পারেনি |
| `RATE_LIMITED` | per-session request/minute limit শেষ |

সব platform/plugin error-এর code একই হবে—এমন নিশ্চয়তা নেই। `message`-ও business logic-এর একমাত্র discriminator করবেন না।

---

# অংশ A — Trusted main-app API

## 3. Core

| Member | Result | কাজ |
|---|---|---|
| `version` | string | trusted bridge version |
| `config` | frozen public build config | active app/features/network/appBrowser/backgroundRunner subset |
| `platform` | `android \| ios \| web` | Capacitor platform |
| `isNative` | boolean | native Capacitor runtime কিনা |
| `ready()` | `Promise<NativeKitAPI>` | DOM readiness |
| `capabilities()` | object | platform, feature flags, SW support ও caveat |

`capabilities()`-এর feature boolean config availability বোঝায়; camera/location permission বা exact-alarm access জানতে সংশ্লিষ্ট `check/status/capabilities` call ব্যবহার করুন।

---

## 4. Permissions

```js
const snapshot = await NK.permissions.check();
const camera = await NK.permissions.requestCamera();
const location = await NK.permissions.requestLocation(false); // true = coarse only
const local = await NK.permissions.requestNotifications();
const push = await NK.permissions.requestPush();
await NK.permissions.openAppSettings();
```

| Method | Result/নোট |
|---|---|
| `check()` | `{ camera, location, notifications, push, alarms, backgroundLocation }` snapshot |
| `requestCamera()` | Capacitor Camera permission result |
| `requestLocation(coarseOnly=false)` | Geolocation permission result |
| `requestNotifications()` | Local Notifications permission result |
| `requestPush()` | Push permission result; credentials configure করে না |
| `openAppSettings()` | OS app settings খুলে |

Request Promise resolve মানেই granted নয়; returned state পরীক্ষা করুন। Background location, exact/full-screen alarm এবং push-এর provisioning আলাদা concern।

---

## 5. HTTP request

### Methods

```js
const r1 = await NK.http.request({
  url: 'https://api.example.com/items',
  method: 'GET',
  headers: { Authorization: `Bearer ${token}` },
  params: { page: 1, tag: ['a', 'b'] },
  responseType: 'json'
});

const r2 = await NK.http.post(
  'https://api.example.com/items',
  { title: 'নতুন' },
  { headers: { 'content-type': 'application/json' } }
);
```

| Method | Signature |
|---|---|
| `http.request(options)` | CapacitorHttp-compatible request |
| `http.get(url, options?)` | method forced `GET` |
| `http.post(url, data?, options?)` | method forced `POST` |

### গুরুত্বপূর্ণ options

| Field | Type/behavior |
|---|---|
| `url` | required HTTP(S) URL |
| `method` | string; default transport behavior `GET` |
| `headers` | string map |
| `params` | scalar/array value map; null/undefined item বাদ |
| `data` | string, object, FormData-compatible body |
| `responseType` | `json`, `text`, `arraybuffer`, `blob` |
| `connectTimeout` | ms; absent হলে config default |
| `readTimeout` | ms; absent হলে config default |
| `shouldEncodeUrlParams` | default true |
| `disableRedirects` | direct-fetch path-এ `manual`; native plugin-এ forwarded |
| `webFetchExtra` | web/direct-fetch `RequestInit` extension |

Result:

```ts
{
  status: number;
  data: T;                    // binary response হলে base64 string
  headers: Record<string,string>;
  url: string;
}
```

### Dispatch rule

1. Browser/web target সবসময় Capacitor HTTP web adapter ব্যবহার করে।
2. Native + `network.nativeHttp=true` Capacitor native HTTP plugin ব্যবহার করে।
3. Native + `network.nativeHttp=false` সরাসরি `window.fetch()` ব্যবহার করে।

`params` existing query-এর পরে যোগ হয় এবং URL hash অক্ষুণ্ণ থাকে। JSON content type response-কে JSON হিসেবে parse করায়। Successful binary `arraybuffer/blob` base64 string দেয়। Non-2xx response transport-level reject নাও করতে পারে; `status` পরীক্ষা করুন। Browser/direct fetch CORS-এর অধীন; native HTTP CORS এড়ালেও TLS, DNS, auth, WAF, server policy বা rate limit এড়ায় না। `network.allowedHostnames`, scheme ও cleartext policy request-এর আগে প্রয়োগ হয়।

Body rule Capacitor `buildRequestInit`-এর সঙ্গে সামঞ্জস্যপূর্ণ:

- string `data` সরাসরি body;
- JSON content type বা object data → JSON string;
- `application/x-www-form-urlencoded` → URL-encoded form;
- multipart/FormData → browser FormData; generated boundary-এর জন্য explicit content-type সরানো হয়।

---

## 6. SSE/text/NDJSON stream

```js
const stream = await NK.http.stream({
  url: 'https://api.example.com/stream',
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({ prompt: 'বাংলায় বলুন' }),
  format: 'sse',              // sse | text | ndjson
  disableRedirects: true
}, {
  onMessage(message) {
    console.log(message.data, message.event, message.id, message.format);
  },
  onError(error) {
    console.error(error.status, error.message);
  },
  onEnd({ status }) {
    console.log('complete', status);
  }
});

await stream.close();
await stream.done;
```

Result:

```ts
{
  id: string;
  close(): Promise<void>;
  done: Promise<{ status?: number }>;
}
```

- Native Android OkHttp/iOS URLSession custom stream; browser-এ Fetch readable stream।
- `sse`: blank-line-delimited SSE, multi-line `data:` join হয়।
- `ndjson`: newline-delimited raw record string; JSON parse app করবে।
- `text`: পাওয়া text chunk সরাসরি event।
- non-2xx বা missing browser body error।
- normal end `onEnd` এবং `done` resolve।
- stream error `onError` এবং `done` reject।
- caller `close()` web fetch abort করে; cancellation error callback হয় না এবং `done` `{}` resolve করে।
- native `close()` stop command পাঠায় এবং local `done` settle/handler release করে; native stop acknowledgement fail হলে `close()` reject করতে পারে, কিন্তু `done` resolve হয়।
- auto reconnect, retry/backoff, Last-Event-ID replay ও auth refresh app-level logic।

---

## 7. Camera

```js
const photo = await NK.camera.getPhoto({ quality: 90, source: 'PROMPT' });
const picked = await NK.camera.pickImages({ quality: 85, limit: 5 });
```

| Method | Default/Result |
|---|---|
| `getPhoto(options?)` | default `quality:85`, `resultType:'uri'`, `source:'PROMPT'`; photo object |
| `pickImages(options?)` | `{ photos: [...] }` |

`source`: `CAMERA | PHOTOS | PROMPT`; `resultType`: `uri | base64 | dataUrl`। Large ছবি base64 না করে URI/file flow নিন। Android/iOS permission state ও picker behavior OS versionভেদে বদলায়।

---

## 8. Foreground location

```js
const point = await NK.location.current({ timeout: 10_000 });
const watch = await NK.location.watch((position, error) => {
  if (error) console.error(error);
  else console.log(position.coords.latitude, position.coords.longitude);
}, { enableHighAccuracy: true });
await watch.remove();
```

| Method | Behavior |
|---|---|
| `current(options?)` | default `enableHighAccuracy:true`, `timeout:15000` |
| `watch(callback, options?)` | default high accuracy; `{ id, remove() }` |

Position shape standard Geolocation: `timestamp`, `coords.latitude/longitude/accuracy` এবং optional altitude/heading/speed। Continuous watch battery-sensitive।

---

## 9. Background location

Feature/config/platform entitlement enable করার পরে:

```js
await NK.backgroundLocation.start({
  minTimeMs: 30_000,
  minDistanceM: 25,
  desiredAccuracy: 'balanced', // low | balanced | high
  maxBuffer: 200
});
const listener = await NK.backgroundLocation.onLocation(console.log);
const state = await NK.backgroundLocation.status();
const { locations } = await NK.backgroundLocation.buffered();
await NK.backgroundLocation.clearBuffered();
await NK.backgroundLocation.stop();
await listener.remove();
```

Methods: `start`, `stop`, `status`, `buffered`, `clearBuffered`, `onLocation`। Status-এ `running`, `permission`, optional `service/startedAt` থাকতে পারে। Buffered point-এ coordinates, accuracy ও timestamp থাকে। OS execution perpetual guarantee নয়; user-visible disclosure/stop control, purpose string ও store policy অপরিহার্য।

---

## 10. Haptics

```js
await NK.haptics.impact('MEDIUM');          // LIGHT | MEDIUM | HEAVY
await NK.haptics.notification('SUCCESS');   // SUCCESS | WARNING | ERROR
await NK.haptics.vibrate(300);
```

Defaults: impact `MEDIUM`, notification `SUCCESS`, vibration `300ms`। Unsupported device/browser-এ no-op বা plugin-specific error হতে পারে।

---

## 11. Local notifications / reminders

```js
const permission = await NK.notifications.request();
await NK.notifications.schedule([{
  id: 101,                 // trusted API-তে Android-compatible integer
  title: 'ওষুধের সময়',
  body: 'নির্ধারিত ডোজ নিন',
  schedule: { at: new Date(Date.now() + 60_000) },
  extra: { route: '/medicine' }
}]);
```

| Method | Result |
|---|---|
| `check()` | display permission state |
| `request()` | display permission result |
| `schedule(notifications[])` | scheduled notifications result |
| `cancel(ids[])` | void |
| `pending()` | `{ notifications }` |
| `delivered()` | `{ notifications }` |
| `removeDelivered(ids[])` | void |
| `createChannel(channel)` | void; Android channel create/update request |
| `onReceived(callback)` | removable handle |
| `onAction(callback)` | removable handle |

Schedule `at`, `every`, `on`, `count`, `allowWhileIdle` ইত্যাদি Capacitor Local Notifications semantics মেনে চলে। Android notification ID integer। Channel settings user-owned হতে পারে; release-এর পরে channel ID/importance বদল সব device-এ পুরোনো channel rewrite করে না। Exact alarm/ringing UI দরকার হলে advanced alarms ব্যবহার করুন।

---

## 12. Advanced alarms

```js
const access = await NK.alarms.capabilities();
await NK.alarms.requestExactAccess();

const alarm = await NK.alarms.schedule({
  id: crypto.randomUUID(),
  title: 'সকালের অ্যালার্ম',
  body: 'উঠুন',
  at: new Date(Date.now() + 300_000).toISOString(),
  repeatIntervalMinutes: 0,
  fullScreen: false,
  sound: 'default',
  extra: { screen: 'wake' }
});
```

| Method | কাজ |
|---|---|
| `capabilities()` | exact/full-screen/AlarmKit access ও platform mode |
| `requestExactAccess()` | Android special settings/access request |
| `requestFullScreenAccess()` | full-screen settings/access request |
| `schedule(options)` | persisted alarm record/status |
| `cancel(id)` | alarm cancel |
| `list()` | `{ alarms }` |
| `stop(id?)` | ringing stop |
| `onFired(callback)` | removable alarm-fired listener |

Required fields: string `id`, `title`, ISO/date-compatible `at`। `repeatIntervalMinutes`, `fullScreen`, `sound`, `extra` optional। Android exact permission না থাকলে adapter inexact fallback report করতে পারে; persisted alarm reboot-এর পরে restore হয়। `USE_EXACT_ALARM`/full-screen policy-restricted। iOS 26+ configured/authorized হলে AlarmKit fixed-date path; নইলে Local Notifications fallback। `fullScreen:true` permission বা policy eligibility তৈরি করে না।

---

## 13. Background Runner

```js
await NK.background.runSyncNow({ reason: 'user-request' });
await NK.background.dispatch({ syncUrl: 'https://api.example.com/sync' });
const p = await NK.background.checkPermissions();
await NK.background.requestPermissions(['notifications', 'geolocation']);
```

| Method | কাজ |
|---|---|
| `dispatch(details?)` | configured runner event dispatch |
| `runSyncNow(details?)` | same runner event immediate request |
| `checkPermissions()` | runner permission snapshot |
| `requestPermissions(apis[])` | only notifications/geolocation |

Runner event/config `app.config.json` থেকে আসে। OS frequency/time budget নিয়ন্ত্রণ করে; interval exact নয়। Task bounded ও idempotent রাখুন। Runner-এর `CapacitorKV` trusted `Preferences` namespace-এর সমার্থক নয়।

---

## 14. Preferences

```js
await NK.preferences.set('theme', 'dark');
console.log(await NK.preferences.get('theme'));     // string | null
await NK.preferences.setJSON('profile', { name: 'Asha' });
console.log(await NK.preferences.getJSON('profile'));
```

Methods:

- `set(key, value)`
- `get(key)` → `string | null`
- `remove(key)`
- `clear()`
- `keys()` → `{ keys: string[] }`
- `setJSON(key, value)`
- `getJSON<T>(key)` → parsed `T | null`

`getJSON` stored malformed JSON পেলে reject করবে। Preferences small non-secret settings-এর জন্য; token/password নয়।

---

## 15. Secure Storage

```js
await NK.secureStorage.set('access-token', token);
const token2 = await NK.secureStorage.get('access-token'); // string | null
await NK.secureStorage.remove('access-token');
await NK.secureStorage.clear();
```

Android Keystore-protected AES-GCM; iOS Keychain। Native-only custom plugin—ordinary hosted web target-এ implementation নেই। Device compromise, unlocked device, runtime XSS বা malicious trusted bundle-এর বিরুদ্ধে absolute vault নয়। Secret DOM/log/audit-এ দেবেন না।

---

## 16. SQLite

```js
await NK.sqlite.open('main', { version: 1, encrypted: false, mode: 'no-encryption' });
await NK.sqlite.execute('main', `CREATE TABLE IF NOT EXISTS note(
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
)`);
await NK.sqlite.run('main', 'INSERT INTO note(body) VALUES (?)', ['hello']);
const result = await NK.sqlite.query('main', 'SELECT * FROM note ORDER BY id DESC');
await NK.sqlite.close('main');
// await NK.sqlite.delete('main');
```

| Method | Result |
|---|---|
| `open(name, options?)` | connection object/handle |
| `execute(name, statements, transaction=true)` | changes object |
| `run(name, statement, values=[], transaction=true)` | changes/lastId object |
| `query(name, statement, values=[])` | `{ values?: row[] }` |
| `close(name)` | void |
| `delete(name)` | void |

Native-only; web target-এ `jeep-sqlite` bundled নয়। Values parameterize করুন। Encryption mode-এর platform key/setup আলাদা হতে পারে; option দিলেই production key lifecycle সম্পন্ন হয় না।

---

## 17. Filesystem

Directory constants:

```js
NK.filesystem.directories
// Documents, Data, Library, Cache, External, ExternalStorage
```

```js
await NK.filesystem.writeFile({
  path: 'exports/report.json',
  directory: 'Data',
  data: JSON.stringify({ ok: true }),
  encoding: 'utf8',
  recursive: true
});
const file = await NK.filesystem.readFile({
  path: 'exports/report.json', directory: 'Data', encoding: 'utf8'
});
```

| Method | প্রধান result |
|---|---|
| `readFile(options)` | `{ data }` |
| `writeFile(options)` | `{ uri }` |
| `appendFile(options)` | void |
| `deleteFile(options)` | void |
| `mkdir(options)` | void |
| `rmdir(options)` | void |
| `readdir(options)` | `{ files }` |
| `stat(options)` | type/size/time/uri |
| `getUri(options)` | `{ uri }` |

Encoding: `utf8 | ascii | utf16`; encoding absent হলে base64 data semantics underlying plugin-এর। `recursive:true` write parent directories best-effort তৈরি করে। Directory availability Android/iOS/Web-এ সমান নয়; External/ExternalStorage Android-specific সীমা/permission-এর অধীন।

---

## 18. File transfer

```js
const downloaded = await NK.transfer.download({
  url: 'https://files.example.com/report.pdf',
  path: 'downloads/report.pdf',
  directory: 'Data',
  headers: { Authorization: `Bearer ${token}` },
  disableRedirects: true,
  onProgress: ({ bytes, contentLength }) => console.log(bytes, contentLength)
});

const uploaded = await NK.transfer.upload({
  url: 'https://files.example.com/upload',
  path: 'downloads/report.pdf',
  directory: 'Data',
  method: 'POST',
  mimeType: 'application/pdf',
  onProgress: console.log
});
```

- `download(options)` parent directory তৈরি করে, sandbox URI resolve করে, শেষে listener remove করে; result `{ path?:string, blob?:Blob }` (platform adapter অনুযায়ী field)।
- `upload(options)` sandbox file URI resolve করে; result `{ bytesSent:number, responseCode:string, response?:string, headers?:Record<string,string> }`।
- URL global network policy মেনে চলে।
- progress event plugin-global; concurrent transfer correlation payload পরীক্ষা করুন।
- resumability, checksum, retry, server max size ও auth refresh app-level concern।

---

## 19. In-app browser, Share, Network, App lifecycle

### Browser

```js
await NK.browser.open('https://example.com');
// অথবা await NK.browser.open({ url: 'https://example.com' });
```

Native-এ pinned Capgo In-App Browser plugin-এর `open`; web-এ `noopener,noreferrer` popup। এটি custom `appBrowser.openUrl()` manager API-র সমার্থক নয়। URL network scheme/host policy মেনে চলে।

### Share

```js
const possible = await NK.share.canShare();
const result = await NK.share.show({
  title: 'রিপোর্ট', text: 'দেখুন', url: 'https://example.com', dialogTitle: 'শেয়ার'
});
```

`canShare()` → `{ value:boolean }`; `show()` → optional `activityType`। Platform share sheet cancel/success semantics আলাদা হতে পারে।

### Network

```js
const current = await NK.network.status(); // { connected, connectionType }
const listener = await NK.network.onChange(console.log);
await listener.remove();
```

Network “connected” মানেই আপনার server reachable নয়।

### App

```js
const info = await NK.app.info();
const state = await NK.app.state();
const life = await NK.app.onStateChange(({ isActive }) => console.log(isActive));
const links = await NK.app.onUrlOpen(({ url }) => console.log(url));
// await NK.app.exit(); // Android-oriented; normal UI flow-এ সাধারণত নয়
```

Methods: `info`, `state`, `onStateChange`, `onUrlOpen`, `exit`।

---

## 20. Push Notifications — code-ready, credentials deferred

```js
const tokenHandle = await NK.push.onRegistration(({ value }) => {
  console.log('Treat as sensitive identifier', value);
});
const errorHandle = await NK.push.onRegistrationError(console.error);
const receiveHandle = await NK.push.onReceived(console.log);
const actionHandle = await NK.push.onAction(console.log);
await NK.push.register();
```

| Method | কাজ |
|---|---|
| `register()` | prompt state হলে request, তারপর native registration |
| `unregister()` | native unregister |
| `delivered()` | delivered push inventory |
| `removeAllDelivered()` | delivered push clear |
| `onRegistration(cb)` | token listener |
| `onRegistrationError(cb)` | registration error |
| `onReceived(cb)` | foreground receive |
| `onAction(cb)` | user action |

Firebase Android config, APNs entitlement/capability/profile/certificate এবং provider/backend setup deferred। Plugin surface থাকাই delivery-ready production configuration নয়।

---

## 21. Service Worker helper

```js
if (NK.serviceWorker.supported) {
  const results = await NK.serviceWorker.unregisterAll();
}
```

- `supported`: web target ও browser capability।
- `unregisterAll()`: current origin-এর registrations unregister result array।
- native launch-এ stale worker best-effort unregister হয়।
- generated Service Worker কেবল web target same-origin offline cache/navigation fallback। এটি native background runner নয়, CORS bypass নয়, App Browser isolation নয়।

---

# অংশ B — Installed package developer API

## 22. Package manifest

ZIP/folder root-এ optional `nativekit.manifest.json`:

```json
{
  "id": "com.example.notes",
  "name": "Notes Mini App",
  "version": "1.2.0",
  "description": "Offline notes",
  "entry": "index.html",
  "requestedCapabilities": ["preferences", "notifications"],
  "allowedHosts": ["api.example.com", "*.cdn.example.com:443"]
}
```

Web Component package:

```json
{
  "id": "com.example.weather-card",
  "name": "Weather Card",
  "version": "1.0.0",
  "requestedCapabilities": ["http"],
  "allowedHosts": ["api.weather.example"],
  "webComponent": {
    "tag": "weather-card",
    "module": "weather-card.js",
    "attributes": { "units": "metric" }
  }
}
```

Rules:

- ID stable lowercase dotted/dashed identifier; max 120 chars।
- name max 80, version max 40, description max 500 chars।
- entry existing `.html/.htm`; default `index.html`।
- component tag-এ hyphen আবশ্যক; module package-এ থাকতে হবে।
- allowed host exact বা `*.suffix`, optional valid port; URL/scheme লেখা যাবে না।
- manifest-requested capability declaration নিজে permission grant নয়।
- package path absolute/traversal/NUL/hidden segment হতে পারে না।
- ZIP central directory install limit-এর আগে inspect হয়; expanded bytes/file count limit মেনে চলে।

Capability enum:

```text
permissions, http, camera, location, backgroundLocation, haptics,
notifications, alarms, background, preferences, secureStorage, sqlite,
filesystem, fileTransfer, sharing, networkStatus, appInfo,
pushNotifications, browser
```

---

## 23. Installed readiness, identity ও generic access

```js
await NativeKit.ready();
console.log(NativeKit.version);      // app-browser-1.1.0
console.log(NativeKit.appIdentity);  // { id, name, version }
console.log(await NativeKit.capabilities());
```

`capabilities()` result:

```ts
{
  appEnabled: boolean;
  grants: Record<string, boolean>;             // compatibility mirror
  methodOverrides: Record<string, boolean>;    // compatibility mirror
  capabilityDecisions: Record<Capability, 'ask'|'allow'|'block'>;
  methodDecisions: Record<string, 'ask'|'allow'|'block'>;
  allowedHosts: string[];
}
```

Generic low-level access আছে:

```js
const result = await NativeKit.call('preferences.get', 'theme');
```

কিন্তু ergonomic namespace method ব্যবহার করাই উত্তম। Unknown/unexposed method fail করবে; generic `call()` allowlist bypass নয়।

---

## 24. Installed exact façade matrix

| Capability | Exposed API |
|---|---|
| `permissions` | `check`, `requestCamera`, `requestLocation`, `requestNotifications`, `openAppSettings` |
| `http` | `request`, `get`, `post`, `stream` |
| `camera` | `getPhoto`, `pickImages` |
| `location` | `current`, `watch` |
| `backgroundLocation` | `start`, `stop`, `status`; location event subscription |
| `haptics` | `impact`, `notification`, `vibrate` |
| `notifications` | `check`, `request`, `schedule`, `cancel`; received/action events |
| `alarms` | `capabilities`, `requestExactAccess`, `requestFullScreenAccess`, `schedule`, `cancel`, `list`, `stop`; fired event |
| `background` | `dispatch`, `runSyncNow`, `checkPermissions`, `requestPermissions` |
| `preferences` | `set`, `get`, `remove`, `setJSON`, `getJSON` |
| `secureStorage` | `set`, `get`, `remove` |
| `sqlite` | `open`, `execute`, `run`, `query`, `close`, `delete` |
| `filesystem` | `readFile`, `writeFile`, `appendFile`, `deleteFile`, `mkdir`, `rmdir`, `readdir`, `stat`; native URI/path API নেই |
| `fileTransfer` | `download`, `upload` |
| `sharing` | `canShare`, `show` |
| `networkStatus` | `status`; change event |
| `appInfo` | `info`, `state`; state-change event |
| `pushNotifications` | only received/action event routing |
| `browser` | `open` |

**ইচ্ছাকৃতভাবে exposed নয়:** `permissions.requestPush`, push register/token/unregister/delivered inventory, `app.onUrlOpen`, `app.exit`, notification global pending/delivered/channel/clear, background-location global buffered history, storage global `clear/keys`, trusted filesystem directory constants, transfer progress callbacks এবং host `appBrowser` manager।

### Installed-specific constraints

- HTTP only `json|text` response type; redirect forced off; method allowlist `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS`। Connect 15s/read 30s broker-owned fixed timeout; installed page-এর type-এ `connectTimeout`, `readTimeout`, `disableRedirects`, `webFetchExtra`, `shouldEncodeUrlParams` বা `dataType` নেই। Body max 1 MiB, params max 64 KiB, ≤64 headers/32 KiB total। URL policy must match app policy allowed host।
- Stream URL allowed-host checked; redirect disabled; broker returns `{ id, close }`—public `done` নেই।
- Camera URI/path/`webPath`/EXIF ফেরায় না। `getPhoto()` quality সর্বোচ্চ 75, width/height সর্বোচ্চ 1024, orientation correction on, gallery save off এবং bounded base64 `{ data, encoding:'base64', format, saved }` দেয়। `pickImages()` quality সর্বোচ্চ 65, width/height সর্বোচ্চ 640, limit সর্বোচ্চ 4; broker নিজে selected file import করে `{ photos:[{ data, encoding:'base64', format }] }` দেয়—mini app-এর আলাদা `filesystem` grant লাগে না। Per-photo encoded output 512 KiB, aggregate gallery JSON প্রায় 1.75 MiB; বেশি হলে পুরো call reject।
- Location options sanitize/clamp; current/watch position-এ শুধু numeric `timestamp` ও exact coordinate fields থাকে, plugin-specific field বাদ। Watch broker subscription।
- Background location min time 10s–1h, distance 0–10,000m, buffer 10–1000; accuracy `low|high`; one owner at a time। `start/status` exact `{ running, permission, ownedByApp }`; অন্য owner/host-এর native running state installed app-কে প্রকাশ করা হয় না। Event-এ শুধু bounded numeric location point।
- Haptic vibration max 5000ms; installed `notification()` invalid/omitted type হলে `WARNING` নেয় (trusted API default `SUCCESS`)। Haptic/stop/cancel/remove/append/mkdir/rmdir/close operation success-এ void; native plugin-specific object forward হয় না।
- Notification schedule এক call-এ 1–16 item; broker native ID/ownership metadata না ফিরিয়ে `{ scheduled:true, ids:string[] }` দেয়। Alarm schedule-ও native ID/extra না ফিরিয়ে `{ id, scheduled:true }` দেয়।
- Background `dispatch/runSyncNow` caller argument ignore করে; trusted configured sync URL/source ব্যবহার করে।
- Preferences/Secure/SQLite/Filesystem resource native namespace app ID দিয়ে isolate হয়।
- Installed SQLite `open(name)` encryption option নেয় না এবং `{ name, open:true, encrypted:false }` দেয়। Dangerous attach/detach/vacuum-into/load-extension/readfile/temp-virtual-table primitives block; SQL text ≤256 KiB।
- Filesystem শুধু `Data|Cache`; logical path app root-এর নিচে rewrite হয়। `readFile` শুধু `{ data:string }`, `writeFile` শুধু `{ path:<logical path> }`, `readdir/stat` থেকে URI/path/plugin field বাদ। `getUri` generic `call()` দিয়েও exposed নয়। Encoded read/write string সর্বোচ্চ 1,835,008 bytes; encoding না-দেওয়া base64 read-এর source file সর্বোচ্চ 1,376,256 bytes।
- Transfer progress callback exposed নয়; redirect disabled। Download native path/blob না দিয়ে `{ path:<logical path>, bytes }`; upload শুধু `{ bytesSent, responseCode, response?, headers? }`। Download সর্বোচ্চ 32 MiB এবং completion-এর পরে app filesystem quota পুনরায় verify হয়।
- Share text/title/URL length/scheme sanitize হয়; result `{ completed, activityType? }`।
- `network.status`/change exact `{ connected, connectionType }`; `app.state` exact `{ isActive }`; installed `app.info` host binary metadata নয়, package identity `{ id, name, version }`।
- `background.dispatch/runSyncNow` exact `{ dispatched:true }`; SQLite execute/run exact `{ changes:{ changes, lastId? } }`, query exact `{ values:row[] }`।
- `browser.open` app allowed-host policy মেনে brokered browser call এবং `{ opened:true }` দেয়; এটি remote URL manager tier নয়।

### Installed exact result contract

Broker success result-এ নিচের key-গুলিই থাকে; raw Capacitor/plugin result, native path/URI, database native name, ownership marker বা platform-only metadata forward হয় না:

| Call | Success result |
|---|---|
| `camera.getPhoto()` | `{ data:string, encoding:'base64', format:string, saved:boolean }` |
| `camera.pickImages()` | `{ photos:Array<{data,encoding:'base64',format}> }` |
| `location.current()` | `{ timestamp, coords:{latitude,longitude,accuracy,altitude,altitudeAccuracy,speed,heading} }` |
| `backgroundLocation.start/status()` | `{ running:boolean, permission:string, ownedByApp:boolean }` |
| `permissions.check()` | camera/location/notification/push state maps + exact alarm/background-location summary |
| `http.request/get/post()` | `{ data, status, headers, url }` |
| `background.dispatch/runSyncNow()` | `{ dispatched:true }` |
| `sqlite.execute/run()` | `{ changes:{ changes:number, lastId?:number } }` |
| `sqlite.query()` | `{ values:row[] }` |
| `filesystem.readFile()` | `{ data:string }` |
| `filesystem.writeFile()` | `{ path:string }` logical app path |
| `filesystem.readdir()` | `{ files:[{name,type,size,ctime?,mtime?}] }` |
| `filesystem.stat()` | `{ type,size,ctime?,mtime? }` |
| `transfer.download()` | `{ path:string, bytes:number }` |
| `transfer.upload()` | `{ bytesSent,responseCode,response?,headers? }` |
| `share.canShare/show()` | `{ value:boolean }` / `{ completed:boolean, activityType? }` |
| `browser.open()` | `{ opened:true }` |
| `network.status()` | `{ connected, connectionType }` |
| `app.info/state()` | `{ id,name,version }` / `{ isActive }` |
| notification/alarm schedule | `{ scheduled:true, ids }` / `{ id, scheduled:true }` |
| void operations | JSON result হিসেবে `undefined`/কোনো plugin object নয় |

Result খুব বড়, malformed, non-finite numeric, unsafe filename, invalid base64/URL/header বা unexpected native shape হলে broker field pass-through না করে fail-closed reject করে। Reconstructed installed error message 500 charactersে bounded; file/content URI, common absolute native path, sandbox resource path ও broker-native database identifier redact হয়।

### Installed subscription

Ergonomic:

```js
const watch = await NativeKit.location.watch((position, error) => {
  console.log(position, error);
});
await watch.remove();

const stream = await NativeKit.http.stream(
  { url: 'https://api.example.com/events', format: 'sse' },
  { onMessage: console.log, onError: console.error, onEnd: console.log }
);
await stream.close();
```

Generic event:

```js
const sub = await NativeKit.subscribe('network.change', console.log);
await sub.remove();
```

Allowed names:

```text
location.watch
http.stream
network.change
app.stateChange
backgroundLocation.location
alarms.fired
notifications.received
notifications.action
push.received
push.action
```

Push event native payload-এর `data.nativeKitAppBrowserId` current app ID-এর সঙ্গে match করলেই route হয়; routing-এর পরে marker strip করে exact notification/action payload দেওয়া হয়। Push token/register API নেই। Network/app/background-location/notification/push event-ও plugin-specific extra field, native identifier বা URI forward করে না।

---

## 25. Installed consent semantics

Durable state:

```text
ask | allow | block
```

Call-time host action:

```text
allow_once | allow_always | block_once | block_always
```

Precedence:

1. app disabled → absolute deny;
2. global feature gate, exposed-method allowlist, ownership/quota/host validation ও OS permission bypass হয় না;
3. capability `block` master revocation—stale method `allow` bypass করতে পারে না;
4. capability `ask|allow` হলে explicit method decision precedence; absent/inherit হলে capability;
5. effective `ask` হলে native operation শুরু হওয়ার আগে pending consent;
6. `allow_always/block_always` method decision persist করে; once action শুধু current call।

Template default:

- requested capability → `ask`;
- unrequested capability → `block`;
- timeout → 90,000 ms;
- `defaultCapabilities: []`;
- prompt enabled।

`defaultCapabilities`-এ capability থাকলেও manifest-এ requested না হলে automatic allow নয়। Prompt disabled অথচ effective decision `ask` হলে call fail-closed।

Close, disable, update, remove, capability/method revoke, renderer failure বা timeout pending call reject করে। Allow হওয়ার পরও operation শুরুর ঠিক আগে session/package/policy recheck হয়।

---

## 26. Installed quotas

| Resource | Hard bound |
|---|---|
| Host broker RPC argument/result/event JSON | 2,097,152 UTF-8 bytes; native renderer transport-এর 2,800,000 character/byte ceiling-ও আলাদা hard ceiling |
| RPC rate | config `maxRequestsPerMinute`, per running session |
| Preferences | 64 keys/app; value ≤1 MiB |
| Secure storage | 64 keys/app; value ≤64 KiB |
| SQLite | 8 DB/app; 64 MiB/DB |
| SQLite SQL | 256 KiB |
| Filesystem | 64 MiB ও 512 files/app, Data+Cache মিলিয়ে |
| Filesystem encoded read/write string | 1,835,008 bytes; base64 read source ≤1,376,256 bytes |
| Camera `getPhoto` encoded result | 1,572,864 bytes |
| Picked camera image | 524,288 bytes/image; 4 image; aggregate JSON ≤1,835,008 bytes |
| Transfer source/destination file | 32 MiB |
| Notifications | 16/app; broker apps মিলিয়ে 32 |
| Alarms | 16/app; broker apps মিলিয়ে 32 |
| HTTP body | 1 MiB |
| HTTP params | 64 KiB JSON |
| HTTP headers | 64 header; total 32 KiB |

Usage scan/stat নিশ্চিত না হলে broker fail-closed। Download quota ভাঙলে partial destination delete চেষ্টা হয়; cleanup-ও ব্যর্থ হলে aggregate error।

---

# অংশ C — Trusted App Browser manager API

## 27. Install, list, launch

```js
const B = NK.appBrowser;

const app1 = await B.installFromZip(zipBlob, {
  id: 'com.example.override',
  name: 'Override Name'
});

const app2 = await B.installFromFiles(fileInput.files, {
  requestedCapabilities: ['preferences']
});

const app3 = await B.install({
  manifest: { id: 'com.example.inline', name: 'Inline App' },
  files: [{ path: 'index.html', data: '<h1>Hello</h1>' }]
});

const apps = await B.list();
const one = await B.get(app1.id);
const session = await B.launch(one.id, document.querySelector('#stage'));
await session.stop();
```

Installed app result includes:

```ts
{
  id, manifest, integrity,
  installedAt, updatedAt,
  totalBytes, fileCount,
  policy
}
```

### Host method list

| Method | কাজ |
|---|---|
| `installFromFiles(files, options?)` | FileList/File[] install/update |
| `installFromZip(blob, options?)` | ZIP install/update |
| `install({ manifest, files })` | in-memory files install/update |
| `installWebComponent({ fileName, data?, source?, tag?, name?, id?, description? })` | **Quick-add:** এক ফাইল web component `.js/.mjs` (tag auto-detect + manifest/wrapper synthesize) বা `.html` plain page — এক call-এ install |
| `list()` | installed app + policy list |
| `get(appId)` | one app + policy |
| `launch(appId, container, options?)` | required `HTMLElement` target-এ isolated/iframe session |
| `stop(sessionId)` | installed session stop |
| `sessions()` | running installed session metadata |
| `remove(appId)` | cleanup সহ remove |
| `cleanup(appId)` | sessions/pending/active state এবং owned DB/preferences/secure/files cleanup; package/policy remove নয় |
| `usage(appId)` | storage, scheduled-resource ও active-session snapshot |
| `capabilities` | static supported capability list; feature disabled হলেও readable metadata |

`usage(appId)` shape:

```ts
{
  appId: string;
  storage: {
    preferenceKeys: number;
    secureStorageKeys: number;
    databases: number;
    filesystem: { bytes: number; files: number } | null;
  };
  scheduled: { notifications: number | null; alarms: number | null };
  active: { sessions: number; subscriptions: number; backgroundLocation: boolean };
}
```

Corresponding feature disabled হলে filesystem/notification/alarm live count `null`; enabled native enumeration fail হলে under-report না করে call reject করে।

`appBrowser` feature disabled হলে host method wrapper feature error ছোড়ে; nested `audit.*`-ও gated। Static `capabilities` list readable থাকে, কিন্তু API usable হওয়ার নিশ্চয়তা নয়।

---

## 28. Host policy management

```js
await B.setEnabled(appId, false);
await B.setCapabilityDecision(appId, 'camera', 'ask');
await B.setMethodDecision(appId, 'camera.pickImages', 'block');
await B.setMethodDecision(appId, 'camera.pickImages', 'inherit');
await B.setAllowedHosts(appId, ['api.example.com', '*.cdn.example.com']);

// compatibility wrappers
await B.setCapability(appId, 'camera', true);       // allow
await B.setCapability(appId, 'camera', false);      // block
await B.setMethodPermission(appId, 'camera.getPhoto', null); // inherit
```

| Method | Meaning |
|---|---|
| `getPolicy(appId)` | current normalized policy |
| `setEnabled(appId, enabled)` | master switch |
| `setCapabilityDecision(appId, capability, decision)` | `ask\|allow\|block` |
| `setMethodDecision(appId, method, decision)` | `inherit\|ask\|allow\|block` |
| `setCapability(appId, capability, boolean)` | compatibility allow/block |
| `setMethodPermission(appId, method, boolean\|null)` | compatibility allow/block/inherit |
| `setAllowedHosts(appId, hosts)` | network/browser policy; running sessions restart/stop |
| `setNetworkMode(appId, mode)` | `sandboxed\|hosts\|full`; running sessions stop হয় যেন নতুন mode apply হয় |
| `setMediaAutoplay(appId, enabled)` | gesture ছাড়া media autoplay allow/block |
| `networkStats(appId?)` | per-app network requests/tracking snapshot |

Revoke শুধু future call বদলায় না: matching pending call cancel, subscription remove এবং owned background location/notification/alarm state release চেষ্টা হয়। Cleanup ব্যর্থ হলে method reject করে; silently success নয়।

---

## 29. Pending permission host UI

```js
addEventListener('nativekitappbrowserpermissionrequest', event => {
  const p = event.detail;
  console.log(p.appName, p.capability, p.method,
              p.argumentSummary, p.createdAt, p.expiresAt);
});

const pending = B.listPendingPermissions();
await B.resolvePermissionRequest(pending[0].requestId, 'allow_once');
```

Methods:

- `listPendingPermissions()` — synchronous public pending list।
- `resolvePermissionRequest(requestId, action)` — exactly once settle।

Pending detail-এ request/app/session/renderer/capability/method, `requestedByManifest`, redacted bounded `argumentSummary`, created/expiry থাকে। Raw body, token, secret বা credential approval UI-তে রাখা হয় না। Native isolated renderer-এ trusted native consent UI-ও একই request settle করতে পারে।

Events:

| Event | Detail |
|---|---|
| `nativekitappbrowserpermissionrequest` | pending request |
| `nativekitappbrowserpermissionresolved` | request + optional action/error |

---

## 30. Audit

```js
const rows = await B.audit.list({ appId, outcome: 'denied', limit: 100 });
const summary = await B.audit.summary(appId);
await B.audit.clear(appId);

addEventListener('nativekitappbrowseraudit', event => console.log(event.detail));
```

Audit record:

```ts
{
  id?: number;
  appId: string;
  appName: string;
  capability: string;
  method: string;
  outcome: 'success'|'error'|'denied'|'rate_limited'|'cancelled'|'timeout';
  timestamp: string;
  durationMs: number;
  error?: string;                 // normalized code, raw native message নয়
  permissionRequestId?: string;
  authorization?: 'control'|'stored_allow'|'allow_once'|'allow_always';
}
```

প্রতি broker call native side effect-এর **আগে** `OUTCOME_PENDING` record durably commit করে; commit fail হলে operation চলে না। শেষে record final outcome update হয়। Final update fail হলে pending marker থেকে অসম্পূর্ণ outcome বোঝা যায়।

সঠিক সীমা:

- audit raw arguments, results, token, renderer credential বা pending `argumentSummary` store করে না;
- blocked once/always call-এর error code/outcome ও permission request ID থাকে, কিন্তু `authorization` field allow/control path-এর union—block action সেখানে লেখা হয় না;
- direct browser JavaScript/network, trusted direct API ও remote URL mode App Browser broker audit নয়;
- bounded local audit tamper-proof remote log নয়; user data clear বা `audit.clear`-এ হারাতে পারে।

---

## 31. Remote HTTPS browser-only mode

```js
const remote = await B.openUrl('https://docs.example.com', { title: 'Docs' });
console.log(remote.mode, remote.nativeKit); // url, false
await remote.stop();

console.log(B.urlSessions());
await B.closeUrl(remote.id);
```

Rules:

- URL credential-বিহীন `https:`।
- config global host allowlist থাকলে initial URL match আবশ্যক; না থাকলে initial host boundary।
- remote page কোনো package record, RPC session, `window.NativeKit`, token, injected bootstrap/script handler, native consent card বা broker audit পায় না।
- native installed session ও remote privileged renderer path একসঙ্গে reuse হয় না।
- web target `window.open` + `noopener,noreferrer` + null opener।
- Android supported হলে dedicated remote profile; iOS 17+ stable persistent website-data store। Close-এ profile retain হয়, যাতে cookie/storage usable থাকে।
- iOS 15–16 arbitrary named persistent store API না থাকায় default persistent store; full partition promise নয়।

Event:

```js
addEventListener('nativekitappbrowserurlstatus', e => {
  console.log(e.detail.sessionId, e.detail.state, e.detail.reason);
});
```

`urlMode` API: `openUrl`, `closeUrl`, `urlSessions`। Feature/config disabled হলে reject।

---

## 32. Renderer/session events ও isolation

```js
addEventListener('nativekitappbrowserstatus', e => {
  const { sessionId, appId, renderer, state, reason } = e.detail;
  console.log(renderer, state, reason);
});
```

Native maximum-isolation path:

- package private native staging, canonical integrity ও atomic commit;
- per-app virtual origin `nk-<hash>.invalid`;
- Android fixed separate `:nativekit_isolated` app process, authenticated bounded/chunked Messenger IPC;
- source origin/main-frame/session/app credential checks;
- Android renderer unresponsive/gone callback, teardown ও recovery UI;
- iOS isolated controller, heartbeat, script-handler detach এবং fresh process-pool/WebView replacement;
- Android WebView profile supported হলে per-app profile; fallback virtual site weaker cookie/cache partition;
- iOS 17+ stable named data store; iOS 15–16 nonpersistent installed-app store।

Iframe fallback (`sandbox="allow-scripts"`) opaque origin ও exact `event.source`/token check ব্যবহার করে, কিন্তু host UI thread/process resource ভাগ করতে পারে। Infinite loop host freeze করতে পারে। Maximum isolation বাধ্যতামূলক deployment-এ `fallbackToIframe:false`।

Renderer loss/close final session-এ pending calls reject, subscriptions remove এবং owned active state release চেষ্টা হয়। Dead WebView reuse করা হয় না। iOS public API arbitrary hung web-content process kill guarantee দেয় না; fresh WebView replacement best effort।

---

## 33. Update, disable, remove ও data lifecycle

- `setEnabled(false)`: policy persist; sessions/pending/subscriptions stop; owned background/scheduled native state revoke। Persistent app storage/DB/file নিজে মুছে না।
- capability/method ask/block: matching pending/subscription cancel; relevant owned active state revoke চেষ্টা।
- integrity-changing update: new package disabled অবস্থায় save; old sessions/state stop; namespaced data রাখা হয়। Host review করে re-enable করবে।
- final session close/renderer failure: pending/subscriptions release; অন্য session না থাকলে owned background/scheduled state release।
- `cleanup(appId)`: Preferences, secure, DB, filesystem ও owned scheduled state cleanup চেষ্টা; package record নিজে remove নয়।
- `remove(appId)`: disable → active/native state cleanup → app-owned DB/preferences/secure/files → staged package/profile/browser data → package/policy/ownership metadata delete।
- cleanup partial fail হলে aggregate error এবং retryযোগ্য metadata/package রাখা হয়; unexpected error লুকানো হয় না।
- remote URL profile installed app resource নয়; app remove-এ মুছে না।

Feature toggle বন্ধ করলে corresponding cleanup façade unavailable হতে পারে। Sensitive feature বন্ধ করার আগে পুরোনো scheduled/data lifecycle review করুন।

---

# অংশ D — Config, platform ও release checklist

## 34. Web developer-এর জন্য প্রাসঙ্গিক config defaults

বর্তমান template defaults:

```json
{
  "network": {
    "nativeHttp": true,
    "allowCleartext": false,
    "allowedHostnames": [],
    "connectTimeoutMs": 30000,
    "readTimeoutMs": 120000
  },
  "appBrowser": {
    "maxApps": 20,
    "maxPackageBytes": 15728640,
    "maxFiles": 500,
    "auditLogLimit": 2000,
    "maxRequestsPerMinute": 120,
    "defaultCapabilities": [],
    "permissionPrompts": {
      "enabled": true,
      "requestTimeoutMs": 90000,
      "requestedCapabilityDefault": "ask",
      "unrequestedCapabilityDefault": "block"
    },
    "allowDirectWebNetwork": false,
    "urlMode": { "enabled": true, "allowedHosts": [] },
    "renderer": "isolated",
    "isolated": {
      "enabled": true,
      "fallbackToIframe": true,
      "stageChunkBytes": 262144,
      "androidMinApi": 28,
      "hangTerminationDelayMs": 4000
    }
  }
}
```

`features.appBrowser` ও `appBrowser.enabled` equal হতে হবে। Empty trusted `network.allowedHostnames` মানে any HTTP(S) hostname (cleartext rule আলাদা); empty package policy `allowedHosts` মানে installed app broker network কোথাও যেতে পারবে না।

**⚡ Quick add (web component):** shell-এর "Sandboxed App Browser → ⚡ Quick Add" বক্সে একটা `.js/.mjs` ফাইল pick করলেই `installWebComponent` runs — tag auto-detect → const `nativekit.manifest.json`-সমান manifest synthesize → generated wrapper entry → install → launch। বিস্তারিত ও code-নিয়ম: [`WEB-DEV-GUIDE.md`](./WEB-DEV-GUIDE.md) ও [`MINI-APP-CREATOR-GUIDE.md`](./MINI-APP-CREATOR-GUIDE.md)।

`allowDirectWebNetwork:false` installed renderer fetch/XHR/WebSocket/media network বন্ধ করে এবং audited broker HTTP নিতে বাধ্য করে। `true` করলে policy-approved direct traffic browser CORS-এর অধীন এবং broker audit-এর বাইরে; remote scripts/styles/fonts/iframes এখনও CSP restriction-এর অধীন।

---

## 35. Platform availability summary

| Feature | Android | iOS | Hosted Web/PWA |
|---|---|---|---|
| HTTP request | native plugin বা fetch | native plugin বা fetch | Capacitor web adapter/fetch + CORS |
| Stream | OkHttp | URLSession | Fetch stream + CORS |
| Camera/location | Capacitor native | Capacitor native | browser implementation/permission |
| Background location | custom native + FGS/policy | custom native + background mode | unavailable |
| Haptics | native | native | limited/no-op browser behavior |
| Local notifications | native | native | unavailable/limited plugin behavior |
| Advanced alarms | Android alarm APIs | AlarmKit/fallback | unavailable |
| Background runner | OS-scheduled | BG task policy | not native background substitute |
| Preferences | native prefs | native prefs | browser storage adapter |
| Secure storage | Keystore AES-GCM | Keychain | unavailable |
| SQLite | native | native | unavailable; jeep-sqlite not bundled |
| Filesystem | native sandbox | native sandbox | Capacitor web storage adapter সীমা |
| Transfer | native | native | plugin/platform support-dependent |
| Share/Network/App | native | native | browser support-dependent |
| Push | FCM config required | APNs config required | এই template-এ production web push নয় |
| Installed isolation | separate app process + WebView | isolated controller/WebKit process | opaque iframe fallback |
| Remote profile | WebView profile if supported | named store iOS 17+ | separate popup/browser rules |

Platform API availability এবং OS/store authorization আলাদা। Real device-এ exact alarm, background location, push, notification action, renderer crash/hang, cookie/profile cleanup ও app update test করুন।

---

## 36. Security checklist

1. Trusted bundle-এ কেবল নিজের reviewed code রাখুন; remote script দিলে সেই script পূর্ণ trusted NativeKit পেতে পারে।
2. Installed package manifest-এ minimum requested capabilities ও hosts দিন।
3. Default `ask/block`; broad automatic allow নয়।
4. HTTP token/secret pending summary বা audit-এ রাখবেন না; runtime ইতিমধ্যে value content redacted করে।
5. Raw Capacitor plugin installed page-এ inject করবেন না।
6. Remote URL-এ NativeKit bootstrap/transport/script handler যোগ করবেন না।
7. Browser iframe fallback-এর isolation limitation production decision-এ ধরুন।
8. SQLite values parameterize; file/HTTP size server-side-ও validate।
9. Listener/watch/stream সবসময় remove/close।
10. Native feature permission success-এর returned state পরীক্ষা।
11. Background/exact/full-screen আচরণ store policy ও user disclosure মেনে enable।
12. Push credential/provisioning complete না হওয়া পর্যন্ত delivery claim করবেন না।

---

## 37. ছোট end-to-end examples

### Trusted app: API + reminder

```js
await NativeKit.ready();
const response = await NativeKit.http.get('https://api.example.com/tasks', {
  responseType: 'json'
});
if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

const permission = await NativeKit.notifications.request();
if (permission.display === 'granted') {
  await NativeKit.notifications.schedule([{
    id: 501,
    title: response.data[0].title,
    schedule: { at: new Date(Date.now() + 60_000) }
  }]);
}
```

### Installed app: brokered storage + HTTP

```js
await NativeKit.ready();
await NativeKit.preferences.setJSON('draft', { text: 'hello' });

try {
  const response = await NativeKit.http.get('https://api.example.com/profile', {
    responseType: 'json'
  });
  document.querySelector('#name').textContent = response.data.name;
} catch (error) {
  if (error.code === 'PERMISSION_TIMEOUT') {
    document.querySelector('#status').textContent = 'Host approval timed out';
  } else {
    throw error;
  }
}
```

### Trusted manager: consent

```js
const B = NativeKit.appBrowser;
addEventListener('nativekitappbrowserpermissionrequest', async ({ detail }) => {
  const userAccepted = await showTrustedConsentDialog(detail);
  await B.resolvePermissionRequest(
    detail.requestId,
    userAccepted ? 'allow_once' : 'block_once'
  );
});
```

---

## 38. Plugin/dependency storage report

18 আগস্ট 2026 checkout-এর measured storage (category-গুলিতে overlap আছে, তাই সরাসরি সব row যোগ করবেন না):

**আপডেট (25 আগস্ট 2026):** `@capacitor-trancee/nearby-connections@0.2.6` যোগের পরে সরাসরি external plugin package ১৪→১৫; নিচের টেবিল ১৮ আগস্টের তারিখিক measurement হিসেবেই রক্ষিত।

| Category | Measurement | ব্যাখ্যা |
|---|---:|---|
| Local plugin source `plugins/` | 253,435 logical bytes; 44 files; 354 KiB `du` | `custom-native` + `isolated-browser` |
| 14 direct external plugin package directory | 8,419,648 logical bytes; 563 files; 9,783 KiB `du` | Capacitor core/platform, CLI, transitive/dev tools বাদ |
| Complete `node_modules/` dependency/tool tree | 209,557,218 logical bytes; 4,927 regular/file-symlink entries; 217,663 KiB `du` | plugin, core, platforms, CLI ও transitive/dev tools; plugin-only নয় |
| Generated native plugin wiring | 9,367 logical bytes; 4 files; 16 KiB allocated | Android registration/Gradle + iOS SPM path wiring; পূর্ণ source copy নয় |
| Retained combined debug APK | 27,054,796 bytes (25.80 MiB) | app, runtime, libraries, resources ও plugin—সব মিলিত |

Measurement-এর সময় local package দুটি `node_modules/@nativekit/*`-এ symlink ছিল, তাই দ্বিতীয় physical plugin-source copy ছিল না; final cleanup-এ পুরো `node_modules/` সরানো হয়েছে। Android Gradle ও iOS SPM package path থেকেই compile করে; synchronized native project-এ আরেকটি পূর্ণ plugin tree নেই। Measured APK merged DEX 25,002,604 raw / 10,090,519 compressed bytes, কিন্তু এতে host, Capacitor, Kotlin/Java runtime ও plugin code merge হয়—তাই APK ZIP entry থেকে exact per-plugin packaged impact আলাদা করা নির্ভরযোগ্য নয়। 25.80 MiB-কে plugin-only size নয়, combined artifact context ধরুন।

## 39. Source-conformance status


---

## সংযোজন (24 আগস্ট 2026): `NativeKit.nearby` — অফলাইন P2P facade

`@capacitor-trancee/nearby-connections@0.2.6` এর উপর গড়া। Feature-gate: `features.nearby=false` হলে প্রতিটি কল throw করে। Trusted `www/`-তেই ব্যবহারযোগ্য; installed mini-app-এর কাছে এখনো expose করা হয় না (ভবিষ্যৎ capability-তালিকায় যুক্ত হতে পারে)। সম্পূর্ণ চুক্তি: payload সবসময় **base64 স্ট্রিং** — facade নিজেই UTF-8↔base64 চালায়।

### Lifecycle
| কল | অর্থ |
|---|---|
| `initialize({endpointName?, serviceID?, strategy?, lowPower?, autoConnect?, payload?})` | Nearby চালু; strategy: `'star'\|'cluster'\|'pointToPoint'` — **দুই পক্ষে মিলা আবশ্যক** |
| `reset()` | সব কিছু থামিয়ে reset |
| `status()` | `{isAdvertising, isDiscovering}` — UI reconcile-এ ব্যবহার করুন (নিয়ম: UI ফ্ল্যাগকে source-of-truth নয়) |

### Visibility
`startAdvertising({endpointName?, connectionType?, lowPower?})`, `stopAdvertising()`, `startDiscovery({lowPower?})`, `stopDiscovery()`

### সংযোগ
`requestConnection({endpointID, endpointName?})` · `acceptConnection({endpointID})` · `rejectConnection({endpointID})` · `disconnect({endpointID})`

### Payload
- `sendPayload({endpointID?|endpointIDs?, payload, alreadyBase64?})` → `{payloadID, payloadType, status}` — **BYTES only**; raw boundary `MAX_PAYLOAD_BYTES=1047552`; facade ডিফল্টে payload-কে base64-এনকোড করে
- `cancelPayload({payloadID})`
- হেল্পার: `encodeBase64Utf8(text)`, `decodeBase64Utf8(b64)`

### পারমিশন
`checkPermissions()` → `{wifiNearby, wifiState, bluetoothNearby, bluetoothLegacy, location, locationCoarse}` · `requestPermissions(groups?)` — group না দিলে ছয়টাই। **কোনো একটি denied থাকলে native advertise/discovery `8034`-এ ব্যর্থ যায়** — UI-তে Geolocation ফ্লো + App Settings deeplink রাখা হার্ড-রুল।

### ইভেন্ট (১২টি — `addListener(name, cb)`)
`onPermissionChanged(granted)` · `onBluetoothStateChanged(state)` · `onEndpointFound/…Lost` `{endpointID, endpointName?}` · `onEndpointInitiated` `{…+authenticationToken, authenticationStatus, isIncomingConnection}` · `onEndpointConnected/…Rejected` `{endpoint}` · `onEndpointFailed` `{endpoint+status}` · `onEndpointDisconnected` · `onEndpointBandwidthChanged` `{endpoint+quality: unknown|low|medium|high}` · `onPayloadReceived` `{endpointID, payloadID, payloadType, payload(base64)}` · `onPayloadTransferUpdate` `{payloadID, status: success|canceled|failure|inProgress, bytesTransferred, totalBytes}`

TestLab-এ ফুল reference-এর ব্যবহারিক প্রমাণ: `www/app.js` "Nearby P2P Lab" মডিউল (চ্যাট + chunked ফাইল প্রোটোকল `fmeta/fchunk/fend/fcancel`, chunk=262,143B)।

---

## `NativeKit.nearby` — পূর্ণ ওয়েব-ডেভ গাইড (যাচাইকৃত ২৫ আগস্ট ২০২৬)

### Trust-tier উপলব্ধতা

| Tier | `nearby` পায়? | কারণ |
|---|---|---|
| Trusted `www/` (আপনার প্রধান অ্যাপ) | ✅ পূর্ণ ১৮ মেম্বার | সরাসরি host bridge |
| **Installed mini-app** | ❌ **নেই** | broker capability enum `APP_BROWSER_CAPABILITIES` (১৯টা আইটেম) ও ৫৬টি নির্দিষ্ট মেথডের allowlist-এ `nearby` **নেই** — সোর্স: `bridge/app-browser.ts` (লাইন ৪–৮) |
| Remote URL (`openUrl`) | ❌ কোনো NativeKit-ই নেই | bridge-free tier |

**সর্বজনীন নিয়ম (যেকোনো নতুন প্লাগিনের ক্ষেত্রে):** নতুন facade মিনি-অ্যাপে **কখনোই অটোম্যাটিক চলে আসে না।** এক্সপোজ করতে দুই ধাপই আলাদা ইঞ্জিনিয়ারিং সিদ্ধান্ত: (১) `APP_BROWSER_CAPABILITIES`-এ নতুন কী যোগ, (২) broker method table-এ `MethodDefinition` এন্ট্রি + consent/audit পাথ। এই বাধাটা ইচ্ছাকৃত — তৃতীয়-পক্ষের কোড নতুন native সারফেস মালিকের সিদ্ধান্ত ছাড়া ছুঁতেই পারে না।

### ধাপে-ধাপে ব্যবহার (প্রকৃত facade মেথড দিয়ে)

ফাইলে `NK = window.NativeKit` ধরে নিলে:

```js
await NK.ready();

// ১) পারমিশন — ৬টি গ্রুপ; কোনো একটিও denied হলে native advertise/discovery 8034 তুলবে
const grants = await NK.nearby.requestPermissions();
//   → { wifiNearby, wifiState, bluetoothNearby, bluetoothLegacy, location, locationCoarse }
// UI-নিয়ম (v1.4.1): location/locationCoarse মিসিং হলে আগে NK.permissions.requestLocation()
// ডেকে আবার চাওয়া, শেষে ব্যর্থ হলে NK.permissions.openAppSettings() ডিপলিংক।

// ২) initialize — strategy দুই পক্ষে মিলা আবশ্যক (না মিললে টানা "peer পাওয়া গেল না")
await NK.nearby.initialize({ strategy: 'star' });

// ৩) ইভেন্ট শোনা (১২টির যেকোনো ইভেন্ট একই generic addListener দিয়ে)
const hFound = await NK.nearby.addListener('onEndpointFound',  e => console.log('পেলাম:', e.endpointID, e.endpointName));
const hData  = await NK.nearby.addListener('onPayloadReceived', e => {
  if (e.payload) console.log('মেসেজ:', NK.nearby.decodeBase64Utf8(e.payload)); // payload সবসময় base64
});
const hInit  = await NK.nearby.addListener('onEndpointInitiated', async e => {
  await NK.nearby.acceptConnection({ endpointID: e.endpointID });  // auto-accept প্যাটার্ন
});

// ৪) দৃশ্যমানতা — যেকোনো বা দুটোই চালু করতে পারো
await NK.nearby.startAdvertising();
await NK.nearby.startDiscovery();

// ৫) কানেক্ট — found-এ ক্লিকে:
await NK.nearby.requestConnection({ endpointID: someId });

// ৬) টেক্সট মেসেজ — payload string-ই; facade নিজে base64-এ পাল্টায় (alreadyBase64:true দিলে না)
await NK.nearby.sendPayload({ endpointID: someId, payload: 'হ্যালো পিয়ার!' });

// ৭) প্রোগ্রেস/ফল
await NK.nearby.addListener('onPayloadTransferUpdate', u => {
  // { payloadID, status: 'inProgress'|'success'|'canceled'|'failure', bytesTransferred, totalBytes }
});

// ৮) UI সিঙ্কে (overlay reopen/e-দ্বিতীয়বার Start): native state-ই সত্য
const st = await NK.nearby.status();   // → { isAdvertising, isDiscovering }

// ৯) পরিষ্কার
await NK.nearby.stopDiscovery(); await NK.nearby.stopAdvertising(); await NK.nearby.reset();
await hFound.remove(); await hData.remove(); await hInit.remove();
```

### Strategy সারণি — কোনটা কখন

| `strategy` | টপোলজি | ব্যবহার |
|---|---|---|
| `'star'` | ১ হোস্ট ↔ N ক্লায়েন্ট | হোস্টেড চ্যাট, শিক্ষক-শিক্ষার্থী, রিমোট কন্ট্রোল (সবচেয়ে ব্যবহৃত) |
| `'cluster'` | সবাই ↔ সবাই mesh | গ্রুপ চ্যাট/কোলাব |
| `'pointToPoint'` | ১ ↔ ১ | একক ফাইল ট্রান্সফার |

Strategy রানটাইমে বদলাতে হলে আগে `reset()` → নতুন `initialize()` (শুধু initialize আবার ডাকলে `ALREADY_HAVE_ACTIVE_STRATEGY`)।

### এরর/স্ট্যাটাস কোড রেফারেন্স (ডিভাইস-প্রমাণিত, v1.4.1)

| কোড/নাম | অর্থ | UI-র সঠিক আচরণ |
|---|---|---|
| `8001` `ALREADY_ADVERTISING` | native-এ advertising আগে থেকেই চলছে | soft-pass (ℹ️) + `status()` দিয়ে UI সিঙ্ক |
| `8002` `ALREADY_DISCOVERING` | discovery আগে থেকেই চলছে | soft-pass + সিঙ্ক |
| `8003` `ALREADY_CONNECTED` (টো endpoint) | peer-টা তো কানেক্টেডই | soft-pass (ℹ️) |
| `8034` `MISSING_PERMISSION…` | কোনো পারমিশন-গ্রুপ denied (বাস্তবে Location জিজ্ঞেস করে) | Geolocation permission ফ্লো → ব্যর্থ হলে App Settings ডিপলিংক |
| `8047` `MISSING_FEATURE…` | ডিভাইসে BT/Wi-Fi হার্ডওয়্যার ফিচারই নেই | ফিচার হাইড |
| অন্যান্য Status enum: `CONNECTION_REJECTED`, `RADIO_ERROR`, `ENDPOINT_UNKNOWN`, `PAYLOAD_UNKNOWN`, `AUTH_ERROR`, `OUT_OF_ORDER_API_CALL`… | প্লাগিনের Status enum-এর বাকি অবস্থা | ইভেন্ট-লগে raw দেখান |

> শিল্প-নিয়ম: Local JS ফ্ল্যাগকে source-of-truth নয় — `status()` দিয়ে reconcile করো; 8001/8002/8003 সিরিজ "native-এ আগেই চলছে আছে" নির্দেশ করে।

### ফাইল-ট্রান্সফার প্রোটোকল নকশা (TestLab-এর প্রমাণিত উদাহরণ)

প্লাগিন upstream-এ BYTES payload-ই দেয়, তাই ফাইলও base64-সিরিজ হিসেবে যায়। TestLab (`www/app.js`) এই ছোট প্রোটোকলটা ব্যবহার করে:

1. **fmeta** — `{type:'fmeta', id, name, size, chunks}` (JSON টেক্সট মেসেজ)
2. **fchunk × N** — `{type:'fchunk', id, seq, data}` — `data` = **262,143-বাইটের** chunk-এর base64
   - `262,143 = 2¹⁸ − 1` — 3-এর গুণিতক, ফলে base64 সীমানা পরিষ্কার; raw সীমার `MAX_PAYLOAD_BYTES = 1,047,552`-এর নীচেই নিরাপদ মার্জিন।
3. **fend** — `{type:'fend', id}` → রিসিভার base64→bytes জোড়া দিয়ে সেভ করে (TestLab: `Data/nativekit-lab/received/`)
4. **fcancel** — `{type:'fcancel', id, payloadID}` + পাঠানোর দিকে `cancelPayload({payloadID})`

> বড় ফাইলে base64-এর ~33% overhead ও মেমরি চাপ মাথায় রাখো; এই প্রোটোকল MB-স্কেল UX-এর জন্য — গিগাবাইট-স্কেলে নয়।

