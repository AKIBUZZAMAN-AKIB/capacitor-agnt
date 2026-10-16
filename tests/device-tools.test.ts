import { describe, expect, it, vi } from 'vitest';
import { unzipSync, zipSync } from 'fflate';

import {
  createDeviceToolsTransport,
  defaultDeviceToolDeps,
  deviceServerConfig,
  deviceToolNames,
  DEVICE_SERVER_NAME,
  type DeviceToolDeps,
} from '../bridge/device-tools';
import {
  connectMcpServers,
  McpClient,
  namespacedToolName,
  type AgentLike,
  type McpServerConfig,
} from '../bridge/mcp-client';

/** First text block of a result, union-safe. */
function textOf(result: any): string {
  return result?.content?.find((block: any) => block.type === 'text')?.text ?? '';
}

// ── helpers ─────────────────────────────────────────────────────────────────

type Calls = { method: string; args: any };

/** Fake device dependencies with per-tool recording and scriptable results. */
function fakeDeps(overrides: Partial<DeviceToolDeps> = {}, clockStart = 1_000_000) {
  const calls: Calls[] = [];
  let clock = clockStart;
  const fetchResponses: Array<{ ok: boolean; status: number; body: string }> = [];
  let overlayGranted = true;
  const files = new Map<string, string>();
  const nearbyHandlers: Record<string, (data: any) => void> = {};
  const askUserScript: Array<(options: string[]) => { answer: string; index: number } | null> = [];
  const record = (method: string) => (args: any) => {
    calls.push({ method, args });
    return Promise.resolve(undefined as any);
  };
  const deps: DeviceToolDeps = {
    camera: {
      async getPhoto(_options: any) {
        calls.push({ method: 'getPhoto', args: _options });
        return { base64String: 'cGhvdG9ieXRlcw==', format: 'jpeg' };
      },
    },
    geolocation: {
      async requestPermissions() {
        calls.push({ method: 'requestPermissions', args: {} });
        return { location: 'granted' };
      },
      async getCurrentPosition(_options?: any) {
        calls.push({ method: 'getCurrentPosition', args: _options });
        return {
          coords: { latitude: 23.8103, longitude: 90.4125, accuracy: 22.5, altitude: null, heading: null, speed: null },
          timestamp: clock,
        };
      },
    },
    haptics: { vibrate: record('vibrate') },
    notifications: {
      async requestPermissions() {
        calls.push({ method: 'notifications.requestPermissions', args: {} });
        return { display: 'granted' };
      },
      schedule: record('notifications.schedule'),
    },
    share: {
      async share(options: any) {
        calls.push({ method: 'share', args: options });
        return { resultType: 'success' } as any;
      },
    },
    network: {
      async getStatus() {
        calls.push({ method: 'getStatus', args: {} });
        return { connected: true, connectionType: 'wifi' };
      },
    },
    alarms: {
      scheduleAlarm: record('scheduleAlarm'),
      async listAlarms() {
        calls.push({ method: 'listAlarms', args: {} });
        return { alarms: [{ id: 'a1', title: 'T' }] } as any;
      },
      cancelAlarm: record('cancelAlarm'),
      stopRinging: record('stopRinging'),
    },
    filesystem: {
      mkdir: record('mkdir'),
      writeFile: async (options: any) => {
        calls.push({ method: 'writeFile', args: options });
        // In-memory store keeps everything as base64 so text and binary paths
        // round-trip through the same fake.
        const data = options.encoding ? Buffer.from(String(options.data ?? ''), 'utf8').toString('base64') : String(options.data ?? '');
        files.set(String(options.path ?? ''), data);
      },
      async readFile(options: any) {
        calls.push({ method: 'readFile', args: options });
        const data = files.get(String(options.path ?? ''));
        if (data === undefined) throw new Error('File does not exist');
        return { data: options.encoding ? Buffer.from(data, 'base64').toString('utf8') : data };
      },
      async readdir(options: any) {
        calls.push({ method: 'readdir', args: options });
        return { files: [] as any };
      },
      async getUri(options: any) {
        calls.push({ method: 'getUri', args: options });
        return { uri: `file:///data/user/0/dev.nativekit.shell/files/${options.path}` };
      },
      async stat(options: any) {
        calls.push({ method: 'stat', args: options });
        return { type: 'file', size: 4096 };
      },
    },
    extras: {
      ttsSpeak: async (options: any) => { calls.push({ method: 'ttsSpeak', args: options }); return { queued: true, languageSupported: true }; },
      ttsStop: record('ttsStop'),
      async listenSpeech(options: any) { calls.push({ method: 'listenSpeech', args: options }); return { text: 'ঢাকার আবহাওয়া ভালো', confidence: 0.82 }; },
      async scanQrCode(_options?: any) { calls.push({ method: 'scanQrCode', args: _options }); return { text: 'https://example.com/qr', format: 'QR_CODE' }; },
      dialPhone: record('dialPhone'),
      composeSms: record('composeSms'),
      setTorch: record('setTorch'),
      async batteryStatus(_options?: any) { calls.push({ method: 'batteryStatus', args: _options }); return { percent: 73, charging: true, plugged: true }; },
      async pickDocument(_options?: any) { calls.push({ method: 'pickDocument', args: _options }); return { path: 'picked/report.pdf', bytes: 20480 }; },
    },
    async askUser(question, options, _timeoutMs) {
      calls.push({ method: 'askUser', args: { question, options } });
      const scripted = askUserScript.shift();
      return scripted ? scripted(options) : { answer: options[0], index: 0 };
    },
    sqlite: {
      async query(name: string, statement: string, values?: any[]) {
        calls.push({ method: 'sqlite.query', args: { name, statement, values } });
        return { values: [{ id: 1, title: 'বাংলা' }, { id: 2, title: 'English' }] } as any;
      },
      async run(name: string, statement: string, values?: any[]) {
        calls.push({ method: 'sqlite.run', args: { name, statement, values } });
        return { changes: 3 } as any;
      },
    },
    nearby: {
      initialize: record('nearby.initialize'),
      startAdvertising: record('nearby.startAdvertising'),
      stopAdvertising: record('nearby.stopAdvertising'),
      async startDiscovery(_options?: any) {
        calls.push({ method: 'nearby.startDiscovery', args: _options });
        setTimeout(() => {
          nearbyHandlers.onEndpointFound?.({ endpointID: 'E1', endpointName: 'Pixel Agent' });
          nearbyHandlers.onEndpointFound?.({ endpointID: 'E2', endpointName: 'S23 Agent' });
          nearbyHandlers.onEndpointLost?.({ endpointID: 'E2' });
        }, 10);
      },
      stopDiscovery: record('nearby.stopDiscovery'),
      async requestConnection(options: any) {
        calls.push({ method: 'nearby.requestConnection', args: options });
        setTimeout(() => nearbyHandlers.onEndpointConnected?.({ endpointID: options.endpointID }), 10);
      },
      acceptConnection: record('nearby.acceptConnection'),
      sendPayload: record('nearby.sendPayload'),
      async status(_options?: any) { calls.push({ method: 'nearby.status', args: _options }); return { advertising: false, discovering: false } as any; },
      requestPermissions: record('nearby.requestPermissions'),
      async addListener(eventName: string, listenerFunc: (data: any) => void) {
        calls.push({ method: 'nearby.addListener', args: { eventName } });
        nearbyHandlers[eventName] = listenerFunc;
        return { remove: () => { delete nearbyHandlers[eventName]; } };
      },
    },
    miniapp: {
      async install(pkg: any) { calls.push({ method: 'miniapp.install', args: pkg }); return { id: (pkg.manifest as any)?.id ?? 'agent.test' }; },
      async launch(appId: string, _target: unknown) { calls.push({ method: 'miniapp.launch', args: { appId } }); return { launched: true }; },
      async list() { calls.push({ method: 'miniapp.list', args: {} }); return [{ id: 'agent.test-mini-app', manifest: { name: 'Test Mini App', version: '1.0.0', requestedCapabilities: ['location'] }, policy: { enabled: true }, totalBytes: 42, fileCount: 1 }]; },
      async sessions() { calls.push({ method: 'miniapp.sessions', args: {} }); return [{ appId: 'agent.test-mini-app', renderer: 'isolated' }]; },
      async stopAll() { calls.push({ method: 'miniapp.stopAll', args: {} }); },
    },
    clipboard: {
      async writeText(text: string) { calls.push({ method: 'clipboard.writeText', args: { text } }); },
      async readText() { calls.push({ method: 'clipboard.readText', args: {} }); return 'ক্লিপবোর্ডে রাখা টেক্সট'; },
    },
    openUrl: (url: string) => calls.push({ method: 'openUrl', args: { url } }),
    fetchImpl: async (url: string, init?: any) => {
      calls.push({ method: 'fetch', args: { url, init } });
      const scripted = fetchResponses.shift() ?? { ok: true, status: 200, body: '' };
      return {
        ok: scripted.ok,
        status: scripted.status,
        text: async () => scripted.body,
      };
    },
    transfer: {
      downloadFile: record('downloadFile'),
      async uploadFile(options: any) {
        calls.push({ method: 'uploadFile', args: options });
        return { statusCode: 201 };
      },
    },
    appInfo: {
      async getInfo() {
        calls.push({ method: 'getInfo', args: {} });
        return { name: 'NativeKit TestLab', id: 'dev.nativekit.shell', version: '1.4.17', build: '31' };
      },
    },
    widget: {
      async checkOverlayPermission() { calls.push({ method: 'checkOverlayPermission', args: {} }); return { granted: overlayGranted }; },
      requestOverlayPermission: record('requestOverlayPermission'),
      async showFloating(options: any) { calls.push({ method: 'showFloating', args: options }); return { shown: true }; },
      hideFloating: record('hideFloating'),
      async updateFloating(options: any) { calls.push({ method: 'updateFloating', args: options }); return { shown: true }; },
      async sendToFloating(options: any) { calls.push({ method: 'sendToFloating', args: options }); return { delivered: true }; },
      setConfig: record('setConfig'),
      async reload(options: any) { calls.push({ method: 'reload', args: options }); return { updated: 1 }; },
      async requestPin(options: any) { calls.push({ method: 'requestPin', args: options }); return { requested: true }; },
    },
    toast: (message: string) => calls.push({ method: 'toast', args: { message } }),
    now: () => clock,
    ...overrides,
  } as DeviceToolDeps & { now: () => number };
  (deps as any).advanceClock = (ms: number) => { clock += ms; };
  (deps as any).queueFetch = (body: string, ok = true, status = 200) => { fetchResponses.push({ body, ok, status }); };
  (deps as any).setOverlay = (granted: boolean) => { overlayGranted = granted; };
  (deps as any).putFile = (path: string, text: string) => { files.set(`agent/workspace/${path}`, Buffer.from(text, 'utf8').toString('base64')); };
  (deps as any).putFileBase64 = (path: string, base64: string) => { files.set(`agent/workspace/${path}`, base64); };
  (deps as any).readStoredFile = (storedPath: string) => files.get(storedPath);
  (deps as any).scriptAskUser = (script: (options: string[]) => { answer: string; index: number } | null) => { askUserScript.push(script); };
  (deps as any).nearbyFire = (event: string, data: any) => { nearbyHandlers[event]?.(data); };
  return { deps, calls };
}

/** A fake agent that records the published catalogue and tool answers. */
function fakeAgent() {
  const published: string[] = [];
  const answers: Array<{ toolCallId: string; result: any; isError?: boolean }> = [];
  const agent: AgentLike = {
    async startMcp(toolsJson: string) {
      published.push(toolsJson);
      return { toolCount: 0 };
    },
    async respondToMcpTool(toolCallId: string, resultJson: string, isError?: boolean) {
      answers.push({ toolCallId, result: JSON.parse(resultJson), isError });
    },
  };
  return { agent, published, answers };
}

/** Drive the transport exactly like a real (stateless) MCP client would. */
function clientFor(deps: DeviceToolDeps, features: Record<string, boolean> = {}, options: { platform?: string } = {}) {
  const transport = createDeviceToolsTransport(deps, { features, ...options });
  return new McpClient(DEVICE_SERVER_NAME, transport, { protocolVersion: 'auto' });
}

async function callTool(deps: DeviceToolDeps, name: string, args: Record<string, unknown> = {}, features: Record<string, boolean> = {}) {
  const client = clientFor(deps, features);
  return client.callTool(name, args);
}

// ── search fixtures (shapes captured from the live endpoints) ───────────────

const BING_HTML = [
  '<li class="b_algo">',
  '<div class="b_tpcn"><a class="tilk" href="https://en.wikipedia.org/wiki/Capacitor"><cite>https://en.wikipedia.org</cite></a></div>',
  '<div class="b_algoheader"><a href="https://en.wikipedia.org/wiki/Capacitor">Capacitor - Wikipedia</a></div>',
  '<h2><strong>Capacitor</strong> - Wikipedia</h2>',
  '<p class="b_lineclamp4">A capacitor is a device that stores electrical energy by accumulating electric charge.</p>',
  '</li>',
  '<li class="b_algo">',
  '<div class="b_algoheader"><a href="https://electronics.howstuffworks.com/capacitor.htm">How Capacitors Work</a></div>',
  '<h2>How Capacitors Work</h2>',
  '<p class="b_lineclamp2">In a way, a capacitor is a little like a battery.</p>',
  '</li>',
].join('');

const DDG_HTML = [
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FElectric_capacitor&amp;rut=abc">Electric capacitor - Wikipedia</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FElectric_capacitor&amp;rut=abc">A capacitor is a passive electrical component.</a>',
].join('');

const DDG_ANOMALY = '<html><body><p>If this persists, please send an anomaly report.</p></body></html>';

const IA_JSON = JSON.stringify({
  Heading: 'Python (programming language)',
  AbstractText: 'Python is a high-level, general-purpose programming language.',
  AbstractURL: 'https://en.wikipedia.org/wiki/Python_(programming_language)',
  RelatedTopics: [{ Text: 'Python Software Foundation - Home', FirstURL: 'https://www.python.org/' }],
});

// ── catalogue & wiring ──────────────────────────────────────────────────────

describe('device tools catalogue', () => {
  it('exposes a fixed, documented set of tools', () => {
    expect(deviceToolNames()).toEqual([
      'notify', 'take_photo', 'get_location', 'vibrate', 'share',
      'network_status', 'schedule_alarm', 'list_alarms', 'cancel_alarm', 'open_url',
      'web_search', 'download_file', 'upload_file', 'toast', 'app_info', 'stop_ringing',
      'show_floating_ui', 'update_floating_ui', 'hide_floating_ui', 'set_widget', 'pin_widget',
      'speak', 'stop_speaking', 'listen', 'scan_qr', 'dial_phone', 'compose_sms', 'torch',
      'battery_status', 'pick_file',
      'ask_user', 'zip_files', 'unzip_file', 'sql_query',
      'nearby_status', 'nearby_advertise', 'nearby_discover', 'nearby_connect', 'nearby_accept', 'nearby_send',
      'stage_miniapp', 'list_miniapps', 'stop_miniapps', 'clipboard_write', 'clipboard_read',
    ]);
  });

  it('lists tools with name, description and input schema', async () => {
    const { deps } = fakeDeps();
    const tools = await clientFor(deps).listTools();
    expect(tools.map((tool) => tool.name)).toEqual(deviceToolNames());
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
    const notify = tools.find((tool) => tool.name === 'notify');
    expect(notify?.inputSchema).toMatchObject({ type: 'object', required: ['title'] });
  });

  it('hides Android-only tools on iOS and refuses to run them there', async () => {
    const { deps } = fakeDeps();
    const client = clientFor(deps, {}, { platform: 'ios' });
    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name);
    // Native backing for these exists only in the Android plugin build.
    for (const hidden of [
      'speak', 'stop_speaking', 'listen', 'scan_qr', 'pick_file', 'dial_phone',
      'compose_sms', 'torch', 'battery_status', 'clipboard_write', 'clipboard_read',
      'show_floating_ui', 'update_floating_ui', 'hide_floating_ui',
    ]) {
      expect(names, `${hidden} must be hidden on iOS`).not.toContain(hidden);
    }
    // Cross-platform tools stay offered.
    for (const kept of ['notify', 'take_photo', 'get_location', 'web_search', 'nearby_status', 'set_widget', 'schedule_alarm', 'stage_miniapp', 'list_miniapps', 'stop_miniapps']) {
      expect(names, `${kept} must stay on iOS`).toContain(kept);
    }
    // And a direct call fail-closes instead of pretending to work.
    const result = await client.callTool('speak', { text: 'hi' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Unknown device tool');
    // Android keeps everything, and the default (no platform) is unchanged.
    expect((await clientFor(deps, {}, { platform: 'android' }).listTools()).map((t) => t.name)).toContain('speak');
    expect((await clientFor(deps).listTools()).map((t) => t.name)).toContain('speak');
  });

  it('hides tools whose feature flag is disabled', async () => {
    const { deps } = fakeDeps();
    const tools = await clientFor(deps, {
      camera: false, advancedAlarms: false, widget: false, fileTransfer: false,
      filesystem: false, sqlite: false, nearby: false, appBrowser: false,
    }).listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('scan_qr');
    expect(names).not.toContain('pick_file');
    expect(names).not.toContain('zip_files');
    expect(names).not.toContain('unzip_file');
    expect(names).not.toContain('sql_query');
    expect(names).not.toContain('nearby_status');
    expect(names).not.toContain('nearby_advertise');
    expect(names).not.toContain('nearby_discover');
    expect(names).not.toContain('nearby_connect');
    expect(names).not.toContain('nearby_accept');
    expect(names).not.toContain('nearby_send');
    expect(names).not.toContain('stage_miniapp');
    expect(names).not.toContain('list_miniapps');
    expect(names).not.toContain('stop_miniapps');
    expect(names).toContain('speak');
    expect(names).toContain('ask_user');
    expect(names).not.toContain('take_photo');
    expect(names).not.toContain('schedule_alarm');
    expect(names).not.toContain('list_alarms');
    expect(names).not.toContain('cancel_alarm');
    expect(names).not.toContain('show_floating_ui');
    expect(names).not.toContain('update_floating_ui');
    expect(names).not.toContain('hide_floating_ui');
    expect(names).not.toContain('set_widget');
    expect(names).not.toContain('pin_widget');
    expect(names).not.toContain('download_file');
    expect(names).not.toContain('upload_file');
    expect(names).toContain('notify');
    expect(names).toContain('get_location');
    expect(names).toContain('web_search');
    expect(names).toContain('toast');
  });

  it('answers initialize for legacy clients too', async () => {
    const { deps } = fakeDeps();
    const transport = createDeviceToolsTransport(deps);
    const response = await transport.send({
      jsonrpc: '2.0', id: 7, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
    });
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 7 });
    expect((response?.result as any).serverInfo).toMatchObject({ name: 'nativekit-device-tools' });
  });

  it('swallows notifications (no id) and rejects unknown methods', async () => {
    const { deps } = fakeDeps();
    const transport = createDeviceToolsTransport(deps);
    expect(await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const response = await transport.send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
    expect(response?.error?.code).toBe(-32601);
  });
});

describe('connectMcpServers wiring', () => {
  it('publishes the device server namespaced, webview-only and ask-by-default', async () => {
    const { deps } = fakeDeps();
    const { agent, published } = fakeAgent();
    const connection = await connectMcpServers(agent, [deviceServerConfig()], {
      makeTransport: () => createDeviceToolsTransport(deps),
    });
    expect(connection.toolCount).toBe(deviceToolNames().length);
    expect(connection.failures).toEqual([]);
    const catalogue = JSON.parse(published[0]);
    for (const entry of catalogue) {
      expect(entry.name.startsWith(`${DEVICE_SERVER_NAME}__`)).toBe(true);
      expect(entry.webviewOnly).toBe(true);
      expect(entry.approvalPolicy).toBe('always_ask');
    }
    const names = catalogue.map((entry: any) => entry.name);
    expect(names).toContain(namespacedToolName(DEVICE_SERVER_NAME, 'notify'));
    expect(names).toContain(namespacedToolName(DEVICE_SERVER_NAME, 'open_url'));
  });

  it('does not weaken HTTPS validation for a remote config alongside an injected one', async () => {
    const { deps } = fakeDeps();
    const { agent } = fakeAgent();
    const servers: McpServerConfig[] = [
      deviceServerConfig(),
      { name: 'remote', url: 'http://insecure.example/mcp' },
    ];
    const connection = await connectMcpServers(agent, servers, {
      makeTransport: (config) => (config.name === DEVICE_SERVER_NAME ? createDeviceToolsTransport(deps) : undefined),
    });
    expect(connection.failures.map((failure) => failure.server)).toEqual(['remote']);
    expect(connection.failures[0].error).toMatch(/HTTPS/);
    expect(connection.toolCount).toBe(deviceToolNames().length);
  });

  it('forwards mcp_tool_call events to the device transport and answers the engine', async () => {
    const { deps, calls } = fakeDeps();
    const { agent, answers } = fakeAgent();
    let eventHandler: ((event: any) => void) | undefined;
    const agentWithListener: AgentLike = {
      ...agent,
      addListener: (_event: string, handler: (event: any) => void) => {
        eventHandler = handler;
        return { remove: () => undefined };
      },
    } as AgentLike;
    await connectMcpServers(agentWithListener, [deviceServerConfig()], {
      makeTransport: () => createDeviceToolsTransport(deps),
    });

    await eventHandler!({
      eventType: 'mcp_tool_call',
      payload: {
        toolCallId: 'call-1',
        toolName: namespacedToolName(DEVICE_SERVER_NAME, 'network_status'),
        args: {},
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.map((entry) => entry.method)).toContain('getStatus');
    expect(answers[0].toolCallId).toBe('call-1');
    expect(answers[0].isError).toBeFalsy();
    expect(textOf(answers[0].result)).toContain('online');
  });
});

// ── individual tools ────────────────────────────────────────────────────────

describe('notify', () => {
  it('schedules a local notification after the permission check', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'notify', { title: 'Done', body: 'Task finished' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Notification shown');
    const schedule = calls.find((entry) => entry.method === 'notifications.schedule');
    expect(schedule?.args.notifications[0]).toMatchObject({ title: 'Done', body: 'Task finished' });
  });

  it('supports a delayed schedule', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'notify', { title: 'Later', delaySeconds: 60 });
    expect(result.isError).toBeFalsy();
    const schedule = calls.find((entry) => entry.method === 'notifications.schedule');
    expect(schedule?.args.notifications[0].schedule.at).toBeInstanceOf(Date);
  });

  it('fails closed when notification permission is denied', async () => {
    const { deps } = fakeDeps({
      notifications: {
        async requestPermissions() { return { display: 'denied' }; },
        async schedule() { throw new Error('must not be reached'); },
      },
    });
    const result = await callTool(deps, 'notify', { title: 'Nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/denied/);
  });

  it('rate limits to 4 notifications per minute on one shared transport', async () => {
    const { deps } = fakeDeps();
    const client = clientFor(deps);
    for (let index = 0; index < 4; index += 1) {
      const ok = await client.callTool('notify', { title: `n${index}` });
      expect(ok.isError).toBeFalsy();
    }
    const limited = await client.callTool('notify', { title: 'n5' });
    expect(limited.isError).toBe(true);
    expect(textOf(limited)).toMatch(/Rate limit/);
  });
});

describe('take_photo', () => {
  it('captures and saves the photo into the agent workspace photos/ directory', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'take_photo', { quality: 70, fileName: 'receipt' });
    expect(result.isError).toBeFalsy();
    const write = calls.find((entry) => entry.method === 'writeFile');
    expect(write?.args.path).toMatch(/^agent\/workspace\/photos\/receipt\.jpg$/);
    expect(write?.args.directory).toBe('DATA');
    const text = textOf(result);
    expect(text).toContain('photos/receipt.jpg');
    expect(result.structuredContent).toMatchObject({ path: 'photos/receipt.jpg', mimeType: 'image/jpeg' });
    // Image bytes are part of the result for future vision support, but the
    // engine flattens them; the transcript-visible text mentions the path.
    expect(result.content.some((block: any) => block.type === 'image')).toBe(true);
  });

  it('reports a user cancellation as an error result, never a throw', async () => {
    const { deps } = fakeDeps({
      camera: { async getPhoto() { throw new Error('User cancelled'); } },
    });
    const result = await callTool(deps, 'take_photo', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cancelled/i);
  });
});

describe('get_location', () => {
  it('returns a single location fix with coordinates', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'get_location', {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('latitude=23.8103');
    expect(result.structuredContent).toMatchObject({ latitude: 23.8103, longitude: 90.4125, accuracyMeters: 22.5 });
  });

  it('fails closed when location permission is denied', async () => {
    const { deps } = fakeDeps({
      geolocation: {
        async requestPermissions() { return { location: 'denied' }; },
        async getCurrentPosition() { throw new Error('unreachable'); },
      },
    });
    const result = await callTool(deps, 'get_location', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/denied/);
  });
});

describe('vibrate', () => {
  it('vibrates with a clamped duration and rate limit', async () => {
    const { deps, calls } = fakeDeps();
    const client = clientFor(deps);
    const result = await client.callTool('vibrate', { durationMs: 500 });
    expect(result.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'vibrate')?.args).toEqual({ duration: 500 });

    const bad = await client.callTool('vibrate', { durationMs: 5000 });
    expect(bad.isError).toBe(true);

    // Every dispatched call consumes a rate slot, even one that fails validation.
    await client.callTool('vibrate', {});
    await client.callTool('vibrate', {});
    const limited = await client.callTool('vibrate', {});
    expect(limited.isError).toBe(true);
    expect(textOf(limited)).toMatch(/Rate limit/);
  });
});

describe('share', () => {
  it('opens the share sheet and treats cancel as success-with-note', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'share', { title: 'Report', text: 'Hello', url: 'https://example.com/x' });
    expect(result.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'share')?.args).toMatchObject({ text: 'Hello' });
  });

  it('requires text or url and validates the url scheme', async () => {
    const { deps } = fakeDeps();
    expect((await callTool(deps, 'share', { title: 'x' })).isError).toBe(true);
    const bad = await callTool(deps, 'share', { text: 'x', url: 'javascript:alert(1)' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/https/);
  });
});

describe('network_status', () => {
  it('reports connectivity', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'network_status', {});
    expect(textOf(result)).toContain('online');
    expect(result.structuredContent).toEqual({ connected: true, connectionType: 'wifi' });
  });
});

describe('alarms', () => {
  it('schedules an exact alarm from inSeconds and validates inputs', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'schedule_alarm', { id: 'wake-up', title: 'Stand up', inSeconds: 120, fullScreen: true });
    expect(result.isError).toBeFalsy();
    const schedule = calls.find((entry) => entry.method === 'scheduleAlarm');
    expect(schedule?.args).toMatchObject({ id: 'wake-up', title: 'Stand up', fullScreen: true });
    expect(schedule?.args.at).toBe(1_000_000 + 120_000);

    expect((await callTool(deps, 'schedule_alarm', { id: 'x', title: 't', atEpochMs: 5, inSeconds: 10 })).isError).toBe(true);
    expect(textOf(await callTool(deps, 'schedule_alarm', { id: 'x', title: 't', atEpochMs: 500 }))).toMatch(/past/);
    expect(textOf(await callTool(deps, 'schedule_alarm', { id: 'x', title: 't', inSeconds: 10 }))).toMatch(/between 30/);
    expect((await callTool(deps, 'schedule_alarm', { id: 'bad id!', title: 't', inSeconds: 60 })).isError).toBe(true);
  });

  it('lists and cancels alarms', async () => {
    const { deps, calls } = fakeDeps();
    const list = await callTool(deps, 'list_alarms', {});
    expect(list.isError).toBeFalsy();
    expect(textOf(list)).toContain('a1');
    const cancel = await callTool(deps, 'cancel_alarm', { id: 'a1' });
    expect(cancel.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'cancelAlarm')?.args).toEqual({ id: 'a1' });
  });
});

describe('open_url', () => {
  it('opens only public https urls', async () => {
    const { deps, calls } = fakeDeps();
    const ok = await callTool(deps, 'open_url', { url: 'https://example.com/page' });
    expect(ok.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'openUrl')?.args.url).toBe('https://example.com/page');

    for (const url of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://localhost/x', 'https://192.168.1.4/x']) {
      const bad = await callTool(deps, 'open_url', { url });
      expect(bad.isError, `${url} must be rejected`).toBe(true);
    }
  });

  it('rate limits how many pages the model may open per minute', async () => {
    const { deps } = fakeDeps();
    const client = clientFor(deps);
    for (let index = 0; index < 6; index += 1) {
      expect((await client.callTool('open_url', { url: `https://example.com/${index}` })).isError).toBeFalsy();
    }
    expect((await client.callTool('open_url', { url: 'https://example.com/7' })).isError).toBe(true);
  });
});

describe('web_search', () => {
  it('parses Bing results first and reports the source', async () => {
    const { deps, calls } = fakeDeps();
    (deps as any).queueFetch(BING_HTML);
    const result = await callTool(deps, 'web_search', { query: 'capacitor' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('source: bing');
    expect(textOf(result)).toContain('https://en.wikipedia.org/wiki/Capacitor');
    expect(textOf(result)).toContain('stores electrical energy');
    expect(calls.filter((entry) => entry.method === 'fetch')).toHaveLength(1);
    expect((result.structuredContent as { results: unknown[] }).results).toHaveLength(2);
  });

  it('falls back to DuckDuckGo html when Bing returns nothing', async () => {
    const { deps } = fakeDeps();
    (deps as any).queueFetch('<html><body>No results</body></html>');
    (deps as any).queueFetch(DDG_HTML);
    const result = await callTool(deps, 'web_search', { query: 'capacitor' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('source: duckduckgo');
    // the uddg redirect is decoded to the real URL
    expect(textOf(result)).toContain('https://en.wikipedia.org/wiki/Electric_capacitor');
  });

  it('skips a DuckDuckGo anomaly page and uses instant answers', async () => {
    const { deps } = fakeDeps();
    (deps as any).queueFetch('');
    (deps as any).queueFetch(DDG_ANOMALY);
    (deps as any).queueFetch(IA_JSON);
    const result = await callTool(deps, 'web_search', { query: 'python language' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('source: duckduckgo_instant_answers');
    expect(textOf(result)).toContain('high-level, general-purpose');
  });

  it('fails with guidance when every source is silent', async () => {
    const { deps } = fakeDeps();
    (deps as any).queueFetch('');
    (deps as any).queueFetch('');
    (deps as any).queueFetch('');
    const result = await callTool(deps, 'web_search', { query: 'nothing' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No search source answered/);
  });

  it('rate limits to 6 searches per minute on one transport', async () => {
    const { deps } = fakeDeps();
    const client = clientFor(deps);
    for (let index = 0; index < 6; index += 1) {
      (deps as any).queueFetch(BING_HTML);
      const ok = await client.callTool('web_search', { query: `q${index}` });
      expect(ok.isError).toBeFalsy();
    }
    const limited = await client.callTool('web_search', { query: 'q7' });
    expect(limited.isError).toBe(true);
    expect(textOf(limited)).toMatch(/Rate limit/);
  });
});

describe('download_file', () => {
  it('downloads into the workspace downloads directory', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'download_file', { url: 'https://example.com/report.pdf', fileName: 'report.pdf' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('downloads/report.pdf');
    const download = calls.find((entry) => entry.method === 'downloadFile');
    expect(download?.args.path).toMatch(/^file:\/\/\/data\/user\/0\/dev\.nativekit\.shell\/files\/agent\/workspace\/downloads\/report\.pdf$/);
    expect(result.structuredContent).toMatchObject({ path: 'downloads/report.pdf' });
  });

  it('rejects unsafe names and non-https urls', async () => {
    const { deps } = fakeDeps();
    expect((await callTool(deps, 'download_file', { url: 'https://example.com/x', fileName: '../escape' })).isError).toBe(true);
    expect((await callTool(deps, 'download_file', { url: 'http://example.com/x', fileName: 'a.pdf' })).isError).toBe(true);
  });
});

describe('upload_file', () => {
  it('stats the workspace file and uploads it natively', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'upload_file', { path: 'photos/receipt.jpg', url: 'https://example.com/upload' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('HTTP 201');
    const stat = calls.find((entry) => entry.method === 'stat');
    expect(stat?.args.path).toBe('agent/workspace/photos/receipt.jpg');
    const upload = calls.find((entry) => entry.method === 'uploadFile');
    expect(upload?.args.path).toMatch(/^file:\/\/\/.*agent\/workspace\/photos\/receipt\.jpg$/);
  });

  it('rejects path traversal', async () => {
    const { deps } = fakeDeps();
    expect((await callTool(deps, 'upload_file', { path: '../secrets', url: 'https://example.com/u' })).isError).toBe(true);
  });
});

describe('toast and app info', () => {
  it('shows an in-app toast', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'toast', { message: 'কাজ শেষ!' });
    expect(result.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'toast')?.args.message).toBe('কাজ শেষ!');
  });

  it('reports app metadata', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'app_info', {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('version=1.4.17');
    expect(textOf(result)).toContain('NativeKit TestLab');
  });
});

describe('stop_ringing', () => {
  it('stops the ringing alarm with or without an id', async () => {
    const { deps, calls } = fakeDeps();
    expect((await callTool(deps, 'stop_ringing', { id: 'wake' })).isError).toBeFalsy();
    expect((await callTool(deps, 'stop_ringing', {})).isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'stopRinging')?.args).toEqual({ id: 'wake' });
  });
});

describe('floating ui', () => {
  it('shows an html overlay after the permission check', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'show_floating_ui', { html: '<b>hi</b>', width: 300, height: 200 });
    expect(result.isError).toBeFalsy();
    const shown = calls.find((entry) => entry.method === 'showFloating');
    expect(shown?.args).toMatchObject({ html: '<b>hi</b>', width: 300, height: 200 });
  });

  it('fails closed when the overlay permission is not granted', async () => {
    const { deps, calls } = fakeDeps();
    (deps as any).setOverlay(false);
    const result = await callTool(deps, 'show_floating_ui', { html: '<b>hi</b>' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/overlay/i);
    expect(calls.find((entry) => entry.method === 'requestOverlayPermission')).toBeTruthy();
  });

  it('caps the html size and rate limits shows', async () => {
    const { deps } = fakeDeps();
    expect((await callTool(deps, 'show_floating_ui', { html: 'x'.repeat(100_001) })).isError).toBe(true);
    const client = clientFor(deps);
    for (let index = 0; index < 3; index += 1) {
      expect((await client.callTool('show_floating_ui', { html: `<p>${index}</p>` })).isError).toBeFalsy();
    }
    expect((await client.callTool('show_floating_ui', { html: '<p>4</p>' })).isError).toBe(true);
  });

  it('updates data and options, then hides', async () => {
    const { deps, calls } = fakeDeps();
    const update = await callTool(deps, 'update_floating_ui', { data: { value: 42 }, title: 'Live' });
    expect(update.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'sendToFloating')?.args).toEqual({ data: { value: 42 } });
    expect(calls.find((entry) => entry.method === 'updateFloating')?.args).toEqual({ title: 'Live' });
    expect((await callTool(deps, 'update_floating_ui', {})).isError).toBe(true);
    expect((await callTool(deps, 'hide_floating_ui', {})).isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'hideFloating')).toBeTruthy();
  });
});

describe('widgets', () => {
  it('sets a native card widget and reloads it', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'set_widget', { kind: 'agent-dashboard', value: '24°', title: 'Dhaka', progress: 40 });
    expect(result.isError).toBeFalsy();
    const config = calls.find((entry) => entry.method === 'setConfig')?.args;
    expect(config.kind).toBe('agent-dashboard');
    expect(config.config).toMatchObject({ value: '24°', title: 'Dhaka', progress: 40 });
    expect(calls.find((entry) => entry.method === 'reload')?.args).toEqual({ kind: 'agent-dashboard' });
  });

  it('sets an html snapshot widget and validates inputs', async () => {
    const { deps } = fakeDeps();
    const html = await callTool(deps, 'set_widget', { kind: 'notes', html: '<p>hello</p>' });
    expect(html.isError).toBeFalsy();
    expect((await callTool(deps, 'set_widget', { kind: 'bad kind!' })).isError).toBe(true);
    expect((await callTool(deps, 'set_widget', { kind: 'x', value: 'v', backgroundColor: 'red' })).isError).toBe(true);
    expect((await callTool(deps, 'set_widget', { kind: 'x' })).isError).toBe(true);
  });

  it('requests a pin and reports the outcome', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'pin_widget', { kind: 'agent-dashboard' });
    expect(result.isError).toBeFalsy();
    expect(calls.find((entry) => entry.method === 'requestPin')?.args).toEqual({ kind: 'agent-dashboard' });
  });
});

describe('phase 2: speech, scanner and hardware tools', () => {
  it('speaks with clamped pitch and rate, and warns when the voice is missing', async () => {
    const { deps, calls } = fakeDeps();
    const ok = await callTool(deps, 'speak', { text: 'স্বাগতম', language: 'bn-BD', pitch: 5, rate: 0.1 });
    expect(textOf(ok)).toBe('Speaking.');
    expect(calls.find((c) => c.method === 'ttsSpeak')?.args).toMatchObject({ text: 'স্বাগতম', language: 'bn-BD', pitch: 2, rate: 0.5 });
  });

  it('refuses to speak with a missing voice and returns install guidance', async () => {
    const { deps } = fakeDeps({ extras: {
      ttsSpeak: async () => ({ queued: false, languageSupported: false }),
      ttsStop: async () => {},
      listenSpeech: async () => ({ text: '' }),
      scanQrCode: async () => ({ text: '' }),
      dialPhone: async () => {},
      composeSms: async () => {},
      setTorch: async () => {},
      batteryStatus: async () => ({}),
      pickDocument: async () => ({ path: 'picked/x' }),
    } });
    const result = await callTool(deps, 'speak', { text: 'hello' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No bn-BD voice is installed');
    expect(textOf(result)).toContain('Text-to-speech output');
  });

  it('stops speaking and listens with a clamped timeout', async () => {
    const { deps, calls } = fakeDeps();
    await callTool(deps, 'stop_speaking', {});
    const heard = await callTool(deps, 'listen', { timeoutMs: 999999 });
    expect(textOf(heard)).toContain('ঢাকার আবহাওয়া ভালো');
    const listenCall = calls.find((c) => c.method === 'listenSpeech');
    expect(listenCall?.args.timeoutMs).toBe(25000);
    expect(calls.some((c) => c.method === 'ttsStop')).toBe(true);
  });

  it('scans a qr code and reports the format', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'scan_qr', {});
    expect(textOf(result)).toContain('https://example.com/qr');
    expect(result.structuredContent).toMatchObject({ text: 'https://example.com/qr', format: 'QR_CODE' });
  });

  it('opens the dialer and rejects malformed numbers', async () => {
    const { deps, calls } = fakeDeps();
    const ok = await callTool(deps, 'dial_phone', { number: '+880 1712-000000' });
    expect(textOf(ok)).toContain('Dialer opened');
    expect(calls.find((c) => c.method === 'dialPhone')?.args).toMatchObject({ number: '+880 1712-000000' });
    const bad = await callTool(deps, 'dial_phone', { number: '880;drop table' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('may only contain digits');
  });

  it('composes an sms with a body', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'compose_sms', { number: '+8801712000000', body: 'হ্যালো' });
    expect(textOf(result)).toContain('SMS composer opened');
    expect(calls.find((c) => c.method === 'composeSms')?.args).toMatchObject({ number: '+8801712000000', body: 'হ্যালো' });
  });

  it('toggles the torch and reports the battery', async () => {
    const { deps, calls } = fakeDeps();
    const torch = await callTool(deps, 'torch', { on: true });
    expect(textOf(torch)).toBe('Torch on.');
    expect(calls.find((c) => c.method === 'setTorch')?.args).toMatchObject({ on: true });
    const battery = await callTool(deps, 'battery_status', {});
    expect(textOf(battery)).toContain('73%');
    expect(textOf(battery)).toContain('charging');
    const missing = await callTool(deps, 'torch', {});
    expect(missing.isError).toBe(true);
  });

  it('picks a document into the workspace picked directory', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'pick_file', {});
    expect(textOf(result)).toContain("picked/report.pdf");
    expect(result.structuredContent).toMatchObject({ path: 'picked/report.pdf', bytes: 20480 });
  });
});

describe('ask_user', () => {
  it('returns the chosen option', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'ask_user', { question: 'কোন ভাষায় উত্তর দেব?', options: ['বাংলা', 'English'] });
    expect(textOf(result)).toContain('বাংলা');
    expect(result.structuredContent).toMatchObject({ answered: true, answer: 'বাংলা', index: 0 });
    expect(calls.find((c) => c.method === 'askUser')?.args.options).toEqual(['বাংলা', 'English']);
  });

  it('reports when the user does not answer', async () => {
    const { deps } = fakeDeps();
    (deps as any).scriptAskUser(() => null);
    const result = await callTool(deps, 'ask_user', { question: 'আছো?', options: ['হ্যাঁ', 'না'] });
    expect(textOf(result)).toContain('did not answer');
    expect(result.structuredContent).toMatchObject({ answered: false });
  });

  it('needs at least two options', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'ask_user', { question: 'q', options: ['একটাই'] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('2–6');
  });
});

describe('zip_files and unzip_file', () => {
  it('zips workspace files and round-trips the content', async () => {
    const { deps } = fakeDeps();
    (deps as any).putFile('notes/a.txt', 'প্রথম লাইন');
    (deps as any).putFile('notes/b.txt', 'second line');
    const zipped = await callTool(deps, 'zip_files', { paths: ['notes/a.txt', 'notes/b.txt'], output: 'bundle.zip' });
    expect(textOf(zipped)).toContain('Zipped 2 file(s)');
    const stored = (deps as any).readStoredFile('agent/workspace/bundle.zip') as string;
    const entries = unzipSync(new Uint8Array(Buffer.from(stored, 'base64')));
    expect(Buffer.from(entries['notes/a.txt']).toString('utf8')).toBe('প্রথম লাইন');
    expect(Buffer.from(entries['notes/b.txt']).toString('utf8')).toBe('second line');
  });

  it('unzips an archive into a directory and skips traversal entries', async () => {
    const { deps } = fakeDeps();
    const archive = zipSync({
      'index.html': new TextEncoder().encode('<h1>hi</h1>'),
      'style.css': new TextEncoder().encode('body{color:#123}'),
      '../evil.txt': new TextEncoder().encode('nope'),
    });
    (deps as any).putFileBase64('app.zip', Buffer.from(archive).toString('base64'));
    const result = await callTool(deps, 'unzip_file', { path: 'app.zip', outputDir: 'site' });
    expect(textOf(result)).toContain('Extracted 2 file(s)');
    const html = (deps as any).readStoredFile('agent/workspace/site/index.html') as string;
    expect(Buffer.from(html, 'base64').toString('utf8')).toBe('<h1>hi</h1>');
    expect((deps as any).readStoredFile('agent/workspace/evil.txt')).toBeUndefined();
  });

  it('validates paths and outputs', async () => {
    const { deps } = fakeDeps();
    const traversal = await callTool(deps, 'zip_files', { paths: ['../escape.txt'], output: 'x.zip' });
    expect(traversal.isError).toBe(true);
    (deps as any).putFile('doc.txt', 'x');
    const notZip = await callTool(deps, 'zip_files', { paths: ['doc.txt'], output: 'archive.tar' });
    expect(notZip.isError).toBe(true);
    const missing = await callTool(deps, 'unzip_file', { path: 'ghost.zip' });
    expect(missing.isError).toBe(true);
  });
});

describe('sql_query', () => {
  it('routes reads to query and writes to run on the agent database', async () => {
    const { deps, calls } = fakeDeps();
    const read = await callTool(deps, 'sql_query', { sql: 'SELECT * FROM notes WHERE title LIKE ?', params: ['%বাংলা%'] });
    expect(textOf(read)).toContain('2 row(s)');
    expect(calls.find((c) => c.method === 'sqlite.query')?.args).toMatchObject({ name: 'agent_tools', values: ['%বাংলা%'] });
    const write = await callTool(deps, 'sql_query', { sql: "INSERT INTO notes (title) VALUES (?)", params: ['নতুন'] });
    expect(textOf(write)).toContain('Rows affected: 3');
    expect(calls.find((c) => c.method === 'sqlite.run')?.args).toMatchObject({ name: 'agent_tools' });
  });

  it('rejects multi-statement sql and non-array params', async () => {
    const { deps } = fakeDeps();
    const multi = await callTool(deps, 'sql_query', { sql: 'DROP TABLE x; DROP TABLE y' });
    expect(multi.isError).toBe(true);
    expect(textOf(multi)).toContain('single statement');
    const badParams = await callTool(deps, 'sql_query', { sql: 'SELECT 1', params: 'nope' });
    expect(badParams.isError).toBe(true);
  });
});

describe('nearby tools', () => {
  it('advertises after permissions', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'nearby_advertise', { title: 'আমার ফোন' });
    expect(textOf(result)).toContain('Advertising started');
    expect(calls.find((c) => c.method === 'nearby.startAdvertising')?.args).toMatchObject({ endpointName: 'আমার ফোন' });
  });

  it('discovers endpoints, drops lost ones and stops scanning', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = fakeDeps();
      const pending = callTool(deps, 'nearby_discover', { durationSeconds: 2 });
      await vi.advanceTimersByTimeAsync(2200);
      const result = await pending;
      expect(textOf(result)).toContain('Found 1 endpoint(s)');
      expect(result.structuredContent).toMatchObject({ endpoints: [{ endpointId: 'E1', endpointName: 'Pixel Agent' }] });
      expect(calls.some((c) => c.method === 'nearby.stopDiscovery')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connects when the endpoint accepts', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'nearby_connect', { endpointId: 'E1' });
    expect(textOf(result)).toContain('Connected to endpoint E1');
    expect(calls.find((c) => c.method === 'nearby.requestConnection')?.args).toMatchObject({ endpointID: 'E1' });
  });

  it('accepts and sends messages', async () => {
    const { deps, calls } = fakeDeps();
    const accept = await callTool(deps, 'nearby_accept', { endpointId: 'E1' });
    expect(textOf(accept)).toContain('Accepted');
    const send = await callTool(deps, 'nearby_send', { endpointId: 'E1', text: 'হ্যালো প্রতিবেশী' });
    expect(textOf(send)).toContain('Sent to E1');
    expect(calls.find((c) => c.method === 'nearby.sendPayload')?.args).toMatchObject({ endpointID: 'E1', payload: 'হ্যালো প্রতিবেশী' });
  });

  it('reports nearby status', async () => {
    const { deps } = fakeDeps();
    const result = await callTool(deps, 'nearby_status', {});
    expect(textOf(result)).toContain('advertising');
  });
});

describe('stage_miniapp', () => {
  it('installs workspace files as a mini-app and launches it', async () => {
    const { deps, calls } = fakeDeps();
    (deps as any).putFile('mini/index.html', '<h1>অ্যাপ</h1>');
    (deps as any).putFile('mini/app.js', 'console.log(1)');
    const result = await callTool(deps, 'stage_miniapp', { name: 'Test Mini App', files: ['mini/index.html', 'mini/app.js'] });
    expect(textOf(result)).toContain("Mini-app 'Test Mini App' installed and launched");
    const install = calls.find((c) => c.method === 'miniapp.install');
    expect(install?.args.manifest).toMatchObject({ id: 'agent.test-mini-app', name: 'Test Mini App', entry: 'mini/index.html' });
    expect(install?.args.files).toHaveLength(2);
    expect(calls.find((c) => c.method === 'miniapp.launch')?.args).toMatchObject({ appId: 'agent.test-mini-app' });
  });

  it('explains when a same-id mini-app with different bytes was installed disabled', async () => {
    const { deps } = fakeDeps();
    (deps as any).putFile('mini/index.html', '<p>v2</p>');
    (deps.miniapp as any).install = async () => ({ id: 'agent.dup', policy: { enabled: false } });
    const result = await callTool(deps, 'stage_miniapp', { name: 'Dup', files: ['mini/index.html'] });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("'agent.dup'");
    expect(text).toContain('DISABLED');
    expect(text).toContain('different');
    // The launch must not be attempted after a disabled install.
    const callsUsed = (deps as any);
    expect(callsUsed).toBeTruthy();
  });

  it('passes requested capabilities into the manifest and validates them', async () => {
    const { deps, calls } = fakeDeps();
    (deps as any).putFile('mini/index.html', '<p>where am I</p>');
    const result = await callTool(deps, 'stage_miniapp', { name: 'Loc App', files: ['mini/index.html'], capabilities: ['location', 'permissions'] });
    expect(result.isError ?? false).toBe(false);
    const install = calls.find((c) => c.method === 'miniapp.install');
    expect(install?.args.manifest).toMatchObject({ requestedCapabilities: ['location', 'permissions'] });
    expect(textOf(result)).toContain('Requested capabilities: location, permissions');

    const bad = await callTool(deps, 'stage_miniapp', { name: 'Bad', files: ['mini/index.html'], capabilities: ['teleport'] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('not a mini-app capability');

    const none = await callTool(deps, 'stage_miniapp', { name: 'Plain', files: ['mini/index.html'] });
    expect(none.isError ?? false).toBe(false);
    const plainInstall = calls.filter((c) => c.method === 'miniapp.install').at(-1);
    expect(plainInstall?.args.manifest.requestedCapabilities).toEqual([]);
    expect(textOf(none)).toContain('No device capabilities were requested');
  });

  it('attaches the iframe-fallback host to the document with a close bar and reports the fallback renderer', async () => {
    // The isolated renderer can be unavailable (API < 28, another session open);
    // the browser then falls back to an iframe rendered inside the launch host.
    // A detached host made that fallback invisible while the tool said success.
    const created: any[] = [];
    const fakeDoc = {
      createElement: () => {
        const el: any = { style: {}, children: [], removed: false, listeners: {},
          setAttribute() {}, prepend(child: any) { el.children.unshift(child); },
          addEventListener(type: string, fn: any) { (el.listeners[type] ??= []).push(fn); },
          remove() { el.removed = true; } };
        created.push(el);
        return el;
      },
      body: { appended: [] as any[], appendChild(el: any) { this.appended.push(el); } },
    };
    (globalThis as any).document = fakeDoc;
    try {
      const { deps } = fakeDeps();
      (deps as any).putFile('mini/index.html', '<p>hi</p>');
      (deps.miniapp as any).launch = async () => ({ renderer: 'iframe', frame: { style: {} }, stop: () => undefined });
      const result = await callTool(deps, 'stage_miniapp', { name: 'Fallback', files: ['mini/index.html'] });
      expect(result.isError ?? false).toBe(false);
      expect(textOf(result)).toContain('in the in-app fallback frame');
      expect(fakeDoc.body.appended).toHaveLength(1);
      const host = fakeDoc.body.appended[0];
      expect(host).toBe(created[0]);
      expect(host.removed).toBe(false);
      expect(host.style.position).toBe('fixed');
      expect(host.children.some((child: any) => child.listeners.click?.length)).toBe(true);
    } finally { delete (globalThis as any).document; }
  });

  it('removes the host when the isolated renderer launches (the activity is the UI)', async () => {
    const fakeDoc: any = {
      createElement: () => ({ style: {}, children: [], removed: false, setAttribute() {}, prepend(child: any) { (this as any).children.unshift(child); }, addEventListener() {}, remove() { (this as any).removed = true; } }),
      body: { appended: [] as any[], appendChild(el: any) { this.appended.push(el); } },
    };
    (globalThis as any).document = fakeDoc;
    try {
      const { deps } = fakeDeps();
      (deps as any).putFile('mini/index.html', '<p>ok</p>');
      (deps.miniapp as any).launch = async () => ({ renderer: 'isolated', stop: () => undefined });
      const result = await callTool(deps, 'stage_miniapp', { name: 'Iso', files: ['mini/index.html'] });
      expect(textOf(result)).toContain('in the isolated app browser');
      expect(fakeDoc.body.appended).toHaveLength(1);
      expect(fakeDoc.body.appended[0].removed).toBe(true);
    } finally { delete (globalThis as any).document; }
  });

  it('cleans the host up when launch fails', async () => {
    const fakeDoc: any = {
      createElement: () => ({ style: {}, children: [], removed: false, setAttribute() {}, prepend(child: any) { (this as any).children.unshift(child); }, addEventListener() {}, remove() { (this as any).removed = true; } }),
      body: { appended: [] as any[], appendChild(el: any) { this.appended.push(el); } },
    };
    (globalThis as any).document = fakeDoc;
    try {
      const { deps } = fakeDeps();
      (deps as any).putFile('mini/index.html', '<p>x</p>');
      (deps.miniapp as any).launch = async () => { throw new Error('Another isolated browser session is already open'); };
      const result = await callTool(deps, 'stage_miniapp', { name: 'Boom', files: ['mini/index.html'] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Another isolated browser session is already open');
      expect(fakeDoc.body.appended).toHaveLength(1);
      expect(fakeDoc.body.appended[0].removed).toBe(true);
    } finally { delete (globalThis as any).document; }
  });

  it('validates the entry file and rejects path traversal', async () => {
    const { deps } = fakeDeps();
    (deps as any).putFile('mini/other.html', '<p>x</p>');
    const entry = await callTool(deps, 'stage_miniapp', { name: 'X', files: ['mini/other.html'], entryFile: 'nope.html' });
    expect(entry.isError).toBe(true);
    const traversal = await callTool(deps, 'stage_miniapp', { name: 'X', files: ['../etc/passwd'] });
    expect(traversal.isError).toBe(true);
    const badId = await callTool(deps, 'stage_miniapp', { name: 'X', files: ['mini/other.html'], appId: 'Bad Id!' });
    expect(badId.isError).toBe(true);
  });
});

describe('mini-app control', () => {
  it('lists installed mini-apps and running sessions', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'list_miniapps', {});
    expect(result.isError ?? false).toBe(false);
    const text = textOf(result);
    expect(text).toContain('agent.test-mini-app');
    expect(text).toContain('Test Mini App');
    expect(text).toContain('capabilities: location');
    expect(text).toContain('Running now: agent.test-mini-app (isolated)');
    expect(calls.some((c) => c.method === 'miniapp.list')).toBe(true);
    expect(calls.some((c) => c.method === 'miniapp.sessions')).toBe(true);
  });

  it('reports when nothing is installed', async () => {
    const { deps } = fakeDeps();
    (deps.miniapp as any).list = async () => [];
    const result = await callTool(deps, 'list_miniapps', {});
    expect(result.isError ?? false).toBe(false);
    expect(textOf(result)).toContain('No mini-apps are installed');
  });

  it('stops all mini-app sessions without removing them', async () => {
    const { deps, calls } = fakeDeps();
    const result = await callTool(deps, 'stop_miniapps', {});
    expect(result.isError ?? false).toBe(false);
    expect(textOf(result)).toContain('stopped');
    expect(textOf(result)).toContain('unchanged');
    expect(calls.some((c) => c.method === 'miniapp.stopAll')).toBe(true);
  });
});

describe('clipboard', () => {
  it('writes and reads the clipboard', async () => {
    const { deps, calls } = fakeDeps();
    const write = await callTool(deps, 'clipboard_write', { text: 'কপি করা টেক্সট' });
    expect(textOf(write)).toBe('Copied to the clipboard.');
    const read = await callTool(deps, 'clipboard_read', {});
    expect(textOf(read)).toContain('ক্লিপবোর্ডে রাখা টেক্সট');
    expect(calls.find((c) => c.method === 'clipboard.writeText')?.args).toMatchObject({ text: 'কপি করা টেক্সট' });
  });
});

describe('robustness', () => {
  it('answers unknown tools and malformed arguments with error results, never throws', async () => {
    const { deps } = fakeDeps();
    const unknown = await callTool(deps, 'no_such_tool', {});
    expect(unknown.isError).toBe(true);

    const malformed = await new Promise<any>((resolve) => {
      const transport = createDeviceToolsTransport(deps);
      transport
        .send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'notify', arguments: 'not-an-object' } })
        .then((response) => resolve((response as any).result));
    });
    // 'title' missing → validation error, but the call still resolves.
    expect(malformed.isError).toBe(true);
  });

  it('converts an unexpected plugin crash into an isError result', async () => {
    const { deps } = fakeDeps({
      network: { async getStatus() { throw new Error('radio exploded'); } },
    });
    const result = await callTool(deps, 'network_status', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('radio exploded');
  });

  it('provides real plugin defaults with an injectable clock', () => {
    const deps = defaultDeviceToolDeps();
    expect(typeof deps.now()).toBe('number');
    expect(typeof deps.openUrl).toBe('function');
    expect(deviceServerConfig()).toMatchObject({ name: DEVICE_SERVER_NAME, protocolVersion: 'auto' });
  });
});
