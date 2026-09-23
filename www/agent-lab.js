// ── AGENT LAB ────────────────────────────────────────────────────────────────
// On-device Rust AI agent (NativeKit.agent) — every public API gets a button.
// Results go to the shared Host Event Log via window.nativeKitDemoLog.
//
// Order matters for a real run:
//   1) Availability  → is the native lib loadable on this device ABI?
//   2) Initialize    → creates SQLite store + workspace + auth profile store
//   3) Set auth key  → without it, sendMessage will fail at the provider
//   4) Listen        → wire the event stream BEFORE sending a turn
//   5) everything else
const log = (label, value) => window.nativeKitDemoLog(label, value);

// ── Lab state ────────────────────────────────────────────────────────────────
const state = {
  initialized: false,
  listening: false,
  sessionKey: `demo-${Date.now()}`,
  lastRunId: null,
  lastToolCallId: null,
  lastCronJobId: null,
  lastSkillId: null,
  streamed: '',
};

const el = (id) => document.getElementById(id);
const val = (id, fallback = '') => (el(id)?.value ?? fallback).trim();

function setStatus(text, tone = 'muted') {
  const node = el('agent-status');
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function requireInit() {
  if (!state.initialized) {
    throw new Error('আগে "Initialize" চাপুন — engine চালু না হলে কোনো API কাজ করবে না।');
  }
}

// ── Event stream ─────────────────────────────────────────────────────────────
// The engine emits raw FFI events: streaming text, tool calls, approval
// requests, cron results, errors. This is the heart of the integration.
async function wireEvents() {
  if (state.listening) return { wired: true, note: 'আগেই wired ছিল।' };
  await window.NativeKit.agent.onEvent((event) => {
    let payload = event.payloadJson;
    try { payload = JSON.parse(event.payloadJson); } catch { /* keep raw */ }

    switch (event.eventType) {
      case 'text_delta':
      case 'assistant_delta': {
        state.streamed += payload?.text ?? payload?.delta ?? '';
        const out = el('agent-stream');
        if (out) out.textContent = state.streamed;
        return; // too chatty for the log
      }
      // The engine emits `approval_request` (not `tool_approval_request`),
      // `agent.completed` (not `turn_complete`/`run_complete`) and
      // `agent.error` (not `error`). The old names never matched a single
      // event, so the approval and completion UI never fired.
      case 'approval_request': {
        // Human-in-the-loop: the agent wants to run a tool and is waiting.
        state.lastToolCallId = payload?.toolCallId ?? payload?.tool_call_id ?? null;
        setStatus(`Tool approval চাইছে: ${payload?.toolName ?? payload?.tool_name ?? '?'}`, 'warn');
        break;
      }
      case 'cron_approval_request': {
        state.lastCronRequestId = payload?.requestId ?? payload?.request_id ?? null;
        break;
      }
      case 'agent.completed': {
        // Terminal: releases the re-entrancy guard in agentsend.
        state.turnRunning = false;
        setStatus('Turn শেষ।', 'ok');
        break;
      }
      case 'max_turns_reached': {
        setStatus(`Turn limit ছুঁয়ে গেছে (${payload?.turns ?? '?'})।`, 'warn');
        break;
      }
      case 'agent.background_timeout': {
        state.turnRunning = false;
        setStatus('Background turn সময়সীমা পেরিয়েছে।', 'warn');
        break;
      }
      case 'retry': {
        setStatus(`Retry হচ্ছে (${payload?.attempt ?? '?'})…`, 'warn');
        break;
      }
      case 'cron.job.completed': {
        setStatus(`Cron job শেষ: ${payload?.jobId ?? '?'}${payload?.deduped ? ' (duplicate — পাঠানো হয়নি)' : ''}`, 'ok');
        break;
      }
      case 'cron.job.error': {
        setStatus(`Cron job ব্যর্থ: ${payload?.error ?? 'unknown'}`, 'err');
        break;
      }
      case 'heartbeat.completed': {
        setStatus('Heartbeat চলল।', 'ok');
        break;
      }
      case 'wake.skipped': {
        setStatus(`Wake বাদ: ${payload?.reason ?? 'unknown'}`, 'warn');
        break;
      }
      case 'agent.error': {
        state.turnRunning = false;
        setStatus(`Error: ${payload?.error ?? payload?.message ?? 'unknown'}`, 'err');
        break;
      }
    }
    log(`agent.${event.eventType}`, payload);
  });
  state.listening = true;
  return { wired: true, hint: 'সব agent event এখন log-এ আসবে।' };
}

// ── Actions ──────────────────────────────────────────────────────────────────
const agentActions = {
  // 1 ── Diagnostics ─────────────────────────────────────────────────────────
  agentavail: async () => {
    // Never rejects. On an ABI without a shipped .so this returns
    // { available: false } instead of crashing the app.
    const res = await window.NativeKit.agent.checkAvailability();
    setStatus(
      res.available ? `Supported (${res.abi})` : `Unsupported: ${res.reason}`,
      res.available ? 'ok' : 'err',
    );
    return res;
  },

  // 2 ── Lifecycle ───────────────────────────────────────────────────────────
  agentinitworkspace: async () => window.NativeKit.agent.initWorkspace({
    dbPath: 'files://agent/agent.db',
    workspacePath: 'files://agent/workspace',
    authProfilesPath: 'files://agent/auth-profiles.json',
  }),

  agentinit: async () => {
    const probe = await window.NativeKit.agent.checkAvailability();
    if (!probe.available) {
      setStatus(`এই device-এ agent চলবে না (${probe.abi})`, 'err');
      return { skipped: true, reason: probe.reason };
    }
    const res = await window.NativeKit.agent.initialize({
      dbPath: 'files://agent/agent.db',
      workspacePath: 'files://agent/workspace',
      authProfilesPath: 'files://agent/auth-profiles.json',
      defaultProvider: val('agent-provider', 'anthropic') || 'anthropic',
      defaultModel: val('agent-model') || undefined,
    });
    state.initialized = true;
    setStatus('Engine চালু — এখন auth key দিন।', 'ok');
    await wireEvents();
    return res ?? { initialized: true, sessionKey: state.sessionKey };
  },

  // 3 ── Auth ────────────────────────────────────────────────────────────────
  agentsetauth: async () => {
    requireInit();
    const key = val('agent-key');
    if (!key) throw new Error('API key ফিল্ডটি খালি — Anthropic/OpenAI key দিন।');
    await window.NativeKit.agent.setAuthKey(key, val('agent-provider', 'anthropic') || 'anthropic');
    setStatus('Key সংরক্ষিত।', 'ok');
    return window.NativeKit.agent.getAuthStatus(val('agent-provider', 'anthropic') || 'anthropic');
  },
  agentauthstatus: async () => { requireInit(); return window.NativeKit.agent.getAuthStatus(val('agent-provider', 'anthropic') || 'anthropic'); },
  agentauthtoken: async () => { requireInit(); return window.NativeKit.agent.getAuthToken(val('agent-provider', 'anthropic') || 'anthropic'); },
  agentrefreshtoken: async () => { requireInit(); return window.NativeKit.agent.refreshToken(val('agent-provider', 'anthropic') || 'anthropic'); },
  agentdeleteauth: async () => { requireInit(); await window.NativeKit.agent.deleteAuth(val('agent-provider', 'anthropic') || 'anthropic'); return { deleted: true }; },
  agentoauth: async () => {
    requireInit();
    // Demonstrates the OAuth code-exchange helper (needs a real token URL/body).
    return window.NativeKit.agent.exchangeOAuthCode(
      val('agent-oauth-url', 'https://example.com/token'),
      JSON.stringify({ grant_type: 'authorization_code', code: 'demo-code' }),
      'application/json',
    );
  },

  // 4 ── Events ──────────────────────────────────────────────────────────────
  agentlisten: async () => { requireInit(); return wireEvents(); },

  // 5 ── Agent turns ─────────────────────────────────────────────────────────
  agentsend: async () => {
    requireInit();
    // The engine now refuses a second concurrent turn (two overlapping turns
    // both branched from the same history, and the slower one silently
    // discarded the other's messages). Catch the double-click here so the user
    // gets a clear message instead of an engine error.
    if (state.turnRunning) {
      throw new Error('একটি turn এখনো চলছে — শেষ হওয়া পর্যন্ত অপেক্ষা করুন, বা Abort চাপুন।');
    }
    state.turnRunning = true;
    state.streamed = '';
    const out = el('agent-stream');
    if (out) out.textContent = '';
    setStatus('Turn চলছে…', 'busy');
    try {
    const res = await window.NativeKit.agent.sendMessage({
      prompt: val('agent-prompt') || 'Say hello in Bangla, one short sentence.',
      sessionKey: state.sessionKey,
      systemPrompt: val('agent-system') || undefined,
      provider: val('agent-provider') || undefined,
      model: val('agent-model') || undefined,
    });
    state.lastRunId = res?.runId ?? null;
    return res;
    } catch (err) {
      // sendMessage only STARTS the turn; agent.completed/agent.error clear the
      // flag. If the start itself failed, no events are coming — clear it here.
      state.turnRunning = false;
      throw err;
    }
  },
  agentfollowup: async () => { requireInit(); await window.NativeKit.agent.followUp(val('agent-prompt') || 'আরেকটু বিস্তারিত বলো।'); return { sent: true }; },
  agentsteer: async () => { requireInit(); await window.NativeKit.agent.steer(val('agent-prompt') || 'সংক্ষেপে বলো।'); return { steered: true }; },
  agentabort: async () => {
    requireInit();
    await window.NativeKit.agent.abort();
    // The engine unwinds asynchronously, but the user has signalled they are
    // done with this turn — release the UI guard so Send works again.
    state.turnRunning = false;
    setStatus('Turn বাতিল।', 'muted');
    return { aborted: true };
  },

  // 6 ── Approval gate ───────────────────────────────────────────────────────
  agentapprove: async () => {
    requireInit();
    if (!state.lastToolCallId) throw new Error('কোনো pending tool approval নেই — আগে এমন prompt দিন যাতে agent tool চালাতে চায়।');
    await window.NativeKit.agent.respondToApproval(state.lastToolCallId, true);
    const id = state.lastToolCallId; state.lastToolCallId = null;
    return { approved: id };
  },
  agentdeny: async () => {
    requireInit();
    if (!state.lastToolCallId) throw new Error('কোনো pending tool approval নেই।');
    await window.NativeKit.agent.respondToApproval(state.lastToolCallId, false, 'User denied from demo lab');
    const id = state.lastToolCallId; state.lastToolCallId = null;
    return { denied: id };
  },
  agentmcpresult: async () => {
    requireInit();
    if (!state.lastToolCallId) throw new Error('কোনো pending MCP tool call নেই।');
    await window.NativeKit.agent.respondToMcpTool(state.lastToolCallId, JSON.stringify({ ok: true, from: 'demo lab' }), false);
    return { responded: state.lastToolCallId };
  },
  agentcronapprove: async () => {
    requireInit();
    if (!state.lastCronRequestId) throw new Error('কোনো pending cron approval নেই।');
    await window.NativeKit.agent.respondToCronApproval(state.lastCronRequestId, true);
    return { approved: state.lastCronRequestId };
  },

  // 7 ── Sessions ────────────────────────────────────────────────────────────
  agentlistsessions: async () => { requireInit(); return window.NativeKit.agent.listSessions('main'); },
  agentloadsession: async () => { requireInit(); return window.NativeKit.agent.loadSession(state.sessionKey); },
  agentresume: async () => {
    requireInit();
    // Returns { wasInterrupted } — was broken on iOS before the audit fix.
    return window.NativeKit.agent.resumeSession({ sessionKey: state.sessionKey, agentId: 'main' });
  },
  agentnewsession: async () => {
    requireInit();
    state.sessionKey = `demo-${Date.now()}`;
    return { sessionKey: state.sessionKey };
  },
  agentclearsession: async () => { requireInit(); await window.NativeKit.agent.clearSession(); return { cleared: true }; },

  // 8 ── Cron / heartbeat ────────────────────────────────────────────────────
  agentaddcron: async () => {
    requireInit();
    const res = await window.NativeKit.agent.addCronJob(JSON.stringify({
      name: 'Demo hourly check',
      schedule: '0 * * * *',
      prompt: 'Summarize anything new since the last run.',
      enabled: true,
    }));
    try { state.lastCronJobId = JSON.parse(res.recordJson)?.id ?? null; } catch { /* ignore */ }
    return res;
  },
  agentlistcron: async () => { requireInit(); return window.NativeKit.agent.listCronJobs(); },
  agentupdatecron: async () => {
    requireInit();
    if (!state.lastCronJobId) throw new Error('আগে "Add cron job" চাপুন।');
    await window.NativeKit.agent.updateCronJob(state.lastCronJobId, JSON.stringify({ enabled: false }));
    return { updated: state.lastCronJobId, enabled: false };
  },
  agentruncron: async () => {
    requireInit();
    if (!state.lastCronJobId) throw new Error('আগে "Add cron job" চাপুন।');
    await window.NativeKit.agent.runCronJob(state.lastCronJobId);
    return { triggered: state.lastCronJobId };
  },
  agentlistcronruns: async () => { requireInit(); return window.NativeKit.agent.listCronRuns(undefined, 20); },
  agentremovecron: async () => {
    requireInit();
    if (!state.lastCronJobId) throw new Error('আগে "Add cron job" চাপুন।');
    await window.NativeKit.agent.removeCronJob(state.lastCronJobId);
    const id = state.lastCronJobId; state.lastCronJobId = null;
    return { removed: id };
  },
  // Foreground catch-up: runs every due cron job now and surfaces the results,
  // exactly like an OS wake — so "Wake now" and a real background wake end up in
  // the same inbox (loadSurfacedMessages).
  agentwake: async () => {
    requireInit();
    const res = await window.NativeKit.agent.handleWake('manual_demo');
    setStatus(res?.ran ? `${res.ran}টি job চলল (${res.summary})` : `হয়েছে: ${res?.summary ?? 'no due job'}`, 'ok');
    return res ?? { ran: 0 };
  },
  agentgetsched: async () => { requireInit(); return window.NativeKit.agent.getSchedulerConfig(); },
  agentsetsched: async () => { requireInit(); await window.NativeKit.agent.setSchedulerConfig(JSON.stringify({ enabled: true, schedulingMode: 'adaptive' })); return { schedulerUpdated: true }; },
  agentsetheartbeat: async () => { requireInit(); await window.NativeKit.agent.setHeartbeatConfig(JSON.stringify({ enabled: true, everyMs: 3600000, prompt: 'Check HEARTBEAT.md and report only what changed.' })); return { heartbeatUpdated: true }; },

  // 9 ── Background wakes (real OS scheduling) ──────────────────────────────
  // Android: Android WorkManager starts the worker even when the app process is
  // gone. iOS: a BGProcessingTask the system runs when it decides to — that is
  // why the answer carries `intervalMinutes` as granted (Android floors at 15)
  // and `opportunistic: true` on iOS.
  agentbgschedule: async () => {
    requireInit();
    // Never rejects: a refusal comes back as jobScheduled:false + reason.
    const res = await window.NativeKit.agent.scheduleBackgroundWakes(30);
    setStatus(res.jobScheduled ? `Background wake armed — ${res.mechanism}, প্রতি ${res.intervalMinutes} মিনিট` : `Schedule হয়নি: ${res.reason}`, res.jobScheduled ? 'ok' : 'warn');
    return res;
  },
  agentbgcancel: async () => {
    requireInit();
    const res = await window.NativeKit.agent.cancelBackgroundWakes();
    setStatus(res.jobCancelled ? 'Background wake বাতিল।' : `বাতিল করা যায়নি: ${res.reason ?? 'unknown'}`, res.jobCancelled ? 'ok' : 'warn');
    return res;
  },
  agentwakes: async () => {
    requireInit();
    const res = await window.NativeKit.agent.getWakeStatus();
    setStatus(res.jobScheduled ? `Wake armed (${res.workState ?? 'pending'})${res.nextRunApproxMs ? `, next ≈ ${new Date(res.nextRunApproxMs).toLocaleTimeString()}` : ''}` : `Wake armed নয়${res.lastWakeAt ? ` — শেষ wake ${res.lastWakeAt}` : ''}`, res.jobScheduled ? 'ok' : 'warn');
    return res;
  },

  // 9a ── Surfaced messages: what the agent produced while the UI was closed.
  // The plugin fills this from the engine's own cron_runs rows (plus the
  // notifications posted during a wake), so a background job's answer is still
  // readable on the next launch.
  agentsurfaced: async () => {
    requireInit();
    const res = await window.NativeKit.agent.loadSurfacedMessages(20);
    setStatus(res.count ? `${res.count}টি message (${res.unread} unread)` : 'এখনো কোনো surfaced message নেই — আগে একটি cron job যোগ করে wake চালান।', res.count ? 'ok' : 'muted');
    return res;
  },
  agentclearsurfaced: async () => {
    requireInit();
    const res = await window.NativeKit.agent.clearSurfacedMessages();
    setStatus(`${res.cleared}টি message মুছে ফেলা হয়েছে।`, 'ok');
    return res;
  },

  // 9b ── Long-term memory (built into the plugin, see MemoryProviderImpl) ────
  // These call the agent's own memory tools directly, which is exactly what the
  // model sees: memory_store / memory_recall / memory_list / memory_forget.
  agentmemstore: async () => {
    requireInit();
    return window.NativeKit.agent.invokeTool('memory_store', JSON.stringify({
      key: 'demo-language',
      text: 'The user prefers answers in Bangla and works on a Capacitor shell called NativeKit.',
      category: 'user-preference',
    }));
  },
  agentmemrecall: async () => {
    requireInit();
    return window.NativeKit.agent.invokeTool('memory_recall', JSON.stringify({ query: 'Bangla preference', limit: 3 }));
  },
  agentmemlist: async () => { requireInit(); return window.NativeKit.agent.invokeTool('memory_list', JSON.stringify({ prefix: '' })); },
  agentmemforget: async () => {
    requireInit();
    return window.NativeKit.agent.invokeTool('memory_forget', JSON.stringify({ query: 'Bangla preference' }));
  },

  // 10 ── Skills ─────────────────────────────────────────────────────────────
  agentaddskill: async () => {
    requireInit();
    const res = await window.NativeKit.agent.addSkill(JSON.stringify({
      name: 'Demo summarizer',
      prompt: 'You summarize text in Bangla, 2 sentences max.',
      allowedTools: [],
    }));
    try { state.lastSkillId = JSON.parse(res.recordJson)?.id ?? null; } catch { /* ignore */ }
    return res;
  },
  agentlistskills: async () => { requireInit(); return window.NativeKit.agent.listSkills(); },
  agentupdateskill: async () => {
    requireInit();
    if (!state.lastSkillId) throw new Error('আগে "Add skill" চাপুন।');
    await window.NativeKit.agent.updateSkill(state.lastSkillId, JSON.stringify({ name: 'Demo summarizer v2' }));
    return { updated: state.lastSkillId };
  },
  agentstartskill: async () => {
    requireInit();
    if (!state.lastSkillId) throw new Error('আগে "Add skill" চাপুন।');
    return window.NativeKit.agent.startSkill(state.lastSkillId);
  },
  agentendskill: async () => {
    requireInit();
    if (!state.lastSkillId) throw new Error('আগে "Add skill" চাপুন।');
    await window.NativeKit.agent.endSkill(state.lastSkillId);
    return { ended: state.lastSkillId };
  },
  agentremoveskill: async () => {
    requireInit();
    if (!state.lastSkillId) throw new Error('আগে "Add skill" চাপুন।');
    await window.NativeKit.agent.removeSkill(state.lastSkillId);
    const id = state.lastSkillId; state.lastSkillId = null;
    return { removed: id };
  },

  // 11 ── Tool permissions ───────────────────────────────────────────────────
  agentseedperms: async () => {
    requireInit();
    return window.NativeKit.agent.seedToolPermissions(JSON.stringify([
      { toolName: 'read_file', permission: 'always_allow', enabled: true },
      { toolName: 'write_file', permission: 'always_ask', enabled: true },
      { toolName: 'execute_command', permission: 'always_ask', enabled: true },
    ]));
  },
  agentlistperms: async () => { requireInit(); return window.NativeKit.agent.listToolPermissions(); },
  agentsetperm: async () => { requireInit(); await window.NativeKit.agent.setToolPermission('write_file', 'always_ask', true); return { toolName: 'write_file', permission: 'always_ask' }; },
  agentresetperms: async () => { requireInit(); await window.NativeKit.agent.resetToolPermissions(); return { reset: true }; },

  // 12 ── MCP ────────────────────────────────────────────────────────────────
  agentstartmcp: async () => { requireInit(); return window.NativeKit.agent.startMcp(JSON.stringify([])); },
  agentsetmcptools: async () => {
    requireInit();
    return window.NativeKit.agent.setMcpTools(JSON.stringify([
      { name: 'demo_echo', description: 'Echo back the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ]));
  },
  agentrestartmcp: async () => { requireInit(); return window.NativeKit.agent.restartMcp(JSON.stringify([])); },

  // 13 ── Models & tools ─────────────────────────────────────────────────────
  agentmodels: async () => { requireInit(); return window.NativeKit.agent.getModels(val('agent-provider', 'anthropic') || 'anthropic'); },
  agentinvoketool: async () => { requireInit(); return window.NativeKit.agent.invokeTool('list_files', JSON.stringify({ path: '.' })); },
};

// ── Wiring ───────────────────────────────────────────────────────────────────
// Reuses the shell's execute() contract: disable button, run, log result/error.
function wireAgentButtons(execute) {
  document.querySelectorAll('[data-agent-action]').forEach((button) => {
    const name = button.dataset.agentAction;
    button.addEventListener('click', () => execute(`agent.${name}`, agentActions[name], button));
  });

  const supported = window.NativeKit?.agent?.supported?.() ?? false;
  if (!supported) {
    setStatus('Web/preview-এ agent চলে না — Android/iOS build-এ চালান।', 'warn');
    document.querySelectorAll('[data-agent-action]').forEach((b) => { b.disabled = true; });
  } else {
    setStatus('প্রস্তুত — "Check availability" দিয়ে শুরু করুন।', 'muted');
  }
}

export { agentActions, wireAgentButtons };
