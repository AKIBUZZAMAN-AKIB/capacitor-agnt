/**
 * A real Model Context Protocol client, and the glue that wires it to the
 * native agent.
 *
 * ## Why this exists
 *
 * The `capacitor-native-agent` plugin is NOT an MCP client. Its engine keeps a
 * catalogue of tool definitions and, when the model calls one, emits an
 * `mcp_tool_call` event and blocks the turn until `respondToMcpTool` answers.
 * Everything between that event and an actual MCP server — the transport, the
 * JSON-RPC framing, `initialize`, `tools/list`, `tools/call` — was left for the
 * app to write, with no guidance beyond the method names.
 *
 * This module is that missing half. It prefers the current stateless MCP
 * specification (2026-07-28) while retaining a deliberately isolated legacy
 * adapter for 2025-06-18 servers that still require initialize/session headers:
 *
 *   1. {@link McpClient} speaks JSON-RPC 2.0 to a server over a pluggable
 *      transport ({@link HttpMcpTransport} implements Streamable HTTP).
 *   2. {@link connectMcpServers} performs the handshake, merges every server's
 *      `tools/list` into one catalogue, publishes it with `startMcp`, and
 *      answers each `mcp_tool_call` by forwarding it as `tools/call`.
 *
 * ## Deliberate choices
 *
 *  * **Tool names are namespaced per server** (`server__tool`). Two servers may
 *    legitimately both expose `search`; without a prefix the second would
 *    silently shadow the first in a flat catalogue and calls would be routed to
 *    the wrong process.
 *  * **A failed call is answered, never dropped.** The engine blocks the whole
 *    turn on `respondToMcpTool` for up to 30 seconds, so every failure path
 *    here still replies — with an MCP-shaped `isError: true` result, which is
 *    what lets the model see the failure and self-correct.
 *  * **The engine owns result formatting.** We forward the server's
 *    `CallToolResult` verbatim; the engine flattens `content` and honours the
 *    inner `isError`.
 */

// ── Protocol types ───────────────────────────────────────────────────────────

/**
 * The old stateful wire revision. It remains exported because many hosted MCP
 * servers still use it and callers may opt in explicitly.
 */
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-06-18';
/** The current stateless Streamable HTTP revision. */
export const MCP_CURRENT_PROTOCOL_VERSION = '2026-07-28';
/** Backward-compatible name used by older callers/tests. */
export const MCP_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSION;
export type McpProtocolVersion = typeof MCP_LEGACY_PROTOCOL_VERSION | typeof MCP_CURRENT_PROTOCOL_VERSION;
export type McpProtocolMode = McpProtocolVersion | 'auto';

function isCurrentProtocol(value: McpProtocolVersion): boolean {
  return value === MCP_CURRENT_PROTOCOL_VERSION;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

/** The server's reply to `tools/call`. */
export interface McpCallToolResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Moves JSON-RPC messages to a server and back. */
export interface McpTransport {
  /** Send one request and resolve with the decoded JSON-RPC response. */
  send(message: Record<string, unknown>): Promise<JsonRpcResponse | null>;
  /** Clears a captured legacy session when a caller falls back/reconnects. */
  resetSession?(): void;
  close?(): Promise<void> | void;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

// ── Transport ───────────────────────────────────────────────────────────────

/**
 * Streamable HTTP transport.
 *
 * Posts JSON-RPC to a single endpoint. A server may answer with `application/
 * json` (one response) or `text/event-stream` (an SSE stream whose final `data:`
 * frame carries the response for our id) — both are part of the transport, so
 * both are handled. Notifications get HTTP 202 with no body, hence the
 * `null` return.
 *
 * `Mcp-Session-Id` is captured from the initialize response and echoed on every
 * later request, which is how the server keeps session state.
 */
export class HttpMcpTransport implements McpTransport {
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly options: {
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {}

  resetSession(): void {
    this.sessionId = null;
  }

  async send(message: Record<string, unknown>): Promise<JsonRpcResponse | null> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new McpError('No fetch implementation is available for the MCP transport');
    }

    const params = message.params as Record<string, unknown> | undefined;
    const meta = params?._meta as Record<string, unknown> | undefined;
    const protocolVersion = typeof meta?.['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? meta['io.modelcontextprotocol/protocolVersion'] as string
      : MCP_LEGACY_PROTOCOL_VERSION;
    const method = typeof message.method === 'string' ? message.method : '';
    const name = typeof params?.name === 'string'
      ? params.name
      : typeof params?.uri === 'string' ? params.uri : undefined;
    const legacy = protocolVersion === MCP_LEGACY_PROTOCOL_VERSION;
    const headers: Record<string, string> = {
      ...(this.options.headers ?? {}),
      // App-provided headers are intentionally added first. Authorization is
      // allowed, but no caller may downgrade/misroute a protocol request by
      // replacing these protocol-critical headers.
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      // MCP 2026-07-28 requires these mirrored routing headers. They are
      // harmless to a legacy endpoint and give a proxy enough information to
      // authorize before parsing a potentially large JSON body.
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
    };
    if (legacy && this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new McpError(`MCP transport request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let response: Response;
    try {
      // Native CapacitorHttp does not implement AbortSignal. Promise.race still
      // releases the agent turn at the advertised deadline; a late native reply
      // is ignored instead of blocking the model for the engine's full timeout.
      response = await Promise.race([
        doFetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (err) {
      if (err instanceof McpError) throw err;
      const reason = (err as Error)?.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : String((err as Error)?.message ?? err);
      throw new McpError(`MCP transport request failed: ${reason}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const captured = response.headers?.get?.('mcp-session-id');
    if (legacy && captured) this.sessionId = captured;

    if (!response.ok) {
      const body = await safeText(response);
      throw new McpError(`MCP server returned HTTP ${response.status}: ${truncate(body, 500)}`);
    }
    if (response.status === 202) return null;

    const contentType = response.headers?.get?.('content-type') ?? '';
    const raw = await safeText(response);
    if (!raw.trim()) return null;
    const payload = contentType.includes('text/event-stream') ? lastSseJson(raw) : raw;
    if (payload == null) return null;

    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      throw new McpError(`MCP server sent a non-JSON response: ${truncate(raw, 300)}`);
    }
  }
}

async function safeText(response: { text?: () => Promise<string> }): Promise<string> {
  try {
    return (await response.text?.()) ?? '';
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Pull the last JSON payload out of an SSE body.
 *
 * Frames are separated by a blank line and a payload may span several `data:`
 * lines, which the spec says to join with newlines. Taking only the first
 * `data:` line would truncate any response big enough to be split.
 */
export function lastSseJson(body: string): string | null {
  const frames = body.split(/\r?\n\r?\n/);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const dataLines = frames[i]
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (dataLines.length) return dataLines.join('\n');
  }
  return null;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class McpClient {
  private nextId = 1;
  private initialized = false;
  private protocol: McpProtocolVersion;
  private serverInfo: { name?: string; version?: string } = {};

  constructor(
    readonly name: string,
    private readonly transport: McpTransport,
    options: { protocolVersion?: McpProtocolMode } = {},
  ) {
    // The class keeps legacy default semantics for existing direct callers.
    // connectMcpServers explicitly uses `auto`, which means current MCP first.
    this.protocol = options.protocolVersion === MCP_CURRENT_PROTOCOL_VERSION || options.protocolVersion === 'auto'
      ? MCP_CURRENT_PROTOCOL_VERSION
      : MCP_LEGACY_PROTOCOL_VERSION;
  }

  private requestMeta(): Record<string, unknown> | undefined {
    if (!isCurrentProtocol(this.protocol)) return undefined;
    return {
      'io.modelcontextprotocol/protocolVersion': MCP_CURRENT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const meta = this.requestMeta();
    const finalParams = params || meta ? { ...(params ?? {}), ...(meta ? { _meta: meta } : {}) } : undefined;
    const response = await this.transport.send({ jsonrpc: '2.0', id, method, ...(finalParams ? { params: finalParams } : {}) });
    if (!response) throw new McpError(`MCP server sent no response to '${method}'`);
    if (response.error) {
      throw new McpError(`MCP server rejected '${method}': ${response.error.message}`, response.error.code, response.error.data);
    }
    if (response.id !== id) {
      throw new McpError(`MCP response id mismatch for '${method}' (sent ${id}, got ${String(response.id)})`);
    }
    return response.result;
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  /**
   * Connects a legacy server with initialize/initialized. The 2026 revision is
   * stateless and intentionally has no handshake or session header.
   */
  async connect(clientInfo: { name: string; version: string } = { name: 'nativekit', version: '1.0.0' }): Promise<void> {
    if (this.initialized) return;
    if (isCurrentProtocol(this.protocol)) {
      this.initialized = true;
      return;
    }
    const result = (await this.request('initialize', {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.serverInfo = result?.serverInfo ?? {};
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  private async useLegacyFallback(): Promise<void> {
    if (!isCurrentProtocol(this.protocol)) throw new McpError('MCP server rejected tools/list');
    this.protocol = MCP_LEGACY_PROTOCOL_VERSION;
    this.initialized = false;
    this.transport.resetSession?.();
    await this.connect();
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.connect();
    const collect = async (): Promise<McpToolDefinition[]> => {
      const tools: McpToolDefinition[] = [];
      let cursor: string | undefined;
      do {
        const page = (await this.request('tools/list', cursor ? { cursor } : undefined)) as
          | { tools?: McpToolDefinition[]; nextCursor?: string }
          | undefined;
        if (page?.tools?.length) tools.push(...page.tools);
        cursor = page?.nextCursor;
      } while (cursor);
      return tools;
    };
    try {
      return await collect();
    } catch (error) {
      // Auto/current deployments sometimes point at an older stateful server.
      // Fall back once, not on every page; the legacy handshake will expose a
      // meaningful error if the endpoint was simply unreachable or unauthorized.
      if (!isCurrentProtocol(this.protocol)) throw error;
      await this.useLegacyFallback();
      return collect();
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    await this.connect();
    const result = (await this.request('tools/call', { name, arguments: args ?? {} })) as McpCallToolResult;
    if (!result || !Array.isArray(result.content)) return { content: [], isError: Boolean(result?.isError) };
    return result;
  }

  describe(): string {
    const { name, version } = this.serverInfo;
    return name ? `${name}${version ? ` ${version}` : ''}` : this.name;
  }

  get protocolVersion(): McpProtocolVersion { return this.protocol; }

  async close(): Promise<void> { await this.transport.close?.(); }
}

// ── Agent wiring ────────────────────────────────────────────────────────────

/** The slice of `NativeKit.agent` this module needs. */
export interface AgentLike {
  startMcp(toolsJson: string): Promise<unknown>;
  respondToMcpTool(toolCallId: string, resultJson: string, isError?: boolean): Promise<unknown>;
  addListener?(event: string, handler: (payload: any) => void): { remove?: () => void } | void;
}

export interface McpServerConfig {
  /** Short, stable id — becomes the `<id>__` prefix on every tool name. */
  name: string;
  url: string;
  /** Runtime-only authorization headers. Persist bearer tokens in secure storage, never here. */
  headers?: Record<string, string>;
  /** `auto` tries current stateless MCP then falls back to legacy stateful MCP. */
  protocolVersion?: McpProtocolMode;
  /** Passed straight through to `startMcp` for each of this server's tools. */
  approvalPolicy?: 'always_allow' | 'always_ask' | 'always_ask_biometric';
  timeoutMs?: number;
}

export interface McpConnection {
  clients: McpClient[];
  toolCount: number;
  /** Errors from servers that failed to connect. Connecting is best-effort. */
  failures: Array<{ server: string; error: string }>;
  dispose(): Promise<void>;
}

function validateServerConfig(config: McpServerConfig, allowNonHttpsForInjectedTransport = false): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(config.name)) {
    throw new McpError(`MCP server name '${config.name}' must be 1–64 letters, digits, _ or - and start with a letter.`);
  }
  // Unit-test/in-process transports have no network boundary and commonly use
  // symbolic URLs such as `x`; retain strict URL checks for every real transport.
  if (!allowNonHttpsForInjectedTransport) {
    let url: URL;
    try { url = new URL(config.url); } catch { throw new McpError(`MCP server '${config.name}' has an invalid URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new McpError(`MCP server '${config.name}' must use a credential-free HTTPS URL.`);
    }
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000)) {
    throw new McpError(`MCP server '${config.name}' timeout must be an integer from 1,000 to 120,000 ms.`);
  }
}

/** `server__tool` — see the note on namespacing at the top of this file. */
export function namespacedToolName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

export function parseNamespacedToolName(value: string): { server: string; tool: string } | null {
  const at = value.indexOf('__');
  if (at <= 0 || at + 2 >= value.length) return null;
  return { server: value.slice(0, at), tool: value.slice(at + 2) };
}

/**
 * Connect to every configured MCP server, publish their tools to the agent, and
 * keep answering `mcp_tool_call` until {@link McpConnection.dispose} is called.
 */
export async function connectMcpServers(
  agent: AgentLike,
  servers: McpServerConfig[],
  options: {
    fetchImpl?: typeof fetch;
    makeTransport?: (config: McpServerConfig) => McpTransport;
    onLog?: (message: string) => void;
  } = {},
): Promise<McpConnection> {
  const log = options.onLog ?? (() => {});
  const clients: McpClient[] = [];
  const byServer = new Map<string, McpClient>();
  const failures: Array<{ server: string; error: string }> = [];
  const catalogue: Array<Record<string, unknown>> = [];

  for (const config of servers) {
    try {
      const transport =
        options.makeTransport?.(config) ??
        new HttpMcpTransport(config.url, {
          headers: config.headers,
          fetchImpl: options.fetchImpl,
          timeoutMs: config.timeoutMs,
        });
      validateServerConfig(config, Boolean(options.makeTransport));
      const requestedProtocol = config.protocolVersion ?? 'auto';
      const client = new McpClient(
        config.name,
        transport,
        { protocolVersion: requestedProtocol === 'auto' ? MCP_CURRENT_PROTOCOL_VERSION : requestedProtocol },
      );
      await client.connect();
      const tools = await client.listTools();

      for (const tool of tools) {
        catalogue.push({
          name: namespacedToolName(config.name, tool.name),
          description: tool.description ?? tool.title ?? `${tool.name} (via ${client.describe()})`,
          inputSchema: tool.inputSchema ?? { type: 'object' },
          // The WebView executes these, so they must not be offered to a
          // background wake that has no WebView to call into.
          webviewOnly: true,
          // Server-provided descriptions/annotations are untrusted. Every
          // remote MCP tool is therefore ask-by-default until its owner grants
          // a narrower policy from the app's permission UI.
          approvalPolicy: config.approvalPolicy ?? 'always_ask',
        });
      }

      clients.push(client);
      byServer.set(config.name, client);
      log(`MCP '${config.name}' connected (${client.describe()}) with ${tools.length} tool(s)`);
    } catch (err) {
      // One unreachable server must not take down the others.
      const message = String((err as Error)?.message ?? err);
      failures.push({ server: config.name, error: message });
      log(`MCP '${config.name}' failed: ${message}`);
    }
  }

  await agent.startMcp(JSON.stringify(catalogue));

  const listener = agent.addListener?.('nativeAgentEvent', (event: any) => {
    const type = event?.eventType ?? event?.type;
    if (type !== 'mcp_tool_call') return;
    let payload: any = event?.payload ?? event;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    void handleToolCall(agent, byServer, payload, log);
  });

  return {
    clients,
    toolCount: catalogue.length,
    failures,
    async dispose() {
      (listener as { remove?: () => void } | undefined)?.remove?.();
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    },
  };
}

/**
 * Forward one `mcp_tool_call` to its server and answer the engine.
 *
 * Every path answers. The engine blocks the model's turn on this reply, so a
 * thrown-away error would cost the user a 30-second stall and then a misleading
 * "timed out".
 */
async function handleToolCall(
  agent: AgentLike,
  byServer: Map<string, McpClient>,
  payload: { toolCallId?: string; tool_call_id?: string; toolName?: string; tool_name?: string; args?: unknown },
  log: (message: string) => void,
): Promise<void> {
  const toolCallId = payload?.toolCallId ?? payload?.tool_call_id;
  const fullName = payload?.toolName ?? payload?.tool_name ?? '';
  if (!toolCallId) return;

  const reply = async (result: McpCallToolResult) => {
    try {
      await agent.respondToMcpTool(toolCallId, JSON.stringify(result), Boolean(result.isError));
    } catch (err) {
      log(`failed to deliver the MCP result for ${toolCallId}: ${String((err as Error)?.message ?? err)}`);
    }
  };

  const errorResult = (text: string): McpCallToolResult => ({
    content: [{ type: 'text', text }],
    isError: true,
  });

  const parsed = parseNamespacedToolName(fullName);
  if (!parsed) return reply(errorResult(`'${fullName}' is not a namespaced MCP tool name.`));

  const client = byServer.get(parsed.server);
  if (!client) return reply(errorResult(`No connected MCP server named '${parsed.server}'.`));

  let args: Record<string, unknown> = {};
  const raw = payload?.args;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return reply(errorResult(`The arguments for '${fullName}' were not valid JSON.`));
    }
  } else if (raw && typeof raw === 'object') {
    args = raw as Record<string, unknown>;
  }

  try {
    const result = await client.callTool(parsed.tool, args);
    // Forwarded verbatim: the engine flattens `content` and honours `isError`.
    await reply(result);
  } catch (err) {
    await reply(errorResult(`MCP call '${fullName}' failed: ${String((err as Error)?.message ?? err)}`));
  }
}
