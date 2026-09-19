import { Capacitor, CapacitorHttp, buildRequestInit } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Camera } from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import { Haptics } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { Share } from '@capacitor/share';
import { Network } from '@capacitor/network';
import { BackgroundRunner } from '@capacitor/background-runner';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { NearbyConnections } from '@capacitor-trancee/nearby-connections';
import { NativeKitCustom } from '@nativekit/custom-native';
import { Widget } from '@nativekit/widget';
import { NativeAgent } from 'capacitor-native-agent';
import { InAppBrowser } from '@capgo/capacitor-inappbrowser';
import { createAppBrowser } from './app-browser';

interface NativeKitBuildConfig {
  app: { name: string; id: string; versionName: string; versionCode: number; buildNumber: string };
  features: Record<string, boolean>;
  network: {
    nativeHttp: boolean;
    patchFetch: boolean;
    patchXMLHttpRequest: boolean;
    allowCleartext: boolean;
    allowedHostnames: string[];
    connectTimeoutMs: number;
    readTimeoutMs: number;
  };
  security: { trustedLocalContentOnly: boolean };
  appBrowser: {
    enabled: boolean;
    maxApps: number;
    maxPackageBytes: number;
    maxFiles: number;
    auditLogLimit: number;
    maxRequestsPerMinute: number;
    defaultCapabilities: Array<'permissions' | 'http' | 'camera' | 'location' | 'backgroundLocation' | 'haptics' | 'notifications' | 'alarms' | 'background' | 'preferences' | 'secureStorage' | 'sqlite' | 'filesystem' | 'fileTransfer' | 'sharing' | 'networkStatus' | 'appInfo' | 'pushNotifications' | 'browser'>;
    permissionPrompts: { enabled: boolean; requestTimeoutMs: number; requestedCapabilityDefault: 'ask' | 'allow' | 'block'; unrequestedCapabilityDefault: 'ask' | 'allow' | 'block' };
    allowDirectWebNetwork: boolean;
    urlMode: { enabled: boolean; allowedHosts: string[] };
    renderer: 'iframe' | 'isolated';
    isolated: { enabled: boolean; fallbackToIframe: boolean; stageChunkBytes: number; androidMinApi: number; hangTerminationDelayMs: number };
  };
  backgroundRunner: { label: string; event: string; defaultSyncUrl: string };
  widget: {
    enabled: boolean;
    homeScreen: {
      enabled: boolean;
      updatePeriodMinutes: number;
      resizeEnabled: boolean;
      kinds: Array<{ id: string; label: string; layout: 'small' | 'medium' | 'large'; minWidthDp: number; minHeightDp: number; targetCellWidth: number; targetCellHeight: number }>;
    };
    floating: { enabled: boolean; title: string; page: string; width: number; height: number; startOnLaunch: boolean };
  };
}

declare const __NATIVEKIT_CONFIG__: NativeKitBuildConfig;

type JsonObject = Record<string, unknown>;
type Remove = { remove: () => Promise<void> | void };
type StreamHandlers = {
  onMessage?: (message: { data: string; event?: string; id?: string; format: string }) => void;
  onError?: (error: Error & { status?: number }) => void;
  onEnd?: (details: { status?: number }) => void;
};
type StreamSession = {
  id: string;
  close: () => Promise<void>;
  done: Promise<{ status?: number }>;
};

const config = Object.freeze(__NATIVEKIT_CONFIG__);
const isNative = Capacitor.isNativePlatform();
const platform = Capacitor.getPlatform();
const streamEntries = new Map<string, {
  handlers: StreamHandlers;
  resolve: (value: { status?: number }) => void;
  reject: (reason: unknown) => void;
}>();
let streamListenersReady: Promise<void> | undefined;
let sqlite: SQLiteConnection | undefined;
const databases = new Map<string, any>();

function feature(name: string): void {
  if (!config.features[name]) throw new Error(`NativeKit feature disabled in app.config.json: ${name}`);
}

function requireNative(): void {
  if (!isNative) throw new Error('This operation requires a native Android/iOS build');
}

function randomId(prefix = 'nk'): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`;
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function assertNetworkUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input, globalThis.location?.href ?? 'https://localhost/');
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (url.protocol === 'http:' && !config.network.allowCleartext) {
    throw new Error('Cleartext HTTP is disabled; use HTTPS or explicitly enable it in app.config.json');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported network scheme: ${url.protocol}`);
  const allowed = config.network.allowedHostnames;
  if (allowed.length && url.origin !== globalThis.location?.origin) {
    const match = allowed.some((pattern) => pattern.startsWith('*.')
      ? url.hostname.endsWith(pattern.slice(1)) && url.hostname !== pattern.slice(2)
      : url.hostname === pattern);
    if (!match) throw new Error(`Hostname is not in network.allowedHostnames: ${url.hostname}`);
  }
  return url;
}

export function withHttpParams(url: URL, params: unknown, shouldEncode = true): URL {
  if (params == null) return url;
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('HTTP params must be an object');
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(params as Record<string, unknown>)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value == null) continue;
      const text = String(value);
      parts.push(`${key}=${shouldEncode ? encodeURIComponent(text) : text}`);
    }
  }
  if (!parts.length) return url;
  const output = new URL(url.toString());
  const hash = output.hash;
  output.hash = '';
  const separator = output.search ? '&' : '?';
  return new URL(`${output.toString()}${separator}${parts.join('&')}${hash}`);
}

async function blobAsBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function usesCapacitorHttpAdapter(nativePlatform: boolean, nativeHttpEnabled: boolean): boolean {
  return !nativePlatform || nativeHttpEnabled;
}

export async function fetchHttpRequest(url: URL, options: Record<string, any>): Promise<Record<string, unknown>> {
  const requestUrl = withHttpParams(url, options.params, options.shouldEncodeUrlParams !== false);
  const requestInit = buildRequestInit(options as any, options.webFetchExtra);
  if (options.disableRedirects) requestInit.redirect = 'manual';
  const response = await fetch(requestUrl, requestInit);
  const contentType = response.headers.get('content-type') ?? '';
  let responseType = response.ok ? (options.responseType ?? 'text') : 'text';
  if (contentType.includes('application/json')) responseType = 'json';
  let data: unknown;
  if (responseType === 'json') data = await response.json();
  else if (responseType === 'arraybuffer' || responseType === 'blob') data = await blobAsBase64(await response.blob());
  else data = await response.text();
  return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()), url: response.url };
}

async function ensureStreamListeners(): Promise<void> {
  if (!streamListenersReady) {
    streamListenersReady = (async () => {
      await NativeKitCustom.addListener('nativeSSEData', (event) => {
        streamEntries.get(event.streamId)?.handlers.onMessage?.({
          data: event.data,
          event: event.event,
          id: event.id,
          format: event.format,
        });
      });
      await NativeKitCustom.addListener('nativeSSEEnd', (event) => {
        const entry = streamEntries.get(event.streamId);
        if (!entry) return;
        entry.handlers.onEnd?.({ status: event.status });
        entry.resolve({ status: event.status });
        streamEntries.delete(event.streamId);
      });
      await NativeKitCustom.addListener('nativeSSEError', (event) => {
        const entry = streamEntries.get(event.streamId);
        if (!entry) return;
        const error = Object.assign(new Error(event.message), { status: event.status });
        entry.handlers.onError?.(error);
        entry.reject(error);
        streamEntries.delete(event.streamId);
      });
    })();
  }
  return streamListenersReady;
}

function parseSseBlock(block: string): { data: string; event?: string; id?: string; format: string } | null {
  const lines = block.replaceAll('\r\n', '\n').split('\n');
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  return data.length || event || id ? { data: data.join('\n'), event, id, format: 'sse' } : null;
}

export async function webStream(
  options: { url: string; method?: string; headers?: Record<string, string>; body?: string; format?: 'sse' | 'text' | 'ndjson'; disableRedirects?: boolean },
  handlers: StreamHandlers,
): Promise<StreamSession> {
  const id = randomId('stream');
  const controller = new AbortController();
  let resolveDone!: (value: { status?: number }) => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<{ status?: number }>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const format = options.format ?? 'sse';
  const request = (async () => {
    try {
      const response = await fetch(assertNetworkUrl(options.url), {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
        redirect: options.disableRedirects ? 'manual' : 'follow',
      });
      if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        const chunk = decoder.decode(value, { stream: true });
        if (format === 'text') {
          handlers.onMessage?.({ data: chunk, format });
          continue;
        }
        pending += chunk.replaceAll('\r\n', '\n');
        const separator = format === 'sse' ? '\n\n' : '\n';
        let index;
        while ((index = pending.indexOf(separator)) >= 0) {
          const record = pending.slice(0, index);
          pending = pending.slice(index + separator.length);
          if (format === 'sse') {
            const parsed = parseSseBlock(record);
            if (parsed) handlers.onMessage?.(parsed);
          } else if (record.trim()) {
            handlers.onMessage?.({ data: record, format });
          }
        }
      }
      if (pending.trim()) handlers.onMessage?.({ data: pending, format });
      handlers.onEnd?.({ status: response.status });
      resolveDone({ status: response.status });
    } catch (cause) {
      if (controller.signal.aborted) {
        resolveDone({});
        return;
      }
      const error = cause instanceof Error ? cause : new Error(String(cause));
      handlers.onError?.(error);
      rejectDone(error);
    }
  })();
  void request;
  return { id, close: async () => controller.abort(), done };
}

export async function nativeStream(
  options: { url: string; method?: string; headers?: Record<string, string>; body?: string; format?: 'sse' | 'text' | 'ndjson'; disableRedirects?: boolean },
  handlers: StreamHandlers,
): Promise<StreamSession> {
  feature('nativeSSE');
  await ensureStreamListeners();
  const id = randomId('stream');
  let resolveDone!: (value: { status?: number }) => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<{ status?: number }>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  streamEntries.set(id, { handlers, resolve: resolveDone, reject: rejectDone });
  try {
    await NativeKitCustom.startSSE({ ...options, url: assertNetworkUrl(options.url).toString(), streamId: id });
  } catch (error) {
    streamEntries.delete(id);
    rejectDone(error);
    throw error;
  }
  return {
    id,
    close: async () => {
      try {
        await NativeKitCustom.stopSSE({ streamId: id });
      } finally {
        // A caller-initiated cancellation always settles local completion and
        // releases the handler entry, even if the native stop acknowledgement fails.
        streamEntries.get(id)?.resolve({});
        streamEntries.delete(id);
      }
    },
    done,
  };
}

function directory(name?: string): Directory | undefined {
  if (!name) return undefined;
  const table: Record<string, Directory> = {
    Documents: Directory.Documents,
    Data: Directory.Data,
    Library: Directory.Library,
    Cache: Directory.Cache,
    External: Directory.External,
    ExternalStorage: Directory.ExternalStorage,
  };
  const value = table[name];
  if (!value) throw new Error(`Unknown Filesystem directory: ${name}`);
  return value;
}

async function ensureDirectory(pathValue: string, directoryName = 'Data'): Promise<void> {
  const parts = pathValue.split('/').filter(Boolean);
  parts.pop();
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await Filesystem.mkdir({ path: current, directory: directory(directoryName), recursive: false }).catch((error) => {
      if (!/exist/i.test(String(error?.message ?? error))) throw error;
    });
  }
}

async function openDatabase(name: string, options: { version?: number; encrypted?: boolean; mode?: string } = {}): Promise<any> {
  feature('sqlite');
  if (!isNative) throw new Error('SQLite web adapter is not bundled. Use preferences on web or add jeep-sqlite for a separately hosted PWA.');
  if (databases.has(name)) return databases.get(name);
  sqlite ??= new SQLiteConnection(CapacitorSQLite);
  const db = await sqlite.createConnection(name, !!options.encrypted, options.mode ?? 'no-encryption', options.version ?? 1, false);
  await db.open();
  databases.set(name, db);
  return db;
}

const NativeKit: any = {
  version: '1.0.0',
  config,
  platform,
  isNative,
  ready: async (): Promise<any> => {
    if (document.readyState === 'loading') await new Promise<void>((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
    return NativeKit;
  },
  capabilities: (): JsonObject => ({
    platform,
    native: isNative,
    ...config.features,
    serviceWorker: !isNative && 'serviceWorker' in navigator,
    caveats: {
      cors: isNative ? 'Explicit native HTTP/SSE avoids browser CORS, but upstream TLS/auth/policy still applies.' : 'Third-party server CORS policy applies.',
      background: 'Execution time and frequency are controlled by Android/iOS.',
      alarms: 'Exact/full-screen behavior requires platform access and store-policy eligibility.',
    },
  }),
  permissions: {
    check: async (): Promise<JsonObject> => ({
      camera: config.features.camera ? await Camera.checkPermissions() : { camera: 'disabled' },
      location: config.features.location ? await Geolocation.checkPermissions() : { location: 'disabled' },
      notifications: config.features.localNotifications ? await LocalNotifications.checkPermissions() : { display: 'disabled' },
      push: config.features.pushNotificationsReady ? await PushNotifications.checkPermissions() : { receive: 'disabled' },
      alarms: config.features.advancedAlarms ? await NativeKitCustom.checkAlarmCapabilities() : { exact: false, fullScreen: false, alarmKit: false },
      backgroundLocation: config.features.backgroundLocation ? await NativeKitCustom.getBackgroundLocationStatus() : { running: false, permission: 'disabled' },
    }),
    requestCamera: async () => { feature('camera'); return Camera.requestPermissions(); },
    requestLocation: async (coarseOnly = false) => { feature('location'); return Geolocation.requestPermissions({ permissions: coarseOnly ? ['coarseLocation'] : ['location'] }); },
    requestNotifications: async () => { feature('localNotifications'); return LocalNotifications.requestPermissions(); },
    requestPush: async () => { feature('pushNotificationsReady'); return PushNotifications.requestPermissions(); },
    openAppSettings: () => NativeKitCustom.openAppSettings(),
  },
  http: {
    request: async (options: Record<string, any>) => {
      const url = assertNetworkUrl(String(options.url));
      const finalOptions: Record<string, any> = {
        connectTimeout: config.network.connectTimeoutMs,
        readTimeout: config.network.readTimeoutMs,
        ...options,
        url: url.toString(),
      };
      // Browser builds use Capacitor's web adapter. Native builds use the plugin only
      // when nativeHttp is enabled; otherwise they deliberately stay on window.fetch.
      if (usesCapacitorHttpAdapter(isNative, config.network.nativeHttp)) return CapacitorHttp.request(finalOptions as any);
      return fetchHttpRequest(url, finalOptions);
    },
    get: (url: string, options: Record<string, any> = {}) => NativeKit.http.request({ ...options, method: 'GET', url }),
    post: (url: string, data?: unknown, options: Record<string, any> = {}) => NativeKit.http.request({ ...options, method: 'POST', url, data }),
    stream: (options: { url: string; method?: string; headers?: Record<string, string>; body?: string; format?: 'sse' | 'text' | 'ndjson'; disableRedirects?: boolean }, handlers: StreamHandlers = {}) => {
      feature('nativeSSE');
      return isNative ? nativeStream(options, handlers) : webStream(options, handlers);
    },
  },
  camera: {
    getPhoto: async (options: Record<string, any> = {}) => { feature('camera'); return Camera.getPhoto({ quality: 85, resultType: 'uri', source: 'PROMPT', ...options } as any); },
    pickImages: async (options: Record<string, any> = {}) => { feature('camera'); return Camera.pickImages(options as any); },
  },
  location: {
    current: async (options: Record<string, any> = {}) => { feature('location'); return Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, ...options }); },
    watch: async (callback: (position: any, error?: any) => void, options: Record<string, any> = {}) => {
      feature('location');
      const id = await Geolocation.watchPosition({ enableHighAccuracy: true, ...options }, (position, error) => callback(position, error));
      return { id, remove: () => Geolocation.clearWatch({ id }) };
    },
  },
  backgroundLocation: {
    start: async (options: Record<string, any> = {}) => { feature('backgroundLocation'); return NativeKitCustom.startBackgroundLocation(options); },
    stop: () => { feature('backgroundLocation'); return NativeKitCustom.stopBackgroundLocation(); },
    status: () => { feature('backgroundLocation'); return NativeKitCustom.getBackgroundLocationStatus(); },
    buffered: () => { feature('backgroundLocation'); return NativeKitCustom.getBufferedLocations(); },
    clearBuffered: () => { feature('backgroundLocation'); return NativeKitCustom.clearBufferedLocations(); },
    onLocation: (callback: (location: any) => void): Promise<Remove> => { feature('backgroundLocation'); return NativeKitCustom.addListener('nativeLocation', callback); },
  },
  haptics: {
    impact: async (style: 'LIGHT' | 'MEDIUM' | 'HEAVY' = 'MEDIUM') => { feature('haptics'); return Haptics.impact({ style: style as any }); },
    notification: async (type: 'SUCCESS' | 'WARNING' | 'ERROR' = 'SUCCESS') => { feature('haptics'); return Haptics.notification({ type: type as any }); },
    vibrate: async (duration = 300) => { feature('haptics'); return Haptics.vibrate({ duration }); },
  },
  notifications: {
    check: () => { feature('localNotifications'); return LocalNotifications.checkPermissions(); },
    request: () => { feature('localNotifications'); return LocalNotifications.requestPermissions(); },
    schedule: async (notifications: any[]) => { feature('localNotifications'); return LocalNotifications.schedule({ notifications }); },
    cancel: (ids: number[]) => { feature('localNotifications'); return LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }); },
    pending: () => { feature('localNotifications'); return LocalNotifications.getPending(); },
    delivered: () => { feature('localNotifications'); return LocalNotifications.getDeliveredNotifications(); },
    removeDelivered: async (ids: number[]) => {
      feature('localNotifications');
      const delivered = await LocalNotifications.getDeliveredNotifications();
      return LocalNotifications.removeDeliveredNotifications({ notifications: delivered.notifications.filter((item) => ids.includes(item.id)) });
    },
    createChannel: (channel: any) => { feature('localNotifications'); return LocalNotifications.createChannel(channel); },
    onReceived: (callback: (notification: any) => void): Promise<Remove> => { feature('localNotifications'); return LocalNotifications.addListener('localNotificationReceived', callback); },
    onAction: (callback: (action: any) => void): Promise<Remove> => { feature('localNotifications'); return LocalNotifications.addListener('localNotificationActionPerformed', callback); },
  },
  alarms: {
    capabilities: () => { feature('advancedAlarms'); return NativeKitCustom.checkAlarmCapabilities(); },
    requestExactAccess: async () => { feature('advancedAlarms'); return NativeKitCustom.requestExactAlarmAccess(); },
    requestFullScreenAccess: async () => { feature('advancedAlarms'); return NativeKitCustom.requestFullScreenIntentAccess(); },
    schedule: async (options: any) => {
      feature('advancedAlarms');
      const at = typeof options.at === 'number' ? options.at : new Date(options.at).getTime();
      if (!Number.isFinite(at)) throw new Error('Alarm at must be a valid ISO date or epoch milliseconds');
      return NativeKitCustom.scheduleAlarm({ ...options, at });
    },
    cancel: (id: string) => { feature('advancedAlarms'); return NativeKitCustom.cancelAlarm({ id }); },
    list: () => { feature('advancedAlarms'); return NativeKitCustom.listAlarms(); },
    stop: (id?: string) => { feature('advancedAlarms'); return NativeKitCustom.stopRinging({ id }); },
    onFired: (callback: (event: { id: string }) => void): Promise<Remove> => { feature('advancedAlarms'); return NativeKitCustom.addListener('nativeAlarmFired', callback); },
  },
  background: {
    dispatch: (details: JsonObject = {}) => {
      feature('backgroundRunner');
      return BackgroundRunner.dispatchEvent({ label: config.backgroundRunner.label, event: config.backgroundRunner.event, details } as any);
    },
    // Background Runner KV is isolated from Preferences; pass syncUrl in dispatch details for on-demand runs.
    runSyncNow: (details: JsonObject = {}) => NativeKit.background.dispatch({ syncUrl: config.backgroundRunner.defaultSyncUrl, ...details }),
    checkPermissions: () => { feature('backgroundRunner'); return BackgroundRunner.checkPermissions(); },
    requestPermissions: (apis: Array<'geolocation' | 'notifications'>) => { feature('backgroundRunner'); return BackgroundRunner.requestPermissions({ apis }); },
  },
  preferences: {
    set: (key: string, value: string) => { feature('preferences'); return Preferences.set({ key, value }); },
    get: async (key: string) => { feature('preferences'); return (await Preferences.get({ key })).value; },
    remove: (key: string) => { feature('preferences'); return Preferences.remove({ key }); },
    clear: () => { feature('preferences'); return Preferences.clear(); },
    keys: () => { feature('preferences'); return Preferences.keys(); },
    setJSON: (key: string, value: unknown) => { feature('preferences'); return Preferences.set({ key, value: JSON.stringify(value) }); },
    getJSON: async <T = unknown>(key: string): Promise<T | null> => {
      feature('preferences');
      const value = (await Preferences.get({ key })).value;
      return value == null ? null : JSON.parse(value) as T;
    },
  },
  secureStorage: {
    set: async (key: string, value: string) => { feature('secureStorage'); return NativeKitCustom.secureSet({ key, value }); },
    get: async (key: string) => { feature('secureStorage'); return (await NativeKitCustom.secureGet({ key })).value; },
    remove: (key: string) => { feature('secureStorage'); return NativeKitCustom.secureRemove({ key }); },
    clear: () => { feature('secureStorage'); return NativeKitCustom.secureClear(); },
  },
  sqlite: {
    open: openDatabase,
    execute: async (name: string, statements: string, transaction = true) => (await openDatabase(name)).execute(statements, transaction),
    run: async (name: string, statement: string, values: any[] = [], transaction = true) => (await openDatabase(name)).run(statement, values, transaction),
    query: async (name: string, statement: string, values: any[] = []) => (await openDatabase(name)).query(statement, values),
    close: async (name: string) => {
      feature('sqlite');
      if (databases.has(name)) await sqlite?.closeConnection(name, false);
      databases.delete(name);
    },
    delete: async (name: string) => {
      feature('sqlite');
      if (databases.has(name)) await sqlite?.closeConnection(name, false);
      databases.delete(name);
      await CapacitorSQLite.deleteDatabase({ database: name });
    },
  },
  filesystem: {
    directories: Object.freeze({ Documents: 'Documents', Data: 'Data', Library: 'Library', Cache: 'Cache', External: 'External', ExternalStorage: 'ExternalStorage' }),
    readFile: (options: any) => { feature('filesystem'); return Filesystem.readFile({ ...options, directory: directory(options.directory), encoding: options.encoding as Encoding | undefined }); },
    writeFile: async (options: any) => { feature('filesystem'); if (options.recursive) await ensureDirectory(options.path, options.directory); return Filesystem.writeFile({ ...options, directory: directory(options.directory), encoding: options.encoding as Encoding | undefined }); },
    appendFile: (options: any) => { feature('filesystem'); return Filesystem.appendFile({ ...options, directory: directory(options.directory), encoding: options.encoding as Encoding | undefined }); },
    deleteFile: (options: any) => { feature('filesystem'); return Filesystem.deleteFile({ ...options, directory: directory(options.directory) }); },
    mkdir: (options: any) => { feature('filesystem'); return Filesystem.mkdir({ ...options, directory: directory(options.directory) }); },
    rmdir: (options: any) => { feature('filesystem'); return Filesystem.rmdir({ ...options, directory: directory(options.directory) }); },
    readdir: (options: any) => { feature('filesystem'); return Filesystem.readdir({ ...options, directory: directory(options.directory) }); },
    stat: (options: any) => { feature('filesystem'); return Filesystem.stat({ ...options, directory: directory(options.directory) }); },
    getUri: (options: any) => { feature('filesystem'); return Filesystem.getUri({ ...options, directory: directory(options.directory) }); },
  },
  transfer: {
    download: async (options: { url: string; path: string; directory?: string; headers?: Record<string, string>; disableRedirects?: boolean; onProgress?: (progress: any) => void }) => {
      feature('fileTransfer');
      assertNetworkUrl(options.url);
      await ensureDirectory(options.path, options.directory);
      const target = await Filesystem.getUri({ path: options.path, directory: directory(options.directory ?? 'Data') as Directory });
      const handle = options.onProgress ? await FileTransfer.addListener('progress', options.onProgress) : undefined;
      try { return await FileTransfer.downloadFile({ url: options.url, path: target.uri, headers: options.headers, progress: !!options.onProgress, disableRedirects: options.disableRedirects }); }
      finally { await handle?.remove(); }
    },
    upload: async (options: { url: string; path: string; directory?: string; headers?: Record<string, string>; method?: string; mimeType?: string; disableRedirects?: boolean; onProgress?: (progress: any) => void }) => {
      feature('fileTransfer');
      assertNetworkUrl(options.url);
      const source = await Filesystem.getUri({ path: options.path, directory: directory(options.directory ?? 'Data') as Directory });
      const handle = options.onProgress ? await FileTransfer.addListener('progress', options.onProgress) : undefined;
      try { return await FileTransfer.uploadFile({ url: options.url, path: source.uri, headers: options.headers, method: options.method, mimeType: options.mimeType, progress: !!options.onProgress, disableRedirects: options.disableRedirects }); }
      finally { await handle?.remove(); }
    },
  },
  browser: {
    open: async (input: string | { url: string }) => {
      feature('inAppBrowser');
      const url = assertNetworkUrl(typeof input === 'string' ? input : input?.url).toString();
      if (isNative) return InAppBrowser.open({ url });
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) throw new Error('Browser popup was blocked');
      return { opened: true };
    },
  },
  share: {
    canShare: () => { feature('sharing'); return Share.canShare(); },
    show: async (options: any) => { feature('sharing'); return Share.share(options); },
  },
  network: {
    status: () => { feature('networkStatus'); return Network.getStatus(); },
    onChange: (callback: (status: any) => void): Promise<Remove> => { feature('networkStatus'); return Network.addListener('networkStatusChange', callback); },
  },
  app: {
    info: () => App.getInfo(),
    state: () => App.getState(),
    onStateChange: (callback: (state: any) => void): Promise<Remove> => App.addListener('appStateChange', callback),
    onUrlOpen: (callback: (event: any) => void): Promise<Remove> => App.addListener('appUrlOpen', callback),
    exit: () => App.exitApp(),
  },
  push: {
    register: async () => { feature('pushNotificationsReady'); const permission = await PushNotifications.checkPermissions(); if (permission.receive === 'prompt') await PushNotifications.requestPermissions(); return PushNotifications.register(); },
    unregister: () => { feature('pushNotificationsReady'); return PushNotifications.unregister(); },
    delivered: () => { feature('pushNotificationsReady'); return PushNotifications.getDeliveredNotifications(); },
    removeAllDelivered: () => { feature('pushNotificationsReady'); return PushNotifications.removeAllDeliveredNotifications(); },
    onRegistration: (callback: (token: any) => void): Promise<Remove> => { feature('pushNotificationsReady'); return PushNotifications.addListener('registration', callback); },
    onRegistrationError: (callback: (error: any) => void): Promise<Remove> => { feature('pushNotificationsReady'); return PushNotifications.addListener('registrationError', callback); },
    onReceived: (callback: (notification: any) => void): Promise<Remove> => { feature('pushNotificationsReady'); return PushNotifications.addListener('pushNotificationReceived', callback); },
    onAction: (callback: (action: any) => void): Promise<Remove> => { feature('pushNotificationsReady'); return PushNotifications.addListener('pushNotificationActionPerformed', callback); },
  },
  nearby: {
    // Largest BYTES payload Google accepts: ConnectionsClient.MAX_BYTES_DATA_SIZE (1,047,552).
    MAX_PAYLOAD_BYTES: 1047552,
    // Send/download the payload as a base64 string across the bridge (plugin contract);
    // these helpers keep that invisible to callers (send plain text/JSON, receive the same).
    encodeBase64Utf8,
    decodeBase64Utf8,
    // Lifecycle
    initialize: (options: Record<string, any> = {}) => { feature('nearby'); return NearbyConnections.initialize(options); },
    reset: () => { feature('nearby'); return NearbyConnections.reset(); },
    startAdvertising: (options: Record<string, any> = {}) => { feature('nearby'); return NearbyConnections.startAdvertising(options); },
    stopAdvertising: () => { feature('nearby'); return NearbyConnections.stopAdvertising(); },
    startDiscovery: (options: Record<string, any> = {}) => { feature('nearby'); return NearbyConnections.startDiscovery(options); },
    stopDiscovery: () => { feature('nearby'); return NearbyConnections.stopDiscovery(); },
    // Connection management
    requestConnection: (options: { endpointID: string; endpointName?: string }) => { feature('nearby'); return NearbyConnections.requestConnection(options); },
    acceptConnection: (options: { endpointID: string }) => { feature('nearby'); return NearbyConnections.acceptConnection(options); },
    rejectConnection: (options: { endpointID: string }) => { feature('nearby'); return NearbyConnections.rejectConnection(options); },
    disconnect: (options: { endpointID: string }) => { feature('nearby'); return NearbyConnections.disconnect(options); },
    // Payloads (BYTES only upstream; payload must be base64 -> encode unless caller opted out)
    sendPayload: (options: { endpointID?: string; endpointIDs?: string[]; payload: string; alreadyBase64?: boolean }) => {
      feature('nearby');
      const { alreadyBase64, ...rest } = options;
      return NearbyConnections.sendPayload({ ...rest, payload: alreadyBase64 ? options.payload : encodeBase64Utf8(options.payload) });
    },
    cancelPayload: (options: { payloadID: number }) => { feature('nearby'); return NearbyConnections.cancelPayload(options); },
    status: () => { feature('nearby'); return NearbyConnections.status(); },
    // Permissions (all groups when not narrowed)
    checkPermissions: () => { feature('nearby'); return NearbyConnections.checkPermissions(); },
    requestPermissions: (groups?: Array<'wifiNearby' | 'wifiState' | 'bluetoothNearby' | 'bluetoothLegacy' | 'location' | 'locationCoarse'>) => {
      feature('nearby');
      const all: Array<'wifiNearby' | 'wifiState' | 'bluetoothNearby' | 'bluetoothLegacy' | 'location' | 'locationCoarse'> = ['wifiNearby', 'wifiState', 'bluetoothNearby', 'bluetoothLegacy', 'location', 'locationCoarse'];
      return NearbyConnections.requestPermissions({ permissions: groups && groups.length ? groups : all });
    },
    // All 12 listeners wired through one generic registration
    addListener: (eventName: string, callback: (event: any) => void): Promise<Remove> => {
      feature('nearby');
      return (NearbyConnections as any).addListener(eventName, callback);
    },
  },
  serviceWorker: {
    supported: !isNative && 'serviceWorker' in navigator,
    unregisterAll: async () => {
      if (!('serviceWorker' in navigator)) return [];
      const registrations = await navigator.serviceWorker.getRegistrations();
      return Promise.all(registrations.map((registration) => registration.unregister()));
    },
  },
  widget: {
    supported: (): boolean => config.features.widget && isNative,
    listConfigs: async () => { feature('widget'); requireNative(); return Widget.listConfigs(); },
    getConfig: async (kind: string) => { feature('widget'); requireNative(); return Widget.getConfig({ kind }); },
    setConfig: async (kind: string, widgetConfig: Record<string, unknown>) => {
      feature('widget'); requireNative();
      return Widget.setConfig({ kind, config: widgetConfig });
    },
    update: async (kind: string, widgetConfig: Record<string, unknown>) => {
      feature('widget'); requireNative();
      const saved = await Widget.setConfig({ kind, config: widgetConfig });
      await Widget.reload({ kind });
      return saved;
    },
    reload: async (kind?: string) => { feature('widget'); requireNative(); return Widget.reload(kind ? { kind } : {}); },
    getWidgetIds: async (kind: string) => { feature('widget'); requireNative(); return Widget.getWidgetIds({ kind }); },
    requestPin: async (kind: string) => { feature('widget'); requireNative(); return Widget.requestPin({ kind }); },
    checkFloatingPermission: async () => { feature('widget'); requireNative(); return Widget.checkOverlayPermission(); },
    requestFloatingPermission: async () => { feature('widget'); requireNative(); return Widget.requestOverlayPermission(); },
    showFloating: async (options: Record<string, unknown> = {}) => { feature('widget'); requireNative(); return Widget.showFloating(options); },
    hideFloating: async () => { feature('widget'); requireNative(); return Widget.hideFloating(); },
    isFloatingVisible: async () => { feature('widget'); requireNative(); return Widget.isFloatingVisible(); },
    updateFloating: async (options: Record<string, unknown> = {}) => { feature('widget'); requireNative(); return Widget.updateFloating(options); },
    runFloatingJavascript: async (script: string) => { feature('widget'); requireNative(); return Widget.runFloatingJavascript({ script }); },
    sendToFloating: async (data: unknown) => { feature('widget'); requireNative(); return Widget.sendToFloating({ data }); },
    onWidgetTap: (callback: (event: any) => void): Promise<Remove> => { feature('widget'); requireNative(); return Widget.addListener('nativeWidgetTap', callback); },
    onFloatingMessage: (callback: (event: any) => void): Promise<Remove> => { feature('widget'); requireNative(); return Widget.addListener('nativeFloatingMessage', callback); },
  },
  // On-device Rust AI agent. Every call below runs entirely inside the app
  // process (LLM client, tool loop, SQLite store, cron scheduler) — the only
  // network traffic is the agent talking to its configured LLM provider.
  //
  // The plugin is pinned to the PUBLIC upstream generation "0.5.2" (see
  // docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md), whose Rust crate source is public
  // and therefore buildable for every Android ABI. Five methods that only exist
  // in the newer (private-source) generation are provided here as compatibility
  // shims instead of raw pass-throughs: checkAvailability (native probe added),
  // scheduleBackgroundWakes, cancelBackgroundWakes, loadSurfacedMessages and
  // setMcpTools.
  agent: {
    supported: (): boolean => config.features.agent && isNative,

    /** Which engine generation the pinned plugin builds against. */
    engineGeneration: '0.5.2-public',

    // ── Diagnostics ──
    // Never rejects: an unsupported device ABI resolves { available: false }.
    checkAvailability: async () => { feature('agent'); requireNative(); return NativeAgent.checkAvailability(); },

    // ── Lifecycle ──
    initWorkspace: async (options: Record<string, unknown>) => { feature('agent'); requireNative(); return NativeAgent.initWorkspace(options as any); },
    initialize: async (options: Record<string, unknown>) => { feature('agent'); requireNative(); return NativeAgent.initialize(options as any); },

    // ── Background wakes (Android JobScheduler / iOS BGProcessingTask) ──
    // Not part of the 0.5.2 engine. Resolves (never rejects) with an explicit
    // "unsupported" envelope so UI code can show a truthful message; scheduled
    // agent work is still available through cron jobs + handleWake().
    scheduleBackgroundWakes: async (intervalMinutes?: number) => {
      feature('agent'); requireNative();
      return {
        supported: false,
        engineGeneration: '0.5.2-public',
        intervalMinutes: intervalMinutes ?? null,
        reason: 'scheduleBackgroundWakes() is a newer-engine (>=0.6) API; the pinned 0.5.2 build has no OS wake scheduler.',
        alternative: 'Use addCronJob() for scheduled runs and handleWake() from your own JobService/BackgroundRunner task.',
      };
    },
    cancelBackgroundWakes: async () => {
      feature('agent'); requireNative();
      return {
        supported: false,
        engineGeneration: '0.5.2-public',
        reason: 'cancelBackgroundWakes() is a newer-engine (>=0.6) API; nothing was scheduled by this build.',
      };
    },

    // ── Agent turns ──
    sendMessage: async (options: Record<string, unknown>) => { feature('agent'); requireNative(); return NativeAgent.sendMessage(options as any); },
    followUp: async (prompt: string) => { feature('agent'); requireNative(); return NativeAgent.followUp({ prompt }); },
    abort: async () => { feature('agent'); requireNative(); return NativeAgent.abort(); },
    steer: async (text: string) => { feature('agent'); requireNative(); return NativeAgent.steer({ text }); },

    // ── Approval gate (human-in-the-loop tool calls) ──
    respondToApproval: async (toolCallId: string, approved: boolean, reason?: string) => {
      feature('agent'); requireNative();
      return NativeAgent.respondToApproval({ toolCallId, approved, reason });
    },
    respondToMcpTool: async (toolCallId: string, resultJson: string, isError = false) => {
      feature('agent'); requireNative();
      return NativeAgent.respondToMcpTool({ toolCallId, resultJson, isError });
    },
    respondToCronApproval: async (requestId: string, approved: boolean) => {
      feature('agent'); requireNative();
      return NativeAgent.respondToCronApproval({ requestId, approved });
    },

    // ── Auth (stored in the engine's auth-profiles.json) ──
    getAuthToken: async (provider = 'anthropic') => { feature('agent'); requireNative(); return NativeAgent.getAuthToken({ provider }); },
    setAuthKey: async (key: string, provider = 'anthropic', authType = 'api_key', refresh?: string, expiresAt?: number) => {
      feature('agent'); requireNative();
      // `refresh`/`expiresAt` are newer-engine fields; the 0.5.2 binding accepts
      // key/provider/authType only (OAuth tokens go through exchangeOAuthCode()).
      return NativeAgent.setAuthKey({ key, provider, authType });
    },
    deleteAuth: async (provider = 'anthropic') => { feature('agent'); requireNative(); return NativeAgent.deleteAuth({ provider }); },
    refreshToken: async (provider = 'anthropic') => { feature('agent'); requireNative(); return NativeAgent.refreshToken({ provider }); },
    getAuthStatus: async (provider = 'anthropic') => { feature('agent'); requireNative(); return NativeAgent.getAuthStatus({ provider }); },
    exchangeOAuthCode: async (tokenUrl: string, bodyJson: string, contentType?: string) => {
      feature('agent'); requireNative();
      return NativeAgent.exchangeOAuthCode({ tokenUrl, bodyJson, contentType });
    },

    // ── Sessions ──
    listSessions: async (agentId = 'main') => { feature('agent'); requireNative(); return NativeAgent.listSessions({ agentId }); },
    loadSession: async (sessionKey: string, agentId?: string) => { feature('agent'); requireNative(); return NativeAgent.loadSession({ sessionKey, agentId: agentId ?? 'main' }); },
    resumeSession: async (options: Record<string, unknown>) => { feature('agent'); requireNative(); return NativeAgent.resumeSession(options as any); },
    clearSession: async () => { feature('agent'); requireNative(); return NativeAgent.clearSession(); },

    // ── Cron / heartbeat ──
    addCronJob: async (inputJson: string) => { feature('agent'); requireNative(); return NativeAgent.addCronJob({ inputJson }); },
    updateCronJob: async (id: string, patchJson: string) => { feature('agent'); requireNative(); return NativeAgent.updateCronJob({ id, patchJson }); },
    removeCronJob: async (id: string) => { feature('agent'); requireNative(); return NativeAgent.removeCronJob({ id }); },
    listCronJobs: async () => { feature('agent'); requireNative(); return NativeAgent.listCronJobs(); },
    runCronJob: async (jobId: string) => { feature('agent'); requireNative(); return NativeAgent.runCronJob({ jobId }); },
    listCronRuns: async (jobId?: string, limit?: number) => { feature('agent'); requireNative(); return NativeAgent.listCronRuns({ jobId, limit }); },
    loadSurfacedMessages: async (limit?: number) => {
      feature('agent'); requireNative();
      // 0.5.2 has no "surfaced messages" API: return the session list instead of
      // throwing, so the lab UI can still render something meaningful.
      const out: Record<string, unknown> = {
        supported: false,
        engineGeneration: '0.5.2-public',
        limit: limit ?? 20,
        reason: 'loadSurfacedMessages() is a newer-engine (>=0.6) API.',
        alternative: 'listSessions() + loadSession() give the stored conversation.',
      };
      try {
        out.sessions = await NativeAgent.listSessions({ agentId: 'main' });
      } catch (error) {
        out.sessionsError = error instanceof Error ? error.message : String(error);
      }
      return out;
    },
    handleWake: async (source?: string) => { feature('agent'); requireNative(); return NativeAgent.handleWake({ source: source ?? 'manual' }); },
    getSchedulerConfig: async () => { feature('agent'); requireNative(); return NativeAgent.getSchedulerConfig(); },
    setSchedulerConfig: async (configJson: string) => { feature('agent'); requireNative(); return NativeAgent.setSchedulerConfig({ configJson }); },
    setHeartbeatConfig: async (configJson: string) => { feature('agent'); requireNative(); return NativeAgent.setHeartbeatConfig({ configJson }); },

    // ── Skills ──
    addSkill: async (inputJson: string) => { feature('agent'); requireNative(); return NativeAgent.addSkill({ inputJson }); },
    updateSkill: async (id: string, patchJson: string) => { feature('agent'); requireNative(); return NativeAgent.updateSkill({ id, patchJson }); },
    removeSkill: async (skillId: string) => { feature('agent'); requireNative(); return NativeAgent.removeSkill({ id: skillId }); },
    listSkills: async () => { feature('agent'); requireNative(); return NativeAgent.listSkills(); },
    startSkill: async (skillId: string, configJson?: string, provider?: string) => {
      feature('agent'); requireNative();
      return NativeAgent.startSkill({
        skillId,
        configJson: configJson ?? '{}',
        ...(provider === undefined ? {} : { provider }),
      });
    },
    endSkill: async (skillId: string) => { feature('agent'); requireNative(); return NativeAgent.endSkill({ skillId }); },

    // ── Tool permissions ──
    seedToolPermissions: async (defaultsJson: string) => { feature('agent'); requireNative(); return NativeAgent.seedToolPermissions({ defaultsJson }); },
    setToolPermission: async (toolName: string, permission: string, enabled?: boolean) => {
      feature('agent'); requireNative();
      return NativeAgent.setToolPermission({ toolName, permission, enabled: enabled ?? true });
    },
    listToolPermissions: async () => { feature('agent'); requireNative(); return NativeAgent.listToolPermissions(); },
    resetToolPermissions: async () => { feature('agent'); requireNative(); return NativeAgent.resetToolPermissions(); },

    // ── MCP ──
    startMcp: async (toolsJson: string) => { feature('agent'); requireNative(); return NativeAgent.startMcp({ toolsJson }); },
    restartMcp: async (toolsJson: string) => { feature('agent'); requireNative(); return NativeAgent.restartMcp({ toolsJson }); },
    setMcpTools: async (toolsJson: string) => {
      feature('agent'); requireNative();
      // No dedicated setter in 0.5.2 — restarting the MCP bridge with the new
      // tool list has the same effect on this generation.
      const result = await NativeAgent.restartMcp({ toolsJson });
      return { ...(result as Record<string, unknown>), engineGeneration: '0.5.2-public', viaCompat: 'setMcpTools→restartMcp' };
    },

    // ── Models & tools ──
    getModels: async (provider = 'anthropic') => { feature('agent'); requireNative(); return NativeAgent.getModels({ provider }); },
    invokeTool: async (toolName: string, argsJson = '{}') => { feature('agent'); requireNative(); return NativeAgent.invokeTool({ toolName, argsJson }); },

    // ── Events (streaming text, tool calls, approvals, cron results) ──
    onEvent: (callback: (event: any) => void): Promise<Remove> => {
      feature('agent'); requireNative();
      return NativeAgent.addListener('nativeAgentEvent', callback);
    },
  },
};

// App Browser is a host-only management API. Uploaded apps receive a separate,
// token-bound RPC façade inside an opaque-origin sandbox and never this object.
NativeKit.appBrowser = createAppBrowser(NativeKit, config.appBrowser);
Object.freeze(NativeKit);

declare global {
  interface Window { NativeKit: typeof NativeKit; }
}

if (window.NativeKit) console.warn('window.NativeKit already existed and has been replaced by the bundled trusted bridge.');
Object.defineProperty(window, 'NativeKit', { value: NativeKit, enumerable: true, configurable: false, writable: false });

// A native build already bundles its UI. Do not leave an old PWA worker controlling Android's local origin.
if (isNative && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((items) => Promise.all(items.map((item) => item.unregister()))).catch(() => undefined);
}

window.dispatchEvent(new CustomEvent('nativekitready', { detail: { platform, version: NativeKit.version } }));
