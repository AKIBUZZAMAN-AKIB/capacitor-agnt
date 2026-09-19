# 📚 নথিপত্র সূচিকা (Documentation Index)

সব ডক দুই ভাগে — দ্রুত রেফারেন্স (ব্যবহারকালীন) বনাম ডিপ-রিসার্চ (সিদ্ধান্তের পেছনের যুক্তি)।

## দ্রুত রেফারেন্স
| ডক | এক লাইনে |
|---|---|
| [`API-REFERENCE.bn.md`](./API-REFERENCE.bn.md) | `window.NativeKit`-এর সম্পূর্ণ API — তিন trust tier, সব facade; v1.4.x `nearby` গভীর গাইড (মিনি-অ্যাপ এক্সপোজার-নিয়মসহ) |
| [`BACKGROUND-WAKES.bn.md`](./BACKGROUND-WAKES.bn.md) | OS-শিডিউলড background wake (WorkManager `PeriodicWorkRequest` / iOS `BGProcessingTask`) + surfaced-message ইনবক্স — API চুক্তি, platform floor/সীমা, ডিভাইসে যাচাইয়ের নিয়ম |
| [`CONFIGURATION.bn.md`](./CONFIGURATION.bn.md) | `app.config.json`-এর প্রতিটি field + `features.*` গেট (v1.4.x: `nearby`) |
| [`WIDGETS.bn.md`](./WIDGETS.bn.md) | Home-screen (AppWidgetProvider/WidgetKit) + floating (overlay WebView) widget — আর্কিটেকচার, API, config, সীমাবদ্ধতা |
| [`SECURITY-POLICY.bn.md`](./SECURITY-POLICY.bn.md) | Trust boundary, capability gate, audit, network mode — "golden rules" |
| [`BUILD-SIGNING-CI.bn.md`](./BUILD-SIGNING-CI.bn.md) | সাইনিং, CI পাইপলাইন, রিলিজ প্রক্রিয়া |
| [`RELEASING.md`](./RELEASING.md) | **নতুন test build release + install guide (EN)** — tag→auto-release flow, কোন ফাইল (app-release.apk) install করবে, signing mode, checksum verification, iOS IPA, secrets reference |
| [`APP-REPLACEMENT.bn.md`](./APP-REPLACEMENT.bn.md) | অন্য অ্যাপ/আইডি রিলিজ করার নিয়ম (App ID, store record) |
| [`IN-APP-BROWSER-COMPARISON.bn.md`](./IN-APP-BROWSER-COMPARISON.bn.md) | Capgo inappbrowser বেনামে বাছাইকরণ — বিকল্পগুলোর সঙ্গে তুলনা |
| [`WEB-DEV-GUIDE.md`](./WEB-DEV-GUIDE.md) | **Web developer guide (EN)** — "একটা web component upload করলেই চলবে" (`⚡ Quick Add`), tag auto-detect, manifest synthesize, native-API consent — হিরো flow |
| [`MINI-APP-CREATOR-GUIDE.md`](./MINI-APP-CREATOR-GUIDE.md) | **Mini-app creator guide (EN)** — package formats, `nativekit.manifest.json` schema, capability/permission model, network modes, isolation, lifecycle, limits |
| [`QUICK-START.md`](./QUICK-START.md) | **Quick-start checklist (EN)** — clone → build → ship a web component → release, ধাপে ধাপে |
| [`CAPACITOR-8-RESEARCH-AUDIT.bn.md`](./CAPACITOR-8-RESEARCH-AUDIT.bn.md) | Capacitor v8.5-এর গভীর audit |

## ডিপ-রিসার্চ (research/)
| ডক | সিদ্ধান্ত যেটার পেছনে এটা |
|---|---|
| [`research/NEARBY-CONNECTIONS-PLUGIN.bn.md`](./research/NEARBY-CONNECTIONS-PLUGIN.bn.md) | v1.4.x P2P ইন্টিগ্রেশন — API বিশ্লেষণ + ইন্টিগ্রেশন শিক্ষা (v1.4.1 ফিক্সসহ) |
| [`research/AGENTIC-ROADMAP.bn.md`](./research/AGENTIC-ROADMAP.bn.md) | "সবচেয়ে শক্তিশালী agentic অ্যাপ"-এর গ্যাপ-অ্যানালাইসিস |
| [`research/PLUGIN-ECOSYSTEM.bn.md`](./research/PLUGIN-ECOSYSTEM.bn.md) | ভবিষ্যৎ প্লাগিন বাছাই — টায়ার-ম্যাপ (clipboard/toast/torch → geofence/MLKit) |
| [`research/NODE-RUNTIME.bn.md`](./research/NODE-RUNTIME.bn.md) | মোবাইলে full Node.js চালানোর প্রশ্ন → ভার্ডিক্ট: না (llama.cpp পথেই যাই) |
| [`research/FULLSCREEN-IMMERSIVE.bn.md`](./research/FULLSCREEN-IMMERSIVE.bn.md) | Fullscreen + blend বারের গবেষণা → v1.3.6 JS bridge জয় |

## এজেন্ট পরিকল্পনা
| ডক | |
|---|---|
| [`ai-agent/HARNESS.bn.md`](./ai-agent/HARNESS.bn.md) | Agent harness-এর কংক্রিট আর্কিটেকচার (M1 = রোডম্যাপের P0.1) |
