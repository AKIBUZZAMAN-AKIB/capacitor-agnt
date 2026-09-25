import { describe, expect, it, vi } from 'vitest';

import {
  HttpMcpTransport,
  MCP_PROTOCOL_VERSION,
  McpClient,
  McpError,
  connectMcpServers,
  lastSseJson,
  namespacedToolName,
  parseNamespacedToolName,
  type AgentLike,
  type McpTransport,
} from '../bridge/mcp-client';

// ── helpers ─────────────────────────────────────────────────────────────────

/** A scripted in-memory MCP server. */
function fakeServer(
  handlers: Record<string, (params: any) => unknown>,
  opts: { recordInto?: any[] } = {},
): McpTransport {
  return {
    async send(message: any) {
      opts.recordInto?.push(message);
      // A notification has no id and expects no response.
      if (message.id === undefined) return null;
      const handler = handlers[message.method];
      if (!handler) {
        return {
          jsonrpc: '2.0' as const,
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
      }
      return { jsonrpc: '2.0' as const, id: message.id, result: handler(message.params) };
    },
  };
}

function agentSpy() {
  const responses: Array<{ id: string; result: any; isError: boolean }> = [];
  let handler: ((payload: any) => void) | undefined;
  const agent: AgentLike & { emit(p: any): void; published: any[] } = {
    published: [],
    async startMcp(toolsJson: string) {
      agent.published = JSON.parse(toolsJson);
    },
    async respondToMcpTool(id: string, resultJson: string, isError?: boolean) {
      responses.push({ id, result: JSON.parse(resultJson), isError: Boolean(isError) });
    },
    addListener(_event: string, h: (payload: any) => void) {
      handler = h;
      return { remove: () => { handler = undefined; } };
    },
    emit(payload: any) {
      handler?.(payload);
    },
  };
  return { agent, responses };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── protocol handshake ──────────────────────────────────────────────────────

describe('McpClient handshake', () => {
  it('sends initialize then the required initialized notification', async () => {
    const sent: any[] = [];
    const client = new McpClient(
      'demo',
      fakeServer(
        { initialize: () => ({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'demo-server', version: '2.0' } }) },
        { recordInto: sent },
      ),
    );
    await client.connect();

    expect(sent[0].method).toBe('initialize');
    expect(sent[0].params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    // The spec requires this before any other request; servers may reject
    // everything until they get it.
    expect(sent[1].method).toBe('notifications/initialized');
    expect(sent[1].id).toBeUndefined();
    expect(client.describe()).toBe('demo-server 2.0');
  });

  it('is idempotent so a second connect does not re-handshake', async () => {
    const sent: any[] = [];
    const client = new McpClient('demo', fakeServer({ initialize: () => ({}) }, { recordInto: sent }));
    await client.connect();
    await client.connect();
    expect(sent.filter((m) => m.method === 'initialize')).toHaveLength(1);
  });

  it('surfaces a JSON-RPC error instead of returning undefined', async () => {
    const client = new McpClient('demo', fakeServer({}));
    await expect(client.connect()).rejects.toThrow(McpError);
  });
});

// ── tools/list ──────────────────────────────────────────────────────────────

describe('McpClient.listTools', () => {
  it('follows pagination to the end', async () => {
    const pages: Record<string, any> = {
      __first: { tools: [{ name: 'a' }], nextCursor: 'c1' },
      c1: { tools: [{ name: 'b' }], nextCursor: 'c2' },
      c2: { tools: [{ name: 'c' }] },
    };
    const client = new McpClient(
      'demo',
      fakeServer({
        initialize: () => ({}),
        'tools/list': (params: any) => pages[params?.cursor ?? '__first'],
      }),
    );
    await client.connect();
    // Stopping at page one would silently hide tools from the model.
    expect((await client.listTools()).map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('tolerates a server that returns no tools', async () => {
    const client = new McpClient('demo', fakeServer({ initialize: () => ({}), 'tools/list': () => ({}) }));
    await client.connect();
    expect(await client.listTools()).toEqual([]);
  });
});

// ── tools/call ──────────────────────────────────────────────────────────────

describe('McpClient.callTool', () => {
  it('sends name and arguments in the shape the spec defines', async () => {
    const sent: any[] = [];
    const client = new McpClient(
      'demo',
      fakeServer(
        {
          initialize: () => ({}),
          'tools/call': () => ({ content: [{ type: 'text', text: '16C' }] }),
        },
        { recordInto: sent },
      ),
    );
    await client.connect();
    const result = await client.callTool('weather', { city: 'Dhaka' });

    const call = sent.find((m) => m.method === 'tools/call');
    expect(call.params).toEqual({ name: 'weather', arguments: { city: 'Dhaka' } });
    expect(result.content[0]).toEqual({ type: 'text', text: '16C' });
  });

  it('preserves an isError result rather than throwing', async () => {
    const client = new McpClient(
      'demo',
      fakeServer({
        initialize: () => ({}),
        'tools/call': () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
      }),
    );
    await client.connect();
    const result = await client.callTool('x', {});
    // A tool-level failure is a normal result, not a protocol error — that is
    // what lets the model see it and self-correct.
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'nope' });
  });

  it('normalises a server that omits content', async () => {
    const client = new McpClient(
      'demo',
      fakeServer({ initialize: () => ({}), 'tools/call': () => ({ isError: true }) }),
    );
    await client.connect();
    const result = await client.callTool('x', {});
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.isError).toBe(true);
  });

  it('rejects a response whose id does not match the request', async () => {
    const client = new McpClient('demo', {
      async send(message: any) {
        if (message.id === undefined) return null;
        if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: {} };
        // Correlating this to our call would hand back another call's result.
        return { jsonrpc: '2.0', id: 9999, result: { content: [] } };
      },
    });
    await client.connect();
    await expect(client.callTool('x', {})).rejects.toThrow(/id mismatch/i);
  });
});

// ── transport ───────────────────────────────────────────────────────────────

describe('HttpMcpTransport', () => {
  const okJson = (body: unknown, headers: Record<string, string> = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => ({ 'content-type': 'application/json', ...headers })[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });

  it('posts JSON-RPC with the protocol header and parses the reply', async () => {
    const fetchImpl = vi.fn(async () => okJson({ jsonrpc: '2.0', id: 1, result: { ok: true } }) as any);
    const transport = new HttpMcpTransport('https://example.test/mcp', { fetchImpl: fetchImpl as any });
    const res = await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    const [, init] = fetchImpl.mock.calls[0] as any[];
    expect(init.method).toBe('POST');
    expect(init.headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION);
    expect(init.headers.accept).toContain('text/event-stream');
    expect(res?.result).toEqual({ ok: true });
  });

  it('captures the session id and echoes it on later requests', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return okJson({ jsonrpc: '2.0', id: call, result: {} }, call === 1 ? { 'mcp-session-id': 'sess-7' } : {}) as any;
    });
    const transport = new HttpMcpTransport('https://example.test/mcp', { fetchImpl: fetchImpl as any });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect((fetchImpl.mock.calls[0] as any[])[1].headers['mcp-session-id']).toBeUndefined();
    // Without echoing this the server loses all session state.
    expect((fetchImpl.mock.calls[1] as any[])[1].headers['mcp-session-id']).toBe('sess-7');
  });

  it('reads the response out of an SSE body', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"v":42}}\n\n';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      text: async () => sse,
    }) as any);
    const transport = new HttpMcpTransport('https://example.test/mcp', { fetchImpl: fetchImpl as any });
    expect((await transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }))?.result).toEqual({ v: 42 });
  });

  it('returns null for the 202 that answers a notification', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 202, headers: { get: () => null }, text: async () => '',
    }) as any);
    const transport = new HttpMcpTransport('https://example.test/mcp', { fetchImpl: fetchImpl as any });
    expect(await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('reports an HTTP failure with its status', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 503, headers: { get: () => null }, text: async () => 'upstream down',
    }) as any);
    const transport = new HttpMcpTransport('https://example.test/mcp', { fetchImpl: fetchImpl as any });
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'x' })).rejects.toThrow(/503/);
  });

  it('times out instead of hanging the agent turn', async () => {
    const fetchImpl = vi.fn((_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err: any = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }));
    const transport = new HttpMcpTransport('https://example.test/mcp', { fetchImpl: fetchImpl as any, timeoutMs: 20 });
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'x' })).rejects.toThrow(/timed out/i);
  });
});

describe('lastSseJson', () => {
  it('joins a payload split across several data lines', () => {
    // Truncating to the first data: line would corrupt any large response.
    expect(lastSseJson('data: {"a":\ndata: 1}\n\n')).toBe('{"a":\n1}');
  });

  it('takes the last frame and ignores comments/keepalives', () => {
    expect(lastSseJson(': keepalive\n\ndata: {"n":1}\n\ndata: {"n":2}\n\n')).toBe('{"n":2}');
  });

  it('returns null when there is no data frame', () => {
    expect(lastSseJson('event: ping\n\n')).toBeNull();
  });
});

// ── namespacing ─────────────────────────────────────────────────────────────

describe('tool namespacing', () => {
  it('round-trips', () => {
    expect(namespacedToolName('github', 'search')).toBe('github__search');
    expect(parseNamespacedToolName('github__search')).toEqual({ server: 'github', tool: 'search' });
  });

  it('keeps a tool name that itself contains the separator intact', () => {
    expect(parseNamespacedToolName('a__b__c')).toEqual({ server: 'a', tool: 'b__c' });
  });

  it('rejects names that are not namespaced', () => {
    for (const bad of ['search', '__search', 'github__', '']) {
      expect(parseNamespacedToolName(bad)).toBeNull();
    }
  });
});

// ── end-to-end wiring ───────────────────────────────────────────────────────

describe('connectMcpServers', () => {
  const weatherServer = () =>
    fakeServer({
      initialize: () => ({ serverInfo: { name: 'weather-srv' } }),
      'tools/list': () => ({ tools: [{ name: 'forecast', description: 'Get the forecast', inputSchema: { type: 'object' } }] }),
      'tools/call': (p: any) => ({ content: [{ type: 'text', text: `sunny in ${p.arguments.city}` }] }),
    });

  it('publishes namespaced tools to the agent', async () => {
    const { agent } = agentSpy();
    const conn = await connectMcpServers(agent, [{ name: 'weather', url: 'x' }], {
      makeTransport: weatherServer,
    });

    expect(conn.toolCount).toBe(1);
    expect(agent.published[0]).toMatchObject({
      name: 'weather__forecast',
      description: 'Get the forecast',
      // Background wakes have no WebView to execute these in.
      webviewOnly: true,
    });
    await conn.dispose();
  });

  it('routes a tool call to the right server and answers the engine', async () => {
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(agent, [{ name: 'weather', url: 'x' }], {
      makeTransport: weatherServer,
    });

    agent.emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 't1', toolName: 'weather__forecast', args: { city: 'Dhaka' } } });
    await flush();

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe('t1');
    expect(responses[0].result.content[0].text).toBe('sunny in Dhaka');
    expect(responses[0].isError).toBe(false);
    await conn.dispose();
  });

  it('keeps two servers separate even when they share a tool name', async () => {
    const make = (label: string) => () =>
      fakeServer({
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'search' }] }),
        'tools/call': () => ({ content: [{ type: 'text', text: `from ${label}` }] }),
      });
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(
      agent,
      [{ name: 'alpha', url: 'a' }, { name: 'beta', url: 'b' }],
      { makeTransport: (c) => (c.name === 'alpha' ? make('alpha')() : make('beta')()) },
    );

    expect(agent.published.map((t: any) => t.name)).toEqual(['alpha__search', 'beta__search']);
    agent.emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 't2', toolName: 'beta__search', args: {} } });
    await flush();
    // A flat catalogue would have shadowed one of these and routed to the wrong process.
    expect(responses[0].result.content[0].text).toBe('from beta');
    await conn.dispose();
  });

  it('still answers when the server call fails, so the turn is not stalled', async () => {
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(agent, [{ name: 'weather', url: 'x' }], {
      makeTransport: () =>
        fakeServer({
          initialize: () => ({}),
          'tools/list': () => ({ tools: [{ name: 'forecast' }] }),
          // no tools/call handler -> JSON-RPC "method not found"
        }),
    });

    agent.emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 't3', toolName: 'weather__forecast', args: {} } });
    await flush();

    expect(responses).toHaveLength(1);
    expect(responses[0].isError).toBe(true);
    expect(responses[0].result.content[0].text).toMatch(/failed/i);
    await conn.dispose();
  });

  it('answers with an error for a tool whose server is not connected', async () => {
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(agent, [], {});
    agent.emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 't4', toolName: 'ghost__tool', args: {} } });
    await flush();
    expect(responses[0].isError).toBe(true);
    expect(responses[0].result.content[0].text).toMatch(/No connected MCP server/);
    await conn.dispose();
  });

  it('accepts a JSON string payload and JSON string args', async () => {
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(agent, [{ name: 'weather', url: 'x' }], {
      makeTransport: weatherServer,
    });
    // Native bridges deliver the payload as a JSON string.
    agent.emit({
      eventType: 'mcp_tool_call',
      payload: JSON.stringify({ tool_call_id: 't5', tool_name: 'weather__forecast', args: '{"city":"Kabul"}' }),
    });
    await flush();
    expect(responses[0].result.content[0].text).toBe('sunny in Kabul');
    await conn.dispose();
  });

  it('one unreachable server does not stop the others', async () => {
    const { agent } = agentSpy();
    const conn = await connectMcpServers(
      agent,
      [{ name: 'broken', url: 'a' }, { name: 'weather', url: 'b' }],
      {
        makeTransport: (c) =>
          c.name === 'broken'
            ? { async send() { throw new Error('connection refused'); } }
            : weatherServer(),
      },
    );

    expect(conn.failures).toHaveLength(1);
    expect(conn.failures[0].server).toBe('broken');
    expect(agent.published.map((t: any) => t.name)).toEqual(['weather__forecast']);
    await conn.dispose();
  });

  it('stops answering after dispose', async () => {
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(agent, [{ name: 'weather', url: 'x' }], {
      makeTransport: weatherServer,
    });
    await conn.dispose();
    agent.emit({ eventType: 'mcp_tool_call', payload: { toolCallId: 't6', toolName: 'weather__forecast', args: {} } });
    await flush();
    expect(responses).toHaveLength(0);
  });

  it('ignores events that are not mcp_tool_call', async () => {
    const { agent, responses } = agentSpy();
    const conn = await connectMcpServers(agent, [{ name: 'weather', url: 'x' }], {
      makeTransport: weatherServer,
    });
    agent.emit({ eventType: 'text_delta', payload: { text: 'hi' } });
    await flush();
    expect(responses).toHaveLength(0);
    await conn.dispose();
  });
});
