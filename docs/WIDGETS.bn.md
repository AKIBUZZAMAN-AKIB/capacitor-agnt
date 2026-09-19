# 🧩 Widget সাপোর্ট — Home-screen ও Floating Widget

NativeKit-এ এখন **দুটি আলাদা ধরণের widget** আছে, দুটি ভিন্ন প্রযুক্তিতে। নিচে প্রতিটির কীভাবে কাজ করে, কী কী limitation আছে, আর ব্যবহারবিধি দেওয়া হলো।

---

## ১. Home-screen widget (`NativeKit.widget`)

এটা "app-এর মতো আলাদা জায়গায়" ভেসে থাকে — home screen-এ একটি নির্দিষ্ট সাইজের box, দীর্ঘক্ষণ রয়ে যায়। Android-এ `AppWidgetProvider` (it's a `BroadcastReceiver`) + `RemoteViews`; iOS-এ `WidgetKit` extension।

### আর্কিটেকচার (Android)

```
web (www)  ──NativeKit.widget.setConfig(kind, config)──▶  NativeKitWidgetPlugin
                                                              │  SharedPreferences (nativekit_widget_store)
                                                              ▼
        config-driven home-screen widget rendered by  NativeKitWidgetProvider  (RemoteViews)
        └─ generated per-kind subclass:  <appId>.Widget_<Kind>
                                                              │
        widget tap (custom action)  ──broadcast──▶  nativeWidgetTap  event
```

- **Provider প্রতি kind একটা করে** — `app.config.json`-এর `widget.homeScreen.kinds` থেকে `scripts/configure-native.mjs` এটাই generate করে:
  - `android/app/src/main/res/xml/<kind>_widget_provider.xml` (sizes, resize mode, update period)
  - `<appId>.Widget_<kind>.java` (একটি ছোট subclass, `kind()` রিটার্ন করে)
  - `AndroidManifest.xml`-এ `<receiver>` (APPWIDGET_UPDATE action + provider meta-data)
- একাধিক kind (small/medium/large, বা আলাদা আলাদা widget) একসঙ্গে রাখা যায়; প্রতিটির নিজস্ব ComponentName থাকে (Android-এ এটা **আবশ্যক**)।
- Native rendering `RemoteViews` দিয়ে — তাই widget-এ স্থায়ী HTML/CSS চালানো যায় না (**big limitation**)। কিন্তু আপনি web থেকে **data push** করেন; value/title/subtitle/color/size সব config-নিয়ন্ত্রিত।
- Widget widget-এ যেটা দেখাবে সেটা `WidgetStore` (SharedPreferences)-এ থাকা spec ও `WidgetStore.readConfig()` দিয়ে পড়ে।

### আর্কিটেকচার (iOS)

- WidgetKit extension আলাদাভাবে Xcode-এ যোগ করতে হয় (আগে দেখুন [`WIDGETS.bn.md`-এর WidgetExtension রিডমি](../plugins/widget/ios/WidgetExtension/README.md))। Extension-টি **App Group** `UserDefaults(suiteName: "group.<bundle-id>")`-এ key `nativekit.widget.<kind>`-এর নিচে লেখা JSON পড়ে এবং SwiftUI দিয়ে render করে।
- `NativeKit.widget.setConfig()` কল করলে plugin সে data App Group-এ লেখে এবং `WidgetCenter.reloadAllTimelines()` ডাকে।

### API

```js
// কাউন্টার push
await NativeKit.widget.setConfig('nativekit-widget', {
  layout: 'medium',          // 'small' | 'medium' | 'large'
  value: '42',
  title: 'NativeKit',
  subtitle: 'Counter',
  accentColor: '#4FC3F7',
  backgroundColor: '#0F172A',
  action: 'open-counter',    // optional: custom tap
  actionValue: JSON.stringify({count: 42}),
  buttonLabel: 'Open',
});

// update + reload (একসঙ্গে)
await NativeKit.widget.update('nativekit-widget', { value: '43', ...spec });

// শুধু reload
await NativeKit.widget.reload('nativekit-widget');

// কোন widget instance এখন home screen-এ আছে?
const { ids } = await NativeKit.widget.getWidgetIds('nativekit-widget');

// User-কে widget যোগ করার প্রম্পট (পিন) চাই
// (Android 8.0+; iOS-এ supported=false ফেরত)
await NativeKit.widget.requestPin('nativekit-widget');

// custom action button-এ ট্যাপ হলে event
const h = await NativeKit.widget.onWidgetTap((ev) => {
  // ev = { kind, action, value, widgetId }
});
// h.remove() দিয়ে বন্ধ করা যায়
```

`listConfigs()` সব kind-এর বর্তমান spec ফেরত দেয়।

### config

`app.config.json`-এ `widget.homeScreen.kinds`-এর প্রতিটি entry:

```json
{
  "widget": {
    "enabled": true,
    "homeScreen": {
      "enabled": true,
      "updatePeriodMinutes": 30,
      "resizeEnabled": true,
      "kinds": [
        { "id": "nativekit-widget", "label": "NativeKit", "layout": "medium",
          "minWidthDp": 140, "minHeightDp": 140, "targetCellWidth": 2, "targetCellHeight": 2 }
      ]
    }
  }
}
```

- `id` = widget-এর নাম; `layout` = initial layout (`small`/`medium`/`large`); `minWidthDp`/`minHeightDp` = dp সাইজ; `targetCellWidth`/`targetCellHeight` = API 31+-এ cell-grid সাইজ (পুরনো ডিভাইসে ignored)।
- `updatePeriodMinutes` minimum **15** (Android-এ minimum update interval) — নিচের *সীমা* অংশটি দেখুন।
- kind যোগ/বদল = config বদলে `npm run native:sync` (receivers/receivers XML/subclass regenerate হয়)।

---

## ২. Floating/ওভারলে widget (`screen-এর উপরে ভেসে থাকে`)

আপনার অনুরোধের **দ্বিতীয় প্যাটার্ন**। এটি একটি draggable bubble/panel — `TYPE_APPLICATION_OVERLAY` window + foreground service (`FloatingWidgetService`), শুধু **Android 8.0+**। এটির ভেতরে একটি **WebView** চলে, তাই আপনি সম্পূর্ণ **HTML/CSS/JS** দিয়ে widget-এর UI বানাতে পারেন — এই কারণেই এটাকে "floating widget" হিসেবে `www/widgets/floating.html`-এ বানানো হয়।

### আর্কিটেকচার

```
NativeKit.widget.showFloating(config)
   └─▶ FloatingWidgetService (foreground service)
         ├─ draggable bubble (WindowManager, TYPE_APPLICATION_OVERLAY)
         ├─ WebView loads  https://appassets.androidplatform.net/public/widgets/floating.html
         └─ two-way bridge:
              widget→app:  window.NativeKitFloating.postMessage(JSON)  → 'nativeFloatingMessage' event
              app→widget:  window.__nativeKitFloatingApply(jsonString)
```

- bubble-এর **header টেনে সরানো** যায়; header-এ ট্যাপ করলে bubbled expand/collapse হয়; ✕-এ বন্ধ হয়।
- করা যাই দুটি দিকের মেসেজ:
  - **Page → app:** জাভাস্ক্রিপ্ট থেকে `window.NativeKitFloating.postMessage(JSON.stringify(payload))`।
  - **App → page:** `NativeKit.widget.sendToFloating({ data })` → native-overlay-এর WebView-এ `window.__nativeKitFloatingApply(<data>)` কল হয়।
- এই দুই handshake-ই `NativeKitWidgetPlugin`-এ `gate` দিয়ে যায় না — এগুলো host-এর নিজস্ব দৃশ্য; তাই কোনো mini-app permission prompt লাগে না।

### API

```js
// অনুমতি
await NativeKit.widget.checkFloatingPermission();       // { granted: boolean }
await NativeKit.widget.requestFloatingPermission();      // Settings খোলে

// bubble খোলা (title/page/width/height সবই top-level; plugin-এর showFloating
// পুরো call object পড়ে নেয় — তাই config বাদ পড়ে না)
await NativeKit.widget.showFloating({
  title: 'NativeKit',
  page: 'public/widgets/floating.html',   // assets-এ path (public/ prefix সহ)
  width: 240, height: 220,
  collapsed: true,                        // শুরুতে ছোট draggable bubble; ট্যাপে খোলে
  data: { value: widgetCount },           // page লোড হওয়া মাত্র __nativeKitFloatingApply() এ পৌঁছে
});

// last-bubble-এ data পাঠানো
await NativeKit.widget.sendToFloating({ data: { value: widgetCount } });

// বন্ধ
await NativeKit.widget.hideFloating();
await NativeKit.widget.isFloatingVisible();

// widget-এর page থেকে আসা মেসেজ শোনা
await NativeKit.widget.onFloatingMessage((ev) => { /* ev = payload */ });
```

### Manifiest/পারমিশন

`scripts/configure-native.mjs` যখন `widget.floating.enabled` থাকে তখন এই জিনিসগুলো `AndroidManifest.xml`-এ যোগ করে:
- `<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />` ("display over other apps")
- `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />` + `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />`
- `<service android:foregroundServiceType="specialUse">` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`

> **Play store policy/warning:** `SYSTEM_ALERT_WINDOW` একটি **sensitive** permission। ব্যবহারের আগে অবশ্যই in-app **user-visible purpose/disclosure** + বন্ধ করার সুবিধা থাকতে হবে। Store-এ প্রকাশের সময় এই permission-টা আপনার যাচাইকৃত use-case-এর সঙ্গে মিলতে হবে। `config-lib.mjs` এ সতর্কতা (warning) দেয়।

---

## ✅ Native compile verification (আসল javac/Swift API-র বিরুদ্ধে)

ওপরের সোর্সগুলো শুধু চোখে দেখা নয় — **সত্যিকারভাবে compile-check** করা হয়েছে:

- **Android (definitive):** সব Java সোর্স + প্রতিটি generated `Widget_<kind>.java` subclass, **আসল Capacitor 8.5.0 core** (`com.capacitorjs:core:8.5.0` AAR — `PluginCall`/`Plugin`/`JSObject`/`JSArray`/`PluginMethod`/`CapacitorPlugin` সবগুলোই real AAR-এর compiled `.class`), **real AndroidX** (`appcompat 1.7.1`, `fragment 1.5.4`, `activity 1.8.0`, `lifecycle 2.6.1`, `core`, `webkit 1.10.0`, `savedstate`), **real Android API 36 `android.jar`**, আর সেই plugin-এর own `R` (AAPT-জেনারেটেড res stub)-এর বিরুদ্ধে `javac -encoding UTF-8 -Xlint:all -source 11 -target 11`-সহ **exit 0, 16টি .class**। অর্থাৎ এখানে **কোনো fabricated stub নেই** — যা compile হয় তা আসল Capacitor SDK-এই compile হয়। এতে ধরা পড়েছে ও ঠিক করা হয়েছে:
  - `AppWidgetManager` আসলে `android.appwidget` প্যাকেজে (যা প্রথম `javac`-এ `cannot find symbol` দিয়েছিল)।
  - `org.json`-এর `put`/`keys` checked `JSONException` নিক্ষেপ করে — `WidgetStore`/plugin-এ গার্ড করা হয়েছে।
  - Capacitor-এর আসল `JSObject.put(...)` checked exception নিক্ষেপ করে না (সে নিজেই swallow করে) — সে অনুযায়ী plugin-এ `throws` নেই।
  - **Capacitor 8.5.0-র আসল `PluginCall`-এ `get(String)` মেথডই নেই** — `sendToFloating` এখন `call.getData().opt("data")` দিয়ে data পড়ে (আগের `call.get("data")` একটি ভুল stub-এ compile হতো, কিন্তু real SDK-তে runtime-এ crash করতো)। `showFloating`-ও `call.getData()` দিয়ে পুরো call object পড়ে।
  - Deprecated `TYPE_PHONE`/`stopForeground(boolean)` শুধু legacy fallback-এ; সেগুলো `@SuppressWarnings("deprecation")`/API-gated।
- **iOS:** Deployment target `15.0`-এ WidgetKit Extension-এ `.containerBackground(for: .widget)` **iOS 17+** — তাই এটি `#available(iOS 17.0, *)`-গেটেড `widgetBackground(...)` modifier-এ মোড়ানো; `reload()`-এ অপ্রয়োজনীয় `#available(iOS 14.0, *)` বাদ দেওয়া হয়েছে। বাকি সব `CAPPluginCall`/`CAPBridgedPlugin` মেথড এই repo-র reference plugin (`custom-native`)-এর সঙ্গে মিলিয়ে যাচাই করা — এগুলোই আসল Capacitor Swift API।

---

## ⚙️ Build-pipeline-এ কী কী plug হয়

- `package.json`: `"@nativekit/widget": "file:plugins/widget"` (+ `npm install`-এ symlink)।
- `bridge/nativekit.ts`: `NativeKit.widget` API (host-only; mini-app façade-এ নেই)।
- `types/nativekit.d.ts.template`: `NativeKitWidgetConfig`, `NativeKitWidgetKind`, `NativeKitWidgetSpec`, `NativeKitFloatingWidgetOptions` declarations।
- `app.config.json` + `app.config.schema.json`: `features.widget` gate + `widget` section।
- `scripts/config-lib.mjs`: cross-field validation (widget↔features, homeScreen↔widget, floating↔widget) + সতর্কতা।
- `scripts/configure-native.mjs`: receiver/provider-info/subclass + FloatingWidgetService + overlay permissions।
- `www/widgets/floating.html`: floating widget-র demo page।
- `www/index.html` + `www/app.js`: demo নিয়ন্ত্রণ।
- `tests/widget.test.ts`: 17টি integration test (real javac-ধরা বাগগুলোর regression-guard সহ — `AppWidgetManager` package, `JSONException` guard, `getData` contract, `get(String)`-না-থাকা, iOS-17 gating)।

---

## 🚧 পরিচিত সীমাবদ্ধতা ও "সব ডিভাইসে কাজ করা"-র বাস্তবতা

**Home-screen widget:**
- Android 4.1 (minSdk 24) থেকে আধুনিক পর্যন্ত সব ডিভাইসে **workable**; `targetCellWidth/Height`, `previewLayout`, `description` শুধু API 31+, নিচের ডিভাইসে এগুলো ignored কিন্তু কোনো সমস্যা হয় না।
- iOS widget শুধু **iOS 14+**; এটি `deploymentTarget: 15.0`-এ ঠিক আছে।
- `icon`/`emoji` RemoteViews-এ `setTextViewText` দিয়ে যাওয়া যাবে। ছবি widget-এ দিতে চাইলে `setImageViewResource` (resource-based) — remote image load **সম্ভব নয়** (RemoteViews-এ)।
- `updatePeriodMinutes` এর **minimum 30 (Android)** সিস্টেম-নিঃশব্দে 30-এ round করে। Exact timer নয়; fresh data পেতে `reload()`-কে `onUpdate`-এর মতো নয়, বরং `update()` call-এর সঙ্গে বলুন (তবেই real-time-ish)। `backgroundRunner` বা push-ও ব্যবহার করা যায়।
- Widget process/app fresh হলে config `WidgetStore` (shared pref)-এ থাকে — `BootReceiver` এবং `onUpdate` সময় data পড়া যায়।

**Floating widget:**
- শুধু **Android 8.0+** (`TYPE_APPLICATION_OVERLAY`); Android 7-এ `TYPE_PHONE` fallback।
- Overlay permission (SYSTEM_ALERT_WINDOW) **runtime** ask করা/ Settings-এ যাওয়া লাগে।
- **Android 15 (target SDK 35+)**-এ foreground service শুরু করার আগে আপনার **visible overlay window থাকতে হবে** (SYSTEM_ALERT_WINDOW-সহ); তাই প্রথমবার `showFloating` foreground context-এ কল করাই শ্রেয়।
- WebView-এ soft keyboard input NOT_FOCUSABLE window-এ নাও আসে; TextView-based fixed input প্রয়োজন।
- iOS-এ floating overlay **নেই** — `showFloating` reject করে; iOS widget শুধু home-screen WidgetKit।

## 📦 দুটি plugin-এর (উইজেট) বাছাই-র rationale (research-based)

আমরা research করে দেখলাম `capacitor-widget-bridge` (KisimediaDE), `@capgo/capacitor-widget-kit` — এগুলোই মূলত চালু। কিন্তু:
- `capacitor-widget-bridge`: **AppWidgetProvider-নিজে লেখতে হবে** (শুধু data sync + reload দেয়)।
- `@capgo/capacitor-widget-kit`: শক্তিশালী SVG template-ভিত্তিক rendering + Live Activity, তবে huge configuration surface এবং Android/iOS এটা মূলত Rendering template—native code হিসাবে আপনার নিয়ন্ত্রণ বেশি।

NativeKit-এর দর্শন **config-driven, no-Java-write**। তাই আমরা একটি **self-contained local plugin** লিখেছি যেটা:
- `app.config.json` থেকে kinds আপনা-আপনি (automatically) Android receiver + provider-info + subclass generate করে।
- home-screen widget-এর **data-only** output (safe) + floating widget-এর **web-rerender** output — দুটোর মিলিয়ে সেরা।

আরও deep-dive: API-এ `NativeKit.config.widget` দেখে নিন। বাস্তব build/device-test অবশ্যই `npm run native:sync` + Android Studio / Xcode-এ করতে হবে।
