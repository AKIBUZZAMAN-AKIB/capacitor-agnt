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
  | 'advancedAlarms';

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
  };
  filesystem: {
    mkdir(options: any): Promise<void>;
    writeFile(options: any): Promise<void>;
  };
  /** Opens a URL outside the WebView. Defaults to `window.open`. */
  openUrl: (url: string) => void;
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

// ── Tool implementations ─────────────────────────────────────────────────────

const NOTIFY_LIMIT = { max: 4, windowMs: 60_000 };
const VIBRATE_LIMIT = { max: 3, windowMs: 60_000 };
const SHARE_LIMIT = { max: 4, windowMs: 60_000 };
const OPEN_URL_LIMIT = { max: 6, windowMs: 60_000 };
const ALARM_LIMIT = { max: 6, windowMs: 60_000 };

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
    now: () => Date.now(),
  };
}

/** Every tool this bridge can expose (before feature filtering). */
export function deviceToolNames(): string[] {
  return TOOL_SPECS.map((spec) => spec.name);
}
