# AI Workspace Upgrade — বাস্তব ব্যবহারকারীর জন্য Agent Chat, Automation ও MCP

**তারিখ:** ২০২৬-১০-০৯  
**লক্ষ্য:** Demo/API-test panel-কে একটি বাস্তব, বাংলা-প্রথম AI workspace-এ উন্নীত করা—যেখানে user chat, memory, skill, cron, private file/persona, provider key, tool policy ও MCP connection নিজে নিয়ন্ত্রণ করতে পারেন।

---

## ১. আগে কী ছিল, কী সমস্যা ছিল

Repo-তে Rust-native agent engine যথেষ্ট শক্তিশালী ছিল—streaming chat, tool approval, SQLite session, memory, skill, cron, WorkManager/BGProcessingTask wake এবং MCP forwarding—কিন্তু visible UI ছিল প্রধানত **৪৭টি API test button-এর Agent Lab**।

এতে তিনটি UX সমস্যা ছিল:

1. একজন normal user-কে API-এর ক্রম (availability → initialize → auth → listen → send) জানতে হতো।
2. Memory/skill/cron/persona/MCP ছিল, কিন্তু এগুলোর জন্য বাস্তব form, list, edit/delete control ও state visibility ছিল না।
3. MCP client পুরোনো `2025-06-18` handshake/session-centric protocol ধরে ছিল; বর্তমান MCP `2026-07-28` stateless HTTP model ব্যবহার করে।

এই upgrade পুরোনো Lab সরায়নি। সেটি **Developer diagnostics** নামে collapsed অংশে রাখা হয়েছে, যাতে every-native-API regression test সম্ভব থাকে। নতুন `আমার AI Workspace` হলো default, user-facing flow।

---

## ২. নতুন user flow

### প্রথম ব্যবহার

1. **Agent চালু করুন** চাপুন।
2. ABI availability পরীক্ষা হয়; তারপর private workspace, SQLite, auth store ও event listener তৈরি হয়।
3. Provider বেছে API key সংরক্ষণ করুন (Keychain/Keystore-backed agent auth store)।
4. Chat-এ বাংলা বা ইংরেজিতে কাজ লিখুন।

চ্যাট চলার সময়:

- streaming text bubble-এ আসে;
- tool চালালে ছোট activity pill দেখা যায়;
- file write, memory save, network/MCP-এর মতো sensitive action হলে inline approval card আসে;
- approve/deny করলে একই run resume হয়—নতুন conversation শুরু হয় না;
- Abort দিয়ে চলমান run থামানো যায়।

### Navigation

| ট্যাব | ব্যবহারকারী কী করতে পারবেন |
|---|---|
| **চ্যাট** | multi-session conversation, streamed response, approve/deny, abort, recent history |
| **অটোমেশন** | one-time বা recurring cron, Saved Skill-linked job, enable/disable/run/delete, Heartbeat, OS wake schedule, background inbox |
| **Skills** | reusable system prompt + allowed-tool list, start/end/delete |
| **মেমোরি** | local memory add, search, list, exact-key delete |
| **ব্যক্তিত্ব ও ফাইল** | `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md` edit/save |
| **MCP সংযোগ** | HTTPS server, protocol mode, secure Bearer token, connect/reconnect/remove |
| **সেটিংস ও টুল** | provider/model/key, runtime budget, tool-specific enabled/allow/ask/biometric policy |

---

## ৩. Customization model

### ৩.১ Agent personality ও নিয়ম

Workspace root-এর সাতটি `.md` file engine প্রথমবার তৈরি করে এবং পরে overwrite করে না। তাই এগুলো user-level customization-এর স্থায়ী জায়গা:

- `AGENTS.md`: কাজের নিয়ম ও safety boundary
- `SOUL.md`: tone/style
- `IDENTITY.md`: agent name/role
- `USER.md`: user preference/context
- `TOOLS.md`: কখন কোন tool ব্যবহার করবে
- `HEARTBEAT.md`: recurring check-এর নিয়ম
- `MEMORY.md`: system prompt-এ থাকা reference note

নতুন UI file editor `read_file`/`write_file` native tool ব্যবহার করে। ফলে atomic write, workspace sandbox ও approval policy বজায় থাকে। API key/token কখনো এই file-এ রাখা যাবে না।

### ৩.২ Memory

Memory `memory_*` native tool-এ থাকে; এটি app-private store এবং বর্তমান implementation lexical/token-overlap search। অর্থাৎ এটি private ও deterministic, কিন্তু embedding/vector semantic search নয়। UI ইচ্ছাকৃতভাবে automatic profiling করে না—user নিজে key/text দিয়ে save করেন এবং delete করতে পারেন।

### ৩.৩ Skills

Skill হলো named reusable instruction bundle:

- `systemPrompt`
- explicit `allowedTools` allow-list
- `maxTurns`
- `timeoutMs`

Allow-list tool permission bypass করে না। কোনো tool `always_ask` হলে Skill থেকেও permission চাইবে।

### ৩.৪ Cron/Background execution

Cron UI engine-এর typed schedule object ব্যবহার করে:

- `{ kind: 'every', everyMs, anchorMs }`
- `{ kind: 'at', atMs }`

Background wake বাস্তব OS scheduler দিয়ে হয়:

- Android: WorkManager periodic work, minimum 15 minutes
- iOS: BGProcessingTask; `earliestBeginDate` একটি earliest floor, exact promise নয়

অতএব UI কোথাও exact timer দাবি করে না। Wake-এর ফল `surfaced messages` inbox-এ পাওয়া যায়। iOS force-quit-এর পরে background execution OS বন্ধ রাখতে পারে—এটি platform limitation, bug নয়।

---

## ৪. MCP upgrade ও নিরাপত্তা

### ৪.১ Protocol support

`bridge/mcp-client.ts` এখন দুই generation সামলায়:

- **Current:** MCP `2026-07-28` stateless Streamable HTTP
- **Legacy:** MCP `2025-06-18` initialize + `Mcp-Session-Id`
- **Auto:** আগে current stateless call; server reject করলে একবার controlled legacy fallback

Current mode-এ request body-এর `_meta`-তে protocol/capabilities দেওয়া হয় এবং HTTP-তে `Mcp-Method` ও প্রয়োজনে `Mcp-Name` routing header দেওয়া হয়। Legacy session id current request-এ পাঠানো হয় না। Native Capacitor HTTP AbortSignal honour না করলেও transport Promise timeout race ব্যবহার করে, যাতে hung MCP request পুরো agent turn আটকে না রাখে।

### ৪.২ MCP trust boundary

MCP server external/untrusted capability। তাই:

1. server URL অবশ্যই credential-free **HTTPS**;
2. server name bounded/validated;
3. সব remote MCP tool default-এ `always_ask`;
4. tool name `<server>__<tool>` namespace-এ যায়—দুই server-এর একই `search` tool collide করে না;
5. access token config/HTML/chat log-এ রাখা হয় না; user চাইলে `secureStorage`-এ (`Android Keystore`/`iOS Keychain`) রাখা হয়;
6. token শুধু সংশ্লিষ্ট server-এর runtime header-এ যোগ হয়;
7. failed tool call-ও engine-কে result হিসেবে ফেরত যায়—তাতে model নিজে correction করতে পারে, 30-second silent stall হয় না।

### ৪.৩ AI Router cockpit

নতুন **AI Router** card থেকে user এখন:

- provider-কে enable/disable ও priority অনুযায়ী উপর-নিচে সাজাতে পারেন;
- প্রতিটি provider-এর default model নির্ধারণ বা catalog default-এ ফিরতে পারেন;
- transient failure-এ failover এবং সর্বোচ্চ fallback সংখ্যা ঠিক করতে পারেন;
- API key ও model configuration-ভিত্তিক **non-billable Config যাচাই** চালাতে পারেন;
- নিজের সম্মতিতে একটি ছোট **বাস্তব পরীক্ষা** চালাতে পারেন। সেটি `Auto router` দিয়ে `ROUTER_HEALTHCHECK` পাঠায় এবং live `trying → selected/fallback` event দেখায়। বাস্তব পরীক্ষায় provider usage/billing হতে পারে, তাই এটি কখনো automatic নয়।

Native engine source audit-এ আচরণটি নিশ্চিত করা হয়েছে: `provider='auto'` হলে `autoRouting.providerOrder` থেকে eligible route তৈরি হয়; retryable failure এবং user-visible streaming শুরু হওয়ার আগেই শুধু পরের route চেষ্টা হয়। ফলে partial answer বা side-effect পুনরায় চলার ঝুঁকি কমে। Explicit provider কখনো silent cross-provider fallback করে না।

AI Horde, LLM7 ও Pollinations-এর built-in default model নেই; router UI ওই route-এ আলাদা model দিতে মনে করায়। WebLLM foreground WebView/WebGPU-নির্ভর, তাই এটি background automatic fallback হিসেবে preflight-এ ready বলা হয় না।

**OpenRouter আলাদা স্তর:** app-এর `autoRouting` হলো app-level cross-provider router। OpenRouter-কে যখন provider হিসেবে বাছা হয়, তার নিজের upstream provider-routing (`order`, `only`, `zdr`, `data_collection`, `max_price`) আলাদা API feature। বর্তমান native request contract-এ ওই fields নেই, তাই UI-তে ভুয়া control যোগ করা হয়নি। ভবিষ্যতে যুক্ত হলে strict allow-list, zero-retention ও cost-limit policy native request layer-এই enforce করতে হবে, শুধু UI-তে নয়। Reference: [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)।

### ৪.৪ OAuth: বর্তমান সত্য

MCP OAuth 2.1/PKCE full browser callback flow এখনও UI-তে implement করা হয়নি। OAuth-enabled server-এর ক্ষেত্রে user consent শেষ করে পাওয়া access token manual secure-store-এ দিতে পারবেন। এটি password/token plaintext settings-এ রাখার চেয়ে নিরাপদ, কিন্তু full OAuth UX নয়।

পরবর্তী কাজ: Protected Resource Metadata discovery → Authorization Server discovery → PKCE → redirect/callback → issuer-bound token refresh. Current MCP spec অনুযায়ী token issuer-bound রাখা এবং issuer validation বাধ্যতামূলক হওয়া উচিত।

---

## ৫. Research-backed design decisions

### MCP

MCP 2026-07-28 specification session-less core, request metadata, header-based routing, cacheable discovery lists এবং authorization hardening এনেছে। এই কারণেই client-কে শুধুই পুরোনো `initialize`/session flow-তে আটকে রাখা ঠিক নয়।

Primary references:

- [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Tools security requirements](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP authorization/OAuth 2.1 guide](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

### Agent approval

Sensitive side effect-এর ঠিক tool boundary-তে approval রাখতে হয়। শুধু system prompt বা outer content filter যথেষ্ট নয়। তাই UI approval native engine-এর pending run ID ব্যবহার করে approve/deny করে; tool call পুনরায় তৈরি করে না।

Reference:

- [OpenAI — Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [OpenAI — Agent builder safety](https://developers.openai.com/api/docs/guides/agent-builder-safety)

### Mobile background reality

Mobile OS persistent arbitrary agent runtime দেয় না। Android periodic work-এর floor 15 minutes; iOS schedule opportunistic এবং runtime constrained। UI তাই “সময়মতো নিশ্চয়ই চলবে” বলে না এবং surfaced inbox রাখে।

Reference:

- [Capacitor Background Runner v8](https://capacitorjs.com/docs/apis/background-runner)

---

## ৬. Source map

| File | দায়িত্ব |
|---|---|
| `www/agent-workspace.html` | user-facing workspace markup |
| `www/agent-workspace.css` | responsive mobile/tablet/desktop UX |
| `www/agent-workspace.js` | chat, lifecycle, approvals, cron, skills, memory, persona, MCP, provider/tool controls |
| `www/app.js` | workspace boot + old diagnostics Lab boot |
| `www/index.html` | workspace entry point; Lab collapsed under `<details>` |
| `www/agent-lab.js` | one shared native handle reuse—Lab আর second initialize করে live turn নষ্ট করবে না |
| `bridge/mcp-client.ts` | current + legacy MCP transport, timeout, routing headers, validation, ask-by-default tools |
| `tests/mcp-client.test.ts` | stateless mode, legacy fallback ও 2026 routing header regression tests |

---

## ৭. Validation

এই upgrade-এর পরে চালানো হয়েছে:

```bash
npm run validate:config
npm run typecheck
npm test -- --reporter=dot
npm run prepare:native
```

Test result: **13 files / 217 tests pass**।

> Local sandbox Node 20 ছিল; repo/CI requirement Node 22+। install চালাতে sandbox-এ `npm ci --engine-strict=false` প্রয়োজন হয়েছিল। প্রকৃত CI/release অবশ্য Node 22+ দিয়েই চালান।

---

## ৮. পরবর্তী বাস্তব roadmap

1. **Full MCP OAuth PKCE**: discovery, browser callback, token refresh, issuer binding, scope UI.
2. **Semantic memory**: on-device embedding + vector index; বর্তমান lexical memory রাখা/মাইগ্রেশন option।
3. **Automation skill picker**: cron form থেকে saved Skill select এবং active-hours UI।
4. **Attachment/multimodal chat**: camera/file context with explicit preview + per-attachment approval.
5. **Chat rendering**: safe markdown/code block, copy/export, trace detail drawer।
6. **Evals/observability**: redacted trace timeline, per-provider cost/tokens, regression task suite.
7. **On-device LLM**: WebLLM-এর বাইরে reliable GGUF/llama.cpp route এবং offline tool policy.

এই ৭টি ধাপ থাকলে “সব কিছু করতে পারে” কথাটা নিরাপদভাবে বাস্তব হবে—অর্থাৎ unlimited raw device access নয়, বরং user-controlled, auditable এবং revocable capability।
