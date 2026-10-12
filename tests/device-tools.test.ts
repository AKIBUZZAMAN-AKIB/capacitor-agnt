import { describe, expect, it, vi } from 'vitest';

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
      writeFile: record('writeFile'),
      async getUri(options: any) {
        calls.push({ method: 'getUri', args: options });
        return { uri: `file:///data/user/0/dev.nativekit.shell/files/${options.path}` };
      },
      async stat(options: any) {
        calls.push({ method: 'stat', args: options });
        return { type: 'file', size: 4096 };
      },
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
function clientFor(deps: DeviceToolDeps, features: Record<string, boolean> = {}) {
  const transport = createDeviceToolsTransport(deps, { features });
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

  it('hides tools whose feature flag is disabled', async () => {
    const { deps } = fakeDeps();
    const tools = await clientFor(deps, { camera: false, advancedAlarms: false, widget: false, fileTransfer: false }).listTools();
    const names = tools.map((tool) => tool.name);
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
