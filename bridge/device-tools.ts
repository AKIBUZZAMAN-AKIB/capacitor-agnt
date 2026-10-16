/**
 * Built-in device tools: the phone's own native APIs, exposed to the agent as
 * an in-process MCP "server".
 *
 * ## Why this exists
 *
 * The agent engine (`capacitor-native-agent`) already speaks MCP: a tool
 * catalogue is published with `startMcp`, the model's calls arrive as
 * `mcp_tool_call` events, and `respondToMcpTool` answers them. Remote MCP
 * servers (Composio, any hosted endpoint) plug in through
 * {@link connectMcpServers}. But the device itself — camera, location,
 * notifications, alarms, sharing — had no tool surface: the plugins exist on
 * `NativeKit`, yet the model could not reach them.
 *
 * This module closes that gap with the same plug point remote servers use:
 * a {@link McpTransport} that runs entirely in-process. No socket, no HTTP.
 * `connectMcpServers` cannot tell it apart from a hosted server, which is the
 * point — namespacing (`device__*`), the single `mcp_tool_call` listener, the
 * always-answer error contract, and per-tool approval all come for free, and
 * no second listener can ever race the MCP client for a tool answer.
 *
 * ## Security posture
 *
 *  * Every tool is published `webviewOnly` + `always_ask`: the engine asks the
 *    user for approval before dispatch, foreground only. The user can narrow
 *    or widen each tool later from the app's tool-permission UI, which is
 *    persisted server-side of this bridge and stays authoritative.
 *  * Feature flags from `app.config.json` gate what is even advertised:
 *    a disabled capability never reaches the model's schema list.
 *  * Nuisance tools (notify, vibrate, share, open_url, schedule_alarm) carry
 *    a sliding-window rate limit so an over-eager model cannot spam the user.
 *  * Photo bytes never enter the transcript: the engine flattens image blocks
 *    to a text marker, and the photo is persisted into the agent workspace
 *    where the agent's own file tools (and the user) can reach it.
 *  * `open_url` accepts public `https:` URLs only — no `file:`, `javascript:`,
 *    `data:` schemes and no loopback/private-range hosts.
 */

import {
  Camera,
  CameraResultType,
  CameraSource,
} from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import { Haptics } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';
import { Network } from '@capacitor/network';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { App } from '@capacitor/app';
import { NearbyConnections } from '@capacitor-trancee/nearby-connections';
import { Widget } from '@nativekit/widget';
import { NativeKitCustom } from '@nativekit/custom-native';
import { unzipSync, zipSync } from 'fflate';
import type {
  JsonRpcResponse,
  McpCallToolResult,
  McpToolDefinition,
  McpTransport,
} from './mcp-client';

// ── Public surface ───────────────────────────────────────────────────────────

/** The virtual MCP server name; every tool becomes `device__<tool>`. */
export const DEVICE_SERVER_NAME = 'device';

/** Feature flags that can hide individual device tools from the catalogue. */
export type DeviceToolFeature =
  | 'camera'
  | 'location'
  | 'localNotifications'
  | 'haptics'
  | 'sharing'
  | 'networkStatus'
  | 'advancedAlarms'
  | 'fileTransfer'
  | 'filesystem'
  | 'sqlite'
  | 'nearby'
  | 'appBrowser'
  | 'widget';

/**
 * The native capabilities this bridge needs, as bare structural types. The
 * defaults are the real Capacitor plugins; tests inject fakes. Methods are
 * wider than the vendor types (`any` options) on purpose so structural
 * assignment never fights optional vendor overloads.
 */
export interface DeviceToolDeps {
  camera: { getPhoto(options: any): Promise<{ base64String?: string; format?: string }> };
  geolocation: {
    requestPermissions(): Promise<Record<string, string>>;
    getCurrentPosition(options?: any): Promise<{
      coords: { latitude: number; longitude: number; accuracy: number; altitude?: number | null; heading?: number | null; speed?: number | null };
      timestamp: number;
    }>;
  };
  haptics: { vibrate(options?: any): Promise<void> };
  notifications: {
    requestPermissions(): Promise<Record<string, string>>;
    schedule(options: any): Promise<unknown>;
  };
  share: { share(options: any): Promise<unknown> };
  network: { getStatus(): Promise<{ connected: boolean; connectionType: string }> };
  alarms: {
    scheduleAlarm(options: any): Promise<unknown>;
    listAlarms(): Promise<{ alarms: unknown }>;
    cancelAlarm(options: { id: string }): Promise<void>;
    stopRinging(options?: { id?: string }): Promise<void>;
  };
  filesystem: {
    mkdir(options: any): Promise<void>;
    writeFile(options: any): Promise<void>;
    readFile(options: any): Promise<{ data: string }>;
    readdir(options: any): Promise<{ files: Array<{ name: string; type?: string; size?: number }> }>;
    getUri(options: any): Promise<{ uri: string }>;
    stat(options: any): Promise<{ size?: number; type?: string }>;
  };
  /** Phase 2 native extras from the custom plugin: speech, scanner, intents, torch, battery, picker. */
  extras: {
    ttsSpeak(options: any): Promise<{ queued?: boolean; languageSupported?: boolean }>;
    ttsStop(options?: any): Promise<void>;
    listenSpeech(options: any): Promise<{ text: string; confidence?: number }>;
    scanQrCode(options?: any): Promise<{ text: string; format?: string }>;
    dialPhone(options: { number: string }): Promise<void>;
    composeSms(options: { number: string; body?: string }): Promise<void>;
    setTorch(options: { on: boolean }): Promise<void>;
    batteryStatus(options?: any): Promise<{ percent?: number; charging?: boolean; plugged?: boolean }>;
    pickDocument(options?: any): Promise<{ path: string; bytes?: number }>;
  };
  /** Asks the user a question through the workspace UI; resolves null on timeout or dismissal. */
  askUser: (question: string, options: string[], timeoutMs: number) => Promise<{ answer: string; index: number } | null>;
  /** SQLite facade slice for sql_query (the agent-owned database). */
  sqlite: {
    query(name: string, statement: string, values?: any[]): Promise<{ values?: any[] }>;
    run(name: string, statement: string, values?: any[]): Promise<{ changes?: unknown }>;
  };
  /** Nearby Connections facade subset for peer-to-peer tools. */
  nearby: {
    initialize(options?: any): Promise<unknown>;
    startAdvertising(options?: any): Promise<unknown>;
    stopAdvertising(options?: any): Promise<unknown>;
    startDiscovery(options?: any): Promise<unknown>;
    stopDiscovery(options?: any): Promise<unknown>;
    requestConnection(options: any): Promise<unknown>;
    acceptConnection(options: any): Promise<unknown>;
    sendPayload(options: any): Promise<unknown>;
    status(options?: any): Promise<Record<string, unknown>>;
    requestPermissions(options?: any): Promise<unknown>;
    addListener(eventName: string, listenerFunc: (data: any) => void): Promise<{ remove?: () => void }>;
  };
  /**
   * Isolated-browser mini-app staging + launch. Wired lazily by the nativekit
   * bridge (the app-browser surface is assembled there); the placeholder
   * default throws so tests must inject a fake.
   */
  miniapp: {
    install(pkg: { files: Array<{ path: string; data: string | Uint8Array; type?: string }>; manifest?: Record<string, unknown> }): Promise<unknown>;
    launch(appId: string, target: unknown): Promise<unknown>;
  };
  /** Clipboard, when the host grants it. */
  clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string> };
  /** Opens a URL outside the WebView. Defaults to `window.open`. */
  openUrl: (url: string) => void;
  /**
   * Minimal fetch slice for web search. On native, the bridge swaps in a
   * CapacitorHttp-backed adapter (no WebView CORS rules); in tests it is a
   * scripted fake.
   */
  fetchImpl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
  /** FileTransfer plugin (download/upload). */
  transfer: {
    downloadFile(options: any): Promise<unknown>;
    uploadFile(options: any): Promise<{ statusCode?: number } | unknown>;
  };
  /** App metadata. */
  appInfo: { getInfo(): Promise<{ name?: string; id?: string; version?: string; build?: string }> };
  /** Widget + floating overlay plugin. */
  widget: {
    checkOverlayPermission(): Promise<{ granted: boolean }>;
    requestOverlayPermission(): Promise<void>;
    showFloating(options?: any): Promise<{ shown?: boolean; error?: string }>;
    hideFloating(): Promise<void>;
    updateFloating(options?: any): Promise<{ shown?: boolean; error?: string }>;
    sendToFloating(options: { data: unknown }): Promise<{ delivered?: boolean }>;
    setConfig(options: any): Promise<unknown>;
    reload(options?: any): Promise<{ updated?: number }>;
    requestPin(options: { kind: string }): Promise<{ requested?: boolean; hint?: string }>;
  };
  /** Shows an in-app toast for the agent (decoupled via a DOM event). */
  toast: (message: string) => void;
  /** Millisecond clock, injectable so rate limits are testable. */
  now: () => number;
}

/** A finished tool run: plain MCP result shape. */
type DeviceOutcome = McpCallToolResult;

interface RunContext {
  features: Partial<Record<DeviceToolFeature, boolean>>;
  rate: RateLimiter;
}

interface DeviceToolSpec {
  /** Bare tool name, published namespaced as `device__<name>`. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Feature flag that must not be `false` for the tool to be offered. */
  feature?: DeviceToolFeature;
  rateLimit?: { max: number; windowMs: number };
  run: (args: Record<string, unknown>, deps: DeviceToolDeps, ctx: RunContext) => Promise<DeviceOutcome>;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function textResult(text: string, structured?: Record<string, unknown>): DeviceOutcome {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorResult(text: string, structured?: Record<string, unknown>): DeviceOutcome {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(args: Record<string, unknown>, key: string, max = 280): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function requiredString(args: Record<string, unknown>, key: string, max = 280): string | null {
  const value = optionalString(args, key, max);
  return value ?? null;
}

/** Clamps a number into [min, max]. */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Workspace-relative path from args: normalised, no '..', no leading '/', no trailing '/'. */
function workspacePathArg(args: Record<string, unknown>, key: string): string | null {
  const raw = optionalString(args, key, 300);
  if (!raw) return null;
  const path = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.includes('..') || path.includes('//') || path.endsWith('/')) return null;
  return path;
}

const TEXT_DECODER = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/** Decodes bytes as UTF-8 with a latin-1 fallback for very old hosts. */
function bytesToText(bytes: Uint8Array): string {
  if (TEXT_DECODER) return TEXT_DECODER.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Decodes base64 to bytes using atob (WebView) or Buffer (node tests). */
function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const raw = atob(clean);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') return new Uint8Array(Buffer.from(clean, 'base64'));
  return new Uint8Array(0);
}

/** Encodes bytes as base64 using btoa (WebView) or Buffer (node tests). */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let raw = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) raw += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(raw);
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') return Buffer.from(bytes).toString('base64');
  throw new Error('No base64 encoder is available in this host');
}

/** File extensions that must be read/written as binary bytes rather than text. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'mp4', 'webm', 'mov', 'pdf', 'zip',
  'gz', 'tgz', 'tar', 'wasm', 'apk', 'jar', 'bin', 'db', 'sqlite', 'sqlite3',
]);

function isBinaryPath(path: string): boolean {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return BINARY_EXTENSIONS.has(extension);
}

/** Reads a workspace file as text or bytes (files live under agent/workspace in Directory.Data). */
async function readWorkspaceFile(
  deps: DeviceToolDeps,
  path: string,
): Promise<{ text?: string; bytes?: Uint8Array }> {
  const fullPath = `agent/workspace/${path}`;
  if (isBinaryPath(path)) {
    const read = await deps.filesystem.readFile({ path: fullPath, directory: Directory.Data });
    return { bytes: base64ToBytes(String(read?.data ?? '')) };
  }
  const read = await deps.filesystem.readFile({ path: fullPath, directory: Directory.Data, encoding: Encoding.UTF8 });
  return { text: String(read?.data ?? '') };
}

/** Writes text or bytes into the workspace under a relative path, creating parent dirs. */
async function writeWorkspaceFile(
  deps: DeviceToolDeps,
  path: string,
  content: { text?: string; bytes?: Uint8Array },
): Promise<void> {
  const fullPath = `agent/workspace/${path}`;
  const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
  if (parent) await deps.filesystem.mkdir({ path: parent, directory: Directory.Data, recursive: true }).catch(() => undefined);
  if (content.bytes !== undefined) {
    await deps.filesystem.writeFile({ path: fullPath, directory: Directory.Data, data: bytesToBase64(content.bytes) });
  } else {
    await deps.filesystem.writeFile({ path: fullPath, directory: Directory.Data, data: content.text ?? '', encoding: Encoding.UTF8 });
  }
}

/** Extracts an endpoint id from a nearby-connections callback payload. */
function nearbyEndpointId(event: unknown): string {
  const record = event as Record<string, unknown> | null | undefined;
  return String(record?.endpointID ?? record?.endpointId ?? '');
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(num) ? num : undefined;
}

/** Rejects non-public web URLs: https-only, no loopback/private hosts. */
function assertPublicHttpsUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `'${raw}' is not a valid URL.` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `Only https: URLs are allowed (got '${parsed.protocol}').` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed.' };
  }
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (blocked) {
    return { ok: false, reason: `Host '${host}' is a private or loopback address and cannot be opened.` };
  }
  return { ok: true, url: parsed.toString() };
}

/** Grants text for a permission map: any granted value passes. */
function permissionGranted(status: Record<string, string> | undefined): boolean {
  if (!status) return false;
  return Object.values(status).some((value) => value === 'granted');
}

// ── Rate limiting ────────────────────────────────────────────────────────────

class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  /** Records a hit; returns false when the limit is exhausted. */
  allow(key: string, max: number, windowMs: number): boolean {
    const at = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => at - ts < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(key, recent);
    return true;
  }
}

// ── Web search helpers ───────────────────────────────────────────────────────

/** Minimal HTML entity decoder (regex parsers run outside a DOM too). */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Parses Bing's no-JS results page (`li.b_algo` blocks). */
export function parseBingResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const h2Anchor = block.match(/<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"/);
    const headerAnchor = block.match(/<div class="b_algoheader">\s*<a[^>]*href="(https?:\/\/[^"]+)"/);
    const anyAnchor = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    const url = h2Anchor?.[1] ?? headerAnchor?.[1] ?? anyAnchor?.[1];
    if (!url || /(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue;
    const title = h2 ? stripTags(h2[1]) : url;
    if (!title) continue;
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) ??
      block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title: title.slice(0, 200), url, snippet: (snippetMatch ? stripTags(snippetMatch[1]) : '').slice(0, 320) });
  }
  return results;
}

/** Parses DuckDuckGo's html endpoint results, decoding the `uddg` redirect. */
export function parseDdgResults(html: string, limit: number): WebSearchResult[] {
  const anchors = html.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  const snippets = html.match(/<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  const results: WebSearchResult[] = [];
  for (let index = 0; index < anchors.length && results.length < limit; index += 1) {
    const anchor = anchors[index];
    const href = anchor.match(/href="([^"]+)"/)?.[1] ?? '';
    const encoded = href.match(/[?&]uddg=([^&"]+)/)?.[1];
    let url = '';
    if (encoded) {
      try { url = decodeURIComponent(encoded); } catch { url = ''; }
    } else if (href.startsWith('https://')) {
      url = href;
    }
    if (!url) continue;
    const title = stripTags(anchor);
    if (!title) continue;
    results.push({
      title: title.slice(0, 200),
      url,
      snippet: (snippets[index] ? stripTags(snippets[index]) : '').slice(0, 320),
    });
  }
  return results;
}

/** Flattens the keyless DuckDuckGo Instant Answer JSON into results. */
export function parseInstantAnswer(payload: unknown): { abstract: string; abstractUrl: string; results: WebSearchResult[] } {
  const data = asRecord(payload);
  const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : '';
  const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
  const results: WebSearchResult[] = [];
  if (abstractText && abstractUrl) {
    results.push({ title: typeof data.Heading === 'string' && data.Heading ? data.Heading : abstractUrl, url: abstractUrl, snippet: abstractText.slice(0, 400) });
  }
  const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of topics.slice(0, 8)) {
    const record = asRecord(topic);
    const text = typeof record.Text === 'string' ? record.Text : '';
    const firstUrl = typeof record.FirstURL === 'string' ? record.FirstURL : '';
    if (text && firstUrl) {
      results.push({ title: text.split(' - ')[0].slice(0, 160), url: firstUrl, snippet: text.slice(0, 320) });
    } else if (Array.isArray(record.Topics)) {
      for (const nested of record.Topics.slice(0, 3)) {
        const inner = asRecord(nested);
        if (typeof inner.Text === 'string' && typeof inner.FirstURL === 'string') {
          results.push({ title: inner.Text.split(' - ')[0].slice(0, 160), url: inner.FirstURL, snippet: inner.Text.slice(0, 320) });
        }
      }
    }
  }
  return { abstract: abstractText, abstractUrl, results };
}

const SEARCH_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36';

// ── Tool implementations ─────────────────────────────────────────────────────

const NOTIFY_LIMIT = { max: 4, windowMs: 60_000 };
const VIBRATE_LIMIT = { max: 3, windowMs: 60_000 };
const SHARE_LIMIT = { max: 4, windowMs: 60_000 };
const OPEN_URL_LIMIT = { max: 6, windowMs: 60_000 };
const ALARM_LIMIT = { max: 6, windowMs: 60_000 };
const SEARCH_LIMIT = { max: 6, windowMs: 60_000 };
const DOWNLOAD_LIMIT = { max: 4, windowMs: 60_000 };
const UPLOAD_LIMIT = { max: 4, windowMs: 60_000 };
const TOAST_LIMIT = { max: 6, windowMs: 60_000 };
const FLOAT_SHOW_LIMIT = { max: 3, windowMs: 60_000 };
const FLOAT_UPDATE_LIMIT = { max: 10, windowMs: 60_000 };
const WIDGET_SET_LIMIT = { max: 4, windowMs: 60_000 };
const SPEAK_LIMIT = { max: 6, windowMs: 60_000 };
const LISTEN_LIMIT = { max: 4, windowMs: 60_000 };
const SCAN_LIMIT = { max: 6, windowMs: 60_000 };
const SMS_LIMIT = { max: 4, windowMs: 60_000 };
const ASK_LIMIT = { max: 4, windowMs: 60_000 };
const ZIP_LIMIT = { max: 4, windowMs: 60_000 };
const SQL_LIMIT = { max: 20, windowMs: 60_000 };
const NEARBY_LIMIT = { max: 6, windowMs: 60_000 };
const MINIAPP_LIMIT = { max: 3, windowMs: 60_000 };
const CLIPBOARD_LIMIT = { max: 10, windowMs: 60_000 };

const TOOL_SPECS: DeviceToolSpec[] = [
  {
    name: 'notify',
    description:
      'Show a local notification on the user\'s device. Use it to deliver a result, a reminder, or an important update ' +
      'while the user may be outside this chat. Requires the user\'s approval per call; keep notifications few and meaningful.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title (max ~60 chars).' },
        body: { type: 'string', description: 'Notification body text (max ~240 chars).' },
        delaySeconds: { type: 'number', description: 'Optional delay before showing the notification (0–86400 seconds).' },
      },
      required: ['title'],
    },
    feature: 'localNotifications',
    rateLimit: NOTIFY_LIMIT,
    run: async (args, deps) => {
      const title = requiredString(args, 'title', 120);
      if (!title) return errorResult("'title' is required and must be a non-empty string.");
      const body = optionalString(args, 'body', 400) ?? '';
      const delaySeconds = optionalNumber(args, 'delaySeconds');
      if (delaySeconds !== undefined && (delaySeconds < 0 || delaySeconds > 86_400)) {
        return errorResult("'delaySeconds' must be between 0 and 86400.");
      }
      const status = await deps.notifications.requestPermissions().catch(() => undefined);
      if (status && !permissionGranted(status)) {
        return errorResult(
          'Notification permission was denied by the user or the OS. Ask the user to enable notifications for this app in system settings.',
        );
      }
      const id = Math.floor(deps.now() / 1000) % 2_147_483_647;
      const schedule = delaySeconds && delaySeconds > 0 ? { at: new Date(deps.now() + delaySeconds * 1000) } : undefined;
      await deps.notifications.schedule({
        notifications: [{ id, title, body, ...(schedule ? { schedule } : {}) }],
      });
      return textResult(
        delaySeconds && delaySeconds > 0
          ? `Notification scheduled; it will appear in about ${Math.round(delaySeconds)} second(s).`
          : 'Notification shown to the user.',
        { title, body, id },
      );
    },
  },
  {
    name: 'take_photo',
    description:
      'Capture a photo with the device camera (the user may also pick one from the gallery when the OS shows that choice). ' +
      'The photo is saved into the agent workspace under photos/ and the saved path is returned. NOTE: you cannot see the ' +
      'image pixels yourself — the engine reports only that image content was produced. Reference the path for the user, ' +
      'or attach it when the user asks to keep or share the photo.',
    inputSchema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Optional file name inside photos/ (a–z, 0–9, -, _; .jpg is appended).' },
        quality: { type: 'number', description: 'JPEG quality 30–95 (default 60).' },
      },
    },
    feature: 'camera',
    run: async (args, deps) => {
      const quality = optionalNumber(args, 'quality');
      if (quality !== undefined && (quality < 30 || quality > 95)) {
        return errorResult("'quality' must be between 30 and 95.");
      }
      const rawName = optionalString(args, 'fileName', 64);
      if (rawName && !/^[A-Za-z0-9_-]{1,64}$/.test(rawName)) {
        return errorResult("'fileName' may only contain letters, digits, '-' and '_' (max 64 chars).");
      }
      let photo: { base64String?: string; format?: string };
      try {
        photo = await deps.camera.getPhoto({
          resultType: CameraResultType.Base64,
          source: CameraSource.Prompt,
          quality: quality ?? 60,
          width: 1600,
          correctOrientation: true,
        });
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        return /cancel|dismiss/i.test(message)
          ? errorResult('The user cancelled the photo capture.')
          : errorResult(`Photo capture failed: ${message}`);
      }
      const base64 = photo?.base64String;
      if (!base64) return errorResult('The camera returned no image data.');
      const stamp = new Date(deps.now());
      const pad = (n: number) => String(n).padStart(2, '0');
      const fileName = `${rawName ?? `photo-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`}.jpg`;
      const dir = 'agent/workspace/photos';
      const path = `${dir}/${fileName}`;
      try {
        await deps.filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }).catch(() => undefined);
        await deps.filesystem.writeFile({ path, directory: Directory.Data, data: base64 });
      } catch (error) {
        return errorResult(`The photo was captured but could not be saved to the workspace: ${String((error as Error)?.message ?? error)}`);
      }
      const approxBytes = Math.floor((base64.length * 3) / 4);
      return {
        content: [
          {
            type: 'text',
            text:
              `Photo captured and saved to the agent workspace at 'photos/${fileName}' (${(approxBytes / 1024).toFixed(0)} KB, image/jpeg). ` +
              'You cannot view the pixels yourself; the user can open the file. Use the workspace file tools if you need to move, rename, or reference it.',
          },
          { type: 'image', data: base64, mimeType: 'image/jpeg' },
        ],
        structuredContent: { path: `photos/${fileName}`, mimeType: 'image/jpeg', bytes: approxBytes },
      };
    },
  },
  {
    name: 'get_location',
    description:
      'Get the device\'s current location (one fix, not continuous tracking). Returns latitude, longitude and accuracy in metres. ' +
      'Requires location permission; the user approves each call. Prefer coarse accuracy — do not request this repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds (1000–30000, default 15000).' },
      },
    },
    feature: 'location',
    run: async (args, deps) => {
      const timeoutMs = optionalNumber(args, 'timeoutMs');
      if (timeoutMs !== undefined && (timeoutMs < 1_000 || timeoutMs > 30_000)) {
        return errorResult("'timeoutMs' must be between 1000 and 30000.");
      }
      const status = await deps.geolocation.requestPermissions().catch(() => undefined);
      if (status && !permissionGranted(status)) {
        return errorResult(
          'Location permission was denied. Ask the user to grant location access in system settings, or continue without location.',
        );
      }
      try {
        const position = await deps.geolocation.getCurrentPosition({ timeout: timeoutMs ?? 15_000, enableHighAccuracy: false });
        const { latitude, longitude, accuracy, altitude, heading, speed } = position.coords;
        const parts = [
          `latitude=${latitude}`,
          `longitude=${longitude}`,
          `accuracy≈${accuracy}m`,
          altitude != null ? `altitude=${altitude}m` : '',
          heading != null ? `heading=${heading}` : '',
          speed != null ? `speed=${speed}m/s` : '',
        ].filter(Boolean);
        return textResult(
          `Current device location: ${parts.join(', ')} (fix at ${new Date(position.timestamp).toISOString()}).`,
          { latitude, longitude, accuracyMeters: accuracy, timestamp: position.timestamp },
        );
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/permission|denied/i.test(message)) {
          return errorResult('Location permission was denied by the user or the OS.');
        }
        return errorResult(`Could not get a location fix: ${message}`);
      }
    },
  },
  {
    name: 'vibrate',
    description:
      'Vibrate the device briefly (10–2000 ms, default 200 ms) to give the user haptic feedback, for example to signal that a long task finished.',
    inputSchema: {
      type: 'object',
      properties: {
        durationMs: { type: 'number', description: 'Vibration length in milliseconds (10–2000, default 200).' },
      },
    },
    feature: 'haptics',
    rateLimit: VIBRATE_LIMIT,
    run: async (args, deps) => {
      const durationMs = optionalNumber(args, 'durationMs');
      if (durationMs !== undefined && (durationMs < 10 || durationMs > 2_000)) {
        return errorResult("'durationMs' must be between 10 and 2000.");
      }
      await deps.haptics.vibrate({ duration: durationMs ?? 200 });
      return textResult(`Device vibrated for ${durationMs ?? 200} ms.`);
    },
  },
  {
    name: 'share',
    description:
      'Open the system share sheet so the user can share text and/or a link to any app they choose. The user completes the share themselves; cancelling the sheet is not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title for the share sheet.' },
        text: { type: 'string', description: 'Text to share (max ~2000 chars).' },
        url: { type: 'string', description: 'Optional https: URL to share alongside the text.' },
      },
    },
    feature: 'sharing',
    rateLimit: SHARE_LIMIT,
    run: async (args, deps) => {
      const text = optionalString(args, 'text', 2000);
      const url = optionalString(args, 'url', 500);
      const title = optionalString(args, 'title', 120);
      if (!text && !url) return errorResult("Provide at least one of 'text' or 'url'.");
      if (url) {
        const check = assertPublicHttpsUrl(url);
        if (!check.ok) return errorResult(`'url' rejected: ${check.reason}`);
      }
      const outcome = await deps.share.share({ title: title ?? 'Share', ...(text ? { text } : {}), ...(url ? { url } : {}) });
      const cancelled = String((outcome as { resultType?: string } | null)?.resultType ?? '') === 'cancel';
      return textResult(cancelled ? 'The user dismissed the share sheet.' : 'Share sheet completed.');
    },
  },
  {
    name: 'network_status',
    description:
      'Report whether the device is currently online and the connection type (wifi, cellular, none, unknown). Useful before large downloads or when a request keeps failing.',
    inputSchema: { type: 'object', properties: {} },
    feature: 'networkStatus',
    run: async (_args, deps) => {
      const status = await deps.network.getStatus();
      return textResult(
        `The device is ${status.connected ? 'online' : 'offline'} (connection type: ${status.connectionType}).`,
        { connected: status.connected, connectionType: status.connectionType },
      );
    },
  },
  {
    name: 'schedule_alarm',
    description:
      'Schedule an exact alarm on the device (survives reboots; may ring full-screen). Use for commitments the user must not miss. ' +
      'Give either atEpochMs (milliseconds since epoch) or inSeconds (from now), not both.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "Stable alarm id (letters, digits, '-', '_'; max 64)." },
        title: { type: 'string', description: 'Alarm title.' },
        body: { type: 'string', description: 'Optional body text shown with the alarm.' },
        atEpochMs: { type: 'number', description: 'When to fire, in milliseconds since epoch (must be in the future).' },
        inSeconds: { type: 'number', description: 'Alternative to atEpochMs: delay from now in seconds (30–31536000).' },
        fullScreen: { type: 'boolean', description: 'Ring full-screen even when the screen is off (default false).' },
        repeatIntervalMinutes: { type: 'number', description: 'Repeat every N minutes (0–10080; 0 = one-shot, default).' },
      },
      required: ['id', 'title'],
    },
    feature: 'advancedAlarms',
    rateLimit: ALARM_LIMIT,
    run: async (args, deps) => {
      const id = requiredString(args, 'id', 64);
      const title = requiredString(args, 'title', 120);
      if (!id) return errorResult("'id' is required.");
      if (!title) return errorResult("'title' is required.");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        return errorResult("'id' may only contain letters, digits, '-' and '_'.");
      }
      const atEpochMs = optionalNumber(args, 'atEpochMs');
      const inSeconds = optionalNumber(args, 'inSeconds');
      if ((atEpochMs === undefined) === (inSeconds === undefined)) {
        return errorResult("Give exactly one of 'atEpochMs' or 'inSeconds'.");
      }
      const now = deps.now();
      const at = atEpochMs ?? now + inSeconds! * 1000;
      if (at < now - 60_000) return errorResult("'atEpochMs' is in the past; alarms must be scheduled for the future.");
      if (at > now + 365 * 24 * 3600 * 1000) return errorResult('Alarms may be scheduled at most one year ahead.');
      if (inSeconds !== undefined && (inSeconds < 30 || inSeconds > 31_536_000)) {
        return errorResult("'inSeconds' must be between 30 and 31536000.");
      }
      const repeatIntervalMinutes = optionalNumber(args, 'repeatIntervalMinutes');
      if (repeatIntervalMinutes !== undefined && (repeatIntervalMinutes < 0 || repeatIntervalMinutes > 10_080)) {
        return errorResult("'repeatIntervalMinutes' must be between 0 and 10080.");
      }
      const fullScreen = args.fullScreen === true;
      const body = optionalString(args, 'body', 400) ?? '';
      await deps.alarms.scheduleAlarm({
        id,
        title,
        body,
        at: Math.round(at),
        fullScreen,
        repeatIntervalMinutes: repeatIntervalMinutes ?? 0,
      });
      const when = new Date(at).toISOString();
      return textResult(
        `Alarm '${id}' scheduled for ${when}${repeatIntervalMinutes ? `, repeating every ${repeatIntervalMinutes} min` : ''}.`,
        { id, atEpochMs: Math.round(at), fullScreen, repeatIntervalMinutes: repeatIntervalMinutes ?? 0 },
      );
    },
  },
  {
    name: 'list_alarms',
    description: 'List every alarm this app has scheduled on the device (id, title, time, repeat interval).',
    inputSchema: { type: 'object', properties: {} },
    feature: 'advancedAlarms',
    run: async (_args, deps) => {
      const result = await deps.alarms.listAlarms().catch(() => undefined);
      const alarms = Array.isArray((result as { alarms?: unknown } | undefined)?.alarms)
        ? (result as { alarms: unknown[] }).alarms
        : [];
      if (!alarms.length) return textResult('No alarms are scheduled on this device.');
      return textResult(`Scheduled alarms (${alarms.length}):\n${JSON.stringify(alarms, null, 2)}`, { count: alarms.length });
    },
  },
  {
    name: 'cancel_alarm',
    description: 'Cancel a previously scheduled alarm by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The alarm id to cancel.' } },
      required: ['id'],
    },
    feature: 'advancedAlarms',
    run: async (args, deps) => {
      const id = requiredString(args, 'id', 64);
      if (!id) return errorResult("'id' is required.");
      await deps.alarms.cancelAlarm({ id });
      return textResult(`Alarm '${id}' cancelled.`);
    },
  },
  {
    name: 'open_url',
    description:
      'Open a public https: URL outside the app (system browser). Use it to show the user a page you found — never to fetch its content; use your web fetch tool for that.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The public https: URL to open.' } },
      required: ['url'],
    },
    rateLimit: OPEN_URL_LIMIT,
    run: async (args, deps) => {
      const url = requiredString(args, 'url', 1000);
      if (!url) return errorResult("'url' is required.");
      const check = assertPublicHttpsUrl(url);
      if (!check.ok) return errorResult(check.reason);
      deps.openUrl(check.url);
      return textResult(`Opened ${check.url} in the device browser.`);
    },
  },
  {
    name: 'web_search',
    description:
      'Search the public web and get a compact list of results (title, url, snippet). Use this before web_fetch when you ' +
      'need to discover pages, facts, or current information. Sources are tried in order (Bing HTML, DuckDuckGo HTML, ' +
      'DuckDuckGo Instant Answers) until one answers; the result says which source was used.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (max 300 chars).' },
        maxResults: { type: 'number', description: 'How many results to return (1–8, default 5).' },
      },
      required: ['query'],
    },
    rateLimit: SEARCH_LIMIT,
    run: async (args, deps) => {
      const query = requiredString(args, 'query', 300);
      if (!query) return errorResult("'query' is required.");
      const maxResults = optionalNumber(args, 'maxResults');
      if (maxResults !== undefined && (maxResults < 1 || maxResults > 8)) {
        return errorResult("'maxResults' must be between 1 and 8.");
      }
      const limit = maxResults ?? 5;
      const attempts: Array<{ source: string; run: () => Promise<WebSearchResult[]> }> = [
        {
          source: 'bing',
          run: async () => {
            const response = await deps.fetchImpl(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit * 2, 20)}&format=html`, {
              headers: { 'user-agent': SEARCH_USER_AGENT, accept: 'text/html' },
            });
            if (!response.ok) return [];
            return parseBingResults(await response.text(), limit);
          },
        },
        {
          source: 'duckduckgo',
          run: async () => {
            const response = await deps.fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
              headers: { 'user-agent': SEARCH_USER_AGENT, accept: 'text/html' },
            });
            if (!response.ok) return [];
            const body = await response.text();
            if (/anomaly|challenge/i.test(body) && !body.includes('result__a')) return [];
            return parseDdgResults(body, limit);
          },
        },
        {
          source: 'duckduckgo_instant_answers',
          run: async () => {
            const response = await deps.fetchImpl(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
              headers: { accept: 'application/json' },
            });
            if (!response.ok) return [];
            try {
              return parseInstantAnswer(JSON.parse(await response.text())).results.slice(0, limit);
            } catch {
              return [];
            }
          },
        },
      ];
      for (const attempt of attempts) {
        try {
          const results = await attempt.run();
          if (!results.length) continue;
          const lines = results.map((result, index) =>
            `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`
          );
          return textResult(
            `Web search results for "${query}" (source: ${attempt.source}):\n\n${lines.join('\n\n')}`,
            { query, source: attempt.source, results },
          );
        } catch {
          // Try the next source; a failing source is not the user's problem.
        }
      }
      return errorResult(
        `No search source answered for "${query}". The device may be offline or all engines refused the request; retry once, then tell the user.`,
      );
    },
  },
  {
    name: 'download_file',
    description:
      'Download a file from a public https: URL into the agent workspace downloads/ directory. Use it for documents, ' +
      'datasets, images or archives you need to inspect; read or process them afterwards with the file tools.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public https: URL to download.' },
        fileName: { type: 'string', description: 'File name inside downloads/ (letters, digits, -, _, .; 1–80 chars).' },
      },
      required: ['url', 'fileName'],
    },
    feature: 'fileTransfer',
    rateLimit: DOWNLOAD_LIMIT,
    run: async (args, deps) => {
      const url = requiredString(args, 'url', 1000);
      const fileName = requiredString(args, 'fileName', 80);
      if (!url) return errorResult("'url' is required.");
      if (!fileName) return errorResult("'fileName' is required.");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(fileName) || fileName.includes('..')) {
        return errorResult("'fileName' may only contain letters, digits, '.', '-' and '_' (no path separators).");
      }
      const check = assertPublicHttpsUrl(url);
      if (!check.ok) return errorResult(`'url' rejected: ${check.reason}`);
      const dir = 'agent/workspace/downloads';
      const path = `${dir}/${fileName}`;
      try {
        await deps.filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }).catch(() => undefined);
        const target = await deps.filesystem.getUri({ path, directory: Directory.Data });
        await deps.transfer.downloadFile({ url: check.url, path: target.uri });
      } catch (error) {
        return errorResult(`Download failed: ${String((error as Error)?.message ?? error)}`);
      }
      const stat = await deps.filesystem.stat({ path, directory: Directory.Data }).catch(() => undefined);
      const bytes = stat?.size;
      return textResult(
        `Downloaded to the agent workspace at 'downloads/${fileName}'${typeof bytes === 'number' ? ` (${(bytes / 1024).toFixed(0)} KB)` : ''}.`,
        { path: `downloads/${fileName}`, url: check.url, ...(typeof bytes === 'number' ? { bytes } : {}) },
      );
    },
  },
  {
    name: 'upload_file',
    description:
      'Upload a file from the agent workspace to a public https: URL (multipart/form-data by default; set an explicit ' +
      'contentType only when the server needs a raw stream). The upload happens natively, outside the WebView.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the file to upload (e.g. photos/x.jpg).' },
        url: { type: 'string', description: 'Public https: endpoint that accepts the upload.' },
        fieldName: { type: 'string', description: 'Form field name for multipart uploads (default "file").' },
        mimeType: { type: 'string', description: 'Optional content type (e.g. image/jpeg).' },
      },
      required: ['path', 'url'],
    },
    feature: 'fileTransfer',
    rateLimit: UPLOAD_LIMIT,
    run: async (args, deps) => {
      const path = requiredString(args, 'path', 300);
      const url = requiredString(args, 'url', 1000);
      if (!path) return errorResult("'path' is required.");
      if (!url) return errorResult("'url' is required.");
      if (path.includes('..') || path.startsWith('/')) return errorResult("'path' must be workspace-relative without '..'.");
      const check = assertPublicHttpsUrl(url);
      if (!check.ok) return errorResult(`'url' rejected: ${check.reason}`);
      const stat = await deps.filesystem.stat({ path: `agent/workspace/${path}`, directory: Directory.Data }).catch(() => undefined);
      if (stat?.type === 'directory' || (stat && stat.type !== undefined && stat.type !== 'file')) {
        return errorResult(`'${path}' is not a file in the workspace.`);
      }
      try {
        const source = await deps.filesystem.getUri({ path: `agent/workspace/${path}`, directory: Directory.Data });
        const result = await deps.transfer.uploadFile({
          url: check.url,
          path: source.uri,
          ...(optionalString(args, 'fieldName', 40) ? { fileName: optionalString(args, 'fieldName', 40) } : {}),
          ...(optionalString(args, 'mimeType', 100) ? { mimeType: optionalString(args, 'mimeType', 100) } : {}),
        });
        const statusCode = (result as { statusCode?: number } | null)?.statusCode;
        return textResult(
          `Uploaded '${path}' to ${check.url}${typeof statusCode === 'number' ? ` (HTTP ${statusCode})` : ''}.`,
          { path, url: check.url, ...(typeof statusCode === 'number' ? { statusCode } : {}) },
        );
      } catch (error) {
        return errorResult(`Upload failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'toast',
    description:
      'Show a short, non-intrusive in-app message (a toast) inside the agent workspace. Prefer this over notifications ' +
      'for quick progress notes while the user is looking at the chat.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Message to show (max 200 chars).' } },
      required: ['message'],
    },
    rateLimit: TOAST_LIMIT,
    run: async (args, deps) => {
      const message = requiredString(args, 'message', 200);
      if (!message) return errorResult("'message' is required.");
      deps.toast(message);
      return textResult('Toast shown in the app.');
    },
  },
  {
    name: 'app_info',
    description: "Report this app's name, version, platform and language — useful for diagnostics and version-specific behaviour.",
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, deps) => {
      const info = await deps.appInfo.getInfo().catch(() => undefined);
      const language = typeof navigator !== 'undefined' ? navigator.language : '';
      const parts = [
        info?.name ? `app=${info.name}` : '',
        info?.version ? `version=${info.version}` : '',
        info?.build ? `build=${info.build}` : '',
        info?.id ? `id=${info.id}` : '',
        language ? `language=${language}` : '',
      ].filter(Boolean);
      return textResult(`Device app info: ${parts.join(', ')}.`, {
        ...(info ?? {}),
        ...(language ? { language } : {}),
      });
    },
  },
  {
    name: 'stop_ringing',
    description: 'Stop an alarm that is currently ringing on the device.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Optional alarm id; omit to stop whichever is ringing.' } },
    },
    feature: 'advancedAlarms',
    run: async (args, deps) => {
      const id = optionalString(args, 'id', 64);
      await deps.alarms.stopRinging(id ? { id } : undefined);
      return textResult(id ? `Stopped ringing alarm '${id}'.` : 'Stopped the ringing alarm.');
    },
  },
  {
    name: 'show_floating_ui',
    description:
      'Show a floating overlay window over other apps with HTML you author (a small dashboard, a card, a calculator...). ' +
      'The overlay is draggable, can be resized or fullscreen, and survives while the app runs. Requires the overlay ' +
      'permission; the user approves this call and the system permission once. Keep the HTML small and self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Self-contained HTML for the overlay (max 100 KB).' },
        width: { type: 'number', description: 'Bubble width in dp (120–720).' },
        height: { type: 'number', description: 'Bubble height in dp (120–1280).' },
        fullscreen: { type: 'boolean', description: 'Fill the whole screen instead of a bubble (default false).' },
        focusable: { type: 'boolean', description: 'Allow typing inside the overlay (default false).' },
        collapsed: { type: 'boolean', description: 'Start collapsed to a small bubble (default false).' },
        title: { type: 'string', description: 'Header title shown in the bubble bar.' },
        data: { description: 'Initial data posted into the page.' },
      },
      required: ['html'],
    },
    feature: 'widget',
    rateLimit: FLOAT_SHOW_LIMIT,
    run: async (args, deps) => {
      const html = typeof args.html === 'string' ? args.html : '';
      if (!html.trim()) return errorResult("'html' is required.");
      if (html.length > 100_000) return errorResult("'html' exceeds the 100 KB limit; keep the overlay small.");
      const width = optionalNumber(args, 'width');
      const height = optionalNumber(args, 'height');
      if (width !== undefined && (width < 120 || width > 720)) return errorResult("'width' must be between 120 and 720 dp.");
      if (height !== undefined && (height < 120 || height > 1280)) return errorResult("'height' must be between 120 and 1280 dp.");
      try {
        const permission = await deps.widget.checkOverlayPermission();
        if (!permission?.granted) {
          await deps.widget.requestOverlayPermission();
          const recheck = await deps.widget.checkOverlayPermission();
          if (!recheck?.granted) {
            return errorResult(
              "The overlay permission ('Display over other apps') is not granted yet. The system settings screen for this app has just been opened — the user must allow it there, then this tool must be called again to show the overlay.",
            );
          }
        }
        const result = await deps.widget.showFloating({
          html,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(args.fullscreen === true ? { fullscreen: true } : {}),
          ...(args.focusable === true ? { focusable: true } : {}),
          ...(args.collapsed === true ? { collapsed: true } : {}),
          ...(optionalString(args, 'title', 80) ? { title: optionalString(args, 'title', 80) } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
        });
        if (result?.error) return errorResult(`Floating UI could not be shown: ${result.error}`);
        return textResult('Floating UI is showing over the app.');
      } catch (error) {
        return errorResult(`Floating UI failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'update_floating_ui',
    description:
      'Update the floating overlay: push fresh data into the page (your HTML listens for it) and/or move/resize the bubble. ' +
      'Cheaper than re-showing the whole HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { description: 'New data posted into the floating page.' },
        width: { type: 'number', description: 'New width in dp.' },
        height: { type: 'number', description: 'New height in dp.' },
        title: { type: 'string', description: 'New header title.' },
      },
    },
    feature: 'widget',
    rateLimit: FLOAT_UPDATE_LIMIT,
    run: async (args, deps) => {
      const hasOptions = args.width !== undefined || args.height !== undefined || args.title !== undefined;
      if (args.data === undefined && !hasOptions) {
        return errorResult("Give at least one of 'data', 'width', 'height' or 'title'.");
      }
      try {
        if (hasOptions) {
          await deps.widget.updateFloating({
            ...(optionalNumber(args, 'width') !== undefined ? { width: optionalNumber(args, 'width') } : {}),
            ...(optionalNumber(args, 'height') !== undefined ? { height: optionalNumber(args, 'height') } : {}),
            ...(optionalString(args, 'title', 80) ? { title: optionalString(args, 'title', 80) } : {}),
          });
        }
        if (args.data !== undefined) {
          await deps.widget.sendToFloating({ data: args.data });
        }
        return textResult('Floating UI updated.');
      } catch (error) {
        return errorResult(`Floating UI update failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'hide_floating_ui',
    description: 'Hide the floating overlay window.',
    inputSchema: { type: 'object', properties: {} },
    feature: 'widget',
    run: async (_args, deps) => {
      await deps.widget.hideFloating();
      return textResult('Floating UI hidden.');
    },
  },
  {
    name: 'set_widget',
    description:
      'Create or update a home-screen widget. Two styles: a native card (value/title/subtitle/progress/colors/icon) or an ' +
      "HTML snapshot (render:'html' with your own HTML). Re-updating refreshes the widget; the user pins it from the " +
      'launcher or with the pin_widget tool.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: "Widget kind id (letters, digits, '-', '_'; e.g. 'agent-dashboard')." },
        title: { type: 'string', description: 'Native style: heading above the value.' },
        value: { type: 'string', description: 'Native style: big headline text (a count, time, temperature...).' },
        subtitle: { type: 'string', description: 'Native style: supporting line.' },
        progress: { type: 'number', description: 'Native style: 0–progressMax progress bar.' },
        html: { type: 'string', description: 'HTML snapshot style: self-contained HTML (max 100 KB).' },
        backgroundColor: { type: 'string', description: 'Hex background color, e.g. #0F172A.' },
        accentColor: { type: 'string', description: 'Hex accent (value) color.' },
      },
      required: ['kind'],
    },
    feature: 'widget',
    rateLimit: WIDGET_SET_LIMIT,
    run: async (args, deps) => {
      const kind = requiredString(args, 'kind', 64);
      if (!kind) return errorResult("'kind' is required.");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(kind)) {
        return errorResult("'kind' may only contain letters, digits, '-' and '_'.");
      }
      const html = typeof args.html === 'string' ? args.html : undefined;
      if (html !== undefined && html.length > 100_000) return errorResult("'html' exceeds the 100 KB limit.");
      const value = optionalString(args, 'value', 120);
      if (!html && !value) {
        return errorResult("Give 'value' (native card) or 'html' (HTML snapshot).");
      }
      const progress = optionalNumber(args, 'progress');
      if (progress !== undefined && (progress < 0 || progress > 1_000_000)) {
        return errorResult("'progress' must be between 0 and 1000000.");
      }
      for (const colorKey of ['backgroundColor', 'accentColor'] as const) {
        const color = optionalString(args, colorKey, 9);
        if (color && !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(color)) {
          return errorResult(`'${colorKey}' must be a hex color like #0F172A.`);
        }
      }
      const config: Record<string, unknown> = {};
      if (html) {
        config.render = 'html';
        config.html = html;
      } else {
        if (value) config.value = value;
        if (optionalString(args, 'title', 120)) config.title = optionalString(args, 'title', 120);
        if (optionalString(args, 'subtitle', 160)) config.subtitle = optionalString(args, 'subtitle', 160);
        if (progress !== undefined) { config.progress = progress; config.progressMax = 100; }
        if (optionalString(args, 'backgroundColor', 9)) config.backgroundColor = optionalString(args, 'backgroundColor', 9);
        if (optionalString(args, 'accentColor', 9)) config.accentColor = optionalString(args, 'accentColor', 9);
      }
      try {
        await deps.widget.setConfig({ kind, config });
        await deps.widget.reload({ kind });
        return textResult(
          `Widget '${kind}' updated${html ? ' (HTML snapshot)' : ''}. It appears on widgets the user has already pinned; new pins need requestPin.`,
          { kind },
        );
      } catch (error) {
        return errorResult(`Widget update failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'pin_widget',
    description:
      "Ask Android to pin a widget kind to the user's home screen (the user confirms). The widget must have been created " +
      'with set_widget at least once.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', description: 'The widget kind id to pin.' } },
      required: ['kind'],
    },
    feature: 'widget',
    run: async (args, deps) => {
      const kind = requiredString(args, 'kind', 64);
      if (!kind) return errorResult("'kind' is required.");
      try {
        const result = await deps.widget.requestPin({ kind });
        return textResult(
          result?.requested
            ? `Pin request shown for widget '${kind}'; the user confirms on the home screen.`
            : `A pin request for '${kind}' could not be shown${result?.hint ? ` (${result.hint})` : ''}.`,
          { kind },
        );
      } catch (error) {
        return errorResult(`Pin request failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },

  // ── Phase 2: speech, scanning and device hardware ─────────────────────────

  {
    name: 'speak',
    description:
      'Reads text aloud with the device text-to-speech voice (defaults to Bangla bn-BD; pass language="en-US" or another BCP-47 tag for other voices). ' +
      'Returns once speech is queued; use stop_speaking to cut it short.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak (1–5000 chars).' },
        language: { type: 'string', description: 'BCP-47 language tag, default "bn-BD".' },
        pitch: { type: 'number', description: 'Voice pitch 0.5–2, default 1.' },
        rate: { type: 'number', description: 'Speaking speed 0.5–2, default 1.' },
      },
      required: ['text'],
    },
    rateLimit: SPEAK_LIMIT,
    run: async (args, deps) => {
      const text = requiredString(args, 'text', 5000);
      if (!text) return errorResult("'text' is required.");
      const language = optionalString(args, 'language', 20) ?? 'bn-BD';
      const pitch = clampNumber(optionalNumber(args, 'pitch') ?? 1, 0.5, 2);
      const rate = clampNumber(optionalNumber(args, 'rate') ?? 1, 0.5, 2);
      try {
        const result = await deps.extras.ttsSpeak({ text, language, pitch, rate });
        if (result?.queued === false) {
          // The engine has no voice data for the language; speaking anyway
          // would play garbage. Give the model actionable guidance instead.
          return errorResult(
            `No ${language} voice is installed on this device, so the text was NOT read aloud. ` +
              'Ask the user to install it once: Android Settings → System → Languages & input → Text-to-speech output → ' +
              'choose a TTS engine → Install voice data (or download the ' + language + ' voice), then try again. ' +
              'Alternatively offer to speak the same text with language="en-US" if an English voice exists.',
            { queued: false, language },
          );
        }
        return textResult('Speaking.', { queued: true, language });
      } catch (error) {
        return errorResult(`Speech failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'stop_speaking',
    description: 'Stops any in-progress text-to-speech playback.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, deps) => {
      try {
        await deps.extras.ttsStop();
        return textResult('Speech stopped.');
      } catch (error) {
        return errorResult(`Stop failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'listen',
    description:
      'Listens to the microphone once and returns the recognised speech as text (defaults to Bangla bn-BD; pass language for another). ' +
      'The device asks for microphone permission the first time. Timeout defaults to 12 s.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'BCP-47 language tag, default "bn-BD".' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds, 2000–25000 (default 12000).' },
      },
    },
    rateLimit: LISTEN_LIMIT,
    run: async (args, deps) => {
      const language = optionalString(args, 'language', 20) ?? 'bn-BD';
      const timeoutMs = Math.round(clampNumber(optionalNumber(args, 'timeoutMs') ?? 12000, 2000, 25000));
      try {
        const result = await deps.extras.listenSpeech({ language, timeoutMs });
        const text = String(result?.text ?? '').trim();
        return textResult(
          text ? `Heard: ${text}` : 'No speech was recognised.',
          { text, ...(typeof result?.confidence === 'number' ? { confidence: result.confidence } : {}) },
        );
      } catch (error) {
        return errorResult(`Listening failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'scan_qr',
    description: 'Opens the camera barcode scanner (QR codes) and returns the decoded text. The user can cancel; camera permission is requested if missing.',
    inputSchema: { type: 'object', properties: {} },
    feature: 'camera',
    rateLimit: SCAN_LIMIT,
    run: async (_args, deps) => {
      try {
        const result = await deps.extras.scanQrCode();
        const text = String(result?.text ?? '');
        return textResult(`Scanned: ${text}`, { text, ...(result?.format ? { format: result.format } : {}) });
      } catch (error) {
        return errorResult(`Scan failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'dial_phone',
    description: 'Opens the phone dialer with a number pre-filled (the user presses call — nothing is dialled automatically).',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'string', description: 'Phone number: digits, +, spaces and ( ) . - only.' } },
      required: ['number'],
    },
    rateLimit: SMS_LIMIT,
    run: async (args, deps) => {
      const number = requiredString(args, 'number', 30);
      if (!number) return errorResult("'number' is required.");
      if (!/^[+\d\s().-]+$/.test(number)) return errorResult("'number' may only contain digits, +, spaces and ( ) . -");
      try {
        await deps.extras.dialPhone({ number });
        return textResult(`Dialer opened with ${number.trim()}.`, { number: number.trim() });
      } catch (error) {
        return errorResult(`Dialer failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'compose_sms',
    description: 'Opens the SMS app with the recipient (and optional message body) pre-filled; the user reviews and sends.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Recipient phone number.' },
        body: { type: 'string', description: 'Pre-filled message text (max 1000 chars).' },
      },
      required: ['number'],
    },
    rateLimit: SMS_LIMIT,
    run: async (args, deps) => {
      const number = requiredString(args, 'number', 30);
      if (!number) return errorResult("'number' is required.");
      const body = optionalString(args, 'body', 1000) ?? '';
      try {
        await deps.extras.composeSms({ number, ...(body ? { body } : {}) });
        return textResult(`SMS composer opened for ${number.trim()}.`, { number: number.trim() });
      } catch (error) {
        return errorResult(`SMS composer failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'torch',
    description: 'Turns the camera flash (torch) on or off.',
    inputSchema: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true to switch the torch on, false for off.' } },
      required: ['on'],
    },
    rateLimit: SCAN_LIMIT,
    run: async (args, deps) => {
      if (typeof args.on !== 'boolean') return errorResult("'on' (boolean) is required.");
      try {
        await deps.extras.setTorch({ on: args.on });
        return textResult(`Torch ${args.on ? 'on' : 'off'}.`, { on: args.on });
      } catch (error) {
        return errorResult(`Torch failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'battery_status',
    description: 'Reports the battery level, whether it is charging and whether a charger is plugged in.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, deps) => {
      try {
        const result = await deps.extras.batteryStatus();
        const percent = typeof result?.percent === 'number' ? result.percent : null;
        const charging = result?.charging === true;
        return textResult(
          `Battery ${percent === null ? 'level unknown' : `${percent}%`}${charging ? ', charging' : ', not charging'}.`,
          { ...(percent !== null ? { percent } : {}), charging, plugged: result?.plugged === true },
        );
      } catch (error) {
        return errorResult(`Battery status failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'pick_file',
    description:
      'Opens the system file picker and copies the chosen file into the agent workspace under picked/ (up to 25 MB), so the file tools can read it. ' +
      'The user picks the file; nothing is read without that.',
    inputSchema: { type: 'object', properties: {} },
    feature: 'filesystem',
    rateLimit: ZIP_LIMIT,
    run: async (_args, deps) => {
      try {
        const result = await deps.extras.pickDocument();
        const path = String(result?.path ?? '');
        if (!path) return errorResult('No file was picked.');
        return textResult(
          `Saved the picked file to the agent workspace at '${path}'${typeof result?.bytes === 'number' ? ` (${(result.bytes / 1024).toFixed(0)} KB)` : ''}; read it with the file tools.`,
          { path, ...(typeof result?.bytes === 'number' ? { bytes: result.bytes } : {}) },
        );
      } catch (error) {
        return errorResult(`Pick failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },

  // ── Phase 3: interaction, files, data and peers ────────────────────────────

  {
    name: 'ask_user',
    description:
      "Shows the user a question card with tappable options in the chat and waits for the answer — use it whenever the user's choice is needed. " +
      'Resolves "no answer" if the user does not respond in time (default 20 s; the engine tool timeout, mcp_tool_timeout_ms default 30 s, also caps the wait).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to show (max 500 chars).' },
        options: { type: 'array', items: { type: 'string' }, description: '2–6 short answer buttons (max 60 chars each).' },
        timeoutSeconds: { type: 'number', description: 'How long to wait for an answer, 3–120 s (default 20).' },
      },
      required: ['question', 'options'],
    },
    rateLimit: ASK_LIMIT,
    run: async (args, deps) => {
      const question = requiredString(args, 'question', 500);
      if (!question) return errorResult("'question' is required.");
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      const options = rawOptions.map((option) => (typeof option === 'string' ? option.trim().slice(0, 60) : '')).filter(Boolean).slice(0, 6);
      if (options.length < 2) return errorResult("'options' must list 2–6 non-empty strings.");
      const timeoutMs = Math.round(clampNumber(optionalNumber(args, 'timeoutSeconds') ?? 20, 3, 120) * 1000);
      const answer = await deps.askUser(question, options, timeoutMs);
      if (!answer) return textResult('The user did not answer in time.', { answered: false });
      return textResult(`The user chose: ${answer.answer}`, { answered: true, answer: answer.answer, index: answer.index });
    },
  },
  {
    name: 'zip_files',
    description:
      'Bundles workspace files into a .zip archive in the workspace (up to 100 files, 20 MB). Pass workspace-relative paths; the archive keeps the same subpaths.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file paths to include.' },
        output: { type: 'string', description: 'Workspace-relative path for the .zip (default "archive-<timestamp>.zip").' },
      },
      required: ['paths'],
    },
    feature: 'filesystem',
    rateLimit: ZIP_LIMIT,
    run: async (args, deps) => {
      const rawPaths = Array.isArray(args.paths) ? args.paths : [];
      const paths = [...new Set(rawPaths.map((path) => (typeof path === 'string' ? path.trim() : '')).filter(Boolean))].slice(0, 100);
      if (!paths.length) return errorResult("'paths' must list at least one workspace file.");
      for (const path of paths) {
        if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return errorResult(`'${path}' must be workspace-relative without '..'.`);
      }
      let output = workspacePathArg(args, 'output');
      if (output === null && args.output !== undefined) return errorResult("'output' is not a valid workspace path.");
      if (!output) output = `archive-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
      if (!output.toLowerCase().endsWith('.zip')) return errorResult("'output' must end with .zip");
      const entries: Record<string, Uint8Array> = {};
      let total = 0;
      for (const path of paths) {
        const stat = await deps.filesystem.stat({ path: `agent/workspace/${path}`, directory: Directory.Data }).catch(() => undefined);
        if (stat?.type === 'directory') return errorResult(`'${path}' is a directory; zip lists files individually.`);
        try {
          const read = await readWorkspaceFile(deps, path);
          if (read.bytes) {
            total += read.bytes.length;
            entries[path] = read.bytes;
          } else {
            if (!read.text) return errorResult(`'${path}' could not be read (missing or empty).`);
            total += read.text.length;
            entries[path] = new TextEncoder().encode(read.text);
          }
          if (total > 20 * 1024 * 1024) return errorResult('The archive would exceed the 20 MB limit.');
        } catch (error) {
          return errorResult(`Could not read '${path}': ${String((error as Error)?.message ?? error)}`);
        }
      }
      if (Object.keys(entries).length === 0) return errorResult('No readable files were found.');
      try {
        const zipped = zipSync(entries, { level: 6 });
        await writeWorkspaceFile(deps, output, { bytes: zipped });
        return textResult(
          `Zipped ${Object.keys(entries).length} file(s) (${(zipped.length / 1024).toFixed(0)} KB) to '${output}'.`,
          { path: output, files: Object.keys(entries).length, bytes: zipped.length },
        );
      } catch (error) {
        return errorResult(`Zip failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'unzip_file',
    description:
      'Extracts a .zip archive from the workspace back into the workspace (up to 200 entries, 40 MB uncompressed). Existing files with the same name are overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the .zip file.' },
        outputDir: { type: 'string', description: 'Optional directory prefix for extracted files (default: archive name without .zip).' },
      },
      required: ['path'],
    },
    feature: 'filesystem',
    rateLimit: ZIP_LIMIT,
    run: async (args, deps) => {
      const path = workspacePathArg(args, 'path');
      if (!path) return errorResult("'path' must be a workspace-relative file path.");
      if (!path.toLowerCase().endsWith('.zip')) return errorResult("'path' must point to a .zip file.");
      const outputDir = workspacePathArg(args, 'outputDir') ?? path.replace(/\.zip$/i, '');
      try {
        const read = await readWorkspaceFile(deps, path);
        const bytes = read.bytes ?? new Uint8Array(0);
        if (!bytes.length) return errorResult(`'${path}' is empty or missing.`);
        const extracted = unzipSync(bytes);
        const names = Object.keys(extracted).filter((name) => !name.endsWith('/'));
        if (!names.length) return errorResult('The archive contains no files.');
        if (names.length > 200) return errorResult(`The archive has ${names.length} entries; the limit is 200.`);
        let total = 0;
        const written: string[] = [];
        for (const name of names) {
          const safeName = name.replace(/\\/g, '/').replace(/^\/+/, '');
          if (!safeName || safeName.includes('..')) continue;
          total += extracted[name].length;
          if (total > 40 * 1024 * 1024) return errorResult('The archive would exceed the 40 MB limit when extracted.');
          const target = outputDir ? `${outputDir}/${safeName}` : safeName;
          await writeWorkspaceFile(deps, target, { bytes: extracted[name] });
          written.push(target);
        }
        return textResult(
          `Extracted ${written.length} file(s) from '${path}'${outputDir ? ` into '${outputDir}/'` : ''}.`,
          { path, outputDir: outputDir || undefined, files: written.length, extracted: written.slice(0, 50) },
        );
      } catch (error) {
        return errorResult(`Unzip failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'sql_query',
    description:
      "Runs ONE SQL statement on the agent's private SQLite database (name: agent_tools) and returns up to 50 rows as JSON. " +
      'Use ? placeholders and params for values. CREATE TABLE / INSERT / UPDATE / DELETE work too; the schema persists across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SQL statement (multiple statements separated by ; are rejected).' },
        params: { type: 'array', description: 'Values for the ? placeholders, in order.' },
      },
      required: ['sql'],
    },
    feature: 'sqlite',
    rateLimit: SQL_LIMIT,
    run: async (args, deps) => {
      const sql = requiredString(args, 'sql', 8000);
      if (!sql) return errorResult("'sql' is required.");
      const trimmed = sql.trim().replace(/;\s*$/, '');
      if (!trimmed) return errorResult("'sql' is empty.");
      if (trimmed.includes(';')) return errorResult('Only a single statement is allowed; remove the inner semicolon.');
      const rawParams = args.params;
      if (rawParams !== undefined && !Array.isArray(rawParams)) return errorResult("'params' must be an array of values.");
      const params = (rawParams as unknown[] | undefined)?.map((value) => (typeof value === 'bigint' ? Number(value) : value)) ?? [];
      const firstWord = trimmed.slice(0, 10).toLowerCase();
      const isRead = firstWord.startsWith('select') || firstWord.startsWith('with') || firstWord.startsWith('pragma') || firstWord.startsWith('explain');
      try {
        if (isRead) {
          const result = await deps.sqlite.query('agent_tools', trimmed, params);
          const rows = Array.isArray(result?.values) ? result.values : [];
          const limited = rows.slice(0, 50);
          const preview = JSON.stringify(limited, null, 1).slice(0, 8000);
          return textResult(
            rows.length > limited.length
              ? `Query returned ${rows.length} rows; showing the first ${limited.length}.\n${preview}`
              : `Query returned ${rows.length} row(s).\n${preview}`,
            { rows: rows.length, results: limited },
          );
        }
        const result = await deps.sqlite.run('agent_tools', trimmed, params);
        const changes = (result as { changes?: unknown } | null)?.changes;
        return textResult(
          `Statement executed.${typeof changes === 'number' ? ` Rows affected: ${changes}.` : ''}`,
          { ...(typeof changes === 'number' ? { changes } : {}) },
        );
      } catch (error) {
        return errorResult(`SQL failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'nearby_status',
    description: 'Reports the Nearby Connections status: advertising/discovery state and the permissions needed for peer-to-peer.',
    inputSchema: { type: 'object', properties: {} },
    feature: 'nearby',
    run: async (_args, deps) => {
      try {
        const status = await deps.nearby.status();
        return textResult(`Nearby status: ${JSON.stringify(status)}`, { status });
      } catch (error) {
        return errorResult(`Status failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'nearby_advertise',
    description:
      'Starts advertising this phone over Nearby Connections (Bluetooth/Wi-Fi direct) so a nearby device running the same agent can discover and connect. ' +
      'The other device runs nearby_discover, then nearby_connect; this side accepts with nearby_accept.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Endpoint name the other device sees (default: a generic agent name).' } },
    },
    feature: 'nearby',
    rateLimit: NEARBY_LIMIT,
    run: async (args, deps) => {
      const title = optionalString(args, 'title', 60);
      try {
        await deps.nearby.initialize();
        await deps.nearby.requestPermissions().catch(() => null);
        await deps.nearby.startAdvertising({ ...(title ? { endpointName: title } : {}) });
        return textResult('Advertising started. The other device can now discover this phone with nearby_discover.', { advertising: true });
      } catch (error) {
        return errorResult(`Advertising failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'nearby_discover',
    description: 'Scans for nearby devices that are advertising (Nearby Connections) for a few seconds and lists endpoint ids/names. Then use nearby_connect.',
    inputSchema: {
      type: 'object',
      properties: { durationSeconds: { type: 'number', description: 'How long to scan, 2–20 s (default 8).' } },
    },
    feature: 'nearby',
    rateLimit: NEARBY_LIMIT,
    run: async (args, deps) => {
      const durationMs = Math.round(clampNumber(optionalNumber(args, 'durationSeconds') ?? 8, 2, 20) * 1000);
      try {
        await deps.nearby.initialize();
        await deps.nearby.requestPermissions().catch(() => null);
        const found = new Map<string, { endpointId: string; endpointName?: string }>();
        const lost = new Set<string>();
        const handles: Array<{ remove?: () => void }> = [];
        handles.push(await deps.nearby.addListener('onEndpointFound', (event) => {
          const id = nearbyEndpointId(event);
          if (!id) return;
          const name = (event as Record<string, unknown> | null)?.endpointName;
          found.set(id, { endpointId: id, ...(typeof name === 'string' && name ? { endpointName: name } : {}) });
        }));
        handles.push(await deps.nearby.addListener('onEndpointLost', (event) => {
          const id = nearbyEndpointId(event);
          if (id) lost.add(id);
        }));
        try {
          await deps.nearby.startDiscovery();
          await new Promise((resolve) => setTimeout(resolve, durationMs));
        } finally {
          await deps.nearby.stopDiscovery().catch(() => undefined);
          for (const handle of handles) handle.remove?.();
        }
        const endpoints = [...found.values()].filter((endpoint) => !lost.has(endpoint.endpointId));
        return textResult(
          endpoints.length
            ? `Found ${endpoints.length} endpoint(s): ${JSON.stringify(endpoints)}`
            : 'No advertising endpoints were found nearby.',
          { endpoints },
        );
      } catch (error) {
        return errorResult(`Discovery failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'nearby_connect',
    description: 'Requests a Nearby Connections connection to a discovered endpoint id. The other side must accept (its agent runs nearby_accept). Waits up to 15 s.',
    inputSchema: {
      type: 'object',
      properties: { endpointId: { type: 'string', description: 'The endpointId returned by nearby_discover.' } },
      required: ['endpointId'],
    },
    feature: 'nearby',
    rateLimit: NEARBY_LIMIT,
    run: async (args, deps) => {
      const endpointId = requiredString(args, 'endpointId', 40);
      if (!endpointId) return errorResult("'endpointId' is required.");
      try {
        await deps.nearby.initialize();
        let connectedResolve!: () => void;
        let failedResolve!: (reason: string) => void;
        const connected = new Promise<void>((resolve) => { connectedResolve = resolve; });
        const failed = new Promise<string>((resolve) => { failedResolve = resolve; });
        const connectedHandle = await deps.nearby.addListener('onEndpointConnected', (event) => {
          if (nearbyEndpointId(event) === endpointId) connectedResolve();
        });
        const failedHandle = await deps.nearby.addListener('onEndpointFailed', (event) => {
          if (nearbyEndpointId(event) === endpointId) {
            const record = event as Record<string, unknown> | null;
            failedResolve(String(record?.status ?? record?.errorMessage ?? 'connection failed'));
          }
        });
        const timeout = new Promise<null>((resolve) => setTimeout(resolve, 15000));
        try {
          await deps.nearby.requestConnection({ endpointID: endpointId });
          const outcome = await Promise.race([connected.then(() => 'connected' as const), failed, timeout]);
          if (outcome === 'connected') {
            return textResult(`Connected to endpoint ${endpointId}. Exchange messages with nearby_send.`, { endpointId, connected: true });
          }
          if (outcome === null) return errorResult('Connection request timed out — the other side did not respond.', { endpointId, connected: false });
          return errorResult(`Connection rejected or failed: ${outcome}`, { endpointId, connected: false });
        } finally {
          connectedHandle.remove?.();
          failedHandle.remove?.();
        }
      } catch (error) {
        return errorResult(`Connection request failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'nearby_accept',
    description: 'Accepts an incoming Nearby Connections request from an endpoint (fires when the other device runs nearby_connect). Afterwards use nearby_send.',
    inputSchema: {
      type: 'object',
      properties: { endpointId: { type: 'string', description: 'The endpointId that requested the connection.' } },
      required: ['endpointId'],
    },
    feature: 'nearby',
    rateLimit: NEARBY_LIMIT,
    run: async (args, deps) => {
      const endpointId = requiredString(args, 'endpointId', 40);
      if (!endpointId) return errorResult("'endpointId' is required.");
      try {
        await deps.nearby.initialize();
        await deps.nearby.acceptConnection({ endpointID: endpointId });
        return textResult(`Accepted the connection from ${endpointId}.`, { endpointId, accepted: true });
      } catch (error) {
        return errorResult(`Accept failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'nearby_send',
    description: 'Sends a short text message to a connected Nearby Connections endpoint (arrives as a payload event on the other agent).',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'string', description: 'Connected endpoint id (omit to send to the single connected endpoint).' },
        text: { type: 'string', description: 'Message text (max 4000 chars).' },
      },
      required: ['text'],
    },
    feature: 'nearby',
    rateLimit: NEARBY_LIMIT,
    run: async (args, deps) => {
      const text = requiredString(args, 'text', 4000);
      if (!text) return errorResult("'text' is required.");
      const endpointId = optionalString(args, 'endpointId', 40);
      try {
        await deps.nearby.sendPayload({ ...(endpointId ? { endpointID: endpointId } : {}), payload: text });
        return textResult(`Sent to ${endpointId ?? 'the connected endpoint'}.`, { endpointId: endpointId ?? undefined, chars: text.length });
      } catch (error) {
        return errorResult(`Send failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'stage_miniapp',
    description:
      'Builds a mini-app (HTML/CSS/JS bundle) from workspace files and launches it in the isolated app browser, full screen on the device. ' +
      'files[] lists workspace-relative paths; the entry must be an HTML file among them. Up to 60 files / 5 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (1–60 chars).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file paths (the HTML entry plus its css/js/assets).' },
        entryFile: { type: 'string', description: 'Entry HTML file (default: the first path ending in index.html).' },
        appId: { type: 'string', description: 'Optional stable app id (lowercase letters/digits/dots/dashes); default "agent.<name>".' },
      },
      required: ['name', 'files'],
    },
    feature: 'appBrowser',
    rateLimit: MINIAPP_LIMIT,
    run: async (args, deps) => {
      const name = requiredString(args, 'name', 60);
      if (!name) return errorResult("'name' is required.");
      const rawFiles = Array.isArray(args.files) ? args.files : [];
      const paths = [...new Set(rawFiles.map((file) => (typeof file === 'string' ? file.trim() : '')).filter(Boolean))].slice(0, 60);
      if (!paths.length) return errorResult("'files' must list at least one workspace path.");
      for (const path of paths) {
        if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return errorResult(`'${path}' must be workspace-relative without '..'.`);
      }
      const entry = optionalString(args, 'entryFile', 120) ?? paths.find((path) => path.toLowerCase().endsWith('index.html')) ?? 'index.html';
      if (!paths.includes(entry)) return errorResult(`Entry file '${entry}' must be one of files[].`);
      let appId = optionalString(args, 'appId', 120);
      if (appId) {
        if (!/^[a-z0-9][a-z0-9.-]{0,118}$/.test(appId)) return errorResult("'appId' may only use lowercase letters, digits, dots and dashes.");
      } else {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        appId = slug ? `agent.${slug}` : 'agent.app';
      }
      const pkgFiles: Array<{ path: string; data: string | Uint8Array; type?: string }> = [];
      let total = 0;
      for (const path of paths) {
        const stat = await deps.filesystem.stat({ path: `agent/workspace/${path}`, directory: Directory.Data }).catch(() => undefined);
        if (stat?.type === 'directory') return errorResult(`'${path}' is a directory; list individual files.`);
        try {
          const read = await readWorkspaceFile(deps, path);
          if (read.bytes) {
            total += read.bytes.length;
            pkgFiles.push({ path, data: read.bytes });
          } else {
            if (!read.text) return errorResult(`'${path}' could not be read (missing or empty).`);
            total += read.text.length;
            pkgFiles.push({ path, data: read.text });
          }
        } catch (error) {
          return errorResult(`Could not read '${path}': ${String((error as Error)?.message ?? error)}`);
        }
      }
      if (total > 5 * 1024 * 1024) return errorResult(`The mini-app bundle is ${(total / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
      try {
        const installResult = await deps.miniapp.install({
          files: pkgFiles,
          manifest: { id: appId, name, entry, version: '1.0.0', requestedCapabilities: [] },
        });
        const installedId = String((installResult as Record<string, unknown> | null)?.id ?? appId);
        // The launch host MUST be attached to the document: when the isolated
        // renderer is unavailable the app browser falls back to an iframe that
        // renders INSIDE this element. A detached host made fallback launches
        // invisible even though the tool reported success.
        let host: HTMLElement | undefined;
        const removeHost = () => { try { host?.remove(); } catch { /* already detached */ } };
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          host = document.createElement('div');
          host.setAttribute('data-nativekit-miniapp-host', installedId);
          host.style.position = 'fixed';
          host.style.inset = '0';
          host.style.zIndex = '2147483000';
          host.style.display = 'flex';
          host.style.flexDirection = 'column';
          host.style.background = '#0b0f14';
          (document.body ?? document.documentElement).appendChild(host);
        }
        try {
          const launched = (await deps.miniapp.launch(installedId, host)) as
            | { renderer?: string; frame?: HTMLIFrameElement; stop?: () => void }
            | undefined;
          const renderer = String(launched?.renderer ?? 'isolated');
          if (renderer === 'iframe' && host) {
            // The fallback iframe renders inside `host`: fill the remaining space
            // and add a close bar so the overlay can be dismissed on the page.
            const frame = launched?.frame;
            if (frame?.style) { frame.style.flex = '1 1 auto'; frame.style.width = '100%'; frame.style.height = '100%'; frame.style.border = '0'; }
            const bar = document.createElement('div');
            bar.textContent = `✕ বন্ধ করুন — ${name}`;
            bar.title = 'Close mini-app';
            bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;padding:10px 14px;font:600 13px system-ui,sans-serif;color:#e6edf3;background:#11161d;cursor:pointer;';
            bar.addEventListener('click', () => { try { launched?.stop?.(); } catch { /* session already stopped */ } removeHost(); });
            host.prepend(bar);
          } else {
            // The fullscreen isolated activity is the real UI; the host is unused
            // and must not linger as an invisible fixed overlay.
            removeHost();
          }
          return textResult(
            `Mini-app '${name}' installed and launched${renderer === 'iframe' ? ' in the in-app fallback frame' : ' in the isolated app browser'}.`,
            { appId: installedId, renderer, files: pkgFiles.length, entry },
          );
        } catch (error) {
          removeHost();
          throw error;
        }
      } catch (error) {
        return errorResult(`Mini-app staging failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'clipboard_write',
    description: 'Copies text to the device clipboard.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to copy (max 20000 chars).' } },
      required: ['text'],
    },
    rateLimit: CLIPBOARD_LIMIT,
    run: async (args, deps) => {
      const text = requiredString(args, 'text', 20000);
      if (!text) return errorResult("'text' is required.");
      try {
        await deps.clipboard.writeText(text);
        return textResult('Copied to the clipboard.', { chars: text.length });
      } catch (error) {
        return errorResult(`Clipboard write failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
  {
    name: 'clipboard_read',
    description: 'Reads the current clipboard text (the device may ask the user for permission). An empty clipboard returns an empty string.',
    inputSchema: { type: 'object', properties: {} },
    rateLimit: CLIPBOARD_LIMIT,
    run: async (_args, deps) => {
      try {
        const text = await deps.clipboard.readText();
        const value = typeof text === 'string' ? text : '';
        return textResult(value ? `Clipboard contains: ${value.slice(0, 4000)}` : 'The clipboard is empty.', { text: value.slice(0, 20000) });
      } catch (error) {
        return errorResult(`Clipboard read failed: ${String((error as Error)?.message ?? error)}`);
      }
    },
  },
];

// ── Transport ────────────────────────────────────────────────────────────────

export interface DeviceToolsOptions {
  /** Feature flags from app.config.json; a `false` value hides matching tools. */
  features?: Partial<Record<DeviceToolFeature, boolean>>;
}

/**
 * Builds the in-process MCP transport for the device tools. The transport is
 * stateless and single-purpose: `tools/list` and `tools/call` (plus a friendly
 * `initialize` so legacy clients also work).
 */
export function createDeviceToolsTransport(
  deps: DeviceToolDeps,
  options: DeviceToolsOptions = {},
): McpTransport {
  const features = options.features ?? {};
  const rate = new RateLimiter(deps.now);
  const ctx: RunContext = { features, rate };

  const visible = () =>
    TOOL_SPECS.filter((spec) => spec.feature === undefined || features[spec.feature] !== false);

  const jsonRpcOk = (id: number | string, result: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    result,
  });

  const jsonRpcError = (id: number | string, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  async function dispatchTool(name: unknown, rawArgs: unknown): Promise<DeviceOutcome> {
    if (typeof name !== 'string' || !name) return errorResult("Malformed tools/call: 'name' must be a string.");
    const spec = visible().find((tool) => tool.name === name);
    if (!spec) return errorResult(`Unknown device tool '${name}'.`);
    if (spec.rateLimit && !rate.allow(name, spec.rateLimit.max, spec.rateLimit.windowMs)) {
      return errorResult(
        `Rate limit: device__${name} is limited to ${spec.rateLimit.max} calls per ${Math.round(spec.rateLimit.windowMs / 1000)}s. Wait, then continue.`,
      );
    }
    const args = asRecord(rawArgs);
    try {
      return await spec.run(args, deps, ctx);
    } catch (error) {
      // A tool must always answer — the engine blocks the model's turn until
      // respondToMcpTool fires, so an unhandled throw would cost a 30s stall.
      return errorResult(`device__${name} failed: ${String((error as Error)?.message ?? error)}`);
    }
  }

  return {
    async send(message: Record<string, unknown>): Promise<JsonRpcResponse | null> {
      // Notifications (no id) expect no response.
      if (message.id === undefined) return null;
      const id = message.id as number | string;
      const method = typeof message.method === 'string' ? message.method : '';

      if (method === 'initialize') {
        return jsonRpcOk(id, {
          serverInfo: { name: 'nativekit-device-tools', version: '1.0.0' },
          capabilities: { tools: { listChanged: false } },
        });
      }
      if (method === 'tools/list') {
        const tools: McpToolDefinition[] = visible().map((spec) => ({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
        }));
        return jsonRpcOk(id, { tools });
      }
      if (method === 'tools/call') {
        const params = asRecord(message.params);
        const result = await dispatchTool(params.name, params.arguments);
        return jsonRpcOk(id, result);
      }
      return jsonRpcError(id, -32601, `Method not found: ${method || '(none)'}`);
    },
  };
}

/** The server config remote callers pass alongside their own servers. */
export function deviceServerConfig(): { name: string; url: string; protocolVersion: 'auto' } {
  return { name: DEVICE_SERVER_NAME, url: 'device://local', protocolVersion: 'auto' };
}

/**
 * Real plugin implementations. Structurally matched against
 * {@link DeviceToolDeps}; guarded by `as unknown as` only where vendor
 * overloads are wider than the minimal shapes above.
 */
export function defaultDeviceToolDeps(): DeviceToolDeps {
  return {
    camera: Camera as unknown as DeviceToolDeps['camera'],
    geolocation: Geolocation as unknown as DeviceToolDeps['geolocation'],
    haptics: Haptics as unknown as DeviceToolDeps['haptics'],
    notifications: LocalNotifications as unknown as DeviceToolDeps['notifications'],
    share: Share as unknown as DeviceToolDeps['share'],
    network: Network as unknown as DeviceToolDeps['network'],
    alarms: NativeKitCustom as unknown as DeviceToolDeps['alarms'],
    filesystem: Filesystem as unknown as DeviceToolDeps['filesystem'],
    openUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    // Plain fetch by default; the nativekit bridge swaps in a CapacitorHttp
    // adapter on devices so WebView CORS rules never block a search.
    fetchImpl: (url, init) => globalThis.fetch(url, init) as Promise<any>,
    transfer: FileTransfer as unknown as DeviceToolDeps['transfer'],
    appInfo: App as unknown as DeviceToolDeps['appInfo'],
    widget: Widget as unknown as DeviceToolDeps['widget'],
    extras: NativeKitCustom as unknown as DeviceToolDeps['extras'],
    // The workspace listens for this DOM event and shows its own toast — the
    // bridge stays UI-agnostic.
    toast: (message) => {
      window.dispatchEvent(new CustomEvent('nativekit:agent-toast', { detail: { message } }));
    },
    // Same decoupling for ask_user: the workspace renders a question card and
    // answers through a paired DOM event.
    askUser: (question, options, timeoutMs) =>
      new Promise((resolve) => {
        if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') { resolve(null); return; }
        const requestId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const onAnswer = (event: Event) => {
          const detail = (event as CustomEvent).detail as { requestId?: string; answer?: { answer: string; index: number } | null } | undefined;
          if (detail?.requestId !== requestId) return;
          cleanup();
          resolve(detail.answer ?? null);
        };
        const cleanup = () => {
          clearTimeout(timer);
          window.removeEventListener('nativekit:agent-ask-response', onAnswer);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, timeoutMs);
        window.addEventListener('nativekit:agent-ask-response', onAnswer);
        window.dispatchEvent(new CustomEvent('nativekit:agent-ask', { detail: { requestId, question, options } }));
      }),
    // Wired by the nativekit bridge at startup (the facades are assembled
    // there); these placeholders keep the module standalone for tests.
    sqlite: {
      query: async () => { throw new Error('sql_query is not wired in this host'); },
      run: async () => { throw new Error('sql_query is not wired in this host'); },
    },
    nearby: NearbyConnections as unknown as DeviceToolDeps['nearby'],
    miniapp: {
      install: async () => { throw new Error('stage_miniapp is not wired in this host'); },
      launch: async () => { throw new Error('stage_miniapp is not wired in this host'); },
    },
    // The WebView clipboard API is gesture-gated and usually rejects calls
    // made from a tool dispatch (no user gesture at that moment), so the
    // native plugin is tried first; the web API is only a fallback for
    // non-native hosts (browser preview).
    clipboard: {
      writeText: async (text: string) => {
        try {
          await NativeKitCustom.clipboardSetText({ text });
          return;
        } catch { /* not a native host — fall through to the web API */ }
        if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard is unavailable in this host');
        await navigator.clipboard.writeText(text);
      },
      readText: async () => {
        try {
          const result = await NativeKitCustom.clipboardGetText();
          return String(result?.text ?? '');
        } catch { /* not a native host — fall through to the web API */ }
        if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard is unavailable in this host');
        return navigator.clipboard.readText();
      },
    },
    now: () => Date.now(),
  };
}

/** Every tool this bridge can expose (before feature filtering). */
export function deviceToolNames(): string[] {
  return TOOL_SPECS.map((spec) => spec.name);
}
