# Native Agent: Provider, Tools ও Context/Memory গভীর অডিট

**পরীক্ষার তারিখ:** ২০২৬-১০-০৮
**কোড:** `plugins/native-agent/rust/native-agent-ffi/src/{provider_catalog.rs,llm_driver.rs,protocol_drivers.rs,agent_loop.rs,tool_runner.rs}`

## সংক্ষিপ্ত সিদ্ধান্ত

- **“সব tools enabled” আর “সব tools সব সময় চালানো যায়”—এক কথা নয়।** Agent Lab-এর seed-এ ২১টি built-in tool `enabled: true`; কিন্তু write/edit, shell, network fetch, cron ও persistent-memory mutation ডিফল্টে approval চায়। অনুমোদন/host capability না থাকলে tool schema-তেই বাদ পড়ে এবং dispatch-এও আবার gate করা হয়।
- Tool call-এর জন্য **provider নয়, নির্বাচিত model-এর capability** বিবেচনা করা হয়। Catalog-এ `false` বা capability অজানা হলে tool-সহ route fail-closed হয়; catalog refresh বা explicit model override না থাকলে অজানা model-কে tool-capable ধরে নেওয়া হয় না।
- Anthropic Messages, OpenAI Chat Completions/Responses, Google Gemini GenerateContent এবং OpenCode Zen-এর একাধিক wire format আলাদা adapter-এ map করা আছে। Tool-use round-trip, SSE parsing, model filter ও retry safety-র Rust unit tests আছে।
- Live public catalog পরীক্ষা একটি বাস্তব ত্রুটি ধরেছে: OVH-এর আগের default `Mistral-Nemo-Instruct-2407` বর্তমান catalog-এ unavailable। Default এখন live/tool-capable `gpt-oss-20b`; OVH catalog-এর `streaming` capability-ও model metadata হিসেবে পড়া হয়।
- OpenCode Zen-এর public model list protocol নয়, কেবল model ID দেয়। তাই protocol mapping official endpoint table দিয়ে করা হয়; অজানা model বা `jev` System One model-কে chat route-এ পাঠানো হয় না। Zen-এর documented prompt-training exception-গুলো এখন catalog/UI-তে privacy warning পায়।
- **সব model/provider নিখুঁতভাবে কাজ করে—এমন দাবি করা হচ্ছে না।** Live authenticated generation (কোনো user API key ছাড়া), সব model-এ real tool round-trip/SSE, Android SDK/NDK cross-build ও iOS/Xcode build এখানে চালানো হয়নি। Catalog/terms পরিবর্তনশীল; UI-তে model refresh করে capability যাচাই করাই নির্ভরযোগ্য পথ।

## Provider অনুযায়ী API contract ও সীমা

| Provider | Default / route | যাচাই-প্রাপ্ত আচরণ ও সতর্কতা |
|---|---|---|
| **Anthropic** | `claude-sonnet-5-5`; Anthropic Messages | `x-api-key` + `anthropic-version`; native `tool_use`/`tool_result`; streaming Messages events। Claude model family-র tool support documented। |
| **OpenAI** | `gpt-6.1-sol`; GPT-5/6 ও O1/O3/O4 family Responses route, অন্য উপযুক্ত model Chat Completions | OpenAI tool schemas/Responses `function_call` ও `function_call_output` আলাদা wire format। Responses stream semantic events; code adapter সেটি parse করে। Model list-এ audio/image-only, embedding, moderation ও realtime model filter করা হয়। |
| **Google Gemini** | `gemini-3.8-flash`; `generateContent` / `streamGenerateContent` | `x-goog-api-key`; `functionDeclarations`, `functionCall` ও `functionResponse`-এর native mapping। Live API catalog key ছাড়া fetch করা যায়নি; official guide-এর contract ও code tests ব্যবহার করা হয়েছে। |
| **OpenRouter** | `anthropic/claude-sonnet-5.5`; OpenAI Chat Completions | Public catalog model-ভিত্তিক `supported_parameters` দেয়; বর্তমান snapshot-এ default ID tools support করে। অন্য model-এ provider নাম দেখে capability অনুমান করা যাবে না; catalog refresh দরকার। |
| **OVHcloud AI Endpoints** | **নতুন default `gpt-oss-20b`**; `gpt-oss-*` Responses, অন্য model OpenAI Chat route | Live catalog: `gpt-oss-20b` available, `function_calling: true`, `streaming: true`; আগের `Mistral-Nemo-Instruct-2407` unavailable। Catalog-এর availability/tool/stream metadata ব্যবহার করা হয়। Public catalog-এ anonymous limit দেখা গেলেও OVH-এর সাধারণ guide access key দিতে বলে—anonymous generation-এর বাস্তব আচরণ key ছাড়া পরীক্ষা করা হয়নি। |
| **AI Horde OpenAI shim** | default model নেই; OpenAI Chat-compatible shim | Upstream proxy documentation স্পষ্টভাবে **tools/functions এবং streaming নেই** বলে; code tool support বন্ধ, stream-ও বন্ধ ধরে buffered request করে। `0000000000` anonymous key সর্বনিম্ন priority; context/output worker availability-তে capped। এটি volunteer compute—গোপন prompt পাঠানোর আগে privacy ঝুঁকি বিবেচনা করুন। |
| **LLM7** | default model নেই; OpenAI Chat Completions | `tools_calling`, `stream`, `tier`, `context_window.tokens` model catalog-নির্ভর। Live snapshot-এ ৫০টি chat model-এর সবগুলোতেই `openai` schema route আছে; ১৪টি OpenAI ও Anthropic—দুই schema-তেই তালিকাভুক্ত। Code OpenAI-only route নিশ্চিত করে; `anthropic`-only future entry filter হয়। `turbo` anonymous/free access; `pro` key লাগে। Capability per-model। |
| **OpenCode Zen** | `claude-sonnet-5-5`; model অনুযায়ী Messages, Responses, Gemini অথবা Chat Completions | Live `/models`-এ ৮৭টি ID পাওয়া গেছে, কিন্তু protocol/capability metadata নেই। Official endpoint table-এর সঙ্গে ID mapping মেলে। `jev-1.13`/`jev-1.13-free` আলাদা `systemone` API; dedicated adapter না থাকায় route বন্ধ। Unknown model-এর protocol override শুধু vendor contract যাচাই করে সেট করতে হবে। Privacy docs-এ চিহ্নিত free/trial exception-এ UI warning দেখায়। |
| **Kilo Gateway** | `kilo-auto/efficient`; OpenAI Chat Completions | Official API reference-এ Bearer key, SSE ও OpenAI-shaped tools আছে। Live catalog-এ default model `isFree: false`, `supported_parameters`-এ `tools`; free model ও `mayTrainOnYourPrompts` model-এর metadata UI-তে আলাদা দেখানো হয়। |
| **Pollinations** | default model নেই; OpenAI Chat Completions | Current public catalog snapshot-এ ৩১৬টি entry। Text/chat category-র entries-এ Chat Completions endpoint আছে; image/audio/embedding/realtime/3D-only entries category/modality filter-এ বাদ পড়ে। `tools`/`stream` support `supported_parameters`/capability থেকে model-wise পড়া হয়; বর্তমান snapshot-এ ১২টি text entry tools parameter দেয়নি। API key catalog-এ লাগে না, generation-এর auth rule provider-level। |
| **WebLLM** | `Llama-3.2-1B-Instruct-q4f16_1-MLC`; local WebGPU | Remote API key লাগে না; weights ডাউনলোড ও compatible WebGPU/WebView দরকার। Foreground callback ছাড়া বা background job-এ route বন্ধ। তালিকাভুক্ত ছোট model-গুলোর tool-call support catalog-এ নিশ্চিত নয়; explicit confirmation ছাড়া tool-সহ request করা হয় না। Android/iOS WebGPU-র বাস্তব device matrix আলাদা করে পরীক্ষা বাকি। |

**Catalog snapshot-এর সংখ্যা পরিবর্তনশীল:** একই দিনে OpenRouter ৩৭৭, Kilo ৪০০ (এর মধ্যে ৩৩২ `tools` parameter, ২৬ `mayTrainOnYourPrompts: true`), LLM7 ৬৫ (৫০ chat; ৪৬ tools true, ৪ false; ৪৯ streaming true, ১ false), OpenCode Zen ৮৭, OVH ২৪ (২০ available; available-গুলোর মধ্যে ৭ function-calling true, streaming ১০ true/১০ false), AI Horde ২৬ এবং Pollinations-এ পরপর fetch-এ ৩১৫–৩১৬ entry ফিরেছে (১৯০ text/chat; ১২ tools parameter দেয়নি; ওই text/chat entries-এ chat endpoint ছিল)। এগুলো permanent guarantee নয়—catalog endpoint-এর তখনকার observation মাত্র।

**Zen-এর model-list ≠ live health:** official endpoint table-এ `muse-spark-1.3-contributor-free` Responses API-তে, Gemini-গুলো Google-native endpoint-এ route হয়; implementation-ও সেই পথ ব্যবহার করে। তবু public user reports-এ Gemini 3.6 Flash-এর upstream failure এবং Muse Spark contributor-free-র API-key path-এ 500/overload দেখা গেছে—Muse report-এর repro `/chat/completions`, যা official 1.3 endpoint table-এর Responses route নয়। তাই ওই report code-এর Responses route যে ব্যর্থ—তা প্রমাণ করে না; কিন্তু Zen `/models` তালিকায় থাকা মানেই model healthy/usable নয়। এগুলো community report, vendor status guarantee নয়; credential ছাড়া আমরা reproduce করিনি।

## Tool policy: কোনটি “enabled”, কোনটি approval-নির্ভর

- Agent Lab-এর default seed ২১টি built-in tool-এ `enabled: true` দেয়। Read-only file/list/find/grep, Git status/log/diff এবং memory recall/search/list `always_allow`; file write/edit/**delete**, shell, Git mutation, web fetch, cron mutation এবং memory store/forget `always_ask`। `delete_file` কেবল workspace-এর regular file মুছে; UI-তে আলাদা confirmation আছে। User policy পরিবর্তন করতে পারেন; unknown permission policy fail-closed থাকে।
- Agent Lab-এর Workspace file manager শুধু configured private workspace-এ কাজ করে; OS/shared device files-এ নয়। UTF-8 text file সর্বোচ্চ ১০ MB edit/create করা যায়, save-এ disk conflict check, আর delete-এ UI confirmation + native approval দুটোই আছে। Binary/non-UTF-8 file edit নয়; regular file delete করা যায়, directory/symlink নয়। `.git`/`.openclaw`/`node_modules` default-এ hidden, checkbox/`include_skipped` দিয়ে explicit দেখা যায়; search/result সীমা কার্যকর থাকে।
- Seed না থাকলেও engine-এর SQLite default `enabled=true`, policy `always_ask`; engine-এর conservative fallback read-only built-in-কে allow, mutation/network-কে ask, MCP-কে ask করে। UI approval callback না থাকলে approval-নির্ভর tool model-কে advertise-ও করা হয় না।
- Tool definition লুকানো usability gate; নিরাপত্তার একমাত্র স্তর নয়। Dispatch সময় session allow-list, registered MCP membership, enabled flag, approval state ও argument/error path আবার যাচাই হয়।
- **Host/OS সীমা:** iOS-এ shell spawning unsupported, তাই `execute_command` schema-তে নেই। Background run-এ MCP/WebView-only tool চলে না। Memory provider না থাকলে `memory_*` schema লুকানো হয়। MCP tool আগে register হতে হবে এবং সাধারণত interactive approval দরকার।
- Tool schema উপস্থিত থাকলেই model সঠিক JSON দেবে—এ নিশ্চয়তা নেই। Adapter response-কে validate করে; missing/malformed call বা unsupported model হলে error/route rejection হয়।

## Routing, retry ও secret handling

- `defaultProvider`, per-provider default model/base URL, model-specific protocol/tool/auth/streaming metadata এবং `autoRouting.providerOrder`, `maxFallbacks`, transient failover ব্যবহারকারী বদলাতে পারেন। Secret runtime JSON-এ নয়, আলাদা native auth store-এ থাকে।
- Auto-route tool call-এর সময় কেবল verified tool-capable candidate রাখে। Unknown/false capability fail-closed; custom base URL হলে provider/model protocol override যাচাই করে দিতে হয়।
- Retry কেবল retryable transport/overload/rate-limit failure-এ; `Retry-After` মানা হয়, তা না থাকলে capped exponential backoff+jitter। কোনো visible partial text/thinking/tool-call event বেরিয়ে গেলে retry বা provider failover করা হয় না—নচেৎ duplicate answer/tool execution হতে পারে। Authentication/invalid request error transient fallback নয়। তবে request timeout-এর সময় upstream কাজ সম্পন্ন করেও response হারিয়ে যেতে পারে; সে ক্ষেত্রে পুনরায় generation provider-side duplicate usage/billing ঘটাতে পারে। সব provider জুড়ে idempotency guarantee নেই।

## Session context, short-term ও long-term memory

- Transcript SQLite-এ session অনুযায়ী থাকে; app/session restart করলেও তা পুনরায় load হতে পারে। Context compaction পুরোনো safe prefix-কে tool-call/result boundary অক্ষত রেখে summarize করে। Summary hidden `Role::Context` message: provider-এ user content হিসেবে যায়, chat display-তে দেখা যায় না, এবং `MEMORY.md`/long-term store-এ auto-promote হয় না। Summary lossy হতে পারে এবং secret-free থাকার নিশ্চয়তা নেই।
- Summarizer unavailable/fail হলে oldest safe prefix trim হয় এবং `context.trimmed` event আসে; success-এ `context.compacted` আসে। সর্বশেষ oversized message একা budget ছাড়ালে provider এখনও request reject করতে পারে।
- `contextCharBudget` হলো **global character-based estimate**, exact model tokenizer নয়। System prompt, tool schema ও `maxTokens × 4` output reserve বাদ দিয়ে transcript budget করা হয়। বর্তমান runtime compactor live `context_length` metadata থেকে model-specific limit গণনা করে না; server-side Anthropic/OpenAI compaction-ও এখানে ব্যবহার করা হয় না। ছোট context-window model ব্যবহারে `contextCharBudget` কমিয়ে দিন।
- Long-term memory আলাদা: workspace `MEMORY.md` system context-এ পড়ে; `memory_*` tool local JSON memory provider ব্যবহার করে। Store/forget approval-নির্ভর; search lexical/token overlap, vector/semantic search নয়। `memory_store` call না হলে transcript বা rolling summary permanent memory-তে কপি হয় না।

## Privacy ও যা নিশ্চিত নয়

- OpenCode Zen-এর privacy docs অধিকাংশ provider-এর no-training policy উল্লেখ করে, তবে কিছু free/trial tier-এ prompt collection/improvement/training exception চিহ্নিত করে; Big Pickle, Exo Free, Fledge Alpha Free, MiMo Free, Ling Free, Nemotron Free এবং Muse Spark 1.3 Contributor Free এই তালিকায় আছে। একই নথির retention অংশে OpenAI ও Anthropic API request ৩০ দিন রাখা হতে পারে বলেছে—তাই “no training” মানেই “no retention” নয়। `/models` privacy flag দেয় না বলে নির্দিষ্ট পরিচিত training/collection-exception IDs code-এ চিহ্নিত; UI-তে warning দেখায়। নতুন free model এলে তালিকা আবার যাচাই করতে হবে। Live Zen list-এ `muse-spark-1.2-contributor-free`-ও দেখা গেছে, কিন্তু privacy page exception-এ শুধু 1.3 নাম দিয়েছে; 1.2-এর policy তাই এখানে unknown। UI এই unknown free-tier privacy status-এও warning দেয়; সংবেদনশীল prompt ব্যবহার করবেন না।
- Kilo catalog-এর `mayTrainOnYourPrompts` field UI-তে warning-এ যায়। অন্য provider-এর retention/training condition model, account ও upstream route অনুযায়ী ভিন্ন হতে পারে; field অনুপস্থিত মানে “নিশ্চিত zero retention” নয়। AI Horde volunteer network-এ prompt পাঠায়—গোপন data না পাঠানোই নিরাপদ।
- এই audit-এ live **public model catalog** fetch করা হয়েছে; কোনো authenticated generation, paid request, live function-call round-trip বা SSE session চালানো হয়নি। OVH anonymous chat auth, Zen Google header compatibility, provider-specific transient error variants এবং catalog refresh failure behavior credentialed integration test পাবে।
- Android/iOS cross-build, iOS-only runtime behavior on device, browser CSP test (Chromium নেই), এবং Xcode/Android SDK build করা হয়নি। Host Linux Rust tests mobile build-এর বিকল্প নয়।

## যাচাই ও পরিবর্তন

- এই সংশোধনের পরে Rust crate test: **১৬৫ passed, ০ failed**। Root `npm_config_engine_strict=false npm run check`: **config validation, typecheck, ১৩ test file/২১৩ test এবং native prepare পাস**।
- OVH default বদলানো ও catalog-ভিত্তিক streaming metadata test আছে; Zen model privacy exception mapping-এর unit test আছে। Live API catalog observation unit test নয়—public service যেকোনো সময় বদলাতে পারে।

## Official sources

- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) · [Models API](https://docs.anthropic.com/en/api/models-list) · [Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- [OpenAI Responses API](https://developers.openai.com/api/docs/guides/responses) · [Function calling](https://developers.openai.com/api/docs/guides/function-calling) · [GPT-6 Luna model capability example](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Gemini Generate Content](https://ai.google.dev/gemini-api/docs/generate-content/get-started) · [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [OpenRouter model docs](https://openrouter.ai/docs/guides/overview/models) · [Live tools-capable model catalog](https://openrouter.ai/api/v1/models?supported_parameters=tools)
- [OVH Catalog API](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-catalog-api) · [OVH Responses API](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-responses-api) · [OVH function calling](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-function-calling) · [Live catalog](https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2)
- [AI Horde OpenAI shim](https://oai.aihorde.net/) · [Proxy implementation and limitations](https://github.com/Haidra-Org/horde-openai-proxy)
- [LLM7 models API](https://docs.llm7.io/guides/models-api) · [Function calling](https://docs.llm7.io/guides/function-calling) · [Streaming](https://docs.llm7.io/guides/streaming)
- [OpenCode Zen endpoints, pricing & privacy](https://opencode.ai/docs/zen/) · [Live model IDs](https://opencode.ai/zen/v1/models) · [Gemini 3.6 user report](https://github.com/anomalyco/opencode/issues/39293) · [Muse Spark 1.3 report](https://github.com/anomalyco/opencode/issues/47192)
- [Kilo API reference](https://kilo.ai/docs/gateway/api-reference) · [Kilo model/provider guide](https://kilo.ai/docs/gateway/models-and-providers) · [Live model catalog](https://api.kilo.ai/api/gateway/models)
- [Pollinations API docs](https://gen.pollinations.ai/docs) · [Live model/capability catalog](https://gen.pollinations.ai/v1/models)
- [AI Horde model list](https://oai.aihorde.net/v1/models) · [LLM7 live model list](https://api.llm7.io/v1/models)
