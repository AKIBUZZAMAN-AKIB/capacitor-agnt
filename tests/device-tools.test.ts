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
    },
    filesystem: {
      mkdir: record('mkdir'),
      writeFile: record('writeFile'),
    },
    openUrl: (url: string) => calls.push({ method: 'openUrl', args: { url } }),
    now: () => clock,
    ...overrides,
  } as DeviceToolDeps & { now: () => number };
  (deps as any).advanceClock = (ms: number) => { clock += ms; };
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

// ── catalogue & wiring ──────────────────────────────────────────────────────

describe('device tools catalogue', () => {
  it('exposes a fixed, documented set of tools', () => {
    expect(deviceToolNames()).toEqual([
      'notify', 'take_photo', 'get_location', 'vibrate', 'share',
      'network_status', 'schedule_alarm', 'list_alarms', 'cancel_alarm', 'open_url',
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
    const tools = await clientFor(deps, { camera: false, advancedAlarms: false }).listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('take_photo');
    expect(names).not.toContain('schedule_alarm');
    expect(names).not.toContain('list_alarms');
    expect(names).not.toContain('cancel_alarm');
    expect(names).toContain('notify');
    expect(names).toContain('get_location');
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
