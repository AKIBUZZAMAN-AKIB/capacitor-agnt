# Mini App ডেভেলপারের সম্পূর্ণ API ও Permission গাইড

> **শুধু installed Mini App-এর জন্য source-verified Bangla guide**
> Repository: `AKIBUZZAMAN-AKIB/capacitor-agnt`
> মূল source baseline: `523c277c5cca27436c1d762fd62eaeb945ce5f79` + Mini App UI artifact feature changes
> Broker facade version: `app-browser-1.1.0`
> Host-এর পূর্ণ API চাইলে [`FULL-API-REFERENCE.bn.md`](./FULL-API-REFERENCE.bn.md) দেখুন।

এই গাইডের প্রধান উৎস `bridge/app-browser.ts`। Mini App-এর জন্য শুধু `bootstrapSource()`-এ inject হওয়া methods এবং `createAppBrowserMethodTable()`/`subscribe()`-এর allowlist-ই প্রযোজ্য। Host facade-এর সব method Mini App-এ পাওয়া যাবে—এমন ধারণা করা যাবে না।

---

## 1. Mini App কী এবং কোন API পায়

Mini App হলো host-এর App Browser-এ install করা একটি static web package। Launch হলে এটি পায়:

- নিজের `appIdentity` ও package integrity ভিত্তিক session;
- non-writable, non-configurable `window.NativeKit`;
- প্রতি session-এর আলাদা random broker token;
- policy-checked, rate-limited native methods;
- per-app namespaced storage/files/database;
- অনুমোদিত subscriptions;
- host-এর raw Capacitor plugins, provider secret, Agent, Widget বা App Browser manager **নয়**।

### Remote URL Mini App নয়

`appBrowser.openUrl()` দিয়ে খোলা remote HTTPS page-এ `NativeKit` bootstrap inject হয় না। সেখানে `window.NativeKit` ধরে code লিখবেন না।

---

## 2. সবচেয়ে ছোট কার্যকর Mini App

### `nativekit.manifest.json`

```json
{
  "id": "com.example.hello",
  "name": "Hello Mini App",
  "version": "1.0.0",
  "entry": "index.html",
  "description": "A small NativeKit example",
  "requestedCapabilities": [
    "preferences",
    "haptics",
    "networkStatus"
  ],
  "allowedHosts": [],
  "networkMode": "sandboxed",
  "colorScheme": "dark"
}
```

### `index.html`

```html
<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello Mini App</title>
</head>
<body>
  <h1 id="title">লোড হচ্ছে…</h1>
  <button id="save">মান সংরক্ষণ</button>
  <button id="read">মান পড়া</button>
  <pre id="output"></pre>

  <script>
    const output = document.querySelector('#output');
    const show = value => output.textContent =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);

    async function boot() {
      const NK = await window.NativeKit.ready();
      document.querySelector('#title').textContent = NK.appIdentity.name;

      document.querySelector('#save').onclick = async () => {
        try {
          await NK.preferences.set('message', 'হ্যালো NativeKit');
          await NK.haptics.notification('SUCCESS');
          show('সংরক্ষিত');
        } catch (error) { show(error.message); }
      };
      document.querySelector('#read').onclick = async () => {
        try { show(await NK.preferences.get('message')); }
        catch (error) { show(error.message); }
      };
    }
    boot().catch(error => show(error.message));
  </script>
</body>
</html>
```

ZIP-এর root বা একটি common root folder-এর ভিতর `index.html` ও `nativekit.manifest.json` রাখা যায়। Package integrity SHA-256 দিয়ে হিসাব হয়।

---

## 3. Manifest schema ও validation

| Field | আবশ্যক/ডিফল্ট | নিয়ম |
|---|---|---|
| `id` | না দিলে generated | lowercase dotted/dashed stable ID; regex `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$`; সর্বোচ্চ 120 char |
| `name` | ডিফল্ট generated/`Third-party app` | সর্বোচ্চ 80 char |
| `version` | `1.0.0` | সর্বোচ্চ 40 char |
| `entry` | `index.html` | package-এর existing `.html`/`.htm` file |
| `description` | খালি | সর্বোচ্চ 500 char |
| `requestedCapabilities` | `[]` | শুধু নিচের ১৯টি known capability; duplicate remove হয় |
| `allowedHosts` | `[]` | hostname, optional `*.` ও port; scheme/path নয় |
| `networkMode` | missing/empty = **`full`** | `sandboxed`, `hosts`, `full`; ভুল non-empty value = `sandboxed` |
| `colorScheme` | `dark` | `dark`/`light`; অন্য value `dark` |
| `webComponent` | optional | `{tag,module,attributes?}`; hyphenated tag ও existing module প্রয়োজন |

`allowedHosts` উদাহরণ:

```json
["api.example.com", "*.cdn.example.com", "localhost:8443"]
```

- `*.cdn.example.com` subdomains মেলায়, কিন্তু apex `cdn.example.com` মেলায় না।
- Broker URL matching HTTP/HTTPS উভয় করতে পারে; host app-এর global cleartext policy আলাদাভাবে `http:` block করতে পারে।
- Host owner `setAllowedHosts()` দিয়ে manifest-এ না থাকা host পরে যোগ করতে পারে না—শুধু requested host-এর subset রাখতে পারে।

### Package limits

বর্তমান `app.config.json` অনুযায়ী:

- সর্বোচ্চ ২০টি installed app;
- প্রতি package সর্বোচ্চ 15 MiB (`15,728,640` bytes);
- সর্বোচ্চ 500 files;
- ZIP64 unsupported;
- absolute path, `..`, backslash/NUL path নিষিদ্ধ;
- duplicate normalized path নিষিদ্ধ;
- entry HTML হতে হবে।

একই ID-এর package content বদলালে integrity বদলায় এবং app **disabled** হয়। Host owner-কে নতুন package পুনরায় enable/review করতে হবে; পুরোনো enabled policy নতুন code-কে স্বয়ংক্রিয়ভাবে চালায় না।

---

## 4. Runtime bootstrap ও lifecycle

```js
window.addEventListener('nativekitready', async event => {
  const NK = await window.NativeKit.ready();
  console.log(event.detail); // { app, brokered: true }
}, { once: true });
```

Bridge যদি ইতিমধ্যে থাকে:

```js
const NK = await window.NativeKit.ready();
console.log(NK.version);      // app-browser-1.1.0
console.log(NK.appIdentity); // frozen { id, name, version }
console.log(await NK.capabilities());
```

`capabilities()` ফেরত দেয়:

- `appEnabled`;
- legacy `grants`, `methodOverrides`;
- `capabilityDecisions`, `methodDecisions`;
- `allowedHosts`।

এটি effective policy snapshot; OS permission বা native feature availability-এর পূর্ণ প্রতিশ্রুতি নয়। প্রতিটি call-এর সময় policy আবার enforce হয়।

### Generic broker call

```js
await NK.call('network.status');
```

সাধারণত typed convenience method ব্যবহার করুন। Arbitrary host method `call()` দিয়ে ডাকা যায় না—শুধু broker method table-এর allowlisted নাম গ্রহণ করা হয়। RPC timeout 120 সেকেন্ড।

---

## 5. সম্পূর্ণ exposed API matrix

নিচের table-টিই installed Mini App-এর বর্তমান direct JavaScript surface। অন্য সব নাম অনুপস্থিত বা reject হবে।

| Group | Direct methods |
|---|---|
| Core | `ready`, `capabilities`, `call`, `subscribe` |
| `permissions` | `permissions.check`, `permissions.requestCamera`, `permissions.requestLocation`, `permissions.requestNotifications`, `permissions.openAppSettings` |
| `http` | `http.request`, `http.get`, `http.post`, `http.stream` |
| `camera` | `camera.getPhoto`, `camera.pickImages` |
| `location` | `location.current`, `location.watch` |
| `backgroundLocation` | `backgroundLocation.start`, `backgroundLocation.stop`, `backgroundLocation.status` |
| `haptics` | `haptics.impact`, `haptics.notification`, `haptics.vibrate` |
| `notifications` | `notifications.check`, `notifications.request`, `notifications.schedule`, `notifications.cancel` |
| `alarms` | `alarms.capabilities`, `alarms.requestExactAccess`, `alarms.requestFullScreenAccess`, `alarms.schedule`, `alarms.cancel`, `alarms.list`, `alarms.stop` |
| `background` | `background.dispatch`, `background.runSyncNow`, `background.checkPermissions`, `background.requestPermissions` |
| `preferences` | `preferences.set`, `preferences.get`, `preferences.remove`, `preferences.setJSON`, `preferences.getJSON` |
| `secureStorage` | `secureStorage.set`, `secureStorage.get`, `secureStorage.remove` |
| `sqlite` | `sqlite.open`, `sqlite.execute`, `sqlite.run`, `sqlite.query`, `sqlite.close`, `sqlite.delete` |
| `filesystem` | `filesystem.readFile`, `filesystem.writeFile`, `filesystem.appendFile`, `filesystem.deleteFile`, `filesystem.mkdir`, `filesystem.rmdir`, `filesystem.readdir`, `filesystem.stat` |
| `transfer` | `transfer.download`, `transfer.upload` |
| `miniUI` | `miniUI.publish`, `miniUI.list`, `miniUI.get`, `miniUI.remove` |
| `floatingUI` | `floatingUI.publish/list/get/remove`, `checkPermission`, `requestPermission`, `show`, `hide` |
| `homeWidget` | `homeWidget.publish/list/get/remove`, `activate`, `requestPin` |
| `browser` | `browser.open` |
| `share` | `share.canShare`, `share.show` |
| `network` | `network.status` |
| `app` | `app.info`, `app.state` |

### যেগুলো Mini App-এ নেই

- `agent`, MCP, built-in device tools;
- raw trusted-host `widget` facade (শুধু নতুন owner-bound `miniUI`/`floatingUI`/`homeWidget` artifact broker exposed);
- `nearby`;
- `appBrowser` install/launch/policy/audit manager;
- `biometric`, `serviceWorker`;
- `push.register`, token, delivered-list APIs;
- `preferences.clear/keys`, `secureStorage.clear`;
- background-location `buffered/clearBuffered`;
- notification delivered-list/channel/removeDelivered;
- app deep-link listener/exit;
- filesystem `getUri`, arbitrary native directory;
- transfer progress callback/redirect control;
- raw native plugins এবং arbitrary Capacitor imports।

`pushNotifications` capability শুধু `push.received` ও `push.action` subscription-এর জন্য।

---

## 6. Capability ও permission model

### 6.1 সব ২২টি capability

```text
permissions
http
camera
location
backgroundLocation
haptics
notifications
alarms
background
preferences
secureStorage
sqlite
filesystem
fileTransfer
sharing
networkStatus
appInfo
pushNotifications
browser
miniUI
floatingUI
homeWidget
```

Manifest-এ requested না থাকা capability-এর বর্তমান default **`block`**। Requested capability-এর default **`ask`**। তাই প্রয়োজনীয় capability manifest-এ না লিখলে host settings বদল না করা পর্যন্ত call ব্যর্থ হবে।

### 6.2 Policy decisions

প্রতিটি capability-এর জন্য:

- `ask` — প্রথম call-এ trusted host consent প্রয়োজন;
- `allow` — broker call অনুমোদিত, OS permission এখনো আলাদা;
- `block` — সম্পূর্ণ revocation।

প্রতিটি exact method-এর জন্য `ask|allow|block|inherit`-এর মতো কার্যকর override থাকতে পারে। Capability `block` হলে stale method-level `allow` কাজ করে না।

`appBrowser.defaultCapabilities` কনফিগ শুধু **manifest-requested** capability pre-allow করতে পারে; unrequested capability স্বয়ংক্রিয়ভাবে allow করে না।

### 6.3 Consent actions

Host UI চারটি action দিতে পারে:

| Action | ফল |
|---|---|
| `allow_once` | শুধু এই call |
| `allow_always` | exact method persistently allow |
| `block_once` | এই call deny |
| `block_always` | exact method persistently block |

Default prompt timeout 90 সেকেন্ড; configured value broker-এ 5–110 সেকেন্ডে clamp হয়। App disable, session stop, package change বা permission revoke হলে pending call cancel হয়।

### 6.4 Broker policy + OS permission

দুটি ধাপ আলাদা:

```text
manifest declaration
  → per-app broker policy/consent
  → native feature flag
  → Android/iOS permission
  → hardware/external configuration
```

উদাহরণ: `camera.getPhoto()` সফল হতে `camera` capability allow/approved, host `features.camera=true`, এবং OS camera/photo access লাগতে পারে। Broker consent দিলেই OS permission granted হয় না।

---

## 7. API-ভিত্তিক বিস্তারিত ব্যবহার

### 7.1 `permissions`

```ts
await NK.permissions.check()
await NK.permissions.requestCamera()
await NK.permissions.requestLocation(coarseOnly = false)
await NK.permissions.requestNotifications()
await NK.permissions.openAppSettings()
```

`check()` sanitized camera/photos, location, notifications, push, alarm এবং background-location snapshot দেয়। Mini App-এর জন্য `permissions.requestPush()` exposed নয়।

### 7.2 `http`

```ts
NK.http.request({
  url, method?, headers?, params?, data?, responseType?: 'json'|'text'
})
NK.http.get(url, options?)
NK.http.post(url, data?, options?)
```

Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`।

Broker-enforced limits/behavior:

- connect timeout 15 সেকেন্ড, read timeout 30 সেকেন্ড;
- redirects disabled;
- শুধু `json`/`text` response type;
- body/JSON data সর্বোচ্চ 1 MiB;
- `params` serialized size সর্বোচ্চ 64 KiB;
- সর্বোচ্চ 64 headers, মোট header bytes 32 KiB;
- header name 1–100 valid token chars; NUL/CR/LF নিষিদ্ধ;
- Mini App caller timeout/redirect/native transport option বদলাতে পারে না।

```js
const result = await NK.http.get('https://api.example.com/items', {
  params: { limit: 10 },
  responseType: 'json'
});
console.log(result.status, result.data);
```

#### `http.stream`

```js
const stream = await NK.http.stream({
  url: 'https://api.example.com/events',
  method: 'GET', // GET বা POST
  headers: { Accept: 'text/event-stream' },
  body: undefined, // সর্বোচ্চ 1 MiB string
  format: 'sse'    // sse | text | ndjson
}, {
  onMessage: message => console.log(message.data),
  onError: error => console.error(error),
  onEnd: info => console.log(info.status)
});
await stream.close();
```

- `http` capability এবং global `nativeSSE` feature লাগে।
- Stream-এর return `{id, close}`; host facade-এর `done` Promise Mini App-এ নেই।
- Event message-এর `data` সর্বোচ্চ 1 MiB।

### 7.3 `camera`

```ts
NK.camera.getPhoto({
  quality?, width?, height?, allowEditing?,
  source?: 'CAMERA'|'PHOTOS'|'PROMPT'
})
NK.camera.pickImages({ quality?, width?, height?, limit? })
```

- Single photo: quality 1–75, width/height সর্বোচ্চ 1024; result base64, gallery-তে save হয় না।
- Single result data সর্বোচ্চ 1.5 MiB।
- Gallery: quality 1–65, width/height সর্বোচ্চ 640, limit 1–4; মোট sanitized result সর্বোচ্চ `1,835,008` bytes।
- Return shape সাধারণত `{data, encoding:'base64', format, saved}` অথবা `{photos:[...]}`।

### 7.4 `location`

```ts
await NK.location.current(options?)
const watch = await NK.location.watch((position, error) => {}, options?)
await watch.remove()
```

Options: `enableHighAccuracy`, `timeout`, `maximumAge`, `minimumUpdateInterval`; broker sanitize/clamp করে। Watch `location.watch` subscription ব্যবহার করে।

### 7.5 `backgroundLocation`

```ts
await NK.backgroundLocation.start({
  minTimeMs?, minDistanceM?, maxBuffer?, desiredAccuracy?: 'low'|'high'
})
await NK.backgroundLocation.stop()
await NK.backgroundLocation.status()
const sub = await NK.subscribe('backgroundLocation.location', point => {})
```

Broker bounds:

- `minTimeMs`: 10 সেকেন্ড–1 ঘণ্টা;
- `minDistanceM`: 0–10,000;
- `maxBuffer`: 10–1,000;
- accuracy `low` না হলে `high`।

এক সময়ে শুধু owner app/host tracking চালাতে পারে। শুধু owner app stop করতে ও location events পেতে পারে। Revocation/disable-এ tracking মুক্ত করা হয়। Buffer read/clear API Mini App-এ নেই।

### 7.6 `haptics`

```ts
NK.haptics.impact('LIGHT'|'MEDIUM'|'HEAVY')
NK.haptics.notification('SUCCESS'|'WARNING'|'ERROR')
NK.haptics.vibrate(durationMs) // broker: 1–5000 ms
```

### 7.7 `notifications`

```ts
NK.notifications.check()
NK.notifications.request()
NK.notifications.schedule(items)
NK.notifications.cancel(logicalIds)
```

```js
await NK.notifications.schedule([{
  id: 'reminder-1',
  title: 'স্মরণ করিয়ে দিন',
  body: 'Mini App task শেষ করুন',
  schedule: { at: new Date(Date.now() + 60_000) },
  sound: 'default'
}]);
await NK.notifications.cancel(['reminder-1']);
```

- Mini App নিজের string/logical ID ব্যবহার করে; broker native numeric ID map করে।
- প্রতি call 1–16 items, batch-এ ID unique।
- প্রতি app সর্বোচ্চ 16 pending, broker-এর সব app মিলিয়ে 32 pending।
- Cancel list সর্বোচ্চ 64 IDs এবং শুধু app-owned notification বাতিল করে।
- Title 200, body 2000 chars পর্যন্ত bounded।
- Schedule: `at`, `every`, `on`, `count`, `allowWhileIdle`; repeat count 1–1000।
- Received/action subscription-এ শুধু app-tagged notification আসে।

### 7.8 `alarms`

```ts
NK.alarms.capabilities()
NK.alarms.requestExactAccess()
NK.alarms.requestFullScreenAccess()
NK.alarms.schedule({ id, title, body?, at, repeatIntervalMinutes?, fullScreen?, sound? })
NK.alarms.cancel(id)
NK.alarms.stop(id)
NK.alarms.list()
```

- প্রতি app 16, broker-এ মোট 32 alarm।
- `at`: valid date string, `Date` বা epoch ms।
- Repeat positive হলে 15–525,600 মিনিটে clamp হয়।
- শুধু app-owned alarm cancel/stop/list করা যায়।
- `request...Access()` resolve হওয়া grant-এর প্রমাণ নয়; capability আবার check করুন।
- `alarms.fired` event-এ logical `id` ফেরত আসে।

### 7.9 `background`

```ts
NK.background.dispatch()
NK.background.runSyncNow()
NK.background.checkPermissions()
NK.background.requestPermissions(['geolocation', 'notifications'])
```

- Caller arbitrary runner event/details দিতে পারে না।
- Dispatch host-এর configured `defaultSyncUrl` ও `source: appBrowser:<appId>` ব্যবহার করে।
- Runner code host-owned; Mini App নিজের background JavaScript file চালায় না।
- Short sync dispatch; exact execution guarantee নয়।

### 7.10 `preferences`

```ts
set(key, stringValue)
get(key): Promise<string|null>
remove(key)
setJSON(key, value)
getJSON(key)
```

Key 1–200 safe chars; NUL/CR/LF নিষিদ্ধ। Value সর্বোচ্চ 1 MiB। Broker key prefix করে, তাই অন্য app/host-এর key পড়া যায় না। `clear()`/`keys()` নেই।

### 7.11 `secureStorage`

```ts
set(key, value)
get(key): Promise<string|null>
remove(key)
```

Key একই 1–200 chars; value সর্বোচ্চ 64 KiB। Native Keystore/Keychain backing; per-app namespaced key। `clear()` নেই। Secret রাখার আগেও data lifecycle ও device backup policy বুঝে নিন।

### 7.12 `sqlite`

```ts
open(logicalName = 'main')
execute(logicalName, statements, transaction = true)
run(logicalName, statement, values = [], transaction = true)
query(logicalName, statement, values = [])
close(logicalName)
delete(logicalName)
```

```js
await NK.sqlite.open('notes');
await NK.sqlite.execute('notes', `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL
  )
`);
await NK.sqlite.run('notes', 'INSERT INTO notes(body) VALUES (?)', ['হ্যালো']);
const rows = await NK.sqlite.query('notes', 'SELECT * FROM notes ORDER BY id');
console.log(rows.values);
```

- Logical name per-app native database-এ map হয়; host/অন্য app-এর DB নাম দিয়ে access করা যায় না।
- Encryption option নেই; broker `encrypted:false` ও `no-encryption` enforce করে।
- Database quota 64 MiB; `PRAGMA max_page_count` দিয়ে verify/enforce হয়।
- Query rows result সর্বোচ্চ 2,000,000 serialized bytes।
- Parameterized SQL ব্যবহার করুন।

### 7.13 `filesystem`

```ts
readFile({ path, directory?, encoding? })
writeFile({ path, data, directory?, encoding?, recursive? })
appendFile({ path, data, directory?, encoding? })
deleteFile({ path, directory?, recursive? })
mkdir({ path, directory?, recursive? })
rmdir({ path, directory?, recursive? })
readdir({ path, directory? })
stat({ path, directory? })
```

- Directory শুধু `Data` বা `Cache`; default `Data`।
- Path broker `nativekit-app-browser/<appId>/...`-এর নিচে রাখে।
- Total quota 64 MiB এবং 512 files প্রতি app।
- Text encoding `utf8`, `ascii`, `utf16`; encoding না দিলে base64 data আশা করা হয়।
- Read limit: encoded text file 1,835,008 bytes; binary file 1,376,256 bytes।
- `readdir` সর্বোচ্চ 1024 entries গ্রহণ করে।
- Arbitrary absolute path, `..`, host Documents/External বা `getUri()` নেই।

### 7.14 `transfer`

```ts
download({ url, path, directory?, headers? })
upload({ url, path, directory?, headers?, method?, mimeType? })
```

- Download file সর্বোচ্চ 32 MiB এবং filesystem quota-এর মধ্যে থাকতে হবে; quota overflow হলে partial file discard করা হয়।
- Upload source file সর্বোচ্চ 32 MiB।
- Upload method `POST`/`PUT`/`PATCH`, default `POST`।
- MIME default `application/octet-stream`।
- Redirects disabled, progress callback নেই।
- URL network policy মেনে চলে।

### 7.15 `share`

```ts
NK.share.canShare()
NK.share.show({ title?, text?, url?, dialogTitle? })
```

- Title/dialogTitle 200, text 10,000, URL 2,000 chars bounded।
- URL শুধু HTTP(S)।
- Mini App broker file attachment expose করে না।
- Return `{completed, activityType?}`-এর মতো sanitized result।

### 7.16 `browser`, `network`, `app`

```ts
NK.browser.open(urlOrOptions) // {opened:true}
NK.network.status()          // {connected, connectionType}
NK.app.info()                // Mini App-এর {id,name,version}
NK.app.state()               // {isActive}
```

`app.info()` host package ID/build নয়—Mini App identity দেয়।

### 7.17 `miniUI`, `floatingUI`, `homeWidget` — আলাদা publishable UI artifact

এগুলো **নতুন implemented feature**; raw `NK.widget` exposure নয়। প্রতিটি group-এ `publish(input)`, `list()`, `get(id='main')`, `remove(id='main')` আছে। Publish-এর `input`-এ `id?`, `title?`, `description?`, `html` ও bounded `config?` থাকে। Caller-এর source identity authenticated Mini App session থেকে আসে—অন্য owner ID পাঠিয়ে overwrite করা যায় না।

```js
await NativeKit.miniUI.publish({
  id: 'stopwatch',
  title: 'Offline stopwatch',
  html: '<!doctype html><button id="start">Start</button><script>/* inline, self-contained JS */<\/script>',
  config: {},
});
const mine = await NativeKit.miniUI.list();
```

Floating Android-এ `checkPermission()`, `requestPermission()`, `show(id)`, `hide(id)` যোগ করে। Permission request-এর পর আবার `checkPermission()` করুন; granted না হলে `show` ব্যর্থ হবে। Home-এ `activate(id)` ও `requestPin(id)` আছে। Home HTML live widget নয়—static bitmap snapshot। Default আটটি reserved Android provider slot configure হয়।

Artifact আলাদা native store-এ source, revision, checksum ও timestamps-সহ থাকে। Host `NK.appBrowser.artifacts` থেকে Mini UI preview mount, floating show/hide, home activate/pin ও delete করতে পারে। Mini UI broker-less/offline iframe; floating-এ network/file/content access ও trusted native JS interface নেই। Native Android/iOS persistence আছে; floating/home activation Android-only। Hosted web target-এ artifact API নেই।

Quotas, host object signatures, storage commit/rollback, slot lifecycle, security এবং stopwatch package-এর বিস্তারিত: [`MINI-APP-UI-ARTIFACTS.bn.md`](./MINI-APP-UI-ARTIFACTS.bn.md)।

---

## 8. সব ১০টি subscription

```ts
const sub = await NK.subscribe(eventName, callback, options?);
await sub.remove();
```

| Event name | Capability | Payload/নোট |
|---|---|---|
| `location.watch` | `location` | `{position,error?}`; সাধারণত `NK.location.watch()` ব্যবহার করুন |
| `http.stream` | `http` | `{type:'message'|'error'|'end',payload}`; সাধারণত `NK.http.stream()` ব্যবহার করুন |
| `network.change` | `networkStatus` | sanitized `{connected,connectionType}` |
| `app.stateChange` | `appInfo` | `{isActive}` |
| `backgroundLocation.location` | `backgroundLocation` | শুধু current owner app |
| `alarms.fired` | `alarms` | app-owned logical `{id}` |
| `notifications.received` | `notifications` | app-tagged notification |
| `notifications.action` | `notifications` | app-tagged action + notification |
| `push.received` | `pushNotifications` | শুধু `data.nativeKitAppBrowserId` matching push |
| `push.action` | `pushNotifications` | matching push action |

### Push-এর গুরুত্বপূর্ণ শর্ত

Mini App নিজে push register/token নেয় না। Host/provider-কে push payload-এ সঠিক `data.nativeKitAppBrowserId` দিতে হবে। Repository-তে Firebase/APNs credentials configured নয়, তাই বর্তমান state-এ end-to-end delivery আশা করা যাবে না।

Session stop, app disable, capability revoke বা package integrity change-এ subscriptions/native resources release হয়। আপনার UI lifecycle-এও unused subscription remove করুন।

---

## 9. Network mode — বাস্তব আচরণ ও সতর্কতা

### 9.1 তিনটি mode

| Mode | Direct WebView/iframe network | Brokered `http`/`transfer`/`browser` |
|---|---|---|
| `full` | iframe CSP-তে HTTPS/WSS খোলা; external images/media/font ইত্যাদি policy অনুযায়ী | যেকোনো HTTP(S) host, host-এর global network gate সাপেক্ষে |
| `hosts` | `allowDirectWebNetwork=true` হলে approved HTTPS/WSS host | approved `allowedHosts` |
| `sandboxed` | direct network বন্ধ | **নিচের implementation caveat পড়ুন** |

`allowDirectWebNetwork=false` শুধু direct web network বন্ধ করে; brokered native HTTP বন্ধ করে না। একইভাবে external remote script package-এ রাখলেও CSP `script-src` remote HTTPS allow করে না—package JS local রাখুন।

### 9.2 Source-verified `sandboxed` caveat

বর্তমান `checkAppUrl()` implementation শুধু `full` বনাম non-`full` আলাদা করে। ফলে `networkMode:'sandboxed'` হলেও **brokered** `http`, `transfer` এবং `browser` call `allowedHosts`-এর কোনো host-এ যেতে পারে। Direct network অবশ্য বন্ধ থাকে।

তাই strict offline Mini App চাইলে এই commit-এ:

- `allowedHosts: []` রাখুন;
- `http`, `fileTransfer`, `browser` capability request করবেন না;
- host policy-তে এগুলো `block` রাখুন।

শুধু `"networkMode":"sandboxed"` লিখে brokered network নিঃসন্দেহে বন্ধ ধরবেন না। এটি implementation-এর বর্তমান সীমাবদ্ধতা/অসঙ্গতি, নিরাপদ offline guarantee নয়।

### 9.3 Default খুব গুরুত্বপূর্ণ

Manifest-এ `networkMode` না দিলে default **`full`**, `sandboxed` নয়। Sensitive app-এ সবসময় স্পষ্ট mode ও ন্যূনতম host/capability লিখুন।

---

## 10. Renderer, storage ও isolation

### Isolated renderer

- বর্তমান default; native Android/iOS plugin stage/open/RPC transport ব্যবহার করে।
- Android minimum API 28; current stage chunk 256 KiB; hang termination delay 4 সেকেন্ড।
- Native unavailable/failure হলে current config iframe fallback করে।
- Isolated consent UI native trusted surface থেকে আসে।

### Iframe fallback

- `sandbox="allow-scripts"`; same-origin allowance নেই।
- `referrerPolicy="no-referrer"`।
- Browser camera/microphone/geolocation feature policy `none`; native access শুধু broker-এর মাধ্যমে।
- Remote package scripts/styles/assets local package file হিসেবে inline/data URL/module map হয়।

### Per-app ownership

Broker logical ID/name-কে native resource-এ map করে:

- Preferences/secure keys prefix হয়;
- SQLite names app-specific;
- files app-specific root-এ যায়;
- notification/alarm IDs app-specific;
- background location owner tracked হয়;
- push/notification events app tag দিয়ে filter হয়।

Native target-এ installed package bytes এখন Capacitor Filesystem `Data/nativekit-object-store/packages/<app>/<integrity>/`-এ থাকে; IndexedDB-তে metadata/policy থাকে। পুরোনো IndexedDB package native commit-এর পর migrate হয় এবং native-এ silent web fallback নেই। Publishable Mini UI/Floating/Home code আলাদা `Data/nativekit-object-store/artifacts/<kind>/<owner>/`-এ versioned native files হিসেবে থাকে।

App disable/capability revoke-এ active sessions এবং owned native resources মুক্ত করা হয়। `cleanup()` data/state clear করে package রাখে; `remove()` package, policy, data, UI artifacts ও owned resources মুছে দেয়—এই host methods Mini App নিজে ডাকতে পারে না।

---

## 11. Rate limit, audit ও errors

### Rate limit

বর্তমান default প্রতি active session **120 broker requests/minute**। `@capabilities`, subscribe/unsubscribe ও normal native call সব broker rate-limit-এর মধ্যে পড়ে। Limit হলে error code `RATE_LIMITED`।

### Audit

Host দেখতে পারে:

- app ID/name;
- method/capability;
- timestamp/duration;
- outcome: `success`, `error`, `denied`, `rate_limited`, `cancelled`, `timeout`;
- error code/permission request ID/authorization type;
- argument-এর type/size/key summary, raw argument value নয়।

Default audit retention 2000 records। Mini App audit read/clear করতে পারে না।

### সাধারণ error handling

```js
async function guarded(action) {
  try { return await action(); }
  catch (error) {
    console.error(error.code, error.message);
    if (error.code === 'POLICY_DENIED') {
      // Host policy block; ব্যবহারকারীকে জানান, retry loop করবেন না।
    } else if (error.code === 'RATE_LIMITED') {
      // Back off; subscription/অন unnecessary call কমান।
    }
    throw error;
  }
}
```

পাওয়া সম্ভব policy errors: `POLICY_DENIED`, `POLICY_BLOCKED_ONCE`, `POLICY_BLOCKED_ALWAYS`, `PERMISSION_TIMEOUT`, `PERMISSION_CANCELLED`, `PERMISSION_UI_FAILED`, `RATE_LIMITED`। OS/plugin errors-এর code/message আলাদা হতে পারে। Sensitive native paths broker error serialization-এ redact হয়।

---

## 12. Permission checklist — capability অনুযায়ী

| Mini App capability/method | Host-side OS permission/configuration |
|---|---|
| `camera` | Android `CAMERA`; iOS camera/photos purpose strings ও user grant |
| `location` | Android coarse/fine runtime; iOS When In Use |
| `backgroundLocation` | Foreground location + Android Allow all the time/FGS বা iOS Always + location background mode |
| `notifications` | Android 13+ notification permission; iOS UserNotifications authorization |
| `alarms` | Android notification/exact/full-screen special access প্রযোজ্য হলে; iOS AlarmKit বা notification fallback |
| `background` | Background Runner manifest/BGTask identifiers; runner API অনুযায়ী location/notification permission |
| `pushNotifications` events | Android Firebase + notification permission; iOS APNs + authorization + correctly tagged payload |
| `http`, `fileTransfer`, `browser` | Internet declaration; network host/mode policy; TLS/cleartext policy |
| `haptics` | Android vibrate merged manifest; iOS system haptics |
| `secureStorage` | Keystore/Keychain; সাধারণ runtime prompt নেই |
| `filesystem` | App-private Data/Cache; public storage permission প্রয়োজন নেই |
| `preferences`, `sqlite`, `networkStatus`, `appInfo`, `sharing` | সংশ্লিষ্ট plugin/config; সাধারণ user runtime permission নেই |
| `permissions` | Broker-level status/request methods; প্রকৃত OS grant আলাদা |
| `miniUI` | Native filesystem + widget/App Browser features; preview host করে; Mini App-এর আলাদা OS prompt নেই |
| `floatingUI` | Native filesystem/widget; Android display-over-other-apps special access ও visible user purpose |
| `homeWidget` | Native filesystem/widget; generated Android provider slots; launcher pin support/confirmation প্রযোজ্য হলে |

বিস্তারিত Android/iOS declaration locations ও merged-manifest caveat পূর্ণ host reference-এর Permission অংশে আছে।

---

## 13. Production Mini App checklist

- [ ] Stable lowercase ID, সঠিক entry ও semantic version দিয়েছি।
- [ ] শুধু প্রয়োজনীয় `requestedCapabilities` রেখেছি।
- [ ] `networkMode` স্পষ্টভাবে লিখেছি; `full` unintentionally default হতে দিইনি।
- [ ] ন্যূনতম `allowedHosts` রেখেছি; wildcard প্রয়োজন কিনা যাচাই করেছি।
- [ ] প্রতিটি Promise-এর rejection handle করেছি।
- [ ] `allow` মানে OS grant নয়—দুটি আলাদা ধাপ হিসেবে UI/ত্রুটি সামলেছি।
- [ ] Watch/stream/subscription `remove()`/`close()` করেছি।
- [ ] Storage, file, DB, notification, alarm ও RPC limits-এর মধ্যে আছি।
- [ ] কোনো provider/API secret package-এ রাখিনি—installed static code user inspect করতে পারে।
- [ ] Direct DOM camera/mic/geolocation নয়, broker API ব্যবহার করেছি।
- [ ] Agent/Widget/Nearby/raw plugin ধরে code লিখিনি।
- [ ] Package update-এর পর host re-enable/review প্রয়োজন—ব্যবহারকারীকে জানিয়েছি।
- [ ] Isolated renderer ও iframe fallback—দুই পরিবেশে UI/test করেছি।
- [ ] Push প্রয়োজন হলে host provider tagging/configuration নিশ্চিত করেছি।
- [ ] Background exact timing নয়—idempotent ও failure-tolerant design করেছি।

---

## 14. দ্রুত source map

| বিষয় | Source |
|---|---|
| Mini App bootstrap method list | `bridge/app-browser.ts → bootstrapSource()` |
| Manifest/network normalization | `parseManifest`, `validateHosts`, `normalizeAppBrowserNetworkMode` |
| Per-method behavior/quotas | `createAppBrowserMethodTable()` |
| Consent policy | `getAppBrowserPermissionDecision`, `authorize`, `requestPermission` |
| Subscriptions | `subscribe()` |
| Package/render/session | `installPackage`, `launch`, `buildDocument`, `stop` |
| Host management | `createAppBrowser()` returned `appBrowser` facade |
| Native package/artifact object store | `bridge/native-object-store.ts` |
| UI artifact activation/preview/ownership | `bridge/mini-app-artifacts.ts` |
| UI artifact guide/sample | `docs/MINI-APP-UI-ARTIFACTS.bn.md`, `examples/app-browser-artifacts/` |
| Global defaults | `app.config.json → appBrowser` |
| Native isolated renderer | `plugins/isolated-browser/{android,ios}` |
