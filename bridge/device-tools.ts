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
import { Directory, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { App } from '@capacitor/app';
import { Widget } from '@nativekit/widget';
import { NativeKitCustom } from '@nativekit/custom-native';
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
    getUri(options: any): Promise<{ uri: string }>;
    stat(options: any): Promise<{ size?: number; type?: string }>;
  };
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
              'The overlay (display over other apps) permission is not granted. Ask the user to enable it in system settings, then try again.',
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
    // The workspace listens for this DOM event and shows its own toast — the
    // bridge stays UI-agnostic.
    toast: (message) => {
      window.dispatchEvent(new CustomEvent('nativekit:agent-toast', { detail: { message } }));
    },
    now: () => Date.now(),
  };
}

/** Every tool this bridge can expose (before feature filtering). */
export function deviceToolNames(): string[] {
  return TOOL_SPECS.map((spec) => spec.name);
}
