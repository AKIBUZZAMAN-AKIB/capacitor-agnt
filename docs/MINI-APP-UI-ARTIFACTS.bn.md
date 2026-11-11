# Mini App UI Artifacts — Mini UI, Floating UI ও Home Widget

এই নথি **নতুন implemented broker feature** বর্ণনা করে। এটি পুরোনো trusted host-only `NK.widget` API নয়। Mini App নিজের মূল UI থেকে আলাদা HTML/CSS/JS artifact publish করে; trusted host সেটি পরে preview/use/update/remove করতে পারে।

## 1. তিনটি surface, তিনটি store

| Mini App facade | Store kind | Host-এর ব্যবহার | Runtime আচরণ |
|---|---|---|---|
| `NativeKit.miniUI` | `mini-ui` | `NK.appBrowser.artifacts.mountMiniUI(...)` | Native host DOM-এ offline, broker-less `sandbox="allow-scripts"` iframe |
| `NativeKit.floatingUI` | `floating-ui` | `showFloatingUI(...)`, `hideFloatingUI(...)` | Android live overlay WebView; এক সময়ে একটি owner |
| `NativeKit.homeWidget` | `home-widget` | `activateHomeWidget(...)`, `requestPinHomeWidget(...)` | Android offscreen WebView থেকে **static bitmap snapshot**; live WebView নয় |

তিন ধরনের artifact-এর ID একই হলেও store আলাদা। যেমন একই app-এর `mini-ui/stopwatch`, `floating-ui/stopwatch`, `home-widget/stopwatch` পরস্পরকে overwrite করে না।

## 2. কেন raw `NK.widget` expose করা হয়নি

পুরোনো widget API একটি global `kind`-এর config লেখে। Mini App-কে সরাসরি সেটি দিলে:

- অন্য app-এর একই `kind` overwrite হতে পারত;
- arbitrary runtime kind দিয়ে Android manifest provider তৈরি করা যায় না;
- অন্য app-এর floating overlay বন্ধ বা বদলে দেওয়ার সুযোগ হতো;
- raw WebView-এর host asset/native JavaScript interface untrusted code পেত;
- uninstall/revoke-এর পর stale surface থেকে যেত।

নতুন broker source identity session-এর authenticated `ctx.app` থেকে নেয়। Mini App-এর পাঠানো `owner`, `appId`, `sourceId` গ্রহণ করা হয় না। Reserved Android slot-এ source/artifact/integrity marker থাকে এবং native plugin-ও owner binding যাচাই করে।

## 3. Native package ও artifact storage

Native target-এ Mini App package code আর IndexedDB-তে থাকে না। Capacitor Filesystem-এর app-specific `Data` directory ব্যবহৃত হয়:

```text
nativekit-object-store/
  packages/<url-encoded-app-id>/<package-sha256>/
    package.json
    files/...
  artifacts/<kind>/<url-encoded-owner-type:owner-id>/<artifact-id>/
    current.json
    versions/<artifact-html-sha256>/
      code.html
      revisions/<revision>/artifact.json
```

- IndexedDB-তে searchable app metadata, policy, audit ও usage metadata থাকে; package bytes থাকে না।
- পুরোনো IndexedDB package প্রথম native read-এ native copy commit হওয়ার **পরে** metadata migrate হয়।
- Package commit record valid না হলে app read ব্যর্থ হয়; native-এ silent web fallback নেই।
- একই valid package integrity আবার save করলে live package delete/rewrite করা হয় না।
- Artifact code ও revisioned metadata লেখার শেষে `current.json` pointer বদলায়। Publish ব্যর্থ হলে পুরোনো committed UI পড়া যায়।
- একই HTML রেখে title/config update-এর ক্ষেত্রেও আলাদা revision metadata ব্যবহৃত হয়; live `code.html` আগে মুছে ফেলা হয় না।
- Pointer commit-এর পরেই পুরোনো unreachable code/revision clean হয়।
- Read-এর সময় owner, ID, kind, revision, byte length ও SHA-256 মিল যাচাই হয়।
- Hosted web target-এ নতুন artifact API unavailable; localStorage/IndexedDB fallback নেই। Legacy package-এর web path শুধু hosted web target-এর জন্য রয়েছে।

`Data` Android-এ application files directory; public `Documents`/`ExternalStorage` ব্যবহৃত হয় না। App uninstall-এ OS এই files মুছে দেয়। iOS-এ `Data` app container-এর Documents-এ যায়; repo-তে Files-app sharing flags চালু নেই।

## 4. Mini App API

তিনটি group-এই common methods:

```ts
await NativeKit.miniUI.publish(input);
await NativeKit.miniUI.list();          // { artifacts }
await NativeKit.miniUI.get('stopwatch'); // { record, html }
await NativeKit.miniUI.remove('stopwatch');

// একই common contract: floatingUI ও homeWidget
```

`get`/`remove`-এ ID না দিলে `main` ব্যবহৃত হয়। `list` শুধু authenticated caller-এর নিজের records দেখায়; অন্য app-এর artifact enumerate/read/remove করা যায় না।

### Publish input

```ts
{
  id?: string;              // default main; lowercase stable artifact ID
  title?: string;
  description?: string;
  html: string;             // self-contained HTML/CSS/JS
  config?: {
    width?: number;         // floating dp
    height?: number;
    widthPx?: number;       // home snapshot px
    heightPx?: number;
    collapsed?: boolean;
    fullscreen?: boolean;
    focusable?: boolean;
    touchThrough?: boolean;
    chrome?: 'bar' | 'none';
    draggable?: boolean;
  }
}
```

Successful result-এ `id`, `kind`, `source`, `integrity`, `bytes`, `revision`, timestamps, `config` ও native storage attribution থাকে। Mini App source-এ `appId` এবং `nativeKitAppBrowserId` থাকে।

### Floating UI

```ts
let permission = await NativeKit.floatingUI.checkPermission();
if (!permission.granted) {
  await NativeKit.floatingUI.requestPermission();
  permission = await NativeKit.floatingUI.checkPermission();
}
if (permission.granted) {
  await NativeKit.floatingUI.show('stopwatch');
}
await NativeKit.floatingUI.hide('stopwatch');
```

- `show` Android-only এবং `floatingUI` capability/policy দরকার।
- Android display-over-other-apps special access আলাদা; broker allow মানেই OS grant নয়।
- Settings থেকে permission না এলে auto-retry করা হয় না; আবার user action নিন।
- Host বা অন্য Mini App-এর visible overlay replace/hide করা যায় না।
- একই owner নতুন artifact show করলে overlay update হয়।
- Manager restart-এর পর native visible config থেকে owner পুনরুদ্ধার হয়; overlay বন্ধ থাকলে stale in-memory owner নতুন app-কে আটকায় না।
- Trusted host selector ছাড়া `hideFloatingUI()` দিয়ে emergency stop করতে পারে; Mini App পারে না।

### Home Widget

```ts
await NativeKit.homeWidget.activate('stopwatch');
const result = await NativeKit.homeWidget.requestPin('stopwatch');
```

- `activate` একটি reserved slot-এ artifact bind করে ও config save/reload করে।
- `requestPin` প্রথমে activate করে, তারপর launcher-এর pin request চায়। `requested:false` মানে launcher/API support নেই—artifact store বা config মুছে যায়নি।
- `appBrowser.maxActiveHomeWidgets` default **8**, schema range **1–32**। `native:sync` প্রতিটি slot-এর receiver, provider-info XML ও generated provider class তৈরি করে।
- Slot ID: `nativekit-miniapp-slot-01` … `08` (configured count পর্যন্ত)।
- Concurrent activation serialised, তাই দুই app একই খালি slot দখল করতে পারে না।
- সব slot ব্যস্ত হলে অন্য owner-এর widget মুছে নয়, স্পষ্ট error আসে।
- Artifact update শুধু একই owner+artifact-এর active slot refresh করে।
- Remove/revoke/disable/uninstall-এ slot `Unavailable` marked হয়; পরে সেটি reuse করা যায়। Android launcher-এ আগে থেকে যোগ করা widget instance থাকলে placeholder দেখতে পারে—OS widget instance programmatically remove করার সাধারণ API নেই।

## 5. Trusted host API

```ts
const artifacts = NK.appBrowser.artifacts;

await artifacts.publish('mini-ui', input); // host-authored artifact
await artifacts.list({ sourceType: 'mini-app', appId, kind: 'mini-ui' });
await artifacts.read({ sourceType: 'mini-app', appId, kind: 'mini-ui', artifactId });
await artifacts.remove({ sourceType: 'mini-app', appId, kind: 'mini-ui', artifactId });

const mount = await artifacts.mountMiniUI({
  sourceType: 'mini-app', appId, artifactId,
  target: document.querySelector('#preview'), replace: true,
});
await mount.stop();

await artifacts.activateHomeWidget({ sourceType: 'mini-app', appId, artifactId });
await artifacts.requestPinHomeWidget({ sourceType: 'mini-app', appId, artifactId });
await artifacts.showFloatingUI({ sourceType: 'mini-app', appId, artifactId });
await artifacts.hideFloatingUI({ sourceType: 'mini-app', appId, artifactId });
await artifacts.hideFloatingUI(); // trusted host/user emergency stop
await artifacts.activations();
await artifacts.removeOwner(appId);
```

Host-authored artifact-এর জন্য `sourceType:'host'` দিন; `appId` লাগে না। Filter/arguments ছাড়া `list()` host ও সব installed Mini App-এর records দেখায়। `limits`-এ quotas, slot prefix ও active-slot count আছে।

ব্যবহারযোগ্য host management UI `www/app-browser-manager.js`-এ আছে: source/revision/checksum দেখা, Mini UI preview, home activate+pin, floating show/stop ও delete।

## 6. Security boundaries

### Mini UI preview

- মূল app-এর RPC token বা broker bootstrap অনুলিপি করা হয় না।
- iframe `sandbox="allow-scripts"`; `allow-same-origin` নেই।
- Injected CSP-তে network, worker, child frame, form, base ও object বন্ধ।
- Inline script/style এবং data/blob image/media চলতে পারে।
- `referrerPolicy=no-referrer`; camera/microphone/geolocation feature policy `none`।
- Frame-এ source ID, artifact ID ও integrity data attributes থাকে।

### Floating UI

Artifact mode `sandboxed:true` দিয়ে চলে:

- network load block;
- file/content access বন্ধ;
- DOM storage বন্ধ;
- mixed content বন্ধ;
- host asset-loader base নয়, `https://miniapp.invalid/` base;
- navigation intercept;
- trusted `NativeKitFloating` JavaScript interface **inject করা হয় না**।

ফলে floating code live UI করতে পারলেও Mini App broker বা host native function ডাকতে পারে না। Code-তে external CDN, remote image/font/API, iframe worker ধরে নেওয়া যাবে না।

### Home snapshot

একই offline/file/content restrictions offscreen renderer-এ প্রযোজ্য। Render শেষে launcher-এ bitmap দেওয়া হয়। JavaScript snapshot তৈরির সময় চলতে পারে, কিন্তু home screen-এ continuous JS execution, touch callback বা live WebView নেই। Timer বদলাতে নতুন HTML publish/update করতে হবে; প্রতি সেকেন্ডে native write/refresh করা এড়িয়ে explicit বা meaningful update ব্যবহার করুন।

Artifact code নিজে native data access না পেলেও publishকারী Mini App তার অনুমোদিত broker data HTML-এ বসিয়ে দিতে পারে। Host-কে artifact source দেখে policy দিতে হবে; widget/overlay-তে secret বা sensitive data রাখা উচিত নয়।

## 7. Lifecycle ও refresh failure

- Publish প্রথমে durable native store-এ commit হয়। Active surface refresh পরে হয়।
- Publish commit সফল কিন্তু active refresh ব্যর্থ হলে publish rollback/failure হয় না। `nativekitappbrowserstatus`-এ `state:'artifactRefreshFailed'`, `artifactId`, `artifactKind` ও reason যায়।
- Mini UI-এর mounted preview নতুন revision-এ refresh হয়।
- Active floating artifact update হলে native source marker মিললেই HTML update হয়।
- Home update শুধু matching owner/artifact slot-এ যায়।
- `remove` active surface deactivate করে store delete করে।
- App disable, package update, capability/method revoke এবং uninstall-এ সংশ্লিষ্ট surface deactivate/cleanup হয়।
- Host app process বন্ধ হলে in-memory Mini UI mount বন্ধ হয়; native files ও Android activation config থাকে। পরের manager native source markers থেকে activation দেখতে পারে।

## 8. Limits

| Limit | Value |
|---|---:|
| প্রতি source/kind artifacts | 8 |
| প্রতি source-এর মোট artifact HTML | 4 MiB |
| Mini UI HTML | 512 KiB |
| Floating UI HTML | 256 KiB |
| Home Widget HTML | 256 KiB |
| Config JSON | 32 KiB |
| Default active home slots | 8 |
| Configurable active slots | 1–32 |
| Floating overlays | এক সময়ে 1 |

Normal broker rate limitও প্রযোজ্য—default প্রতি active session 120 requests/minute। Storage quota ও rate limit আলাদা।

## 9. Platform matrix

| Feature | Android | iOS | Hosted web |
|---|---|---|---|
| Native package/artifact persistence | ✓ | ✓ | Artifact API নেই |
| Mini UI host preview | ✓ | ✓ | নেই |
| Floating artifact show/hide | ✓, overlay special access | HTML floating activation নেই | নেই |
| Home HTML artifact activation | ✓, static snapshot | HTML activation নেই; WidgetKit arbitrary HTML/WebView নয় | নেই |
| Launcher pin request | API/launcher support সাপেক্ষে | এই artifact API-তে নেই | নেই |

iOS WidgetKit SwiftUI timeline-driven; সাধারণ Mini App HTML-কে live widget হিসেবে চালানোর API নয়। তাই store-এ iOS artifact রাখা গেলেও activation স্পষ্ট error দেয়—false success নয়।

## 10. Manifest ও নমুনা

```json
{
  "id": "dev.nativekit.stopwatch.artifacts",
  "name": "Native Stopwatch Artifacts",
  "version": "1.0.0",
  "entry": "index.html",
  "requestedCapabilities": ["miniUI", "floatingUI", "homeWidget"],
  "allowedHosts": []
}
```

সম্পূর্ণ installable package: [`examples/app-browser-artifacts/`](../examples/app-browser-artifacts/README.bn.md)। Publish করলে host UI-তে records দেখা যায়; Mini App নিজে host preview mount করতে পারে না।

Capability তিনটি পুরোনো ১৯টির সঙ্গে যুক্ত হয়ে broker list এখন **২২টি**। Raw `widget`, `agent`, `nearby`, host `appBrowser` এবং arbitrary native plugin এখনও Mini App-এ exposed নয়।

## 11. যাচাই

- `tests/native-object-store.test.ts`: namespaces, integrity, rollback, same-HTML failure, quotas/native package behavior।
- `tests/mini-app-artifacts.test.ts`: owner slots, concurrent allocation, slot exhaustion, update/remove, floating ownership/restart, iOS/web boundaries।
- `tests/native-package-integration.test.ts`: IndexedDB metadata-only native install ও legacy migration।
- `tests/artifact-native-contract.test.ts`: generated providers, native hardening, declarations, sample ও host controls।
- `tests/app-browser-runtime.test.ts`: authenticated RPC/policy/lifecycle সহ broker integration।

Official design references: [Android pin widgets](https://developer.android.com/develop/ui/views/appwidgets/discoverability), [AppWidgetManager](https://developer.android.com/reference/android/appwidget/AppWidgetManager), [Android cross-app scripting mitigations](https://developer.android.com/privacy-and-security/risks/cross-app-scripting), [WebView native bridge risks](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges), [Capacitor Filesystem directories](https://capacitorjs.com/docs/apis/filesystem), [Apple Meet WidgetKit](https://developer.apple.com/videos/play/wwdc2020/10028/), [Apple Bring widgets to life](https://developer.apple.com/videos/play/wwdc2023/10028/)।
