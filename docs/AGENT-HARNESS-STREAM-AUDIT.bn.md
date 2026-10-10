# Agent harness, streaming ও phrase-integrity audit

**তারিখ:** ১০ অক্টোবর ২০২৬

**scope:** Native Rust agent loop, provider stream adapters, Android/iOS event bridge, `AI Workspace` UI, session continuity ও bottom audit log।

## সংক্ষিপ্ত verdict

Harness-টির মূল lifecycle সঠিক: UI `sendMessage` দিয়ে প্রথম turn শুরু করে, SQLite-তে raw transcript থাকে, এরপর `resumeSession → followUp`-এ একই transcript চালানো যায়। পূর্বে UI startup-এ session restore না করার কারণে এটি ব্যবহারকারীর কাছে fresh session-এর মতো দেখাত। সেটি ঠিক করা হয়েছে।

তবে গভীর audit-এ তিনটি সত্যিকারের gap পাওয়া গেছে:

1. Rust engine `thinking` event emit করলেও owner-facing workspace সেটি render করত না। তাই provider reasoning আসলেও ব্যবহারকারী দেখতে পেতেন না।
2. OpenAI-compatible SSE stream-এর দুইটি path একাধিক `data:` line-কে SSE-standard অনুযায়ী এক frame হিসেবে parse করত না এবং malformed JSON নীরবে বাদ দিত। কোনো gateway JSON event fold করলে phrase/পুরো delta হারিয়ে যেতে পারত। EOF-এ separator ছাড়া শেষ data frame-ও বাদ পড়তে পারত।
3. Anthropic-style response-এর `Thinking` block turn transcript-এ ঢুকে SQLite-তে থেকে যাওয়ার সম্ভাবনা ছিল—যা live-only reasoning privacy guarantee ভাঙত।

এই পরিবর্তনে তিনটি gap-এর source-level fix, legacy-data scrub এবং regression test যোগ করা হয়েছে।

---

## Harness lifecycle audit

### Verified path

1. **Durability:** Rust turn শেষে raw messages, provider/model/usage ও constraints SQLite session store-এ save করে।
2. **Restore:** `resumeSession(sessionKey, agentId)` raw history, route এবং tool constraints native `current_session`-এ ফিরিয়ে আনে।
3. **Foreground protection:** UI প্রতিটি follow-up-এর আগে আবার `resumeSession` করে; background skill/cron native handle বদলালেও visible chat ভুল transcript-এ চলে যায় না।
4. **Startup:** UI এখন session list load করে persisted active session (না থাকলে latest session) open+resume করেই composer enable করে।
5. **Isolation:** skill শুরু হলে আর foreground session pointer বদলানো হয় না।

### Acceptance criterion

- App reload/reopen-এর পরে পুরোনো message দেখা যাবে এবং পরের prompt `followUp` হবে।
- User শুধু **নতুন** চাপলে নতুন transcript শুরু হবে।
- A skill/cron completion visible chat-এর assistant bubble, model badge বা session readiness নষ্ট করবে না।

---

## Thinking / reasoning audit

### আগে কী ঘটত

- `StreamEvent::ThinkingDelta` → `event_bus::emit_thinking` → native callback দিয়ে `thinking` event আসত।
- Type definition-এ `thinking` ছিল।
- কিন্তু `agent-workspace.js` শুধুমাত্র `text_delta`/`assistant_delta` render করত। ফলে live reasoning invisible ছিল।
- Gemini `part.thought: true` অংশ explicit ভাবে skip করা হতো। OpenAI-compatible `reasoning_content`/`reasoning` এবং Responses reasoning summary delta-ও সাধারণত UI পর্যন্ত পৌঁছাত না।

### এখন কী হয়

- Chat-এর ওপরে **Agent-এর live reasoning** collapsible panel যোগ করা হয়েছে।
- `thinking`, `thinking_delta`, `reasoning_delta` আলাদা stream হিসেবে render হয়; final answer-এর সাথে মেশে না।
- Anthropic, Gemini stream thought, WebLLM reasoning content, OpenAI-compatible reasoning content এবং OpenAI Responses reasoning summary/direct delta native `ThinkingDelta`-এ normalise করা হয়েছে।
- Raw reasoning **persistent bottom log/localStorage, SQLite transcript বা পরের provider request-এ রাখা হয় না**; কেবল live panel-এ session চলাকালীন থাকে। নিচের audit log শুধু update/character count রাখে। Save boundary-তে block filter এবং schema initialization-এ legacy `Thinking` row scrub আছে। এই সিদ্ধান্তটি privacy ও incomplete-provider-thinking ঝুঁকি কমায়।

> Provider reasoning final answer নয় এবং provider ভেদে একেবারেই নাও আসতে পারে। UI fake thinking তৈরি করে না।

---

## Phrase integrity ও SSE audit

### কেন regex একা natural-language বোঝার সমাধান নয়

Bangla বা অন্য natural language-এর অর্থ বোঝা LLM/model-এর কাজ; regex দিয়ে semantic intent নির্ভুল করা যায় না। কিন্তু regex/parser ব্যবহার করে **protocol phrase loss**, **error category** এবং **fixed command pattern** নির্ভরযোগ্যভাবে শনাক্ত করা যায়। এই audit-এ regex/protocol validation সেই জায়গায় ব্যবহার করা হয়েছে, model-এর ভাষা বোঝার ভুয়া বিকল্প হিসেবে নয়।

### আগে পাওয়া ঝুঁকি

| ঝুঁকি | আগের আচরণ | ফলাফল |
|---|---|---|
| UTF-8 chunk split | ইতিমধ্যে byte-buffer দিয়ে ঠিক করা ছিল | Bangla/CJK/emoji character ভাঙা আটকাত |
| `\r\n\r\n` বনাম `\n\n` frame separator | ইতিমধ্যে ঠিক করা ছিল | CDN/proxy line-ending সমস্যা কমত |
| একাধিক SSE `data:` line | দুই OpenAI-compatible path line-by-line JSON parse করত | folded JSON frame-এ phrase হারাতে পারত |
| malformed SSE JSON | `if let Ok(...)`/`let Ok(...) else continue` দিয়ে silently skip | user incomplete answer দেখত, কিন্তু exact cause পেত না |
| EOF final frame | final blank separator না থাকলে data বাদ পড়ত | শেষ শব্দ/বাক্য হারাতে পারত |

### source-level fix

- একক `parse_sse_json_frame(bytes)` helper তৈরি হয়েছে।
- Strict UTF-8 decode করা হয়; lossy replacement character দিয়ে corrupted phrase দেখানো হয় না।
- SSE spec অনুযায়ী সব `data:` line newline দিয়ে join করে তারপর JSON parse করা হয়।
- Invalid JSON আর silently বাদ যায় না; typed parse error হয়।
- EOF-এ leftover complete frame parse করা হয়।
- Native error UI regex classifier দিয়ে `auth`, `rate_limit`, `context_limit`, `stream_protocol`, `timeout`, `network`, `tool`, `cancelled` category-তে বাংলায় actionable message দেয়। Raw/provider-sensitive error persistent log-এ রাখা হয় না।

### Regression coverage

Rust unit test যোগ হয়েছে যাতে যাচাই করে:

- মাঝখানে split হওয়া Bangla UTF-8 text অক্ষত থাকে;
- LF ও CRLF separator সঠিক হয়;
- folded multi-line `data:` frame থেকে `বাংলা phrase` অক্ষত পাওয়া যায়;
- invalid JSON, invalid UTF-8 এবং `[DONE]` সঠিক ফল দেয়।

---

## Bottom audit log audit

- Provider route/fallback, tools, approval, retry, context trim/compact, background cron/heartbeat/wake, UI action, session restore/open/new এবং terminal error—all event নিচে audit করা হয়।
- Text/reasoning token chunks আলাদা আলাদা অসংখ্য row না বানিয়ে aggregate count দেখায়, কিন্তু final text ও live reasoning panel আলাদাভাবে দেখা যায়।
- Prompt, file content, token/key/cookie, provider request/response body এবং raw reasoning persistent event log-এ redacted থাকে।
- সর্বশেষ ৩০০টি redacted audit event device local storage-এ থাকে; user **Log মুছুন** দিয়ে clear করতে পারেন।

---

## Validation status

সম্পন্ন:

- `node --check` UI files, native plugin TypeScript build ও root TypeScript typecheck সফল।
- `npm run check` সফল: config validation, TypeScript, **15টি Vitest file / 233টি test**, এবং native web staging pass করেছে।
- Rust FFI-তে `cargo check --lib` সফল এবং `cargo test --lib`: **182 passed, 0 failed**। এতে UTF-8 split, LF/CRLF, folded multi-line `data:`, bad JSON/UTF-8, ephemeral-only reasoning persistence/legacy-scrub guard এবং auto-router default regression আছে।
- repeated `npm run configure:native`-এ Android Gradle byte-for-byte idempotent হয়েছে; signing preamble corruption regression-ও test-covered।

রিলিজের আগে অবশিষ্ট সীমা:

- Native SSE/reasoning fix Rust FFI-তে হওয়ায় নতুন source pass করলেও পুরোনো prebuilt binary সেটি বহন করে না। Release APK-এর আগে চার ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) এবং iOS XCFramework পুনর্নির্মাণ ও real-device smoke test আবশ্যক।
- এই sandbox-এর Node 20.20.2-এ JS gate pass হয়েছে, কিন্তু project engine Node 22+ চায়। Capacitor sync, Android release build ও iOS archive Node 22 CI-তে পুনরায় চালাতে হবে।
- `cargo fmt --check` এখনো legacy Rust file-গুলোর বহু pre-existing formatting difference দেখায়। এটি compile/test failure নয়; আলাদা formatting-cleanup PR-তে সমাধান করা উচিত।

### Signed APK / publish attempt-এর বাস্তব অবস্থা

এই environment-এ release build sequentially শুরু করে যাচাই করা হয়েছে। পুরোনো `NativeKit-1.4.11-free-router-release.apk`-এ চার ABI-তেই native agent library আছে, কিন্তু সেটি `1.4.12-agent-continuity` source fix বহন করে না। নতুন signed APK এখানেই তৈরি/publish করা যায়নি, কারণ:

1. এই workspace-এ Git worktree/remote নেই—তাই `git push` করার repository বা authenticated target নেই।
2. `ANDROID_KEYSTORE_PATH`, keystore password, alias এবং key password—চারটিই অনুপস্থিত। নতুন random key তৈরি করলে existing Play/update signing identity ভেঙে যাবে, তাই তা করা নিরাপদ নয়।
3. Rust toolchain এবং Android SDK/NDK এই runtime-এ নেই; তাই চার ABI-র FFI rebuild সম্ভব নয়।
4. Android project AGP `8.13.0` ব্যবহার করছে, যার জন্য JDK 17 দরকার; runtime-এ JDK 11 আছে। Gradle release attempt Maven TLS handshake failure-এ dependency resolution-এর আগেই থেমেছে।
5. Node 20.20.2 project-এর Node 22+ requirement পূরণ করে না।

অতএব signed release ও push-এর জন্য CI/secure build runner-এ Node 22, JDK 17, Android SDK Build Tools 35+, NDK r27, Rust targets, existing signing secret এবং authenticated Git remote দিতে হবে।
