# Background wakes — কীভাবে কাজ করে, কী প্রতিশ্রুতি দেয় না

> এই ডকটি সেই পাঁচটি API-র আচরণ বর্ণনা করে যেগুলো আগে `supported:false` ফেরত দিত:
> `scheduleBackgroundWakes`, `cancelBackgroundWakes`, `getWakeStatus`,
> `loadSurfacedMessages`, `clearSurfacedMessages`।
> কোড: `plugins/native-agent/{android,ios}` · ব্রিজ: `bridge/nativekit.ts` ·
> ল্যাব: `www/agent-lab.js` (Background wakes কার্ড)।

---

## ১. এক নজরে

| কাজ | Android | iOS |
|---|---|---|
| OS-শিডিউলিং | `WorkManager` → `PeriodicWorkRequest`, unique work name `native-agent-wake` | `BGTaskScheduler` → `BGProcessingTask`, id `io.t6x.nativeagent.wake` |
| সর্বনিম্ন interval | **১৫ মিনিট** (platform floor; কম চাইলে clamp করে granted মান রিপোর্ট হয়) | ১৫ মিনিট (আমরা `earliestBeginDate`-এ চাপি; **সময় OS ঠিক করে**) |
| নেটওয়ার্ক লাগে | `NetworkType.CONNECTED` constraint | `requiresNetworkConnectivity = true` |
| চার্জ লাগবে কি | `setRequiresCharging(engine.scheduler_config.runOnCharging)` | `requiresExternalPower` (একই মান) |
| অ্যাপ বন্ধ থাকলেও চলে | ✅ WorkManager নিজে প্রসেস চালু করে | ✅ system প্রসেস চালু করে (ইউজার force-quit না করলে) |
| কে জাগে | `NativeAgentWakeWorker` → `NativeWakeRunner` | `NativeAgentBackgroundTask` handler → `NativeAgentWakeRunner` |
| ফল কোথায় যায় | OS নোটিফিকেশন + `surfaced.json` ইনবক্স + telemetry | একই |

---

## ২. দায়িত্বের বিভাজন: ইঞ্জিন বনাম OS

পিন করা ইঞ্জিন (0.5.2-public) **wake চালাতে পারে**:

- `handle_wake(source)` — due cron job খুঁজে চালায়, প্রতি job-এর জন্য `cron_runs` row লেখে
  (`wake_source` = কলার যা পাঠিয়েছে), `NativeNotifier` দিয়ে নোটিফাই করে, event দেয়
  (`wake.no_jobs`, `wake.jobs_found`, `cron.notification`)।

কিন্তু ইঞ্জিন **নিজে জাগতে পারে না** — Android/iOS-এ background runtime কেবল *অ্যাপ* চাইতে পারে।
তাই এই feature দুটি ভাগে ভাগ করা:

1. **OS-এর অর্ধেক** — প্লাগিনের (`NativeWakeScheduler.kt`, `NativeAgentBackgroundTask.swift`);
2. **ইঞ্জিনের অর্ধেক** — অপরিবর্তিত (`handle_wake` + `cron_runs`)।

এ কারণেই wake ঠিক foreground-এর মতোই কাজ করে: একই cron job, একই `cron_runs` ইতিহাস,
একই নোটিফিকেশন — শুধু ডাকাটা OS থেকে আসে।

---

## ৩. Android-এ WorkManager কেন (JobScheduler / AlarmManager / FGS নয়)

- **JobScheduler** — WorkManager এটারই উপরে বসা, কিন্তু persistence ও status API দেয় না;
  reboot বা App Standby bucket বদলে হারানো job অদৃশ্য থেকে যায়। WorkManager নিজের DB রাখে,
  reboot-এর পর নিজে re-schedule করে, আর `getWorkInfosForUniqueWork()` দিয়ে আসল state দেয়।
- **AlarmManager** — Android 12+ থেকে `SCHEDULE_EXACT_ALARM` একটি special permission, Android 14+-এ
  Play একে alarm-clock অ্যাপে সীমিত করে। এটি agent scheduler, alarm clock নয় — আর
  "due কাজের শিকার হলে চলুক" এর জন্য exact delivery কোনো বাড়তি সুবিধা দেয় না।
- **Foreground service** — স্থায়ী নোটিফিকেশন দেখায়, `FOREGROUND_SERVICE_*` type লাগে, আর
  Android 12+ এ background থেকে start-ই করা যায় না।

### বাস্তবে যা মেনে নিতে হয়

- periodic work **১৫ মিনিটের নিচে** নয় (`PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS`)।
- interval একটি **সর্বনিম্ন** মান: Doze, App Standby bucket, battery saver দেরি করাতে পারে।
- constraint (net/charging) ভাঙলে run হয় না — পরে আবার সুযোগ এলে চলে।
- periodic work কখনো `SUCCEEDED`/`FAILED` হয় না, সব result → `ENQUEUED`। তাই worker
  **সবসময় `Result.success()`** ফেরায় (এতে কিছু লুকায় না — ফল `getWakeStatus()` telemetry-তে দেখা যায়)।

---

## ৪. iOS-এ BGProcessingTask কেন (BGAppRefreshTask নয়)

- একটি cron job মানে পূর্ণ agent turn + LLM call (ইঞ্জিন প্রতি job-এ ২৫ সেকেন্ড বাজেট ধরে) —
  এটা "মিনিটের কাজ", ঠিক যেটার জন্য Apple `BGProcessingTask` বানিয়েছে। `BGAppRefreshTask`
  ছোট refresh-এর জন্য, আর সেটা network/power শর্ত দিতে পারে না।
- দুটো নিয়ম ভাঙলে অ্যাপ **kill** হয়, তাই কোডে কঠোরভাবে মানা হয়েছে:
  1. launch handler **অ্যাপ লঞ্চ শেষ হওয়ার আগেই** register করতে হবে → `AppDelegate`-এ
     `NativeAgentBackgroundTask.registerIfNeeded()` (generated) ;
  2. একই identifier **দুবার register** করা যাবে না → process-wide flag দিয়ে guard।
- identifier টি `Info.plist`-এর `BGTaskSchedulerPermittedIdentifiers`-এ থাকতে হবে
  (`scripts/configure-native.mjs` যোগ করে) এবং `UIBackgroundModes`-এ `processing` লাগে।
- `BGProcessingTask` **one-shot**: handler-এর শুরুতে পরের request submit করা হয়, নইলে chain থেমে যায়।
- `earliestBeginDate` শুধু **floor** — কখন চলবে সেটা iOS ঠিক করে (তাই `opportunistic: true`)।
- ইউজার app switcher থেকে force-quit করলে iOS আর কোনো task চালায় না; অ্যাপ কোনো notification
  পায় না (কোথাও cancel চিহ্নও থাকে না)।
- **Simulator**-এ background task চলে না (`BGTaskScheduler` `.unavailable`) — আসল যাচাই ডিভাইসে (নিচে ৯)।

---

## ৫. একটি wake ঠিক কী করে (দুই প্ল্যাটফর্মে একই ধাপ)

```
OS (WorkManager / BGTaskScheduler)
  └─ NativeWake{Worker,Runner}
       1. engine config path পড়া  ← initialize() যেটা লিখেছিল
          (Android: SharedPreferences "CapacitorStorage" key mobilecron:native-agent-config-path
           iOS:     UserDefaults same key)
       2. createHandleFromPersistedConfig(path)  → ইঞ্জিন cold start (WebView নেই)
       3. setNotifier(recording notifier)   → নোটিফিকেশন পোস্ট + ইনবক্সে লিখে রাখে
       4. setMemoryProvider(বিল্ট-ইন ফাইল-ভিত্তিক provider)  → memory_* টুল background-ও চলে
       5. handleWake(source)   → due cron job চলে, cron_runs row লেখা হয়
       6. capture: cron_runs(wakeSource==source, startedAt>=wake start) → surfaced records
       7. recordWake(summary, ran, ok)  → getWakeStatus() এটাই রিপোর্ট করে
       8. handle.close()
```

কোনো ধাপ ব্যর্থ হলে ক্র্যাশ নয় — ফলাফল **ডেটা** হিসেবে রেকর্ড হয় (`lastWakeSummary` দেখুন)।

---

## ৬. ইনবক্স (`surfaced.json`)

- অবস্থান: Android `<filesDir>/native-agent-wakes/surfaced.json`, iOS `Application Support/native-agent-wakes/surfaced.json`।
- দুটি সোর্স, একই record shape:
  1. wake-এ চালু হওয়া প্রতি cron run (`source:"background"`, `jobId`, `runId`, `status`, `responseText`);
  2. wake-এর সময় ইঞ্জিনের পাঠানো প্রতি নোটিফিকেশন (`source:"notification"`) —
     শুধু wake-এর সময় notifier wrap করা হয়, তাই ফোরগ্রাউন্ড চ্যাট ইনবক্সে মিশে যায় না।
- সর্বোচ্চ **৫০০** record (নতুন ঢুকলে পুরোনো বাদ), `read` flag, `markRead` অপশন।
- `text` ৮০০০ ও `body` ৪০০০ অক্ষরে কাটা (runaway মডেল আউটপুট ফাইল ফোলাতে পারবে না)।

---

## ৭. API চুক্তি

| API | রিটার্ন (মূল ফিল্ড) |
|---|---|
| `scheduleBackgroundWakes(intervalMinutes?)` | `jobScheduled`, `intervalMinutes` (OS যা দিয়েছে), `requestedIntervalMinutes`, `requiresCharging`, `minIntervalMinutes`, `nextRunApproxMs?`, `mechanism`, `workName`/`taskIdentifier`, `schedulerEnabled?`, `heartbeatIntervalMinutes?`, `opportunistic` (iOS), `reason?` |
| `cancelBackgroundWakes()` | `jobScheduled:false`, `jobCancelled`, `intervalMinutes:0` |
| `getWakeStatus()` | উপরের সব + `workState`, `runAttemptCount`, `lastWakeAt/Source/Summary`, `lastWakeRan/Ok`, `unreadSurfaced`, `engineInitialized`, `enabledCronJobs`, `dueCronJobs`, `pendingTasks` (= still-waiting কাজ), `permitted` (iOS) |
| `loadSurfacedMessages(limit?)` | `messagesJson`, `count`, `unread`, `limit`, `markRead`, `lastWake*` |
| `clearSurfacedMessages()` | `cleared`, `unread:0` |
| `handleWake(source?)` | `ran`, `failed`, `surfaced`, `summary` (ফোরগ্রাউন্ড catch-up; একই ক্যাপচার পথ) |

- সব মেথড **কখনো reject করে না**; নেটিভ স্তরে পৌঁছানো না গেলে
  `{supported:false, reason, alternative}` resolve করে।
- success-এ রিটার্নটা OS-এর নিজের উত্তর: `intervalMinutes` মানে *granted*, চাওয়া মান নয়।

```js
// ল্যাব যা করে:
const s = await NativeKit.agent.scheduleBackgroundWakes(30);
// { jobScheduled:true, intervalMinutes:30, mechanism:'WorkManager PeriodicWorkRequest', … }
const st = await NativeKit.agent.getWakeStatus();   // nextRunApproxMs, lastWakeSummary, unreadSurfaced…
const inbox = await NativeKit.agent.loadSurfacedMessages(20);
JSON.parse(inbox.messagesJson).forEach(m => console.log(m.title, m.body));
```

---

## ৮. কনফিগ

`app.config.json` → `agent` ব্লক (`app.config.schema.json`-এ ভ্যালিডেটেড, `scripts/build-bridge.mjs` ব্রিজে বসায়):

| key | ডিফল্ট | কাজ |
|---|---|---|
| `wakeIntervalMinutes` | 30 | interval না দিলে এটাই অনুরোধ করা হয় |
| `minWakeIntervalMinutes` | 15 | floor (schema-তে সর্বনিম্ন ১৫ — platform reality) |
| `surfacedLimit` | 50 | `loadSurfacedMessages()` ডিফল্ট page size |
| `markSurfacedRead` | false | পড়ার সাথে read-mark করবে কি না |

---

## ৯. ডিভাইসে যাচাই (এখনো করা হয়নি — এটাই বাকি কাজ)

**Android**

```bash
adb shell dumpsys jobscheduler | grep -A 12 native-agent-wake   # job আছে কি, nextRunTime
adb shell dumpsys package com.<app> | grep -i work              # WorkManager DB state
adb logcat -s NativeAgentWakeWorker:* NativeWakeScheduler:*     # wake-এর লগ
# সাথে সাথে একবার চালিয়ে দেখতে (debug only):
adb shell am broadcast -a androidx.work.diagnostics.REQUEST_DIAGNOSTICS -p com.<app>
```

**iOS** (ডিভাইস + Xcode debugger)

```
# app চালু করে debugger-এ pause করে, lldb console-এ (debug-only private API):
e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"io.t6x.nativeagent.wake"]
e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateExpirationForTaskWithIdentifier:@"io.t6x.nativeagent.wake"]
```

যাচাই করার তালিকা: (১) `initialize()`-এর পর config path লেখা হয়েছে কি, (২) schedule-এ
`jobScheduled:true` + অর্থপূর্ণ `nextRunApproxMs`, (৩) wake-এর পর `lastWakeAt`/`lastWakeRan`
বদলেছে কি, (৪) ইনবক্সে record এসেছে কি, (৫) force-quit-এর পর iOS-এ আর wake আসে না (প্রত্যাশিত)।

---

## ১০. যা এই feature **নয়**

- এটি exact alarm নয়, background-এ চিরচলন্ত এজেন্টও নয় — OS সুযোগ দিলে তখনই চলে।
- iOS-এ "৩০ মিনিট পরপর" কোনো প্রতিশ্রুতি নয়; কখনো কয়েক ঘণ্টা দেরি হতে পারে, কখনো দিনে
  কয়েকবারই সুযোগ মিলবে — ব্যাটারি/usage ইতিহাসই ঠিক করে।
- অ্যাপ UI-তে থাকা অবস্থায় OS wake নির্ভরযোগ্য কিছু নয় — দরকার হলে `handleWake()` (catch-up) কল করুন।
- PhoneBuddy-র মতো দ্বিতীয় engine এখানে আসছে না; এই feature ইঞ্জিনেরই `handle_wake` ব্যবহার করে।
