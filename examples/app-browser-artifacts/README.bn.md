# Stopwatch UI Artifact নমুনা

এটি একটি installable Mini App package, তিনটি আলাদা artifact-এর browser demo নয়। Package-এর চারটি runtime file হলো `nativekit.manifest.json`, `index.html`, `style.css`, `app.js`।

## চালানো

1. Native Android app-এ **App Browser → ZIP / files বাছুন** থেকে এই চারটি file একসঙ্গে select করে install করুন। ZIP দিলে files root-এ রাখুন।
2. App-এর **API policy**-তে `miniUI`, `floatingUI`, `homeWidget` প্রয়োজন অনুযায়ী Allow/Ask করুন।
3. App Run করে **Publish** চাপুন। Host-এর **Native UI Artifacts** section-এ source, revision ও checksum দেখা যাবে।
4. Mini UI-এর **Preview** চাপুন। এটি মূল app session থেকে আলাদা, offline broker-less iframe।
5. Floating UI publish করে app-এর **Show floating** চাপুন। Overlay permission না থাকলে system settings খুলবে; ফিরে এসে আবার Show চাপুন। Permission না দিলে auto-retry হয় না।
6. Home snapshot publish করে **Activate + request pin** চাপুন। Launcher pin support না থাকলে Android widget picker থেকে `Mini App Widget 01`–`08` slot বেছে নিন; প্রথমে activate করা slot-এই artifact দেখাবে।

## গুরুত্বপূর্ণ সীমা

- Home Widget হলো WebView থেকে তৈরি **static bitmap snapshot**, live stopwatch নয়। Main stopwatch-এর বর্তমান সময় আবার **Publish current snapshot** করলে active slot refresh হয়।
- Floating UI live HTML/CSS/JS, কিন্তু Mini App-এর broker/native JS interface পায় না। Network, host file/content, worker ও navigation ব্যবহার করতে পারে না।
- Mini UI-ও broker-less/offline; মূল app-এর `NativeKit` object সেখানে থাকে না।
- প্রতিটি artifact-এর independent stopwatch state। Artifact publish state sync channel নয়; code publish ও update-এর ব্যবস্থা।
- Artifact publish native Android/iOS storage-এ হয়। Android-এই floating/home activation আছে; iOS-এ Mini UI preview ও native persistence রয়েছে, HTML home/floating activation নেই। Hosted web target-এ artifact API unavailable।
- Delete করলে সংশ্লিষ্ট active surface deactivate হয়। App uninstall/disable বা capability revoke lifecycle-ও broker পরিচালনা করে।
