// Owner-facing AI workspace. This is intentionally separate from agent-lab.js:
// the Lab remains a full API diagnostic surface, while this module is the safe,
// task-oriented interface a real user uses every day.

const $ = (id) => document.getElementById(id);
const AGENT_INIT = Object.freeze({
  dbPath: 'files://agent/agent.db',
  workspacePath: 'files://agent/workspace',
  authProfilesPath: 'files://agent/auth-profiles.json',
});
const MCP_PREF_KEY = 'nativekit.agent.mcp.servers.v1';
const MCP_TOKEN_PREFIX = 'nativekit.agent.mcp.token.';
const PERSONA_HINTS = Object.freeze({
  'AGENTS.md': 'AGENTS.md: agent-এর প্রধান নিয়ম, কাজের ধাপ ও নিরাপত্তা সীমা লিখুন।',
  'SOUL.md': 'SOUL.md: কথার টোন, মূল্যবোধ ও আচরণ লিখুন।',
  'IDENTITY.md': 'IDENTITY.md: agent-এর নাম, ভূমিকা ও বিশেষজ্ঞতা ঠিক করুন।',
  'USER.md': 'USER.md: আপনার ভাষা, পছন্দ, কাজের ধরন ও ব্যক্তিগত context লিখুন।',
  'TOOLS.md': 'TOOLS.md: কোন tool কখন ব্যবহার করবে বা করবে না—তা লিখুন।',
  'HEARTBEAT.md': 'HEARTBEAT.md: নিয়মিত check-এর সময় কী দেখবে ও কখন নীরব থাকবে তা লিখুন।',
  'MEMORY.md': 'MEMORY.md: system prompt-এর সাথে থাকা স্থায়ী reference note লিখুন।',
});
const TOOL_DEFAULTS = Object.freeze([
  ['read_file', 'always_allow'], ['list_files', 'always_allow'], ['find_files', 'always_allow'], ['grep_files', 'always_allow'],
  ['git_status', 'always_allow'], ['git_log', 'always_allow'], ['git_diff', 'always_allow'], ['memory_recall', 'always_allow'],
  ['memory_search', 'always_allow'], ['memory_list', 'always_allow'], ['write_file', 'always_ask'], ['edit_file', 'always_ask'],
  ['delete_file', 'always_ask'], ['execute_command', 'always_ask'], ['git_init', 'always_ask'], ['git_add', 'always_ask'],
  ['git_commit', 'always_ask'], ['web_fetch', 'always_ask'], ['manage_cron', 'always_ask'], ['memory_store', 'always_ask'], ['memory_forget', 'always_ask'],
]);

const ROUTABLE_PROVIDERS = Object.freeze([
  'anthropic', 'openai', 'gemini', 'openrouter', 'ovhcloud', 'opencode_zen',
  'llm7', 'kilo', 'pollinations', 'aihorde', 'webllm',
]);
const MODEL_REQUIRED_FOR_ROUTE = new Set(['aihorde', 'llm7', 'pollinations']);
const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', openrouter: 'OpenRouter',
  ovhcloud: 'OVHcloud', opencode_zen: 'OpenCode Zen', llm7: 'LLM7', kilo: 'Kilo',
  pollinations: 'Pollinations', aihorde: 'AI Horde', webllm: 'WebLLM (local)',
});

const state = {
  initialized: false,
  initializing: false,
  listening: false,
  running: false,
  sessionKey: `chat-${Date.now()}`,
  runtimeConfig: null,
  pendingApproval: null,
  currentAssistant: null,
  sessions: [],
  skills: [],
  cronJobs: [],
  memoryKeys: [],
  mcpConfigs: [],
  mcp: null,
  personaFile: 'AGENTS.md',
  files: { directory: '.', entries: [], mode: 'directory', selectedPath: null, originalContent: null, originalBytes: 0, isNew: false, editable: false, dirty: false, busy: false, truncated: false },
  activity: [],
  routerDraft: null,
  routeEvents: [],
  heartbeat: null,
};

function nativeAgent() { return window.NativeKit?.agent; }
function featureReady() { return Boolean(nativeAgent?.() && window.NativeKit.agent.supported()); }
function clean(value) { return String(value ?? '').trim(); }
function nowTime(ms = Date.now()) { return new Intl.DateTimeFormat('bn-BD', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
function dateTime(ms) { return new Intl.DateTimeFormat('bn-BD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)); }
function bytes(value) { return new TextEncoder().encode(String(value ?? '')).byteLength; }
function parseJson(raw, fallback) { try { return JSON.parse(raw ?? ''); } catch { return fallback; } }
function safeText(value, max = 140) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; }
function uniqueName(value) { return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value); }

function toast(message, tone = 'muted') {
  const node = $('aw-toast');
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, tone === 'err' ? 8000 : 4500);
}

function status(message, tone = 'muted') {
  const node = $('aw-status');
  if (!node) return;
  node.dataset.tone = tone;
  const text = node.querySelector('span');
  if (text) text.textContent = message;
}

function requireInit() {
  if (!state.initialized) throw new Error('Agent প্রস্তুত হচ্ছে—একটু অপেক্ষা করে আবার চেষ্টা করুন।');
}

function setComposerAvailability(ready) {
  const disabled = !ready || state.running;
  const submit = $('aw-composer')?.querySelector('[type="submit"]');
  if (submit) submit.disabled = disabled;
  const input = $('aw-chat-input');
  if (input) input.disabled = disabled;
}

function setRunning(running, message) {
  state.running = running;
  $('aw-abort').hidden = !running;
  setComposerAvailability(state.initialized);
  if (message) status(message, running ? 'busy' : 'ok');
}

function showTab(name) {
  document.querySelectorAll('[data-aw-tab]').forEach((button) => {
    const selected = button.dataset.awTab === name;
    button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.aw-tab').forEach((panel) => panel.classList.toggle('active', panel.id === `aw-tab-${name}`));
  if (name === 'automations' && state.initialized) void refreshAutomations();
  if (name === 'skills' && state.initialized) void refreshSkills();
  if (name === 'memory' && state.initialized) void refreshMemory();
  if (name === 'files' && state.initialized) void refreshFiles();
  if (name === 'mcp' && state.initialized) void renderMcp();
  if (name === 'settings' && state.initialized) void refreshSettings();
}

function appendActivity(label, tone = '') {
  state.activity.unshift({ label, tone });
  state.activity = state.activity.slice(0, 6);
  const node = document.querySelector('.aw-activity') ?? document.createElement('div');
  node.className = 'aw-activity';
  node.replaceChildren(...state.activity.map((entry) => {
    const item = document.createElement('span');
    item.className = `aw-activity-item ${entry.tone}`.trim();
    item.textContent = entry.label;
    return item;
  }));
  const feed = $('aw-chat-feed');
  if (feed && !node.parentElement) feed.prepend(node);
}

function recordRouteEvent(kind, payload = {}) {
  const provider = payload.provider ?? payload.toProvider ?? payload.selectedProvider ?? 'unknown';
  const model = payload.model ?? payload.toModel ?? payload.selectedModel ?? '';
  const attempt = payload.attempt ? ` · চেষ্টা ${payload.attempt}` : '';
  const reason = payload.reason ? ` · ${safeText(payload.reason, 110)}` : '';
  const label = `${kind} · ${provider}${model ? ` / ${model}` : ''}${attempt}${reason}`;
  state.routeEvents.unshift({ label, kind, at: Date.now() });
  state.routeEvents = state.routeEvents.slice(0, 8);
  const root = $('aw-route-live');
  if (root) root.replaceChildren(...state.routeEvents.map((entry) => {
    const row = document.createElement('span');
    row.className = `aw-route-event ${entry.kind}`;
    row.textContent = entry.label;
    return row;
  }));
}

function makeMessage(role, text, when = Date.now(), pending = false) {
  $('aw-empty-chat')?.remove();
  const wrap = document.createElement('article');
  wrap.className = `aw-message ${role === 'user' ? 'user' : 'assistant'}`;
  wrap.dataset.role = role;
  const avatar = document.createElement('div');
  avatar.className = 'aw-avatar';
  avatar.textContent = role === 'user' ? 'আপনি' : '✦';
  const body = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'aw-bubble';
  bubble.textContent = text;
  if (pending) bubble.dataset.pending = 'true';
  const stamp = document.createElement('div');
  stamp.className = 'aw-message-time';
  stamp.textContent = nowTime(when);
  body.append(bubble, stamp);
  wrap.append(avatar, body);
  $('aw-chat-feed')?.append(wrap);
  $('aw-chat-feed').scrollTop = $('aw-chat-feed').scrollHeight;
  return bubble;
}

function clearChat() {
  const feed = $('aw-chat-feed');
  if (!feed) return;
  feed.replaceChildren();
  state.currentAssistant = null;
  state.activity = [];
  const empty = document.createElement('div');
  empty.id = 'aw-empty-chat';
  empty.className = 'aw-empty-chat';
  empty.innerHTML = '<div><div class="aw-empty-icon">✦</div><h3>নতুন কথোপকথন</h3><p>আপনার লক্ষ্য লিখুন। Agent জটিল কাজ হলে আগে একটি পরিকল্পনা দেখাতে পারে এবং tool চালানোর আগে অনুমতি চাইবে।</p></div>';
  feed.append(empty);
}

function redactArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const secret = /(?:key|token|secret|password|authorization|cookie|content|prompt|command)/i;
  return Object.entries(value).map(([key, raw]) => `${key}: ${secret.test(key) ? 'গোপন রাখা হয়েছে' : safeText(typeof raw === 'string' ? raw : JSON.stringify(raw), 80)}`).join(' · ');
}

function renderApproval() {
  const roots = [...document.querySelectorAll('[data-aw-approval-queue]')];
  const chatRoot = $('aw-approval-queue');
  if (chatRoot && !roots.includes(chatRoot)) roots.push(chatRoot);
  if (!roots.length) return;
  const request = state.pendingApproval;
  for (const root of roots) {
    root.replaceChildren();
    if (!request) continue;
    const card = document.createElement('div');
    card.className = 'aw-approval';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `অনুমতি প্রয়োজন: ${request.toolName}`;
    const detail = document.createElement('span');
    detail.textContent = redactArgs(request.args) || 'Agent এই tool চালাতে চায়।';
    copy.append(title, detail);
    const actions = document.createElement('div');
    actions.className = 'aw-actions';
    const deny = document.createElement('button'); deny.type = 'button'; deny.className = 'ghost'; deny.textContent = 'না, বাতিল';
    deny.addEventListener('click', () => void answerApproval(false));
    const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = 'অনুমতি দিন';
    approve.addEventListener('click', () => void answerApproval(true));
    actions.append(deny, approve); card.append(copy, actions); root.append(card);
  }
}

async function answerApproval(approved) {
  const request = state.pendingApproval;
  if (!request) return;
  try {
    await nativeAgent().respondToApproval(request.id, approved, approved ? undefined : 'User denied this action in AI Workspace');
    appendActivity(`${approved ? 'অনুমোদিত' : 'বাতিল'} · ${request.toolName}`, approved ? '' : 'warn');
    state.pendingApproval = null;
    renderApproval();
  } catch (error) { toast(`অনুমতি পাঠানো যায়নি: ${error.message ?? error}`, 'err'); }
}

async function initialize() {
  if (state.initializing) return;
  state.initializing = true;
  setComposerAvailability(false);
  $('aw-start').disabled = true;
  try {
    if (!featureReady()) {
      status('Web preview-এ native agent চলে না; Android/iOS build চালান।', 'warn');
      toast('Native build ছাড়া AI engine চালু করা যাবে না।', 'warn');
      return;
    }
    if (state.initialized || globalThis.__nativeKitAgentInitialized) {
      state.initialized = true;
      await afterInitialize();
      return;
    }
    status('Agent engine প্রস্তুত হচ্ছে…', 'busy');
    const probe = await nativeAgent().checkAvailability();
    if (!probe.available) throw new Error(probe.reason || `এই device ABI (${probe.abi}) supported নয়`);
    await nativeAgent().initialize(AGENT_INIT);
    globalThis.__nativeKitAgentInitialized = true;
    state.initialized = true;
    await afterInitialize();
    status('Agent প্রস্তুত। এখন চ্যাট শুরু করুন।', 'ok');
    toast('Private workspace, local memory ও scheduler প্রস্তুত।', 'ok');
  } catch (error) {
    status(`Agent চালু হয়নি: ${error.message ?? error}`, 'err');
    toast(`Agent চালু হয়নি: ${error.message ?? error}`, 'err');
  } finally {
    state.initializing = false;
    $('aw-start').disabled = false;
  }
}

async function afterInitialize() {
  await wireEvents();
  // The engine is ready at this point. Do not make chat wait for optional
  // settings/history refreshes: that made a healthy agent look unsendable.
  setComposerAvailability(true);
  $('aw-start').textContent = '✓ Agent প্রস্তুত';
  await Promise.allSettled([
    refreshSettings(), refreshSessions(), refreshAutomations(), refreshSkills(),
    refreshMemory(), refreshFiles(), loadMcpConfigs(), loadPersona(),
  ]);
}

async function wireEvents() {
  if (state.listening) return;
  await nativeAgent().onEvent((event) => {
    const type = event?.eventType ?? event?.type;
    let payload = event?.payloadJson ?? event?.payload ?? {};
    if (typeof payload === 'string') payload = parseJson(payload, { raw: payload });
    if (type === 'text_delta' || type === 'assistant_delta') {
      const text = payload?.text ?? payload?.delta ?? '';
      if (!state.currentAssistant) state.currentAssistant = makeMessage('assistant', '', Date.now(), true);
      state.currentAssistant.textContent += text;
      $('aw-chat-feed').scrollTop = $('aw-chat-feed').scrollHeight;
      return;
    }
    if (type === 'approval_request') {
      state.pendingApproval = {
        id: payload?.toolCallId ?? payload?.tool_call_id,
        toolName: payload?.toolName ?? payload?.tool_name ?? 'unknown tool',
        args: payload?.args ?? payload?.input ?? {},
      };
      renderApproval(); appendActivity(`অনুমতি অপেক্ষমান · ${state.pendingApproval.toolName}`, 'warn');
      status(`অনুমতি অপেক্ষমান: ${state.pendingApproval.toolName}`, 'warn'); return;
    }
    if (type === 'tool_use') {
      appendActivity(`Tool চলছে · ${payload?.toolName ?? payload?.tool_name ?? 'unknown'}`); return;
    }
    if (type === 'tool_result') {
      appendActivity(`${payload?.result?.isError ? 'Tool ব্যর্থ' : 'Tool শেষ'} · ${payload?.toolName ?? payload?.tool_name ?? 'unknown'}`, payload?.result?.isError ? 'warn' : ''); return;
    }
    if (type === 'mcp_tool_call') { appendActivity(`MCP tool চলছে · ${payload?.toolName ?? payload?.tool_name ?? 'unknown'}`); return; }
    if (type === 'provider.selected' || type === 'provider.route') {
      const name = payload?.provider ?? payload?.selectedProvider;
      const model = payload?.model ?? payload?.selectedModel;
      if (name) $('aw-model-label').textContent = `${name}${model ? ` / ${model}` : ''}`;
      recordRouteEvent(type === 'provider.selected' ? 'selected' : 'trying', payload ?? {});
      appendActivity(`${type === 'provider.selected' ? 'Route selected' : 'Route চেষ্টা'} · ${name ?? 'unknown'}`);
      return;
    }
    if (type === 'provider.fallback') {
      recordRouteEvent('fallback', payload ?? {});
      appendActivity(`Provider fallback · ${payload?.toProvider ?? payload?.provider ?? 'unknown'}`, 'warn'); return;
    }
    if (type === 'context.compacted' || type === 'context.trimmed') { appendActivity('পুরোনো context সংক্ষেপ করা হয়েছে', 'warn'); return; }
    if (type === 'agent.completed') {
      state.currentAssistant?.removeAttribute('data-pending');
      state.currentAssistant = null; setRunning(false, 'উত্তর প্রস্তুত।'); void refreshSessions(); return;
    }
    if (type === 'agent.error' || type === 'agent.background_timeout') {
      const message = payload?.error ?? payload?.message ?? (type === 'agent.background_timeout' ? 'Background সময়সীমা শেষ' : 'Agent error');
      if (!state.currentAssistant?.textContent) state.currentAssistant = makeMessage('assistant', `⚠ ${message}`);
      state.currentAssistant?.removeAttribute('data-pending'); state.currentAssistant = null;
      setRunning(false, `সমস্যা: ${safeText(message)}`); toast(String(message), 'err'); return;
    }
    if (/^(cron\.|heartbeat\.|wake\.)/.test(type ?? '')) { appendActivity(`${type}: ${safeText(payload?.summary ?? payload?.error ?? 'update')}`, type.includes('error') ? 'warn' : ''); void refreshAutomations(); }
  });
  state.listening = true;
}

async function sendMessage(event) {
  event?.preventDefault();
  requireInit();
  if (state.running) return;
  const input = $('aw-chat-input');
  const prompt = clean(input.value);
  if (!prompt) return;
  const provider = clean($('aw-provider').value || 'auto');
  const model = clean($('aw-model').value);
  const systemPrompt = clean($('aw-persona-system')?.value);
  makeMessage('user', prompt); input.value = '';
  state.currentAssistant = makeMessage('assistant', '', Date.now(), true);
  setRunning(true, 'Agent ভাবছে…'); appendActivity('নতুন কাজ শুরু');
  try {
    const options = { prompt, sessionKey: state.sessionKey, provider, ...(model ? { model } : {}), ...(systemPrompt ? { systemPrompt } : {}) };
    await nativeAgent().sendMessage(options);
  } catch (error) {
    state.currentAssistant.textContent = `⚠ পাঠানো যায়নি: ${error.message ?? error}`;
    state.currentAssistant.removeAttribute('data-pending'); state.currentAssistant = null;
    setRunning(false, 'বার্তা পাঠানো যায়নি।'); toast(String(error.message ?? error), 'err');
  }
}

async function abortRun() {
  if (!state.running) return;
  await nativeAgent().abort();
  state.currentAssistant?.removeAttribute('data-pending'); state.currentAssistant = null;
  setRunning(false, 'বর্তমান কাজ থামানো হয়েছে।'); appendActivity('User কাজ থামিয়েছেন', 'warn');
}

function normalizeMessage(message) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const content = typeof message?.content === 'string' ? message.content
    : typeof message?.text === 'string' ? message.text
      : Array.isArray(message?.content) ? message.content.map((item) => item?.text ?? '').join('\n') : '';
  return { role, text: content, at: Number(message?.createdAt ?? message?.timestamp ?? Date.now()) };
}

async function refreshSessions() {
  requireInit();
  const response = await nativeAgent().listSessions('main');
  state.sessions = parseJson(response?.sessionsJson, []);
  const root = $('aw-session-list'); root.replaceChildren();
  for (const item of state.sessions.slice(0, 12)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `aw-session ${item.sessionKey === state.sessionKey ? 'active' : ''}`;
    const title = document.createElement('strong'); title.textContent = item.sessionKey === state.sessionKey ? '● বর্তমান চ্যাট' : (item.model || item.sessionKey);
    const sub = document.createElement('span'); sub.textContent = `${item.provider || 'default'} · ${item.updatedAt ? dateTime(item.updatedAt) : ''}`;
    button.append(title, sub); button.addEventListener('click', () => void openSession(item.sessionKey)); root.append(button);
  }
  if (!state.sessions.length) root.innerHTML = '<span class="aw-help">এখনো কোনো সংরক্ষিত চ্যাট নেই</span>';
}

async function openSession(sessionKey) {
  requireInit();
  if (state.running && !confirm('একটি কাজ চলছে। তবু অন্য চ্যাট খুলবেন?')) return;
  const response = await nativeAgent().loadSession(sessionKey, 'main');
  const messages = parseJson(response?.messagesJson, []);
  state.sessionKey = sessionKey; $('aw-session-label').textContent = sessionKey;
  const feed = $('aw-chat-feed'); feed.replaceChildren(); state.currentAssistant = null;
  for (const message of messages) { const normalized = normalizeMessage(message); if (normalized.text) makeMessage(normalized.role, normalized.text, normalized.at); }
  if (!feed.children.length) clearChat();
  await refreshSessions(); showTab('chat');
}

function newChat() {
  if (state.running) { toast('চলমান কাজ শেষ বা বন্ধ হওয়ার পর নতুন চ্যাট খুলুন।', 'warn'); return; }
  state.sessionKey = `chat-${Date.now()}`; $('aw-session-label').textContent = 'নতুন চ্যাট'; clearChat(); $('aw-chat-input').focus(); void refreshSessions();
}

async function refreshAutomations() {
  requireInit();
  const [jobsReply, inboxReply, wakeReply, schedulerReply] = await Promise.all([
    nativeAgent().listCronJobs(), nativeAgent().loadSurfacedMessages(30), nativeAgent().getWakeStatus(), nativeAgent().getSchedulerConfig(),
  ]);
  state.cronJobs = parseJson(jobsReply?.jobsJson, []); renderCronJobs(); renderInbox(parseJson(inboxReply?.messagesJson, []));
  const wake = wakeReply ?? {};
  $('aw-wake-status').textContent = wake.jobScheduled
    ? `চালু · ${wake.mechanism ?? 'OS scheduler'} · প্রতি ${wake.intervalMinutes ?? '?'} মিনিট${wake.nextRunApproxMs ? ` · পরেরটি ≈ ${dateTime(wake.nextRunApproxMs)}` : ''}`
    : `চালু নয়${wake.reason ? ` · ${wake.reason}` : ''}`;
  const heartbeat = schedulerReply?.heartbeat ?? {}; state.heartbeat = heartbeat;
  $('aw-heartbeat-enabled').checked = heartbeat.enabled === true;
  $('aw-heartbeat-minutes').value = Math.max(1, Math.round(Number(heartbeat.everyMs ?? 3_600_000) / 60_000));
  $('aw-heartbeat-prompt').value = heartbeat.prompt ?? '';
  if ($('aw-heartbeat-skill')) $('aw-heartbeat-skill').value = heartbeat.skillId ?? '';
  $('aw-heartbeat-status').textContent = heartbeat.enabled
    ? `চালু · প্রতি ${Math.round(Number(heartbeat.everyMs ?? 0) / 60_000)} মিনিট${heartbeat.nextRunAt ? ` · পরেরটি ≈ ${dateTime(heartbeat.nextRunAt)}` : ''}`
    : 'বন্ধ · চালু করলে পরের OS wake-এ best-effort কাজ হবে।';
}

function scheduleText(job) {
  const schedule = typeof job.schedule === 'object' ? job.schedule : parseJson(job.scheduleJson, {});
  if (schedule?.kind === 'at') return `একবার · ${dateTime(schedule.atMs)}`;
  const minutes = Math.round(Number(schedule?.everyMs ?? 0) / 60_000);
  return `প্রতি ${minutes || '?'} মিনিট${job.nextRunAt ? ` · পরেরটি ${dateTime(job.nextRunAt)}` : ''}`;
}

function renderCronJobs() {
  const root = $('aw-cron-list'); root.replaceChildren();
  for (const job of state.cronJobs) {
    const row = document.createElement('div'); row.className = 'aw-list-item';
    const copy = document.createElement('div'); copy.className = 'aw-list-copy';
    const title = document.createElement('strong'); title.textContent = `${job.enabled ? '●' : '○'} ${job.name}`;
    const sub = document.createElement('span'); sub.textContent = `${scheduleText(job)} · ${job.deliveryMode || 'notification'} · ${safeText(job.prompt || job.skillId || '', 90)}`;
    copy.append(title, sub); const actions = document.createElement('div'); actions.className = 'aw-list-actions';
    const run = document.createElement('button'); run.type = 'button'; run.className = 'ghost'; run.textContent = 'এখন চালান'; run.disabled = !job.enabled; run.addEventListener('click', () => void runCron(job));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'ghost'; toggle.textContent = job.enabled ? 'বন্ধ' : 'চালু'; toggle.addEventListener('click', () => void toggleCron(job));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'aw-danger'; remove.textContent = 'মুছুন'; remove.addEventListener('click', () => void deleteCron(job));
    actions.append(run, toggle, remove); row.append(copy, actions); root.append(row);
  }
}

function renderInbox(items) {
  const root = $('aw-inbox'); root.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'aw-list-item';
    const copy = document.createElement('div'); copy.className = 'aw-list-copy';
    const title = document.createElement('strong'); title.textContent = item.title || item.status || 'Background ফলাফল';
    const sub = document.createElement('span'); sub.textContent = `${item.at ? dateTime(item.at) : ''} · ${item.text || item.body || 'কোনো লেখা নেই'}`;
    copy.append(title, sub); row.append(copy); root.append(row);
  }
}

async function createCron(event) {
  event.preventDefault(); requireInit();
  const kind = $('aw-cron-kind').value; const name = clean($('aw-cron-name').value); const prompt = clean($('aw-cron-prompt').value); const skillId = clean($('aw-cron-skill').value);
  if (!name || (!prompt && !skillId)) throw new Error('নাম এবং একটি কাজের নির্দেশনা বা Saved Skill দিন।');
  let schedule;
  if (kind === 'at') { const at = new Date($('aw-cron-at').value).getTime(); if (!Number.isFinite(at) || at <= Date.now()) throw new Error('একবারের কাজের জন্য ভবিষ্যতের তারিখ ও সময় দিন।'); schedule = { kind: 'at', atMs: at }; }
  else { const minutes = Number($('aw-cron-every').value); if (!Number.isInteger(minutes) || minutes < 1) throw new Error('সময় ব্যবধান কমপক্ষে ১ মিনিট হতে হবে।'); schedule = { kind: 'every', everyMs: minutes * 60_000, anchorMs: Date.now() }; }
  await nativeAgent().addCronJob({ name, prompt, ...(skillId ? { skillId } : {}), schedule, enabled: $('aw-cron-enabled').checked, sessionTarget: $('aw-cron-session').value, wakeMode: 'next-heartbeat', deliveryMode: $('aw-cron-delivery').value, deliveryNotificationTitle: name });
  event.target.reset(); $('aw-cron-every').value = '60'; $('aw-cron-enabled').checked = true; syncSkillSelects(); toast('Automation যোগ করা হয়েছে।', 'ok'); await refreshAutomations();
}
async function saveHeartbeat(event) {
  event.preventDefault(); requireInit();
  const minutes = Number($('aw-heartbeat-minutes').value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Heartbeat interval ১ থেকে ১৪৪০ মিনিটের মধ্যে দিন।');
  const skillId = clean($('aw-heartbeat-skill').value); const prompt = clean($('aw-heartbeat-prompt').value);
  await nativeAgent().setHeartbeatConfig({ enabled: $('aw-heartbeat-enabled').checked, everyMs: minutes * 60_000, skillId: skillId || null, prompt: prompt || null });
  toast($('aw-heartbeat-enabled').checked ? 'Heartbeat সংরক্ষণ ও চালু হয়েছে।' : 'Heartbeat বন্ধ রাখা হয়েছে।', 'ok'); await refreshAutomations();
}

async function runCron(job) { await nativeAgent().runCronJob(job.id); await nativeAgent().handleWake('user_workspace'); toast('Cron job চালানো হয়েছে; ফলাফল inbox-এ আসবে।', 'ok'); await refreshAutomations(); }
async function toggleCron(job) { await nativeAgent().updateCronJob(job.id, { enabled: !job.enabled }); await refreshAutomations(); }
async function deleteCron(job) { if (!confirm(`“${job.name}” স্থায়ীভাবে মুছবেন?`)) return; await nativeAgent().removeCronJob(job.id); await refreshAutomations(); }
async function scheduleWake() { requireInit(); const minutes = Number($('aw-wake-minutes').value); const result = await nativeAgent().scheduleBackgroundWakes(minutes); toast(result.jobScheduled ? 'Background wake চালু হয়েছে।' : (result.reason || 'Wake চালু হয়নি।'), result.jobScheduled ? 'ok' : 'warn'); await refreshAutomations(); }
async function cancelWake() { requireInit(); const result = await nativeAgent().cancelBackgroundWakes(); toast(result.jobCancelled ? 'Background wake বন্ধ করা হয়েছে।' : (result.reason || 'Wake বন্ধ হয়নি।'), result.jobCancelled ? 'ok' : 'warn'); await refreshAutomations(); }

function syncSkillSelects() {
  for (const id of ['aw-cron-skill', 'aw-heartbeat-skill']) {
    const select = $(id); if (!select) continue;
    const previous = select.value || (id === 'aw-heartbeat-skill' ? state.heartbeat?.skillId ?? '' : '');
    const emptyLabel = id === 'aw-cron-skill' ? 'নিজের prompt ব্যবহার করুন' : 'HEARTBEAT.md অনুযায়ী';
    select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: emptyLabel }));
    for (const skill of state.skills) select.append(Object.assign(document.createElement('option'), { value: skill.id, textContent: skill.name || skill.id }));
    select.value = previous;
  }
}

async function refreshSkills() {
  requireInit(); const reply = await nativeAgent().listSkills(); state.skills = parseJson(reply?.skillsJson, []); syncSkillSelects(); const root = $('aw-skill-list'); root.replaceChildren();
  for (const skill of state.skills) {
    const row = document.createElement('div'); row.className = 'aw-list-item'; const copy = document.createElement('div'); copy.className = 'aw-list-copy';
    const title = document.createElement('strong'); title.textContent = skill.name || skill.id; const tools = parseJson(skill.allowedTools, []);
    const sub = document.createElement('span'); sub.textContent = `${tools.length ? tools.join(', ') : 'কোনো tool নয়'} · ${skill.maxTurns ?? 3} turns · ${safeText(skill.systemPrompt || '', 90)}`;
    copy.append(title, sub); const actions = document.createElement('div'); actions.className = 'aw-list-actions';
    const start = document.createElement('button'); start.type = 'button'; start.className = 'ghost'; start.textContent = 'Start'; start.addEventListener('click', () => void startSkill(skill));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'aw-danger'; remove.textContent = 'মুছুন'; remove.addEventListener('click', () => void removeSkill(skill));
    actions.append(start, remove); row.append(copy, actions); root.append(row);
  }
}
async function createSkill(event) { event.preventDefault(); requireInit(); const toolText = clean($('aw-skill-tools').value); const allowedTools = toolText ? toolText.split(',').map((name) => name.trim()).filter(Boolean) : []; await nativeAgent().addSkill({ name: clean($('aw-skill-name').value), systemPrompt: clean($('aw-skill-prompt').value), allowedTools, maxTurns: Number($('aw-skill-turns').value), timeoutMs: Number($('aw-skill-timeout').value) * 1000 }); event.target.reset(); $('aw-skill-turns').value = '5'; $('aw-skill-timeout').value = '60'; toast('Skill সংরক্ষণ হয়েছে।', 'ok'); await refreshSkills(); }
async function startSkill(skill) { const result = await nativeAgent().startSkill(skill.id, {}, clean($('aw-provider').value) || undefined); state.sessionKey = result.sessionKey; $('aw-session-label').textContent = result.sessionKey; toast(`“${skill.name}” skill session শুরু হয়েছে।`, 'ok'); showTab('chat'); await refreshSessions(); }
async function removeSkill(skill) { if (!confirm(`“${skill.name}” মুছবেন?`)) return; await nativeAgent().removeSkill(skill.id); await refreshSkills(); }

async function invokeMemory(name, args) {
  const response = await nativeAgent().invokeTool(name, args); const result = parseJson(response?.resultJson, response);
  if (result?.error) throw new Error(result.error); return result;
}
async function refreshMemory() { requireInit(); const result = await invokeMemory('memory_list', { prefix: '', limit: 100 }); state.memoryKeys = Array.isArray(result) ? result : parseJson(result?.keys, Array.isArray(result?.keys) ? result.keys : []); renderMemoryList(); }
function renderMemoryList() { const root = $('aw-memory-list'); root.replaceChildren(); for (const key of state.memoryKeys) { const row = document.createElement('div'); row.className = 'aw-list-item'; const copy = document.createElement('div'); copy.className = 'aw-list-copy'; const title = document.createElement('strong'); title.textContent = key; const sub = document.createElement('span'); sub.textContent = 'Local long-term memory'; copy.append(title, sub); const actions = document.createElement('div'); actions.className = 'aw-list-actions'; const forget = document.createElement('button'); forget.type = 'button'; forget.className = 'aw-danger'; forget.textContent = 'ভুলে যাও'; forget.addEventListener('click', () => void forgetMemory(key)); actions.append(forget); row.append(copy, actions); root.append(row); } }
async function storeMemory(event) { event.preventDefault(); requireInit(); const key = clean($('aw-memory-key').value); const text = clean($('aw-memory-text').value); if (!key || !text) throw new Error('মেমোরির নাম ও লেখা দিন।'); await invokeMemory('memory_store', { key, text, metadata: { category: clean($('aw-memory-category').value) || undefined } }); event.target.reset(); toast('মেমোরি সংরক্ষণ হয়েছে।', 'ok'); await refreshMemory(); }
async function searchMemory(event) { event.preventDefault(); requireInit(); const query = clean($('aw-memory-query').value); const root = $('aw-memory-search-results'); root.replaceChildren(); if (!query) return; const result = await invokeMemory('memory_search', { query, limit: 10 }); const records = Array.isArray(result) ? result : (result?.results ?? []); for (const item of records) { const row = document.createElement('div'); row.className = 'aw-list-item'; const copy = document.createElement('div'); copy.className = 'aw-list-copy'; const title = document.createElement('strong'); title.textContent = item.key ?? 'মেমোরি'; const sub = document.createElement('span'); sub.textContent = item.text ?? safeText(JSON.stringify(item)); copy.append(title, sub); row.append(copy); root.append(row); } }
async function forgetMemory(key) { if (!confirm(`“${key}” মেমোরি থেকে মুছবেন?`)) return; await invokeMemory('memory_forget', { key }); await refreshMemory(); }

async function invokeFile(name, args) { const response = await nativeAgent().invokeTool(name, args); const result = parseJson(response?.resultJson, response); if (result?.error) throw new Error(result.error); return result; }
// ── Private workspace file browser ──────────────────────────────────────────
// This deliberately uses the same built-in tools as the agent. There is no
// second browser-only store: an upload is written into files://agent/workspace
// so the agent, personas, scheduler and user see one auditable file tree.
const WORKSPACE_TEXT_LIMIT = 10_000_000;
const TEXT_UPLOAD_EXTENSIONS = /\.(?:txt|md|markdown|json|csv|js|mjs|cjs|ts|tsx|jsx|py|html?|css|xml|ya?ml|toml|ini|log|svg|sh)$/i;

function humanFileSize(value) {
  const bytesValue = Number(value ?? 0);
  if (!Number.isFinite(bytesValue) || bytesValue < 1024) return `${Math.max(0, Math.round(bytesValue || 0))} B`;
  if (bytesValue < 1024 ** 2) return `${(bytesValue / 1024).toFixed(1)} KB`;
  return `${(bytesValue / 1024 ** 2).toFixed(1)} MB`;
}

function normalizeWorkspacePath(value) {
  const raw = clean(value).replace(/\\/g, '/');
  if (!raw || raw === '.') return '.';
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('শুধু workspace-relative path ব্যবহার করুন।');
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..' || part.includes('\0'))) throw new Error('.. বা invalid path ব্যবহার করা যাবে না।');
  return parts.join('/') || '.';
}

function parentWorkspacePath(path) {
  const parts = normalizeWorkspacePath(path).split('/');
  parts.pop();
  return parts.filter((part) => part && part !== '.').join('/') || '.';
}

function baseWorkspaceName(path) {
  const parts = normalizeWorkspacePath(path).split('/');
  return parts.at(-1) === '.' ? '' : parts.at(-1);
}

function childWorkspacePath(directory, name) {
  const safeName = clean(name);
  if (!safeName || safeName === '.' || safeName === '..' || /[\\/\0]/.test(safeName)) throw new Error('একটি বৈধ file name দিন; /, \\ ও .. ব্যবহার করা যাবে না।');
  if (bytes(safeName) > 255) throw new Error('File name সর্বোচ্চ 255 UTF-8 bytes হতে পারে।');
  const parent = normalizeWorkspacePath(directory);
  return parent === '.' ? safeName : `${parent}/${safeName}`;
}

function fileManagerState() { return state.files; }
function setFilesStatus(message, tone = 'muted') {
  const node = $('aw-files-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function currentFilePath() {
  const files = fileManagerState();
  if (files.selectedPath) return files.selectedPath;
  if (files.isNew && clean($('aw-file-name')?.value)) return childWorkspacePath(files.directory, $('aw-file-name').value);
  return null;
}

function clearFileEditor() {
  const files = fileManagerState();
  files.selectedPath = null;
  files.originalContent = null;
  files.originalBytes = 0;
  files.isNew = false;
  files.editable = false;
  files.dirty = false;
  const name = $('aw-file-name'); if (name) name.value = '';
  const content = $('aw-file-content'); if (content) content.value = '';
  updateFileManagerControls();
}

function confirmDiscardFileDraft() {
  const files = fileManagerState();
  return !(files.isNew || files.dirty) || window.confirm('এই file editor-এ unsaved পরিবর্তন আছে। পরিবর্তন বাদ দেবেন?');
}

function updateFileManagerControls() {
  const files = fileManagerState();
  const disabled = !state.initialized || state.running || files.busy;
  const hasEditor = Boolean(files.selectedPath || files.isNew);
  const name = $('aw-file-name');
  const content = $('aw-file-content');
  if (name) name.disabled = disabled || !files.isNew;
  if (content) content.disabled = disabled || !hasEditor || !files.editable;
  for (const id of ['aw-files-dir', 'aw-files-search', 'aw-files-include-skipped']) {
    const node = $(id); if (node) node.disabled = disabled;
  }
  for (const id of ['aw-files-open-dir', 'aw-files-up', 'aw-files-refresh', 'aw-files-open-uploads', 'aw-files-find', 'aw-files-new', 'aw-files-choose']) {
    const node = $(id); if (node) node.disabled = disabled;
  }
  const canSave = files.isNew ? Boolean(clean(name?.value)) : Boolean(files.selectedPath && files.editable && files.dirty);
  if ($('aw-file-save')) $('aw-file-save').disabled = disabled || !canSave;
  if ($('aw-file-revert')) $('aw-file-revert').disabled = disabled || !hasEditor || (!files.isNew && (!files.editable || !files.dirty));
  if ($('aw-file-delete')) $('aw-file-delete').disabled = disabled || !files.selectedPath;
  if ($('aw-file-insert-chat')) $('aw-file-insert-chat').disabled = disabled || !files.selectedPath;
  const stateNode = $('aw-file-state');
  if (stateNode) stateNode.textContent = !hasEditor ? 'কোনো ফাইল খোলা নেই'
    : files.isNew ? (files.dirty ? 'নতুন draft · unsaved' : 'নতুন file draft')
      : files.editable ? (files.dirty ? 'Unsaved changes' : 'Saved') : 'Read-only · binary/বড় file';
  const pathNode = $('aw-file-path'); if (pathNode) pathNode.textContent = currentFilePath() ?? '—';
  const sizeNode = $('aw-file-size');
  if (sizeNode) sizeNode.textContent = !hasEditor ? 'সর্বোচ্চ 10 MB UTF-8 text'
    : files.isNew ? `Draft · ${humanFileSize(bytes(content?.value ?? ''))}` : humanFileSize(files.originalBytes);
}

function renderFileEntries(items, mode) {
  const root = $('aw-files-list');
  if (!root) return;
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-file-empty';
    empty.textContent = mode === 'search' ? 'কোনো matching file/folder পাওয়া যায়নি।' : 'এই folder খালি।';
    root.append(empty);
    return;
  }
  const files = fileManagerState();
  for (const entry of items) {
    const type = String(entry?.type ?? 'unknown');
    const path = mode === 'search'
      ? normalizeWorkspacePath(entry?.path ?? '')
      : childWorkspacePath(files.directory, String(entry?.name ?? ''));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `agent-file-entry${files.selectedPath === path ? ' selected' : ''}`;
    button.disabled = !state.initialized || files.busy || state.running || !['file', 'directory'].includes(type);
    button.title = path;
    const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = type === 'directory' ? '📁' : type === 'file' ? '▤' : '↗';
    const label = document.createElement('span'); label.className = 'agent-file-entry-name'; label.textContent = mode === 'search' ? baseWorkspaceName(path) : String(entry?.name ?? path);
    const meta = document.createElement('span'); meta.className = 'agent-file-entry-meta';
    meta.textContent = type === 'directory' ? 'folder' : type === 'file' ? humanFileSize(entry?.size) : type === 'symlink' ? 'symlink · blocked' : 'unavailable';
    button.append(icon, label, meta);
    if (type === 'file') button.addEventListener('click', () => void guardFileOperation(() => openWorkspaceFile(path, entry)));
    if (type === 'directory') button.addEventListener('click', () => void guardFileOperation(() => openWorkspaceDirectory(path)));
    root.append(button);
  }
}

async function refreshFiles(path = $('aw-files-dir')?.value ?? fileManagerState().directory) {
  if (!state.initialized) return;
  const directory = normalizeWorkspacePath(path);
  const files = fileManagerState();
  setFilesStatus(`Folder পড়া হচ্ছে: ${directory}`, 'busy');
  const result = await invokeFile('list_files', { path: directory, include_skipped: Boolean($('aw-files-include-skipped')?.checked) });
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  entries.sort((a, b) => {
    const rank = (item) => item?.type === 'directory' ? 0 : item?.type === 'file' ? 1 : 2;
    return rank(a) - rank(b) || String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, { sensitivity: 'base' });
  });
  files.directory = directory; files.entries = entries; files.mode = 'directory'; files.truncated = Boolean(result?.truncated);
  if ($('aw-files-dir')) $('aw-files-dir').value = directory;
  if ($('aw-files-count')) $('aw-files-count').textContent = `${entries.length}${files.truncated ? '+' : ''} items`;
  renderFileEntries(entries, 'directory');
  setFilesStatus(`Workspace/${directory === '.' ? '' : directory} · ${entries.length}টি item${files.truncated ? ' · তালিকা সীমিত, search ব্যবহার করুন' : ''}`, files.truncated ? 'warn' : 'ok');
  updateFileManagerControls();
}

async function openWorkspaceDirectory(path) {
  if (!confirmDiscardFileDraft()) return;
  clearFileEditor();
  await refreshFiles(path);
}

async function searchWorkspaceFiles() {
  const pattern = clean($('aw-files-search')?.value);
  if (!pattern) throw new Error('Filename search-এর জন্য pattern দিন; যেমন *.md।');
  const files = fileManagerState();
  setFilesStatus(`খোঁজা হচ্ছে: ${pattern}`, 'busy');
  const result = await invokeFile('find_files', { path: files.directory, pattern, include_skipped: Boolean($('aw-files-include-skipped')?.checked) });
  const matches = Array.isArray(result?.files) ? result.files : [];
  files.entries = matches; files.mode = 'search'; files.truncated = Boolean(result?.truncated);
  if ($('aw-files-count')) $('aw-files-count').textContent = `${matches.length}${files.truncated ? '+' : ''} matches`;
  renderFileEntries(matches, 'search');
  setFilesStatus(`${matches.length}টি match${files.truncated ? ' · scan/result limit-এ কাটা হয়েছে; pattern আরও নির্দিষ্ট করুন' : ''}`, files.truncated ? 'warn' : 'ok');
}

async function readWorkspaceText(path) {
  let offset = 0; let content = ''; let expectedBytes = null; let expectedModifiedMs = null;
  while (true) {
    const part = await invokeFile('read_file', { path, offset_bytes: offset, limit_bytes: 50_000 });
    if (typeof part?.content !== 'string' || !Number.isSafeInteger(part?.fileBytes)) throw new Error('File-এর বৈধ UTF-8 text metadata পাওয়া যায়নি।');
    if (expectedBytes === null) { expectedBytes = part.fileBytes; expectedModifiedMs = part.modifiedMs ?? null; }
    else if (part.fileBytes !== expectedBytes || (expectedModifiedMs !== null && part.modifiedMs !== expectedModifiedMs)) throw new Error('ফাইল পড়ার সময় বদলে গেছে; আবার Refresh/Open করুন।');
    content += part.content;
    if (!part.truncated) return { content, bytes: expectedBytes ?? 0 };
    const next = Number(part.nextOffsetBytes);
    if (!Number.isSafeInteger(next) || next <= offset || next > expectedBytes) throw new Error('File read cursor নিরাপদ নয়; আবার Refresh করুন।');
    offset = next;
  }
}

async function openWorkspaceFile(path, entry = {}) {
  if (!confirmDiscardFileDraft()) return;
  const files = fileManagerState();
  const safePath = normalizeWorkspacePath(path);
  setFilesStatus(`খোলা হচ্ছে: ${safePath}`, 'busy');
  let text = null; let reason = '';
  try { text = await readWorkspaceText(safePath); }
  catch (error) {
    const message = String(error?.message ?? error);
    if (/utf-8|File exceeds|tool limit/i.test(message)) reason = /exceeds|limit/i.test(message) ? '10 MB-এর বেশি' : 'binary/non-UTF-8';
    else throw error;
  }
  files.directory = parentWorkspacePath(safePath); files.selectedPath = safePath; files.isNew = false; files.dirty = false;
  files.editable = Boolean(text); files.originalContent = text?.content ?? null; files.originalBytes = text?.bytes ?? Number(entry?.size ?? 0);
  if ($('aw-files-dir')) $('aw-files-dir').value = files.directory;
  if ($('aw-file-name')) $('aw-file-name').value = baseWorkspaceName(safePath);
  if ($('aw-file-content')) $('aw-file-content').value = text?.content ?? '';
  await refreshFiles(files.directory);
  setFilesStatus(reason ? `${safePath} তালিকায় আছে, তবে ${reason} হওয়ায় editor read-only।` : `${safePath} খোলা হয়েছে · ${humanFileSize(files.originalBytes)}`, reason ? 'warn' : 'ok');
  updateFileManagerControls();
}

function createWorkspaceFile() {
  if (!confirmDiscardFileDraft()) return;
  clearFileEditor();
  const files = fileManagerState();
  files.isNew = true; files.editable = true; files.originalContent = ''; files.originalBytes = 0; files.dirty = false;
  updateFileManagerControls();
  setFilesStatus(`Workspace/${files.directory === '.' ? '' : files.directory}-এ নতুন draft। Save create-only; existing file overwrite হবে না।`, 'muted');
  $('aw-file-name')?.focus();
}

function updateWorkspaceFileDraft() {
  const files = fileManagerState();
  const content = $('aw-file-content')?.value ?? '';
  files.dirty = files.isNew ? Boolean(clean($('aw-file-name')?.value) || content) : Boolean(files.selectedPath && content !== files.originalContent);
  updateFileManagerControls();
}

async function saveWorkspaceFile() {
  const files = fileManagerState();
  if (!files.selectedPath && !files.isNew) throw new Error('আগে file নির্বাচন করুন বা নতুন file তৈরি করুন।');
  const path = files.isNew ? childWorkspacePath(files.directory, $('aw-file-name').value) : files.selectedPath;
  const content = $('aw-file-content')?.value ?? '';
  if (bytes(content) > WORKSPACE_TEXT_LIMIT) throw new Error('File 10 MB UTF-8 limit ছাড়িয়েছে।');
  if (!files.isNew && content === files.originalContent) return;
  if (!files.isNew) {
    const latest = await readWorkspaceText(path);
    if (latest.content !== files.originalContent) throw new Error('File editor-এ খোলার পর disk-এ বদলেছে। Draft রাখা আছে; আবার Open করে পরিবর্তন মিলিয়ে নিন।');
  }
  setFilesStatus(files.isNew ? 'নতুন file তৈরি হচ্ছে; approval চাইতে পারে…' : 'পরিবর্তন সংরক্ষণ হচ্ছে; approval চাইতে পারে…', 'busy');
  await invokeFile('write_file', { path, content, ...(files.isNew ? { create_only: true } : {}) });
  files.selectedPath = path; files.directory = parentWorkspacePath(path); files.isNew = false; files.editable = true; files.dirty = false;
  files.originalContent = content; files.originalBytes = bytes(content);
  if ($('aw-file-name')) $('aw-file-name').value = baseWorkspaceName(path);
  await refreshFiles(files.directory);
  setFilesStatus(`${path} সংরক্ষিত · ${humanFileSize(files.originalBytes)}`, 'ok');
}

function revertWorkspaceFile() {
  const files = fileManagerState();
  if (files.isNew) { clearFileEditor(); setFilesStatus('নতুন file draft বাতিল হয়েছে।', 'muted'); return; }
  if (!files.selectedPath || !files.editable) throw new Error('Revert করার মতো editable file নেই।');
  $('aw-file-content').value = files.originalContent ?? ''; files.dirty = false;
  updateFileManagerControls(); setFilesStatus('Editor-কে সর্বশেষ load করা content-এ ফিরিয়ে দেওয়া হয়েছে।', 'muted');
}

async function deleteWorkspaceFile() {
  const files = fileManagerState();
  const path = files.selectedPath;
  if (!path) throw new Error('মুছতে আগে একটি file নির্বাচন করুন।');
  if (!window.confirm(`“${path}” স্থায়ীভাবে মুছবেন? এরপর native approval-ও লাগতে পারে।`)) return;
  setFilesStatus(`${path} মুছতে approval অপেক্ষা করছে…`, 'busy');
  await invokeFile('delete_file', { path });
  clearFileEditor(); await refreshFiles(files.directory);
  setFilesStatus(`${path} স্থায়ীভাবে মুছে ফেলা হয়েছে।`, 'ok');
}

function isSupportedTextUpload(file) {
  return TEXT_UPLOAD_EXTENSIONS.test(file.name) || /^text\//.test(file.type) || ['application/json', 'application/xml', 'image/svg+xml'].includes(file.type);
}

async function uploadWorkspaceFiles(list) {
  const selected = [...list].slice(0, 8);
  if (!selected.length) return;
  const rejected = selected.filter((file) => !isSupportedTextUpload(file) || file.size > WORKSPACE_TEXT_LIMIT);
  const accepted = selected.filter((file) => !rejected.includes(file));
  if (rejected.length) toast(`${rejected.map((file) => file.name).join(', ')} text/10 MB limit পূরণ করে না; binary file এই private text workspace-এ upload করা যায় না।`, 'warn');
  for (const file of accepted) {
    const name = baseWorkspaceName(file.name.replace(/\\/g, '/'));
    const path = childWorkspacePath('uploads', name);
    setFilesStatus(`${name} upload হচ্ছে; approval চাইতে পারে…`, 'busy');
    const content = await file.text();
    if (bytes(content) > WORKSPACE_TEXT_LIMIT) throw new Error(`${name} 10 MB UTF-8 limit ছাড়িয়েছে।`);
    await invokeFile('write_file', { path, content, create_only: true });
  }
  await refreshFiles('uploads');
  setFilesStatus(`${accepted.length}টি text file uploads/-এ সংরক্ষিত। চ্যাটে path দিন button দিয়ে Agent-কে পড়তে বলুন।`, 'ok');
}

function insertFilePathIntoChat() {
  const path = fileManagerState().selectedPath;
  if (!path) return;
  showTab('chat');
  const input = $('aw-chat-input');
  const instruction = `workspace-এর ফাইল “${path}” পড়ো এবং সংক্ষেপে বলো।`;
  input.value = input.value ? `${input.value.trim()}\n${instruction}` : instruction;
  input.focus();
}

async function guardFileOperation(operation) {
  requireInit();
  const files = fileManagerState();
  if (files.busy) throw new Error('একটি file operation চলছে—শেষ হওয়া পর্যন্ত অপেক্ষা করুন।');
  files.busy = true; updateFileManagerControls();
  try { return await operation(); }
  catch (error) { setFilesStatus(String(error?.message ?? error), 'err'); throw error; }
  finally { files.busy = false; updateFileManagerControls(); }
}

async function loadPersona() { if (!state.initialized) return; const result = await invokeFile('read_file', { path: state.personaFile, offset_bytes: 0, limit_bytes: 50_000 }); $('aw-persona-editor').value = result?.content ?? ''; $('aw-persona-hint').textContent = PERSONA_HINTS[state.personaFile] || ''; }
async function savePersona() { requireInit(); const content = $('aw-persona-editor').value; if (bytes(content) > 10_000_000) throw new Error('ফাইলটি ১০ MB সীমার বেশি।'); await invokeFile('write_file', { path: state.personaFile, content }); toast(`${state.personaFile} সংরক্ষণ হয়েছে।`, 'ok'); }

async function loadMcpConfigs() { requireInit(); const configs = await window.NativeKit.preferences.getJSON(MCP_PREF_KEY).catch(() => null); state.mcpConfigs = Array.isArray(configs) ? configs : []; renderMcp(); }
async function saveMcpConfigs() { await window.NativeKit.preferences.setJSON(MCP_PREF_KEY, state.mcpConfigs); }
function mcpTokenKey(name) { return `${MCP_TOKEN_PREFIX}${name}`; }
async function connectAllMcp() {
  requireInit(); if (state.mcp) { await state.mcp.dispose(); state.mcp = null; }
  const servers = [];
  for (const config of state.mcpConfigs) {
    const token = await window.NativeKit.secureStorage.get(mcpTokenKey(config.name));
    servers.push({ name: config.name, url: config.url, protocolVersion: config.protocolVersion ?? 'auto', approvalPolicy: config.alwaysAsk === false ? 'always_allow' : 'always_ask', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  }
  state.mcp = await nativeAgent().connectMcp(servers); renderMcp();
  const failures = state.mcp.failures ?? []; toast(failures.length ? `${servers.length - failures.length}টি server যুক্ত হয়েছে; ${failures.length}টি ব্যর্থ।` : `${state.mcp.toolCount}টি MCP tool প্রস্তুত।`, failures.length ? 'warn' : 'ok');
}
function renderMcp() { const root = $('aw-mcp-list'); if (!root) return; root.replaceChildren(); for (const config of state.mcpConfigs) { const row = document.createElement('div'); row.className = 'aw-list-item'; const copy = document.createElement('div'); copy.className = 'aw-list-copy'; const title = document.createElement('strong'); title.textContent = `${config.name} · ${config.protocolVersion ?? 'auto'}`; const failure = state.mcp?.failures?.find((item) => item.server === config.name); const sub = document.createElement('span'); sub.textContent = failure ? `ব্যর্থ: ${safeText(failure.error)}` : `${config.url} · ${config.alwaysAsk === false ? 'always allow' : 'প্রতিবার অনুমতি'}`; copy.append(title, sub); const actions = document.createElement('div'); actions.className = 'aw-list-actions'; const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.className = 'ghost'; reconnect.textContent = 'Reconnect'; reconnect.addEventListener('click', () => void connectAllMcp()); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'aw-danger'; remove.textContent = 'মুছুন'; remove.addEventListener('click', () => void removeMcp(config.name)); actions.append(reconnect, remove); row.append(copy, actions); root.append(row); } }
async function addMcp(event) { event.preventDefault(); requireInit(); const name = clean($('aw-mcp-name').value); const url = clean($('aw-mcp-url').value); if (!uniqueName(name)) throw new Error('Server name-এর শুরু letter হতে হবে; শুধু letter, digit, _ এবং - ব্যবহার করুন।'); let parsed; try { parsed = new URL(url); } catch { throw new Error('সঠিক HTTPS MCP URL দিন।'); } if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Credential-free HTTPS URL ব্যবহার করুন।'); const token = $('aw-mcp-token').value; if (token) await window.NativeKit.secureStorage.set(mcpTokenKey(name), token); const config = { name, url, protocolVersion: $('aw-mcp-protocol').value, alwaysAsk: $('aw-mcp-always-ask').checked }; state.mcpConfigs = [...state.mcpConfigs.filter((entry) => entry.name !== name), config]; await saveMcpConfigs(); event.target.reset(); $('aw-mcp-always-ask').checked = true; await connectAllMcp(); }
async function removeMcp(name) { if (!confirm(`“${name}” MCP server এবং secure token মুছবেন?`)) return; state.mcpConfigs = state.mcpConfigs.filter((config) => config.name !== name); await Promise.all([saveMcpConfigs(), window.NativeKit.secureStorage.remove(mcpTokenKey(name))]); await connectAllMcp(); }

function routerDraftFrom(config) {
  const auto = config?.autoRouting ?? {};
  const order = Array.isArray(auto.providerOrder) && auto.providerOrder.length ? auto.providerOrder.filter((id) => ROUTABLE_PROVIDERS.includes(id)) : [...ROUTABLE_PROVIDERS];
  return { order: [...new Set(order)], models: { ...(config?.defaultModels ?? {}) } };
}
function moveRoute(provider, delta) {
  const draft = state.routerDraft; if (!draft) return;
  const at = draft.order.indexOf(provider); const next = at + delta;
  if (at < 0 || next < 0 || next >= draft.order.length) return;
  [draft.order[at], draft.order[next]] = [draft.order[next], draft.order[at]];
  renderRouter();
}
function renderRouter(config = state.runtimeConfig) {
  const root = $('aw-router-list'); if (!root) return;
  if (!state.routerDraft) state.routerDraft = routerDraftFrom(config ?? {});
  const draft = state.routerDraft; root.replaceChildren();
  const display = [...draft.order, ...ROUTABLE_PROVIDERS.filter((provider) => !draft.order.includes(provider))];
  for (const provider of display) {
    const enabled = draft.order.includes(provider); const index = draft.order.indexOf(provider);
    const row = document.createElement('div'); row.className = `aw-route-row${enabled ? '' : ' disabled'}`;
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = enabled; toggle.title = `${PROVIDER_LABELS[provider]} route enable/disable`;
    toggle.addEventListener('change', () => { if (toggle.checked) draft.order.push(provider); else draft.order = draft.order.filter((item) => item !== provider); renderRouter(); });
    const position = document.createElement('span'); position.className = 'aw-route-position'; position.textContent = enabled ? String(index + 1) : '—';
    const label = document.createElement('strong'); label.textContent = PROVIDER_LABELS[provider] ?? provider;
    const model = document.createElement('input'); model.type = 'text'; model.placeholder = 'catalog default'; model.value = draft.models[provider] ?? ''; model.setAttribute('aria-label', `${provider} default model`);
    model.addEventListener('input', () => { draft.models[provider] = clean(model.value); });
    const up = document.createElement('button'); up.type = 'button'; up.className = 'ghost'; up.textContent = '↑'; up.disabled = !enabled || index === 0; up.title = 'উপরে নিন'; up.addEventListener('click', () => moveRoute(provider, -1));
    const down = document.createElement('button'); down.type = 'button'; down.className = 'ghost'; down.textContent = '↓'; down.disabled = !enabled || index === draft.order.length - 1; down.title = 'নিচে নিন'; down.addEventListener('click', () => moveRoute(provider, 1));
    row.append(toggle, position, label, model, up, down); root.append(row);
  }
  const auto = config?.autoRouting ?? {};
  $('aw-router-failover').checked = draft.failoverOnTransient ?? auto.failoverOnTransient !== false;
  $('aw-router-max-fallbacks').value = draft.maxFallbacks ?? auto.maxFallbacks ?? 3;
  $('aw-router-summary').textContent = draft.order.length
    ? `${draft.order.length}টি route enabled · প্রথম eligible provider-ই আগে চেষ্টা হবে। Model খালি রাখলে verified catalog default ব্যবহার হবে।`
    : 'কোনো route নেই। Auto router ব্যবহার করতে অন্তত একটি provider চালু করুন।';
}
async function checkRouterConfig() {
  requireInit(); const draft = state.routerDraft ?? routerDraftFrom(state.runtimeConfig ?? {});
  if (!draft.order.length) throw new Error('Auto router-এ অন্তত একটি provider চালু করুন।');
  const statuses = await Promise.all(draft.order.map(async (provider) => {
    const model = clean(draft.models[provider]);
    if (provider === 'webllm') return { provider, ready: false, note: 'শুধু foreground WebView/WebGPU; auto background fallback নয়' };
    const auth = await nativeAgent().getAuthStatus(provider).catch(() => null);
    const needsModel = MODEL_REQUIRED_FOR_ROUTE.has(provider) && !model;
    const anonymous = provider === 'aihorde';
    const ready = (Boolean(auth?.hasKey) || anonymous) && !needsModel;
    const modelNote = needsModel ? ' · আগে default model দিন' : (model ? ` · ${model}` : ' · catalog default');
    return { provider, ready, note: auth?.hasKey ? `key আছে${modelNote}` : (anonymous ? `anonymous route${modelNote}` : `key নেই${modelNote}`) };
  }));
  const ready = statuses.filter((item) => item.ready);
  const compact = statuses.map((item) => `${PROVIDER_LABELS[item.provider]}: ${item.note}`).join(' | ');
  $('aw-router-summary').textContent = ready.length
    ? `Config check: ${ready.length}/${statuses.length}টি সম্ভাব্য route প্রস্তুত। এটি কোনো billable LLM call নয়। Live যাচাইয়ের জন্য Auto router বেছে একটি message পাঠান; নিচে চেষ্টা/selected/fallback event দেখা যাবে। ${compact}`
    : `Config check: কোনো eligible route পাওয়া যায়নি। অন্তত প্রথম পছন্দের cloud provider-এর API key সংরক্ষণ করুন। ${compact}`;
  toast(ready.length ? 'Router configuration যাচাই শেষ।' : 'Router-এর জন্য কোনো API key পাওয়া যায়নি।', ready.length ? 'ok' : 'warn');
}
async function runLiveRouterTest() {
  requireInit();
  if (state.running) throw new Error('বর্তমান কাজ শেষ বা থামার পর router test চালান।');
  if (!confirm('এটি নির্বাচিত Auto router দিয়ে একটি ছোট বাস্তব LLM request চালাবে এবং provider usage/billing হতে পারে। চালাবেন?')) return;
  $('aw-provider').value = 'auto'; $('aw-model').value = '';
  $('aw-chat-input').value = 'ROUTER_HEALTHCHECK: কোনো tool ব্যবহার না করে শুধু এক লাইনে ROUTER_OK লিখুন।';
  state.routeEvents = []; const root = $('aw-route-live'); if (root) root.replaceChildren();
  showTab('chat'); await sendMessage();
}

async function saveRouter(event) {
  event.preventDefault(); requireInit(); const draft = state.routerDraft ?? routerDraftFrom(state.runtimeConfig ?? {});
  if (!draft.order.length) throw new Error('Auto router-এ অন্তত একটি provider রাখতে হবে।');
  const models = Object.fromEntries(ROUTABLE_PROVIDERS.map((provider) => [provider, clean(draft.models[provider]) || null]));
  const autoRouting = { providerOrder: draft.order, failoverOnTransient: $('aw-router-failover').checked, maxFallbacks: Number($('aw-router-max-fallbacks').value) };
  state.runtimeConfig = await nativeAgent().setRuntimeConfig({ defaultModels: models, autoRouting });
  state.routerDraft = routerDraftFrom(state.runtimeConfig); renderRouter(); toast('AI Router policy সংরক্ষণ হয়েছে।', 'ok');
}

async function refreshSettings() {
  requireInit(); const config = await nativeAgent().getRuntimeConfig(); state.runtimeConfig = config; state.routerDraft = routerDraftFrom(config);
  $('aw-max-turns').value = config.defaultMaxTurns ?? 25; $('aw-max-tokens').value = config.maxTokens ?? 8192; $('aw-temperature').value = config.temperature ?? 0; $('aw-context-budget').value = config.contextCharBudget ?? 150000;
  // Route choice and key management are intentionally separate: leaving the
  // route untouched means every chat uses native Auto Router.
  const selected = clean($('aw-provider').value) || 'auto'; $('aw-provider').value = selected; $('aw-model-label').textContent = selected === 'auto' ? 'Auto provider' : selected;
  await refreshKeyStatus();
  renderRouter(config);
  const perms = await nativeAgent().listToolPermissions(); renderTools(parseJson(perms?.permissionsJson, []));
}

function renderTools(rows) { const root = $('aw-tool-list'); root.replaceChildren(); for (const row of rows) { const name = row.toolName ?? row.tool_name ?? row.name; if (!name) continue; const item = document.createElement('div'); item.className = 'aw-tool-item'; const code = document.createElement('code'); code.textContent = name; const controls = document.createElement('div'); const select = document.createElement('select'); for (const [value, label] of [['always_allow', 'Allow'], ['always_ask', 'Ask'], ['always_ask_biometric', 'Biometric']]) { const opt = document.createElement('option'); opt.value = value; opt.textContent = label; opt.selected = (row.permission ?? row.policy) === value; select.append(opt); } const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = row.enabled !== false; enabled.title = 'Tool enabled'; enabled.addEventListener('change', () => void saveTool(name, select.value, enabled.checked)); select.addEventListener('change', () => void saveTool(name, select.value, enabled.checked)); controls.append(select, enabled); item.append(code, controls); root.append(item); } }
async function saveTool(name, permission, enabled) { try { await nativeAgent().setToolPermission(name, permission, enabled); toast(`${name} policy সংরক্ষণ হয়েছে।`, 'ok'); } catch (error) { toast(String(error.message ?? error), 'err'); } }
async function seedTools() { requireInit(); await nativeAgent().seedToolPermissions(TOOL_DEFAULTS.map(([toolName, permission]) => ({ toolName, permission, enabled: true }))); toast('নিরাপদ tool defaults যোগ হয়েছে; আগের সিদ্ধান্ত বদলানো হয়নি।', 'ok'); await refreshSettings(); }
async function refreshModels() { requireInit(); const provider = clean($('aw-provider').value); if (provider === 'auto' || provider === 'webllm') { toast('নির্দিষ্ট cloud provider বাছলে তার model catalog আনা যাবে।', 'warn'); return; } const response = await nativeAgent().getModels(provider); const models = parseJson(response?.modelsJson, []); const list = $('aw-model-list'); list.replaceChildren(...models.slice(0, 500).map((model) => { const opt = document.createElement('option'); opt.value = model.id; opt.label = `${model.name ?? model.id}${model.toolCalling === true ? ' · tools' : ''}`; return opt; })); toast(`${models.length}টি model পাওয়া গেছে।`, 'ok'); }
async function refreshKeyStatus() {
  const provider = clean($('aw-key-provider')?.value) || 'anthropic';
  const auth = await nativeAgent().getAuthStatus(provider).catch(() => null);
  $('aw-key-status').textContent = auth?.hasKey
    ? `${PROVIDER_LABELS[provider] ?? provider}: key সংরক্ষিত · ${auth.masked}`
    : `${PROVIDER_LABELS[provider] ?? provider}-এর জন্য এখনো কোনো key সংরক্ষিত নেই।`;
}
async function saveProviderKey() { requireInit(); const provider = clean($('aw-key-provider').value); const key = $('aw-provider-key').value; if (!provider || provider === 'webllm') throw new Error('Key সংরক্ষণের জন্য একটি নির্দিষ্ট provider বাছুন।'); if (!key) throw new Error('API key/token লিখুন।'); await nativeAgent().setAuthKey(key, provider); $('aw-provider-key').value = ''; await refreshKeyStatus(); toast('Key নিরাপদ auth store-এ সংরক্ষণ হয়েছে।', 'ok'); }
async function saveRuntime(event) { event.preventDefault(); requireInit(); const patch = { defaultMaxTurns: Number($('aw-max-turns').value), maxTokens: Number($('aw-max-tokens').value), temperature: Number($('aw-temperature').value), contextCharBudget: Number($('aw-context-budget').value), defaultProvider: clean($('aw-provider').value) || 'auto' }; state.runtimeConfig = await nativeAgent().setRuntimeConfig(patch); toast('Runtime settings সংরক্ষণ হয়েছে।', 'ok'); }

async function guarded(label, task) { try { await task(); } catch (error) { const message = String(error?.message ?? error); toast(message, 'err'); status(`${label}: ${safeText(message)}`, 'err'); } }

function bind() {
  $('aw-start').addEventListener('click', () => void initialize());
  document.querySelectorAll('[data-aw-tab]').forEach((button) => button.addEventListener('click', () => showTab(button.dataset.awTab)));
  document.querySelectorAll('[data-aw-prompt]').forEach((button) => button.addEventListener('click', () => { $('aw-chat-input').value = button.dataset.awPrompt; $('aw-chat-input').focus(); }));
  $('aw-composer').addEventListener('submit', (event) => void guarded('বার্তা', () => sendMessage(event)));
  $('aw-chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('aw-composer').requestSubmit(); } });
  $('aw-abort').addEventListener('click', () => void guarded('থামানো', abortRun)); $('aw-new-chat').addEventListener('click', newChat); $('aw-refresh-sessions').addEventListener('click', () => void guarded('চ্যাট ইতিহাস', refreshSessions));
  $('aw-cron-kind').addEventListener('change', () => { const at = $('aw-cron-kind').value === 'at'; $('aw-at-wrap').hidden = !at; $('aw-every-wrap').hidden = at; });
  $('aw-cron-form').addEventListener('submit', (event) => void guarded('Automation', () => createCron(event))); $('aw-heartbeat-form').addEventListener('submit', (event) => void guarded('Heartbeat', () => saveHeartbeat(event))); $('aw-refresh-automations').addEventListener('click', () => void guarded('Automation', refreshAutomations)); $('aw-schedule-wake').addEventListener('click', () => void guarded('Wake', scheduleWake)); $('aw-cancel-wake').addEventListener('click', () => void guarded('Wake', cancelWake)); $('aw-refresh-inbox').addEventListener('click', () => void guarded('Inbox', refreshAutomations)); $('aw-clear-inbox').addEventListener('click', () => void guarded('Inbox', async () => { await nativeAgent().clearSurfacedMessages(); await refreshAutomations(); }));
  $('aw-skill-form').addEventListener('submit', (event) => void guarded('Skill', () => createSkill(event))); $('aw-refresh-skills').addEventListener('click', () => void guarded('Skills', refreshSkills));
  $('aw-memory-form').addEventListener('submit', (event) => void guarded('মেমোরি', () => storeMemory(event))); $('aw-memory-search-form').addEventListener('submit', (event) => void guarded('মেমোরি খোঁজা', () => searchMemory(event))); $('aw-refresh-memory').addEventListener('click', () => void guarded('মেমোরি', refreshMemory));
  document.querySelectorAll('[data-aw-persona-file]').forEach((button) => button.addEventListener('click', () => { state.personaFile = button.dataset.awPersonaFile; document.querySelectorAll('[data-aw-persona-file]').forEach((node) => node.classList.toggle('active', node === button)); void guarded('Persona file', loadPersona); })); $('aw-load-persona').addEventListener('click', () => void guarded('Persona file', loadPersona)); $('aw-save-persona').addEventListener('click', () => void guarded('Persona save', savePersona)); $('aw-open-file-manager').addEventListener('click', () => showTab('files'));
  $('aw-files-refresh').addEventListener('click', () => void guarded('Files', () => guardFileOperation(refreshFiles)));
  $('aw-files-open-dir').addEventListener('click', () => void guarded('Files', () => guardFileOperation(() => openWorkspaceDirectory($('aw-files-dir').value))));
  $('aw-files-up').addEventListener('click', () => void guarded('Files', () => guardFileOperation(() => openWorkspaceDirectory(parentWorkspacePath(fileManagerState().directory)))));
  $('aw-files-open-uploads').addEventListener('click', () => void guarded('Files', () => guardFileOperation(() => openWorkspaceDirectory('uploads'))));
  $('aw-files-find').addEventListener('click', () => void guarded('Files', () => guardFileOperation(searchWorkspaceFiles)));
  $('aw-files-new').addEventListener('click', () => void guarded('Files', () => guardFileOperation(createWorkspaceFile)));
  $('aw-files-choose').addEventListener('click', () => $('aw-files-picker').click());
  $('aw-files-picker').addEventListener('change', (event) => { const list = event.target.files; event.target.value = ''; void guarded('Upload', () => guardFileOperation(() => uploadWorkspaceFiles(list))); }); $('aw-files-include-skipped').addEventListener('change', () => void guarded('Files', () => guardFileOperation(refreshFiles))); $('aw-files-dir').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('aw-files-open-dir').click(); } }); $('aw-files-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('aw-files-find').click(); } }); $('aw-file-name').addEventListener('input', updateWorkspaceFileDraft); $('aw-file-content').addEventListener('input', updateWorkspaceFileDraft); $('aw-file-save').addEventListener('click', () => void guarded('File save', () => guardFileOperation(saveWorkspaceFile))); $('aw-file-revert').addEventListener('click', () => void guarded('File revert', revertWorkspaceFile)); $('aw-file-delete').addEventListener('click', () => void guarded('File delete', () => guardFileOperation(deleteWorkspaceFile))); $('aw-file-insert-chat').addEventListener('click', insertFilePathIntoChat);
  $('aw-mcp-form').addEventListener('submit', (event) => void guarded('MCP', () => addMcp(event))); $('aw-reconnect-mcp').addEventListener('click', () => void guarded('MCP', connectAllMcp));
  $('aw-load-settings').addEventListener('click', () => void guarded('Settings', refreshSettings)); $('aw-provider').addEventListener('change', () => { $('aw-model-label').textContent = $('aw-provider').value === 'auto' ? 'Auto provider' : $('aw-provider').value; }); $('aw-key-provider').addEventListener('change', () => void guarded('Key status', refreshKeyStatus)); $('aw-router-form').addEventListener('submit', (event) => void guarded('AI Router', () => saveRouter(event))); $('aw-router-check').addEventListener('click', () => void guarded('AI Router', checkRouterConfig)); $('aw-router-live-test').addEventListener('click', () => void guarded('AI Router live test', runLiveRouterTest)); $('aw-router-refresh').addEventListener('click', () => void guarded('AI Router', refreshSettings)); $('aw-refresh-models').addEventListener('click', () => void guarded('Model catalog', refreshModels)); $('aw-save-key').addEventListener('click', () => void guarded('API key', saveProviderKey)); $('aw-runtime-form').addEventListener('submit', (event) => void guarded('Runtime settings', () => saveRuntime(event))); $('aw-seed-tools').addEventListener('click', () => void guarded('Tool defaults', seedTools)); $('aw-refresh-tools').addEventListener('click', () => void guarded('Tools', refreshSettings));
}

function start() {
  if (!$('agent-workspace')) return;
  bind();
  setComposerAvailability(false);
  updateFileManagerControls();
  if (!featureReady()) {
    status('Web preview-এ agent চলে না; Android/iOS build-এ ব্যবহার করুন।', 'warn');
    $('aw-start').disabled = true;
    return;
  }
  // Native initialization is automatic; the visible button remains a retry
  // control if availability or initialization fails.
  void initialize();
}

export { start as wireAgentWorkspace };
