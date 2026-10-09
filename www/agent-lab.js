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
  // MCP tool calls need their OWN id. Reusing lastToolCallId (set only by
  // approval_request) meant the MCP button either threw "no pending call" or
  // answered an unrelated approval id.
  lastMcpCall: null,
  // Live MCP client connection, so it can be disposed before reconnecting.
  mcp: null,
  lastCronJobId: null,
  lastSkillId: null,
  streamed: '',
  providerCatalog: [],
  catalogProvider: 'anthropic',
  runtimeConfig: null,
  pendingApproval: null,
  fileManager: {
    currentDir: '.',
    mode: 'directory',
    entries: [],
    truncated: false,
    selectedPath: null,
    originalContent: null,
    originalBytes: 0,
    isNew: false,
    dirty: false,
    editable: false,
    busy: false,
    pendingDelete: null,
  },
};

const el = (id) => document.getElementById(id);
const val = (id, fallback = '') => (el(id)?.value ?? fallback).trim();


// WebLLM is intentionally a WebView-side adapter: WebGPU is exposed to the
// JavaScript runtime, not to native Rust. The native driver asks for one
// request through `provider.request`; this handler returns typed stream deltas
// and the final OpenAI-shaped completion through a dedicated native callback.
const WEBLLM_CDN = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm';
let webLlmModulePromise = null;
let webLlmEngine = null;
let webLlmEngineModel = null;
let webLlmLoadPromise = null;

async function getWebLlmEngine(model, requestId) {
  if (!globalThis.navigator?.gpu) {
    throw new Error('এই WebView-এ WebGPU নেই; WebLLM শুধু WebGPU-সক্ষম foreground WebView-এ চলে।');
  }
  if (webLlmEngine && webLlmEngineModel === model) return webLlmEngine;
  if (webLlmLoadPromise) await webLlmLoadPromise;
  if (webLlmEngine && webLlmEngineModel === model) return webLlmEngine;

  webLlmLoadPromise = (async () => {
    webLlmModulePromise ??= import(/* @vite-ignore */ WEBLLM_CDN);
    const module = await webLlmModulePromise;
    if (typeof module.CreateMLCEngine !== 'function') {
      throw new Error('WebLLM module-এ CreateMLCEngine পাওয়া যায়নি।');
    }
    webLlmEngine = await module.CreateMLCEngine(model, {
      initProgressCallback: (progress) => {
        const text = String(progress?.text ?? 'WebLLM model প্রস্তুত হচ্ছে…').slice(0, 160);
        setStatus(text, 'busy');
        const serialized = JSON.stringify({ type: 'thinking_delta', text: '' });
        void serialized; // Loading status stays in the WebView, not model output.
      },
    });
    webLlmEngineModel = model;
  })();
  try {
    await webLlmLoadPromise;
    return webLlmEngine;
  } finally {
    webLlmLoadPromise = null;
  }
}

async function handleWebLlmProviderRequest(payload) {
  const requestId = String(payload?.requestId ?? '');
  const model = String(payload?.model ?? '');
  if (!requestId || !model || !payload?.request) return;
  const sendBridge = (value, isFinal = false, isError = false) =>
    window.NativeKit.agent.respondToProviderRequest(requestId, JSON.stringify(value), isFinal, isError);
  try {
    const engine = await getWebLlmEngine(model, requestId);
    const request = { ...payload.request, model, stream: true };
    const stream = await engine.chat.completions.create(request);
    let text = '';
    const calls = new Map();
    let lastFlush = 0;
    let textBuffer = '';
    const flushText = async (force = false) => {
      if (!textBuffer || (!force && performance.now() - lastFlush < 45)) return;
      const piece = textBuffer;
      textBuffer = '';
      lastFlush = performance.now();
      await sendBridge({ type: 'text_delta', text: piece });
    };

    for await (const chunk of stream) {
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        textBuffer += delta.content;
        await flushText();
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        // Keep reasoning hidden by default; native event consumers may opt in.
        await sendBridge({ type: 'thinking_delta', text: delta.reasoning_content });
      }
      const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const part of toolDeltas) {
        const index = Number.isInteger(part?.index) ? part.index : calls.size;
        let call = calls.get(index);
        if (!call) {
          call = { id: '', name: '', arguments: '' };
          calls.set(index, call);
        }
        if (typeof part?.id === 'string' && part.id) call.id = part.id;
        if (typeof part?.function?.name === 'string') call.name += part.function.name;
        if (typeof part?.function?.arguments === 'string') call.arguments += part.function.arguments;
      }
    }
    await flushText(true);

    const toolCalls = [];
    for (const [index, call] of calls.entries()) {
      const id = call.id || `webllm_${requestId}_${index}`;
      const name = call.name;
      if (!name) throw new Error(`WebLLM tool call ${index} did not include a function name.`);
      let args;
      try { args = JSON.parse(call.arguments || '{}'); }
      catch (error) { throw new Error(`WebLLM returned invalid JSON arguments for '${name}': ${error.message}`); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`WebLLM arguments for '${name}' must be a JSON object.`);
      }
      await sendBridge({ type: 'tool_use_start', id, name });
      await sendBridge({ type: 'tool_use_end', id, name, input: args });
      toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    }

    const completion = {
      id: `chatcmpl-webllm-${requestId}`,
      object: 'chat.completion',
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    await sendBridge(completion, true, false);
    setStatus(`WebLLM local response · ${model}`, 'ok');
  } catch (error) {
    const message = String(error?.message ?? error ?? 'WebLLM request failed').slice(0, 1_500);
    try { await sendBridge({ error: message }, true, true); }
    catch (replyError) { log('agent.webllm.reply-error', String(replyError?.message ?? replyError)); }
    setStatus(`WebLLM ব্যর্থ: ${message.slice(0, 110)}`, 'err');
  }
}

function setStatus(text, tone = 'muted') {
  const node = el('agent-status');
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function requireInit() {
  // The owner-facing workspace and this developer Lab share ONE native handle.
  // Do not make a second initialize() call merely because the Lab was opened
  // after the workspace; replacing the handle could interrupt a live turn.
  if (!state.initialized && globalThis.__nativeKitAgentInitialized) {
    state.initialized = true;
  }
  if (!state.initialized) {
    throw new Error('আগে "Initialize" চাপুন — engine চালু না হলে কোনো API কাজ করবে না।');
  }
}

function setFileStatus(text, tone = 'muted') {
  const node = el('agent-files-status');
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function normalizeWorkspacePath(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/');
  if (!raw || raw === '.') return '.';
  if (raw.startsWith('/') || (raw.length >= 2 && /^[A-Za-z]:/.test(raw))) {
    throw new Error('শুধু workspace-relative path ব্যবহার করুন; absolute path গ্রহণ করা হয় না।');
  }
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Path-এ .. ব্যবহার করা যাবে না।');
  }
  const safeParts = parts.filter((part) => part !== '.');
  return safeParts.length ? safeParts.join('/') : '.';
}

function childWorkspacePath(parent, name) {
  return parent && parent !== '.' ? `${parent}/${name}` : name;
}

function parentWorkspacePath(path) {
  const parts = normalizeWorkspacePath(path).split('/').filter((part) => part && part !== '.');
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function baseWorkspaceName(path) {
  const normalized = normalizeWorkspacePath(path);
  return normalized.split('/').filter(Boolean).at(-1) ?? '';
}

function humanFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return 'size অজানা';
  if (size < 1_000) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size;
  let unit = 'B';
  for (const next of units) {
    value /= 1_000;
    unit = next;
    if (value < 1_000 || next === units.at(-1)) break;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function safeApprovalArgs(toolName, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  // Normalise snake_case, camelCase and punctuation so api_key, apiKey,
  // access_token and similar spellings all receive the same treatment.
  const privateFields = new Set([
    'content', 'oldtext', 'newtext', 'body', 'prompt', 'text', 'key', 'token',
    'apikey', 'accesstoken', 'refreshtoken', 'authorization', 'headers', 'metadata',
    'command', 'clientsecret', 'secret', 'password', 'credential', 'cookie',
  ]);
  const privateFieldPattern = /^(?:(?:api|access|refresh|auth|bearer|client|private|session)(?:key|token)|(?:api|client|db|app)?secret(?:key)?|password|credentials?|authorization|setcookie)$/;
  const safe = {};
  for (const [key, value] of Object.entries(args)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (privateFields.has(normalizedKey) || privateFieldPattern.test(normalizedKey)) {
      const size = typeof value === 'string' ? new TextEncoder().encode(value).byteLength : JSON.stringify(value ?? null).length;
      safe[key] = `[গোপন রাখা হয়েছে · ${size} bytes]`;
    } else if (typeof value === 'string' && value.length > 240) {
      safe[key] = `${value.slice(0, 240)}… [${value.length} characters]`;
    } else if (Array.isArray(value)) {
      safe[key] = `[${value.length} items]`;
    } else if (value && typeof value === 'object') {
      safe[key] = `[object · ${Object.keys(value).length} keys]`;
    } else {
      safe[key] = value;
    }
  }
  if (toolName === 'write_file' && typeof args.content === 'string') {
    safe.content = `[${new TextEncoder().encode(args.content).byteLength} UTF-8 bytes; content not logged]`;
  }
  return safe;
}

const FILE_RESULT_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_files',
  'find_files', 'grep_files', 'git_diff',
]);

function summarizeFileToolResult(toolName, payload) {
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
  const raw = typeof result.content === 'string' ? result.content : '';
  let data = null;
  try { data = JSON.parse(raw); } catch { /* non-JSON tool errors are summarized by size */ }
  const summary = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of [
      'path', 'success', 'created', 'deletedBytes', 'fileBytes', 'modifiedMs',
      'offsetBytes', 'nextOffsetBytes', 'truncated', 'replacements', 'returned',
      'error', 'exitCode', 'timedOut',
    ]) {
      const value = data[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        summary[key] = typeof value === 'string' ? value.slice(0, 300) : value;
      }
    }
    if (typeof data.content === 'string') {
      summary.content = `[${new TextEncoder().encode(data.content).byteLength} UTF-8 bytes; file content not logged]`;
    }
    for (const key of ['entries', 'files', 'matches', 'changes']) {
      if (Array.isArray(data[key])) summary[`${key}Count`] = data[key].length;
    }
    if (Array.isArray(data.entries)) {
      summary.entryTypes = data.entries.reduce((counts, entry) => {
        const type = String(entry?.type ?? 'unknown');
        counts[type] = (counts[type] ?? 0) + 1;
        return counts;
      }, {});
    }
  } else {
    summary.output = `[${new TextEncoder().encode(raw).byteLength} UTF-8 bytes; file-tool output not logged]`;
  }
  return {
    toolName,
    toolCallId: payload?.toolCallId ?? payload?.tool_call_id ?? null,
    sessionKey: payload?.sessionKey ?? payload?.session_key ?? '',
    isError: Boolean(result.isError),
    summary,
  };
}

function updateApprovalUi() {
  const request = state.pendingApproval;
  const hasApproval = Boolean(state.lastToolCallId && request?.toolCallId === state.lastToolCallId);
  const status = el('agent-approval-status');
  const details = el('agent-approval-details');
  const fileApproval = el('agent-file-approval');
  const fileApprovalText = el('agent-file-approval-text');
  if (status) {
    status.textContent = hasApproval
      ? `Pending: ${request.toolName} · session ${request.sessionKey || 'direct/UI'}`
      : 'কোনো pending tool approval নেই।';
    status.dataset.tone = hasApproval ? 'warn' : 'muted';
  }
  if (details) {
    details.textContent = hasApproval
      ? JSON.stringify(safeApprovalArgs(request.toolName, request.args), null, 2)
      : '';
  }
  const fileTool = hasApproval && ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_files', 'find_files'].includes(request.toolName);
  if (fileApproval) fileApproval.hidden = !fileTool;
  if (fileApprovalText && fileTool) {
    fileApprovalText.textContent = `${request.toolName} approval pending — content values are redacted above. Approve or deny to continue.`;
  }
  document.querySelectorAll('[data-agent-action="agentapprove"], [data-agent-action="agentdeny"]')
    .forEach((button) => { button.disabled = !hasApproval; });
}

async function invokeNativeTool(toolName, args = {}) {
  requireInit();
  if (!state.listening) await wireEvents();
  const response = await window.NativeKit.agent.invokeTool(toolName, args);
  let result;
  try { result = JSON.parse(response?.resultJson ?? 'null'); }
  catch (error) { throw new Error(`Native tool '${toolName}' malformed JSON result দিয়েছে: ${error.message}`); }
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    throw new Error(result.error);
  }
  return result;
}

async function readWorkspaceText(path) {
  let offset = 0;
  let content = '';
  let expectedBytes = null;
  let expectedModifiedMs = null;
  let chunks = 0;
  while (true) {
    const result = await invokeNativeTool('read_file', {
      path,
      offset_bytes: offset,
      limit_bytes: 50_000,
    });
    if (!result || typeof result.content !== 'string' || !Number.isSafeInteger(result.fileBytes)) {
      throw new Error('read_file did not return valid UTF-8 content metadata.');
    }
    if (expectedBytes === null) {
      expectedBytes = result.fileBytes;
      expectedModifiedMs = result.modifiedMs ?? null;
    } else if (result.fileBytes !== expectedBytes || (expectedModifiedMs !== null && result.modifiedMs !== expectedModifiedMs)) {
      throw new Error('ফাইল পড়ার সময় বদলে গেছে; আবার Refresh/Open করুন।');
    }
    content += result.content;
    chunks += 1;
    if (chunks === 1 || chunks % 10 === 0) {
      const progress = expectedBytes ? Math.min(100, Math.round((Number(result.nextOffsetBytes ?? expectedBytes) / expectedBytes) * 100)) : 100;
      setFileStatus(`ফাইল পড়া হচ্ছে… ${progress}% · ${humanFileSize(expectedBytes)}`, 'busy');
    }
    if (!result.truncated) break;
    const next = Number(result.nextOffsetBytes);
    if (!Number.isSafeInteger(next) || next <= offset || next > expectedBytes) {
      throw new Error('read_file returned an invalid nextOffsetBytes cursor.');
    }
    offset = next;
  }
  return { content, fileBytes: expectedBytes ?? 0, modifiedMs: expectedModifiedMs };
}

function validNewFileName(value) {
  const name = String(value ?? '').trim();
  return Boolean(name)
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
    && new TextEncoder().encode(name).byteLength <= 255;
}

function currentEditorPath() {
  const fm = state.fileManager;
  if (fm.selectedPath) return fm.selectedPath;
  if (fm.isNew && validNewFileName(el('agent-file-name')?.value)) {
    return childWorkspacePath(fm.currentDir, val('agent-file-name'));
  }
  return null;
}

function updateFileManagerControls() {
  const fm = state.fileManager;
  const initialized = state.initialized;
  const busy = fm.busy || state.turnRunning;
  const hasEditor = Boolean(fm.selectedPath || fm.isNew);
  const name = el('agent-file-name');
  const content = el('agent-file-content');
  const save = document.querySelector('[data-agent-file-action="save"]');
  const revert = document.querySelector('[data-agent-file-action="revert"]');
  const remove = document.querySelector('[data-agent-file-action="delete"]');
  const editorState = el('agent-file-state');
  const pathLabel = el('agent-file-relative-path');
  const sizeLabel = el('agent-file-size');

  if (name) name.disabled = !initialized || busy || !fm.isNew;
  if (content) content.disabled = !initialized || busy || !hasEditor || !fm.editable;
  if (save) {
    const canSave = fm.isNew
      ? validNewFileName(name?.value)
      : Boolean(fm.selectedPath && fm.editable && fm.dirty);
    save.disabled = !initialized || busy || !canSave;
  }
  if (revert) revert.disabled = !initialized || busy || !hasEditor || (!fm.isNew && (!fm.editable || !fm.dirty));
  if (remove) remove.disabled = !initialized || busy || !fm.selectedPath;
  const deleteConfirm = document.querySelector('[data-agent-file-action="confirm-delete"]');
  const deleteCancel = document.querySelector('[data-agent-file-action="cancel-delete"]');
  if (deleteConfirm) deleteConfirm.disabled = !initialized || busy || !fm.pendingDelete;
  if (deleteCancel) deleteCancel.disabled = busy || !fm.pendingDelete;

  document.querySelectorAll('[data-agent-file-action]').forEach((button) => {
    if (button.dataset.agentFileAction === 'save'
      || button.dataset.agentFileAction === 'revert'
      || button.dataset.agentFileAction === 'delete'
      || button.dataset.agentFileAction === 'confirm-delete'
      || button.dataset.agentFileAction === 'cancel-delete') return;
    button.disabled = !initialized || busy;
  });
  document.querySelectorAll('.agent-file-entry').forEach((button) => {
    button.disabled = !initialized || busy || button.dataset.fileCanOpen !== 'true';
  });
  for (const id of ['agent-files-dir', 'agent-files-search', 'agent-files-include-skipped']) {
    const field = el(id);
    if (field) field.disabled = !initialized || busy;
  }

  if (editorState) {
    editorState.textContent = !hasEditor ? 'কোনো ফাইল খোলা নেই'
      : fm.isNew ? (fm.dirty ? 'নতুন draft · unsaved' : 'নতুন file draft')
        : fm.editable ? (fm.dirty ? 'Unsaved changes' : 'Saved') : 'Read-only · text edit সমর্থিত নয়';
    editorState.dataset.tone = fm.dirty || fm.isNew ? 'warn' : (fm.selectedPath && fm.editable ? 'ok' : 'muted');
  }
  if (pathLabel) pathLabel.textContent = currentEditorPath() ?? '—';
  if (sizeLabel) {
    if (!hasEditor) sizeLabel.textContent = 'সর্বোচ্চ ১০ MB UTF-8 text';
    else if (fm.isNew && content) sizeLabel.textContent = `Draft · ${humanFileSize(new TextEncoder().encode(content.value).byteLength)}`;
    else sizeLabel.textContent = `${humanFileSize(fm.originalBytes)}${fm.readOnlyReason ? ` · ${fm.readOnlyReason}` : ''}`;
  }
}

function setEditorContent(value) {
  const textarea = el('agent-file-content');
  if (textarea) textarea.value = value;
}

function clearFileEditor() {
  const fm = state.fileManager;
  fm.selectedPath = null;
  fm.originalContent = null;
  fm.originalBytes = 0;
  fm.isNew = false;
  fm.dirty = false;
  fm.editable = false;
  fm.readOnlyReason = '';
  fm.pendingDelete = null;
  if (el('agent-file-name')) el('agent-file-name').value = '';
  setEditorContent('');
  const confirmation = el('agent-file-delete-confirm');
  if (confirmation) confirmation.hidden = true;
  updateFileManagerControls();
}

function confirmDiscardEditor() {
  const fm = state.fileManager;
  if (!fm.isNew && !fm.dirty) return true;
  return window.confirm('এই file editor-এ unsaved পরিবর্তন আছে। পরিবর্তন বাদ দেবেন?');
}

function renderFileEntries(items, mode = 'directory') {
  const list = el('agent-files-list');
  if (!list) return;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-file-empty';
    empty.textContent = mode === 'search' ? 'কোনো matching file/folder পাওয়া যায়নি।' : 'এই folder খালি।';
    list.append(empty);
    return;
  }

  const fm = state.fileManager;
  for (const item of items) {
    const itemType = String(item?.type ?? 'unknown');
    const relativePath = mode === 'search'
      ? normalizeWorkspacePath(item?.path ?? '')
      : childWorkspacePath(fm.currentDir, String(item?.name ?? ''));
    const name = mode === 'search' ? baseWorkspaceName(relativePath) : String(item?.name ?? '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `agent-file-entry${fm.selectedPath === relativePath ? ' selected' : ''}`;
    button.dataset.fileCanOpen = String(itemType === 'file' || itemType === 'directory');
    button.setAttribute('role', 'listitem');
    button.title = relativePath;
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = itemType === 'directory' ? '📁' : itemType === 'file' ? '▤' : '↗';
    const label = document.createElement('span');
    label.className = 'agent-file-entry-name';
    label.textContent = name || relativePath;
    const meta = document.createElement('span');
    meta.className = 'agent-file-entry-meta';
    meta.textContent = itemType === 'directory' ? 'folder'
      : itemType === 'file' ? humanFileSize(item?.size)
        : itemType === 'symlink' ? 'symlink · blocked' : 'unavailable';
    button.append(icon, label, meta);
    if (itemType !== 'file' && itemType !== 'directory') {
      button.disabled = true;
      button.title = `${relativePath} — symbolic link বা অজানা type খোলা হয় না`;
    } else {
      button.addEventListener('click', () => {
        const task = itemType === 'directory'
          ? () => navigateFileDirectory(relativePath)
          : () => openWorkspaceFile(relativePath, item);
        void execute(itemType === 'directory' ? 'agent.files.open-folder' : 'agent.files.open',
          () => runFileManagerOperation(task), button);
      });
    }
    list.append(button);
  }
}

async function loadFileDirectory(path = val('agent-files-dir', '.')) {
  requireInit();
  const safePath = normalizeWorkspacePath(path);
  const includeSkipped = Boolean(el('agent-files-include-skipped')?.checked);
  setFileStatus(`Folder পড়া হচ্ছে: ${safePath}`, 'busy');
  const result = await invokeNativeTool('list_files', { path: safePath, include_skipped: includeSkipped });
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  entries.sort((a, b) => {
    const order = (a.type === 'directory' ? 0 : a.type === 'file' ? 1 : 2) - (b.type === 'directory' ? 0 : b.type === 'file' ? 1 : 2);
    return order || String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });
  });
  const fm = state.fileManager;
  fm.currentDir = safePath;
  fm.mode = 'directory';
  fm.entries = entries;
  fm.truncated = Boolean(result?.truncated);
  if (el('agent-files-dir')) el('agent-files-dir').value = safePath;
  if (el('agent-files-count')) el('agent-files-count').textContent = `${entries.length}${fm.truncated ? '+' : ''} items`;
  renderFileEntries(entries, 'directory');
  setFileStatus(`Workspace/${safePath === '.' ? '' : safePath} · ${entries.length} item${entries.length === 1 ? '' : 's'}${fm.truncated ? ' · তালিকা ১০০-এ সীমিত—নাম দিয়ে search করুন' : ''}`, fm.truncated ? 'warn' : 'ok');
  return { path: safePath, entries: entries.length, truncated: fm.truncated };
}

async function navigateFileDirectory(path) {
  const fm = state.fileManager;
  if ((fm.isNew || fm.dirty) && !confirmDiscardEditor()) return { cancelled: true, reason: 'unsaved changes kept' };
  if (fm.isNew || fm.dirty) clearFileEditor();
  return loadFileDirectory(path);
}

async function searchWorkspaceFiles() {
  requireInit();
  const pattern = val('agent-files-search');
  if (!pattern) throw new Error('Filename search-এর জন্য pattern দিন (যেমন *.md)।');
  const fm = state.fileManager;
  const result = await invokeNativeTool('find_files', {
    pattern,
    path: fm.currentDir,
    include_skipped: Boolean(el('agent-files-include-skipped')?.checked),
  });
  const files = Array.isArray(result?.files) ? result.files : [];
  fm.mode = 'search';
  fm.entries = files;
  fm.truncated = Boolean(result?.truncated);
  if (el('agent-files-count')) el('agent-files-count').textContent = `${files.length}${fm.truncated ? '+' : ''} matches`;
  renderFileEntries(files, 'search');
  setFileStatus(`${files.length}টি match · search base Workspace/${fm.currentDir === '.' ? '' : fm.currentDir}${fm.truncated ? ' · ফলাফল/scan limit-এ কাটা হয়েছে; pattern আরও নির্দিষ্ট করুন' : ''}`, fm.truncated ? 'warn' : 'ok');
  return { matches: files.length, truncated: fm.truncated, base: fm.currentDir };
}

async function openWorkspaceFile(path, entry = {}) {
  requireInit();
  const fm = state.fileManager;
  const safePath = normalizeWorkspacePath(path);
  if (!confirmDiscardEditor()) return { cancelled: true, reason: 'unsaved changes kept' };
  setFileStatus(`খোলা হচ্ছে: ${safePath}`, 'busy');
  const parent = parentWorkspacePath(safePath);
  const name = baseWorkspaceName(safePath);
  let textResult = null;
  let readOnlyReason = '';
  try {
    textResult = await readWorkspaceText(safePath);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/invalid utf-8|invalid UTF-8|File exceeds the .* tool limit/i.test(message)) {
      readOnlyReason = /File exceeds/i.test(message) ? '১০ MB-এর বেশি' : 'binary/non-UTF-8';
    } else {
      throw error;
    }
  }

  fm.currentDir = parent;
  fm.mode = 'directory';
  fm.selectedPath = safePath;
  fm.isNew = false;
  fm.dirty = false;
  fm.pendingDelete = null;
  fm.editable = Boolean(textResult);
  fm.readOnlyReason = readOnlyReason;
  fm.originalContent = textResult?.content ?? null;
  fm.originalBytes = textResult?.fileBytes ?? Number(entry?.size ?? 0);
  if (el('agent-files-dir')) el('agent-files-dir').value = parent;
  if (el('agent-file-name')) el('agent-file-name').value = name;
  setEditorContent(textResult?.content ?? '');
  if (el('agent-file-delete-confirm')) el('agent-file-delete-confirm').hidden = true;
  updateFileManagerControls();
  try { await loadFileDirectory(parent); }
  catch (error) { setFileStatus(`File খোলা হয়েছে, তবে folder refresh ব্যর্থ: ${error.message}`, 'warn'); }
  if (readOnlyReason) {
    setFileStatus(`${safePath} খোলা হয়েছে, তবে ${readOnlyReason} content edit করা যাবে না। প্রয়োজনে regular file হিসেবে Delete করা যাবে।`, 'warn');
  } else {
    setFileStatus(`${safePath} খোলা হয়েছে · ${humanFileSize(textResult.fileBytes)} · Save-এর আগে disk conflict check হবে।`, 'ok');
  }
  return { opened: safePath, bytes: fm.originalBytes, editable: fm.editable, readOnlyReason: readOnlyReason || undefined };
}

function startNewWorkspaceFile() {
  requireInit();
  if (state.turnRunning) throw new Error('Agent turn চলাকালে file draft শুরু করা যাবে না।');
  if (!confirmDiscardEditor()) return { cancelled: true, reason: 'unsaved changes kept' };
  clearFileEditor();
  const fm = state.fileManager;
  fm.isNew = true;
  fm.editable = true;
  fm.originalContent = '';
  fm.originalBytes = 0;
  fm.dirty = false;
  if (el('agent-file-name')) el('agent-file-name').value = '';
  setEditorContent('');
  updateFileManagerControls();
  setFileStatus(`Workspace/${fm.currentDir === '.' ? '' : fm.currentDir}-এ নতুন file draft; Save create-only, কোনো existing file overwrite করবে না।`, 'muted');
  el('agent-file-name')?.focus();
  return { draft: true, folder: fm.currentDir };
}

async function saveWorkspaceFile() {
  requireInit();
  const fm = state.fileManager;
  if (!fm.isNew && !fm.selectedPath) throw new Error('আগে file নির্বাচন করুন বা New file চাপুন।');
  if (fm.isNew && !validNewFileName(el('agent-file-name')?.value)) {
    throw new Error('একটি valid file name দিন (একটি folder-এর ভেতরে; /, \\ ও .. গ্রহণ করা হয় না)।');
  }
  const path = fm.isNew ? childWorkspacePath(fm.currentDir, val('agent-file-name')) : fm.selectedPath;
  const content = el('agent-file-content')?.value ?? '';
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > 10_000_000) throw new Error('File 10 MB UTF-8 tool limit ছাড়িয়েছে।');
  if (!fm.isNew && content === fm.originalContent) return { unchanged: true, path };

  if (!fm.isNew) {
    setFileStatus('Disk version যাচাই হচ্ছে…', 'busy');
    const latest = await readWorkspaceText(path);
    if (latest.content !== fm.originalContent) {
      throw new Error('ফাইলটি editor-এ খোলার পর disk-এ বদলেছে। আপনার draft রাখা হয়েছে; আগে Revert/পুনরায় Open করে পরিবর্তন মিলিয়ে নিন।');
    }
  }

  setFileStatus(fm.isNew ? 'নতুন file তৈরি হচ্ছে… approval চাইতে পারে।' : 'পরিবর্তন সংরক্ষণ হচ্ছে… approval চাইতে পারে।', 'busy');
  const result = await invokeNativeTool('write_file', {
    path,
    content,
    ...(fm.isNew ? { create_only: true } : {}),
  });
  fm.selectedPath = path;
  fm.currentDir = parentWorkspacePath(path);
  fm.isNew = false;
  fm.editable = true;
  fm.readOnlyReason = '';
  fm.originalContent = content;
  fm.originalBytes = bytes;
  fm.dirty = false;
  fm.pendingDelete = null;
  if (el('agent-files-dir')) el('agent-files-dir').value = fm.currentDir;
  if (el('agent-file-name')) el('agent-file-name').value = baseWorkspaceName(path);
  if (el('agent-file-delete-confirm')) el('agent-file-delete-confirm').hidden = true;
  updateFileManagerControls();
  try { await loadFileDirectory(fm.currentDir); }
  catch (error) { setFileStatus(`Save সফল, কিন্তু folder refresh ব্যর্থ: ${error.message}`, 'warn'); }
  setFileStatus(`${path} সংরক্ষিত · ${humanFileSize(bytes)}`, 'ok');
  return { saved: path, bytes, created: Boolean(result?.created) };
}

function revertWorkspaceFile() {
  const fm = state.fileManager;
  if (fm.isNew) {
    clearFileEditor();
    setFileStatus('নতুন file draft বাতিল হয়েছে।', 'muted');
    return { discarded: true };
  }
  if (!fm.selectedPath || !fm.editable) throw new Error('Revert করার মতো editable file নেই।');
  setEditorContent(fm.originalContent ?? '');
  fm.dirty = false;
  updateFileManagerControls();
  setFileStatus('Editor-কে সর্বশেষ load করা content-এ ফিরিয়ে দেওয়া হয়েছে।', 'muted');
  return { reverted: fm.selectedPath };
}

function requestWorkspaceFileDelete() {
  requireInit();
  if (state.turnRunning) throw new Error('Agent turn চলাকালে Delete শুরু করা যাবে না।');
  const fm = state.fileManager;
  if (!fm.selectedPath) throw new Error('মুছতে আগে workspace file নির্বাচন করুন।');
  if (fm.dirty && !window.confirm('Editor-এ unsaved পরিবর্তন আছে। Draft বাদ দিয়ে এই file delete করবেন?')) {
    return { cancelled: true };
  }
  fm.pendingDelete = fm.selectedPath;
  const confirmBox = el('agent-file-delete-confirm');
  if (confirmBox) confirmBox.hidden = false;
  if (el('agent-file-delete-path')) el('agent-file-delete-path').textContent = fm.selectedPath;
  setFileStatus('Delete স্থায়ী—নিচে আবার confirm করুন; এরপর native approval-ও লাগবে।', 'warn');
  updateFileManagerControls();
  return { confirmationRequired: fm.selectedPath };
}

async function confirmWorkspaceFileDelete() {
  const fm = state.fileManager;
  const path = fm.pendingDelete;
  if (!path || path !== fm.selectedPath) throw new Error('Pending delete target মেলে না; আবার file নির্বাচন করুন।');
  setFileStatus(`${path} মুছতে native approval অপেক্ষা করছে…`, 'busy');
  const result = await invokeNativeTool('delete_file', { path });
  clearFileEditor();
  try { await loadFileDirectory(fm.currentDir); }
  catch (error) { setFileStatus(`Delete সফল, কিন্তু folder refresh ব্যর্থ: ${error.message}`, 'warn'); }
  setFileStatus(`${path} স্থায়ীভাবে মুছে ফেলা হয়েছে (${humanFileSize(result?.deletedBytes)}).`, 'ok');
  return { deleted: path, bytes: result?.deletedBytes ?? 0 };
}

function updateFileEditorDraft() {
  const fm = state.fileManager;
  const text = el('agent-file-content')?.value ?? '';
  if (fm.isNew) {
    fm.dirty = Boolean(val('agent-file-name')) || text !== '';
  } else if (fm.selectedPath && fm.editable) {
    fm.dirty = text !== fm.originalContent;
  }
  updateFileManagerControls();
}

async function runFileManagerOperation(task) {
  requireInit();
  if (state.turnRunning) throw new Error('Agent turn চলছে; approval ID মিশে যাওয়া এড়াতে turn শেষ হলে file operation করুন।');
  const fm = state.fileManager;
  if (fm.busy) throw new Error('একটি file operation চলছে—শেষ হওয়া পর্যন্ত অপেক্ষা করুন।');
  fm.busy = true;
  updateFileManagerControls();
  try {
    return await task();
  } catch (error) {
    setFileStatus(String(error?.message ?? error), 'err');
    throw error;
  } finally {
    fm.busy = false;
    updateFileManagerControls();
  }
}

const AGENT_PROVIDERS = [
  'anthropic', 'openai', 'gemini', 'openrouter', 'ovhcloud', 'aihorde',
  'llm7', 'opencode_zen', 'kilo', 'pollinations', 'webllm',
];
const DEFAULT_PROVIDER_ORDER = [
  'anthropic', 'openai', 'gemini', 'openrouter', 'ovhcloud', 'opencode_zen',
  'llm7', 'kilo', 'aihorde',
];
const PROVIDER_PROTOCOLS = {
  anthropic: ['anthropic_messages'],
  openai: ['openai_chat_completions', 'openai_responses'],
  gemini: ['gemini_generate_content'],
  openrouter: ['openai_chat_completions'],
  ovhcloud: ['openai_chat_completions', 'openai_responses'],
  aihorde: ['openai_chat_completions'],
  llm7: ['openai_chat_completions'],
  opencode_zen: ['anthropic_messages', 'openai_chat_completions', 'openai_responses', 'gemini_generate_content'],
  kilo: ['openai_chat_completions'],
  pollinations: ['openai_chat_completions'],
  webllm: ['webllm_chat_completions'],
};
const catalogProvider = () => val('agent-catalog-provider') || val('agent-auth-provider', 'anthropic') || 'anthropic';
const authProvider = () => val('agent-auth-provider', 'anthropic') || 'anthropic';

function filterProtocolChoices(provider) {
  const allowed = new Set(PROVIDER_PROTOCOLS[provider] ?? []);
  const select = el('agent-model-protocol');
  if (!select) return;
  for (const option of select.options) {
    const supported = option.value === '' || allowed.has(option.value);
    option.hidden = !supported;
    option.disabled = !supported;
  }
  if (select.value && !allowed.has(select.value)) select.value = '';
}

function updateModelCapabilitySummary(provider, model, catalogMetadata = null) {
  const summary = el('agent-model-capability-summary');
  if (!summary) return;
  if (!model) {
    summary.textContent = 'Default model নির্বাচন করলে catalog access/streaming metadata এখানে দেখাবে।';
    return;
  }
  const config = state.runtimeConfig ?? {};
  const authSetting = config.providerModelAuthRequirements?.[provider]?.[model];
  const streamSetting = config.providerModelStreamingCapabilities?.[provider]?.[model];
  const authRequired = typeof catalogMetadata?.authRequired === 'boolean'
    ? catalogMetadata.authRequired
    : typeof authSetting === 'boolean' ? authSetting : null;
  const streaming = typeof catalogMetadata?.streamingSupported === 'boolean'
    ? catalogMetadata.streamingSupported
    : typeof streamSetting === 'boolean' ? streamSetting : null;
  const parts = [
    authRequired === true ? 'এই model-এ API key প্রয়োজন'
      : authRequired === false ? 'এই model-এ API key ঐচ্ছিক/anonymous tier'
      : 'API-key requirement অজানা; provider-এর safe default প্রযোজ্য',
    streaming === true ? 'streaming enabled'
      : streaming === false ? 'streaming অসমর্থিত—buffered completion ব্যবহার হবে'
      : 'streaming capability অজানা',
  ];
  if (catalogMetadata?.mayTrainOnYourPrompts === true) {
    parts.push('সতর্কতা: provider prompt log/train করতে পারে; sensitive data পাঠাবেন না');
  } else if (catalogMetadata?.mayTrainOnYourPrompts === false && provider === 'opencode_zen') {
    parts.push('Zen-এর vendor docs: এই model tier prompt training-এ ব্যবহার করে না; retention শর্ত আলাদা হতে পারে');
  } else if (provider === 'opencode_zen' && /-free$/i.test(model)) {
    parts.push('সতর্কতা: এই free model-এর prompt-retention/training status নিশ্চিত নয়; sensitive data পাঠাবেন না');
  }
  summary.textContent = `${provider}/${model} · ${parts.join(' · ')}`;
}

function applyProviderSettingsToUi(provider) {
  filterProtocolChoices(provider);
  const config = state.runtimeConfig ?? {};
  const model = String(config.defaultModels?.[provider] ?? '');
  if (el('agent-provider-default-model')) el('agent-provider-default-model').value = model;
  if (el('agent-provider-base-url')) {
    const localRuntime = provider === 'webllm';
    el('agent-provider-base-url').value = localRuntime ? '' : String(config.providerBaseUrls?.[provider] ?? '');
    el('agent-provider-base-url').disabled = localRuntime;
  }
  if (provider !== 'webllm' && el('agent-auth-provider') && AGENT_PROVIDERS.includes(provider)) {
    el('agent-auth-provider').value = provider;
  }
  const protocol = config.providerModelProtocols?.[provider]?.[model];
  if (el('agent-model-protocol')) el('agent-model-protocol').value = protocol ?? '';
  const capability = config.providerToolCapabilities?.[provider]?.[model];
  if (el('agent-model-tools')) el('agent-model-tools').value = capability === true ? 'true' : capability === false ? 'false' : 'unknown';
  const metadata = state.providerCatalog.find((item) => item?.id === model);
  updateModelCapabilitySummary(provider, model, metadata);
}

function selectCatalogProvider(provider) {
  state.catalogProvider = provider;
  state.providerCatalog = [];
  el('agent-model-list')?.replaceChildren();
  if (el('agent-model') && val('agent-provider') === 'auto') el('agent-model').value = '';
  applyProviderSettingsToUi(provider);
}

function renderProviderModels(models) {
  state.providerCatalog = Array.isArray(models) ? models : [];
  const list = el('agent-model-list');
  if (list) {
    list.replaceChildren(...state.providerCatalog.slice(0, 500).map((item) => {
      const option = document.createElement('option');
      option.value = String(item?.id ?? '');
      const access = item?.authRequired === true ? ' · key required' : item?.authRequired === false ? ' · key optional' : '';
      const streaming = item?.streamingSupported === false ? ' · buffered' : '';
      const privacy = item?.mayTrainOnYourPrompts === true ? ' · prompts may train'
        : state.catalogProvider === 'opencode_zen' && /-free$/i.test(String(item?.id ?? '')) && item?.mayTrainOnYourPrompts !== false
          ? ' · privacy unknown'
          : '';
      option.label = `${item?.name ?? item?.id ?? ''}${item?.toolCalling === true ? ' · tools' : item?.toolCalling === false ? ' · no tools' : ' · tool support unknown'}${access}${streaming}${privacy}`;
      return option;
    }));
  }
  state.catalogProvider = catalogProvider();
  const chosen = val('agent-provider-default-model');
  const metadata = state.providerCatalog.find((item) => item?.id === chosen);
  const configuredProtocol = state.runtimeConfig?.providerModelProtocols?.[state.catalogProvider]?.[chosen];
  const protocol = el('agent-model-protocol');
  if (protocol) protocol.value = configuredProtocol ?? metadata?.protocol ?? '';
  const configuredCapability = state.runtimeConfig?.providerToolCapabilities?.[state.catalogProvider]?.[chosen];
  const capability = typeof configuredCapability === 'boolean' ? configuredCapability : metadata?.toolCalling;
  const tools = el('agent-model-tools');
  if (tools) tools.value = capability === true ? 'true' : capability === false ? 'false' : 'unknown';
  updateModelCapabilitySummary(state.catalogProvider, chosen, metadata);
  setStatus(`${state.providerCatalog.length}টি model catalog-এ এসেছে (${state.catalogProvider})।`, 'ok');
  return state.providerCatalog;
}

async function loadRuntimeConfigIntoUi() {
  const config = await window.NativeKit.agent.getRuntimeConfig();
  state.runtimeConfig = config;
  const provider = String(config?.defaultProvider ?? 'anthropic');
  if (el('agent-provider')) el('agent-provider').value = provider;
  const routing = config?.autoRouting ?? {};
  if (el('agent-provider-order')) el('agent-provider-order').value = (routing.providerOrder ?? DEFAULT_PROVIDER_ORDER).join(',');
  if (el('agent-failover')) el('agent-failover').checked = routing.failoverOnTransient !== false;
  if (el('agent-max-fallbacks')) el('agent-max-fallbacks').value = String(routing.maxFallbacks ?? 3);
  const defaults = config?.defaultModels ?? {};
  const firstConfigured = routing.providerOrder?.find((id) => defaults[id])
    ?? (provider !== 'auto' ? provider : 'anthropic');
  if (el('agent-catalog-provider')) el('agent-catalog-provider').value = firstConfigured;
  // A request override is distinct from a provider default. In Auto mode it
  // must stay blank unless the user deliberately pins a model for this turn.
  if (el('agent-model')) el('agent-model').value = '';
  applyProviderSettingsToUi(firstConfigured);
  return config;
}

async function persistProviderSettings() {
  requireInit();
  const providerChoice = val('agent-provider', 'anthropic') || 'anthropic';
  const selectedCatalogProvider = catalogProvider();
  const model = val('agent-provider-default-model');
  const baseUrl = val('agent-provider-base-url');
  const orderText = val('agent-provider-order');
  const providerOrder = orderText
    ? orderText.split(',').map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_PROVIDER_ORDER;
  if (providerOrder.some((provider) => !AGENT_PROVIDERS.includes(provider))) {
    throw new Error('Auto-routing order-এ অজানা provider ID আছে।');
  }
  if (new Set(providerOrder).size !== providerOrder.length) {
    throw new Error('Auto-routing order-এ একই provider একাধিকবার আছে।');
  }
  const maxFallbacks = Number(val('agent-max-fallbacks', '3'));
  if (!Number.isInteger(maxFallbacks) || maxFallbacks < 0 || maxFallbacks > 10) {
    throw new Error('Max fallbacks 0–10 integer হতে হবে।');
  }

  const patch = {
    defaultProvider: providerChoice,
    autoRouting: {
      providerOrder,
      failoverOnTransient: Boolean(el('agent-failover')?.checked),
      maxFallbacks,
    },
  };
  patch.defaultModels = { [selectedCatalogProvider]: model || null };
  if (selectedCatalogProvider !== 'webllm') {
    patch.providerBaseUrls = { [selectedCatalogProvider]: baseUrl || null };
  }

  if (model) {
    const metadata = state.catalogProvider === selectedCatalogProvider
      ? state.providerCatalog.find((item) => item?.id === model)
      : null;
    const protocolChoice = val('agent-model-protocol');
    if (protocolChoice) {
      patch.providerModelProtocols = {
        [selectedCatalogProvider]: { [model]: protocolChoice },
      };
    } else {
      patch.providerModelProtocols = { [selectedCatalogProvider]: { [model]: null } };
    }

    const capabilityChoice = val('agent-model-tools', 'unknown');
    if (capabilityChoice === 'true' || capabilityChoice === 'false') {
      patch.providerToolCapabilities = {
        [selectedCatalogProvider]: { [model]: capabilityChoice === 'true' },
      };
    } else if (typeof metadata?.toolCalling === 'boolean') {
      patch.providerToolCapabilities = {
        [selectedCatalogProvider]: { [model]: metadata.toolCalling },
      };
    } else {
      // Clear an earlier user override when the current catalog no longer
      // confirms the selected model's capability.
      patch.providerToolCapabilities = { [selectedCatalogProvider]: { [model]: null } };
    }

    patch.providerModelAuthRequirements = {
      [selectedCatalogProvider]: { [model]: typeof metadata?.authRequired === 'boolean' ? metadata.authRequired : null },
    };
    patch.providerModelStreamingCapabilities = {
      [selectedCatalogProvider]: { [model]: typeof metadata?.streamingSupported === 'boolean' ? metadata.streamingSupported : null },
    };
  }
  const saved = await window.NativeKit.agent.setRuntimeConfig(patch);
  state.runtimeConfig = saved;
  applyProviderSettingsToUi(selectedCatalogProvider);
  setStatus(`Settings সংরক্ষিত · default provider ${saved.defaultProvider}; auto failover ${saved.autoRouting.maxFallbacks} পর্যন্ত।`, 'ok');
  return saved;
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
      case 'provider.request': {
        if (payload?.provider === 'webllm') {
          void handleWebLlmProviderRequest(payload);
          setStatus(`WebLLM request শুরু · ${payload?.model ?? 'model'}`, 'busy');
        }
        // Never put provider request messages/tool schemas in the shared log:
        // a request can contain private workspace file content.
        log('agent.provider.request', {
          provider: payload?.provider ?? '',
          model: payload?.model ?? '',
          requestId: payload?.requestId ?? '',
          messageCount: Array.isArray(payload?.request?.messages) ? payload.request.messages.length : 0,
          toolCount: Array.isArray(payload?.request?.tools) ? payload.request.tools.length : 0,
        });
        return;
      }
      case 'provider.route':
      case 'provider.selected':
      case 'provider.fallback': {
        log(`agent.${event.eventType}`, payload);
        break;
      }
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
        // Human-in-the-loop. Show the arguments with text/secrets redacted;
        // never dump a whole file body or API token into the shared event log.
        const toolName = payload?.toolName ?? payload?.tool_name ?? '?';
        const toolCallId = payload?.toolCallId ?? payload?.tool_call_id ?? null;
        state.lastToolCallId = toolCallId;
        state.pendingApproval = toolCallId ? {
          toolCallId,
          toolName,
          args: payload?.args ?? {},
          sessionKey: payload?.sessionKey ?? payload?.session_key ?? '',
        } : null;
        updateApprovalUi();
        setStatus(`Tool approval চাইছে: ${toolName}`, 'warn');
        if (state.fileManager.busy) setFileStatus(`${toolName} approval pending — file card-এর Approve/Deny button অথবা Approval gate ব্যবহার করুন।`, 'warn');
        log('agent.approval_request', {
          toolName,
          toolCallId,
          sessionKey: payload?.sessionKey ?? payload?.session_key ?? '',
          args: safeApprovalArgs(toolName, payload?.args ?? {}),
          requireBiometric: Boolean(payload?.requireBiometric ?? payload?.require_biometric),
        });
        return;
      }
      case 'tool_use': {
        const toolName = payload?.toolName ?? payload?.tool_name ?? '?';
        log('agent.tool_use', {
          toolName,
          toolCallId: payload?.toolCallId ?? payload?.tool_call_id ?? null,
          sessionKey: payload?.sessionKey ?? payload?.session_key ?? '',
          args: safeApprovalArgs(toolName, payload?.args ?? payload?.input ?? {}),
        });
        return;
      }
      case 'tool_result': {
        const toolName = payload?.toolName ?? payload?.tool_name ?? '?';
        if (FILE_RESULT_TOOLS.has(toolName)) {
          log('agent.tool_result', summarizeFileToolResult(toolName, payload));
          return;
        }
        break;
      }
      case 'mcp_tool_call': {
        // The engine is asking the WebView to run an MCP tool and is blocked
        // until respondToMcpTool() answers (or 30 s elapses). This case was
        // missing entirely, so the MCP demo could never respond.
        state.lastMcpCall = {
          id: payload?.toolCallId ?? payload?.tool_call_id ?? null,
          name: payload?.toolName ?? payload?.tool_name ?? '?',
          args: payload?.args ?? {},
        };
        setStatus(`MCP tool চাইছে: ${state.lastMcpCall.name}`, 'warn');
        log('agent.mcp_tool_call', {
          toolCallId: state.lastMcpCall.id,
          toolName: state.lastMcpCall.name,
          args: safeApprovalArgs(state.lastMcpCall.name, state.lastMcpCall.args),
        });
        return;
      }
      case 'cron_approval_request': {
        state.lastCronRequestId = payload?.requestId ?? payload?.request_id ?? null;
        break;
      }
      case 'agent.completed': {
        // Terminal: releases the re-entrancy guard in agentsend.
        state.turnRunning = false;
        updateFileManagerControls();
        setStatus('Turn শেষ।', 'ok');
        break;
      }
      case 'max_turns_reached': {
        setStatus(`Turn limit ছুঁয়ে গেছে (${payload?.turns ?? '?'})।`, 'warn');
        break;
      }
      case 'context.compacted': {
        log('agent.context.compacted', payload);
        setStatus(`পুরোনো conversation সংক্ষেপ করা হয়েছে (${payload?.compactedMessages ?? '?'}টি message)।`, 'warn');
        break;
      }
      case 'context.trimmed': {
        log('agent.context.trimmed', payload);
        setStatus(payload?.overBudget
          ? 'Context estimate এখনো budget ছাড়িয়েছে; provider request ব্যর্থ হতে পারে।'
          : `পুরোনো context বাদ দেওয়া হয়েছে (${payload?.droppedMessages ?? '?'}টি message)।`, 'warn');
        break;
      }
      case 'agent.background_timeout': {
        state.turnRunning = false;
        updateFileManagerControls();
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
        updateFileManagerControls();
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
    if (state.initialized || globalThis.__nativeKitAgentInitialized) {
      state.initialized = true;
      await loadRuntimeConfigIntoUi();
      await wireEvents();
      updateFileManagerControls();
      return { initialized: true, reused: true };
    }
    const probe = await window.NativeKit.agent.checkAvailability();
    if (!probe.available) {
      setStatus(`এই device-এ agent চলবে না (${probe.abi})`, 'err');
      return { skipped: true, reason: probe.reason };
    }
    const res = await window.NativeKit.agent.initialize({
      dbPath: 'files://agent/agent.db',
      workspacePath: 'files://agent/workspace',
      authProfilesPath: 'files://agent/auth-profiles.json',
    });
    state.initialized = true;
    globalThis.__nativeKitAgentInitialized = true;
    await loadRuntimeConfigIntoUi();
    setStatus('Engine চালু — provider/auth settings যাচাই করুন।', 'ok');
    updateFileManagerControls();
    await wireEvents();
    try { await runFileManagerOperation(() => loadFileDirectory('.')); }
    catch (error) { setFileStatus(`Engine চালু, তবে workspace তালিকা পড়া যায়নি: ${error.message}`, 'warn'); }
    return res ?? { initialized: true, sessionKey: state.sessionKey };
  },

  // 3 ── Auth ────────────────────────────────────────────────────────────────
  agentsetauth: async () => {
    requireInit();
    const key = val('agent-key');
    if (!key) throw new Error('API key ফিল্ডটি খালি — নির্বাচিত provider-এর key দিন।');
    await window.NativeKit.agent.setAuthKey(key, authProvider());
    setStatus('Key সংরক্ষিত।', 'ok');
    return window.NativeKit.agent.getAuthStatus(authProvider());
  },
  agentauthstatus: async () => { requireInit(); return window.NativeKit.agent.getAuthStatus(authProvider()); },
  agentauthtoken: async () => { requireInit(); return window.NativeKit.agent.getAuthToken(authProvider()); },
  agentrefreshtoken: async () => { requireInit(); return window.NativeKit.agent.refreshToken(authProvider()); },
  agentdeleteauth: async () => { requireInit(); await window.NativeKit.agent.deleteAuth(authProvider()); return { deleted: true }; },
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
    if (state.fileManager.busy) throw new Error('একটি workspace file operation চলছে; শেষ হলে message পাঠান।');
    state.turnRunning = true;
    updateFileManagerControls();
    state.streamed = '';
    const out = el('agent-stream');
    if (out) out.textContent = '';
    setStatus('Turn চলছে…', 'busy');
    try {
    const chosenProvider = val('agent-provider') || undefined;
    const chosenModel = val('agent-model') || undefined;
    const modelProvider = chosenProvider === 'auto' ? catalogProvider() : chosenProvider;
    const routedModel = chosenProvider === 'auto' && chosenModel
      ? `${modelProvider}/${chosenModel}`
      : chosenModel;
    const turnModelMetadata = chosenModel && state.catalogProvider === modelProvider
      ? state.providerCatalog.find((item) => item?.id === chosenModel)
      : null;
    if (chosenModel && turnModelMetadata) {
      const capabilityPatch = {};
      if (typeof turnModelMetadata.authRequired === 'boolean') {
        capabilityPatch.providerModelAuthRequirements = { [modelProvider]: { [chosenModel]: turnModelMetadata.authRequired } };
      }
      if (typeof turnModelMetadata.streamingSupported === 'boolean') {
        capabilityPatch.providerModelStreamingCapabilities = { [modelProvider]: { [chosenModel]: turnModelMetadata.streamingSupported } };
      }
      if (typeof turnModelMetadata.toolCalling === 'boolean') {
        capabilityPatch.providerToolCapabilities = { [modelProvider]: { [chosenModel]: turnModelMetadata.toolCalling } };
      }
      if (typeof turnModelMetadata.protocol === 'string') {
        capabilityPatch.providerModelProtocols = { [modelProvider]: { [chosenModel]: turnModelMetadata.protocol } };
      }
      if (Object.keys(capabilityPatch).length) {
        state.runtimeConfig = await window.NativeKit.agent.setRuntimeConfig(capabilityPatch);
      }
    }
    const res = await window.NativeKit.agent.sendMessage({
      prompt: val('agent-prompt') || 'Say hello in Bangla, one short sentence.',
      sessionKey: state.sessionKey,
      systemPrompt: val('agent-system') || undefined,
      provider: chosenProvider,
      model: routedModel,
    });
    state.lastRunId = res?.runId ?? null;
    return res;
    } catch (err) {
      // sendMessage only STARTS the turn; agent.completed/agent.error clear the
      // flag. If the start itself failed, no events are coming — clear it here.
      state.turnRunning = false;
      updateFileManagerControls();
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
    updateFileManagerControls();
    setStatus('Turn বাতিল।', 'muted');
    return { aborted: true };
  },

  // 6 ── Approval gate ───────────────────────────────────────────────────────
  agentapprove: async () => {
    requireInit();
    if (!state.lastToolCallId) throw new Error('কোনো pending tool approval নেই — আগে এমন prompt দিন যাতে agent tool চালাতে চায়।');
    const id = state.lastToolCallId;
    await window.NativeKit.agent.respondToApproval(id, true);
    if (state.lastToolCallId === id) { state.lastToolCallId = null; state.pendingApproval = null; }
    updateApprovalUi();
    setTimeout(updateApprovalUi, 0); // execute() re-enables its button in finally
    return { approved: id };
  },
  agentdeny: async () => {
    requireInit();
    if (!state.lastToolCallId) throw new Error('কোনো pending tool approval নেই।');
    const id = state.lastToolCallId;
    await window.NativeKit.agent.respondToApproval(id, false, 'User denied from Agent Lab');
    if (state.lastToolCallId === id) { state.lastToolCallId = null; state.pendingApproval = null; }
    updateApprovalUi();
    setTimeout(updateApprovalUi, 0); // execute() re-enables its button in finally
    return { denied: id };
  },
  agentmcpresult: async () => {
    requireInit();
    const call = state.lastMcpCall;
    if (!call?.id) throw new Error('কোনো pending MCP tool call নেই — আগে এমন prompt দিন যাতে agent একটি MCP tool চালাতে চায়।');
    // Answer in the MCP `CallToolResult` shape the spec defines:
    //   { content: ContentBlock[], isError?: boolean, structuredContent?: object }
    // The engine flattens `content` into readable text and honours the inner
    // `isError`, so a real MCP client can forward its server's reply verbatim.
    const result = {
      content: [{ type: 'text', text: `demo lab ran '${call.name}' successfully` }],
      isError: false,
    };
    await window.NativeKit.agent.respondToMcpTool(call.id, JSON.stringify(result), false);
    state.lastMcpCall = null;
    return { responded: call.id, tool: call.name };
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
  agentmemstore: async () => invokeNativeTool('memory_store', {
    key: 'demo-language',
    text: 'The user prefers answers in Bangla and works on a Capacitor shell called NativeKit.',
    category: 'preference',
  }),
  agentmemrecall: async () => invokeNativeTool('memory_recall', { query: 'Bangla preference', limit: 3 }),
  agentmemlist: async () => invokeNativeTool('memory_list', { prefix: '' }),
  agentmemforget: async () => invokeNativeTool('memory_forget', { query: 'Bangla preference' }),

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
    // Mirror the engine's conservative fallback for every builtin so the
    // permissions screen can show the full tool set. Read-only tools may run;
    // writes, shell, network and persistent mutations still ask every time.
    return window.NativeKit.agent.seedToolPermissions(JSON.stringify([
      { toolName: 'read_file', permission: 'always_allow', enabled: true },
      { toolName: 'write_file', permission: 'always_ask', enabled: true },
      { toolName: 'edit_file', permission: 'always_ask', enabled: true },
      { toolName: 'delete_file', permission: 'always_ask', enabled: true },
      { toolName: 'list_files', permission: 'always_allow', enabled: true },
      { toolName: 'find_files', permission: 'always_allow', enabled: true },
      { toolName: 'grep_files', permission: 'always_allow', enabled: true },
      { toolName: 'execute_command', permission: 'always_ask', enabled: true },
      { toolName: 'git_init', permission: 'always_ask', enabled: true },
      { toolName: 'git_status', permission: 'always_allow', enabled: true },
      { toolName: 'git_add', permission: 'always_ask', enabled: true },
      { toolName: 'git_commit', permission: 'always_ask', enabled: true },
      { toolName: 'git_log', permission: 'always_allow', enabled: true },
      { toolName: 'git_diff', permission: 'always_allow', enabled: true },
      { toolName: 'web_fetch', permission: 'always_ask', enabled: true },
      { toolName: 'manage_cron', permission: 'always_ask', enabled: true },
      { toolName: 'memory_recall', permission: 'always_allow', enabled: true },
      { toolName: 'memory_store', permission: 'always_ask', enabled: true },
      { toolName: 'memory_forget', permission: 'always_ask', enabled: true },
      { toolName: 'memory_search', permission: 'always_allow', enabled: true },
      { toolName: 'memory_list', permission: 'always_allow', enabled: true },
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
  // The real MCP client: handshake a server, publish its tools/list as the
  // agent's catalogue, and answer every mcp_tool_call as tools/call. The three
  // buttons above are the raw engine hooks; this one is the whole protocol.
  agentconnectmcp: async () => {
    requireInit();
    const url = (val('agent-mcp-url') || '').trim();
    if (!url) throw new Error('একটি MCP server URL দিন (যেমন https://example.com/mcp)।');
    // Disconnect a previous session first, otherwise its listener keeps
    // answering calls for tools that are no longer published.
    if (state.mcp) { await state.mcp.dispose(); state.mcp = null; }
    const connection = await window.NativeKit.agent.connectMcp([{ name: 'lab', url }]);
    state.mcp = connection;
    return {
      tools: connection.toolCount,
      failures: connection.failures,
      note: connection.toolCount
        ? 'এখন এমন prompt দিন যাতে agent এই tool গুলো ব্যবহার করে।'
        : 'server কোনো tool দেয়নি।',
    };
  },

  // 13 ── Models & tools ─────────────────────────────────────────────────────
  agentmodels: async () => {
    requireInit();
    const provider = catalogProvider();
    const response = await window.NativeKit.agent.getModels(provider);
    let models;
    try { models = JSON.parse(response.modelsJson ?? '[]'); }
    catch { throw new Error(`${provider} model catalog malformed JSON ফেরত দিয়েছে।`); }
    renderProviderModels(models);
    return { provider, count: models.length, modelsJson: response.modelsJson };
  },
  agentsaveproviders: async () => persistProviderSettings(),
  agentinvoketool: async () => invokeNativeTool('list_files', { path: state.fileManager.currentDir, include_skipped: Boolean(el('agent-files-include-skipped')?.checked) }),
};

// ── Wiring ───────────────────────────────────────────────────────────────────
// Reuses the shell's execute() contract: disable button, run, log result/error.
function wireAgentButtons(execute) {
  const providerSelect = el('agent-provider');
  const catalogSelect = el('agent-catalog-provider');
  if (providerSelect && catalogSelect) {
    providerSelect.addEventListener('change', () => {
      if (el('agent-model')) el('agent-model').value = '';
      if (providerSelect.value !== 'auto') {
        catalogSelect.value = providerSelect.value;
        selectCatalogProvider(providerSelect.value);
      }
    });
    catalogSelect.addEventListener('change', () => {
      selectCatalogProvider(catalogProvider());
    });
  }
  el('agent-provider-default-model')?.addEventListener('change', () => {
    const model = val('agent-provider-default-model');
    const metadata = state.providerCatalog.find((item) => item?.id === model);
    const protocol = state.runtimeConfig?.providerModelProtocols?.[catalogProvider()]?.[model];
    if (el('agent-model-protocol')) el('agent-model-protocol').value = protocol ?? metadata?.protocol ?? '';
    filterProtocolChoices(catalogProvider());
    const configuredCapability = state.runtimeConfig?.providerToolCapabilities?.[catalogProvider()]?.[model];
    const capability = typeof configuredCapability === 'boolean' ? configuredCapability : metadata?.toolCalling;
    if (el('agent-model-tools')) el('agent-model-tools').value = capability === true ? 'true' : capability === false ? 'false' : 'unknown';
    updateModelCapabilitySummary(catalogProvider(), model, metadata);
  });
  document.querySelectorAll('[data-agent-action]').forEach((button) => {
    const name = button.dataset.agentAction;
    button.addEventListener('click', () => {
      void execute(`agent.${name}`, agentActions[name], button).finally(() => {
        updateApprovalUi();
        updateFileManagerControls();
      });
    });
  });

  const fileActions = {
    'open-dir': () => runFileManagerOperation(() => navigateFileDirectory(val('agent-files-dir', '.'))),
    up: () => runFileManagerOperation(() => navigateFileDirectory(parentWorkspacePath(state.fileManager.currentDir))),
    refresh: () => runFileManagerOperation(() => state.fileManager.mode === 'search' && val('agent-files-search')
      ? searchWorkspaceFiles()
      : loadFileDirectory(state.fileManager.currentDir)),
    find: () => runFileManagerOperation(() => searchWorkspaceFiles()),
    'new-file': () => startNewWorkspaceFile(),
    save: () => runFileManagerOperation(() => saveWorkspaceFile()),
    revert: () => revertWorkspaceFile(),
    delete: () => requestWorkspaceFileDelete(),
    'confirm-delete': () => runFileManagerOperation(() => confirmWorkspaceFileDelete()),
    'cancel-delete': () => {
      state.fileManager.pendingDelete = null;
      if (el('agent-file-delete-confirm')) el('agent-file-delete-confirm').hidden = true;
      setFileStatus('Delete বাতিল করা হয়েছে।', 'muted');
      updateFileManagerControls();
      return { cancelled: true };
    },
  };
  document.querySelectorAll('[data-agent-file-action]').forEach((button) => {
    const name = button.dataset.agentFileAction;
    const action = fileActions[name];
    if (action) button.addEventListener('click', () => {
      void execute(`agent.files.${name}`, action, button).finally(updateFileManagerControls);
    });
  });
  el('agent-file-content')?.addEventListener('input', updateFileEditorDraft);
  el('agent-file-name')?.addEventListener('input', updateFileEditorDraft);
  el('agent-files-dir')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') document.querySelector('[data-agent-file-action="open-dir"]')?.click();
  });
  el('agent-files-search')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') document.querySelector('[data-agent-file-action="find"]')?.click();
  });

  updateApprovalUi();
  updateFileManagerControls();
  const supported = window.NativeKit?.agent?.supported?.() ?? false;
  if (!supported) {
    setStatus('Web/preview-এ agent চলে না — Android/iOS build-এ চালান।', 'warn');
    document.querySelectorAll('[data-agent-action], [data-agent-file-action]').forEach((b) => { b.disabled = true; });
  } else {
    setStatus('প্রস্তুত — "Check availability" দিয়ে শুরু করুন।', 'muted');
  }
}

export { agentActions, wireAgentButtons };
