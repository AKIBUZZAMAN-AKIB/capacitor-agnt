import { unzipSync } from 'fflate';
import { NativeKitIsolatedBrowser } from '@nativekit/isolated-browser';
import {
  ARTIFACT_KINDS,
  NATIVE_ARTIFACT_LIMITS,
  createNativeArtifactStore,
  deleteNativePackage,
  readNativePackage,
  saveNativePackage,
  type NativeArtifactKind,
  type NativeArtifactOwner,
  type NativeArtifactRecord,
  type NativeArtifactStore,
  type NativeObjectKit,
} from './native-object-store';
import { createMiniAppArtifactManager, MINI_APP_HOME_WIDGET_SLOT_PREFIX } from './mini-app-artifacts';

export const APP_BROWSER_CAPABILITIES = Object.freeze([
  'permissions', 'http', 'camera', 'location', 'backgroundLocation', 'haptics',
  'notifications', 'alarms', 'background', 'preferences', 'secureStorage', 'sqlite',
  'filesystem', 'fileTransfer', 'sharing', 'networkStatus', 'appInfo', 'pushNotifications', 'browser',
  'miniUI', 'floatingUI', 'homeWidget',
] as const);

export type AppBrowserCapability = typeof APP_BROWSER_CAPABILITIES[number];

export type AppBrowserPermissionDecision = 'ask' | 'allow' | 'block';
export type AppBrowserPermissionAction = 'allow_once' | 'allow_always' | 'block_once' | 'block_always';

type AppBrowserConfig = {
  enabled: boolean;
  maxApps: number;
  maxPackageBytes: number;
  maxFiles: number;
  auditLogLimit: number;
  maxRequestsPerMinute: number;
  maxActiveHomeWidgets: number;
  defaultCapabilities: AppBrowserCapability[];
  allowDirectWebNetwork: boolean;
  urlMode: { enabled: boolean; allowedHosts: string[] };
  renderer: 'iframe' | 'isolated';
  permissionPrompts?: {
    enabled: boolean;
    requestTimeoutMs: number;
    requestedCapabilityDefault: AppBrowserPermissionDecision;
    unrequestedCapabilityDefault: AppBrowserPermissionDecision;
  };
  isolated: {
    enabled: boolean;
    fallbackToIframe: boolean;
    stageChunkBytes: number;
    androidMinApi: number;
    hangTerminationDelayMs: number;
  };
};

type PackageFile = { path: string; bytes: Uint8Array; type: string };
export type AppBrowserNetworkMode = 'sandboxed' | 'hosts' | 'full';

type AppManifest = {
  id: string;
  name: string;
  version: string;
  entry: string;
  description: string;
  requestedCapabilities: AppBrowserCapability[];
  allowedHosts: string[];
  networkMode?: AppBrowserNetworkMode;
  colorScheme?: 'dark' | 'light';
  webComponent?: { tag: string; module: string; attributes?: Record<string, string> };
};
type InstalledApp = {
  id: string;
  manifest: AppManifest;
  files: PackageFile[];
  integrity: string;
  installedAt: string;
  updatedAt: string;
  totalBytes: number;
  fileCount?: number;
};
type AppMetadata = Omit<InstalledApp, 'files'> & { files?: PackageFile[] };
type StoredInstalledApp = AppMetadata & {
  packageStorage?: 'native-filesystem' | 'indexeddb-web';
};
type AppPolicy = {
  appId: string;
  enabled: boolean;
  /** Compatibility mirrors for v1/v2 hosts. New code must use the tri-state maps below. */
  grants: Record<string, boolean>;
  methodOverrides: Record<string, boolean>;
  capabilityDecisions: Record<string, AppBrowserPermissionDecision>;
  methodDecisions: Record<string, AppBrowserPermissionDecision>;
  allowedHosts: string[];
  networkMode: AppBrowserNetworkMode;
  mediaAutoplay: boolean;
  colorScheme: 'dark' | 'light';
  updatedAt: string;
};
type AuditOutcome = 'success' | 'error' | 'denied' | 'rate_limited' | 'cancelled' | 'timeout';
type AuditRecord = {
  id?: number;
  appId: string;
  appName: string;
  capability: string;
  method: string;
  outcome: AuditOutcome;
  timestamp: string;
  durationMs: number;
  error?: string;
  permissionRequestId?: string;
  authorization?: 'control' | 'stored_allow' | 'allow_once' | 'allow_always';
};
export type AppBrowserPendingPermission = {
  requestId: string;
  appId: string;
  appName: string;
  sessionId: string;
  renderer: 'iframe' | 'isolated';
  capability: AppBrowserCapability;
  method: string;
  argumentSummary: string;
  requestedByManifest: boolean;
  createdAt: string;
  expiresAt: string;
};
type PendingPermissionInternal = AppBrowserPendingPermission & {
  callId: number;
  settled: boolean;
  resolve: (action: AppBrowserPermissionAction) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type RpcSubscription = { remove: () => Promise<void> | void; capability: AppBrowserCapability; method: string };
type RpcSession = {
  id: string;
  app: InstalledApp;
  frame?: HTMLIFrameElement;
  renderer: 'iframe' | 'isolated';
  nativeOrigin?: string;
  token: string;
  requests: number[];
  subscriptions: Map<string, RpcSubscription>;
  loadCount: number;
};
type MethodContext = { app: InstalledApp; policy: AppPolicy };
type MethodDefinition = { capability: AppBrowserCapability; run: (context: MethodContext, args: any[]) => Promise<any> | any };

const DB_NAME = 'nativekit-app-browser-v1';
const DB_VERSION = 4;
const RPC_CHANNEL = 'nativekit-app-browser-v1';
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\\0]).+$/;
const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const COMPONENT_TAG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export async function runWithDurablePrecondition<T>(persist: () => Promise<unknown>, operation: () => Promise<T>): Promise<T> {
  await persist();
  return operation();
}

function validPermissionDecision(value: unknown): value is AppBrowserPermissionDecision {
  return value === 'ask' || value === 'allow' || value === 'block';
}

export function normalizeAppBrowserColorScheme(value: unknown): 'dark' | 'light' {
  return value === 'light' ? 'light' : 'dark';
}

export function normalizeAppBrowserNetworkMode(value: unknown): AppBrowserNetworkMode {
  if (value === 'hosts' || value === 'sandboxed' || value === 'full') return value;
  // OWNER RULE: apps default to the open internet ('full'). Absent/empty means
  // "no opinion" → full. Corrupted values still fail closed to 'sandboxed'.
  if (value === undefined || value === null || value === '') return 'full';
  return 'sandboxed';
}

function normalizePolicy(policy: Partial<AppPolicy> & Pick<AppPolicy, 'appId' | 'enabled' | 'allowedHosts' | 'updatedAt'>): AppPolicy {
  const legacyGrants = policy.grants && typeof policy.grants === 'object' ? policy.grants : {};
  const capabilityDecisions: Record<string, AppBrowserPermissionDecision> = {};
  for (const capability of APP_BROWSER_CAPABILITIES) {
    const stored = policy.capabilityDecisions?.[capability];
    // Migration is intentionally fail-closed: old true -> allow, old false/missing -> block.
    capabilityDecisions[capability] = validPermissionDecision(stored) ? stored : legacyGrants[capability] === true ? 'allow' : 'block';
  }
  const legacyMethods = policy.methodOverrides && typeof policy.methodOverrides === 'object' ? policy.methodOverrides : {};
  const methodDecisions: Record<string, AppBrowserPermissionDecision> = {};
  for (const [method, value] of Object.entries(policy.methodDecisions ?? {})) if (METHOD_RE.test(method) && validPermissionDecision(value)) methodDecisions[method] = value;
  for (const [method, value] of Object.entries(legacyMethods)) if (METHOD_RE.test(method) && !Object.hasOwn(methodDecisions, method)) methodDecisions[method] = value === true ? 'allow' : 'block';
  return {
    appId: policy.appId,
    enabled: policy.enabled === true,
    grants: Object.fromEntries(APP_BROWSER_CAPABILITIES.map((capability) => [capability, capabilityDecisions[capability] === 'allow'])),
    methodOverrides: Object.fromEntries(Object.entries(methodDecisions).filter(([, value]) => value !== 'ask').map(([method, value]) => [method, value === 'allow'])),
    capabilityDecisions,
    methodDecisions,
    allowedHosts: Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [],
    networkMode: normalizeAppBrowserNetworkMode(policy.networkMode),
    mediaAutoplay: policy.mediaAutoplay === true,
    colorScheme: normalizeAppBrowserColorScheme(policy.colorScheme),
    updatedAt: typeof policy.updatedAt === 'string' ? policy.updatedAt : new Date().toISOString(),
  };
}

export function getAppBrowserPermissionDecision(policy: AppPolicy, method: string, capability: AppBrowserCapability): AppBrowserPermissionDecision {
  if (!policy.enabled) return 'block';
  const normalized = normalizePolicy(policy);
  const capabilityDecision = normalized.capabilityDecisions[capability] ?? 'block';
  // Capability block is a master revocation and cannot be bypassed by a stale method allow.
  if (capabilityDecision === 'block') return 'block';
  const methodDecision = normalized.methodDecisions[method];
  return validPermissionDecision(methodDecision) ? methodDecision : capabilityDecision;
}

export function isAppBrowserMethodAllowed(policy: AppPolicy, method: string, capability: AppBrowserCapability): boolean {
  return getAppBrowserPermissionDecision(policy, method, capability) === 'allow';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('apps')) db.createObjectStore('apps', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('policies')) db.createObjectStore('policies', { keyPath: 'appId' });
      if (!db.objectStoreNames.contains('netstats')) db.createObjectStore('netstats', { keyPath: 'appId' });
      if (!db.objectStoreNames.contains('audit')) {
        const store = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
        store.createIndex('appId', 'appId');
        store.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('resources')) {
        const store = db.createObjectStore('resources', { keyPath: 'id' });
        store.createIndex('appId', 'appId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('App Browser database open failed'));
  });
}

async function idbRequest<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result: T; let failed = false;
    const fail = (error: unknown) => { if (!failed) { failed = true; reject(error); } };
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => fail(request.error ?? new Error(`IndexedDB ${storeName} request failed`));
    transaction.oncomplete = () => { db.close(); if (!failed) resolve(result); };
    transaction.onabort = () => { db.close(); fail(transaction.error ?? new Error(`IndexedDB ${storeName} transaction aborted`)); };
    transaction.onerror = () => fail(transaction.error ?? new Error(`IndexedDB ${storeName} transaction failed`));
  });
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  return idbRequest<T[]>(storeName, 'readonly', (store) => store.getAll());
}

async function idbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
  return idbRequest<IDBValidKey>(storeName, 'readwrite', (store) => store.put(value));
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return idbRequest<T | undefined>(storeName, 'readonly', (store) => store.get(key));
}

async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  await idbRequest<undefined>(storeName, 'readwrite', (store) => store.delete(key));
}

export async function saveInstalledAppAndPolicy(app: InstalledApp, policy: AppPolicy, nativeKit?: NativeObjectKit): Promise<void> {
  // On Android/iOS, package bytes are committed to app-private native storage
  // first. IndexedDB retains only searchable metadata and the policy, never a
  // silent second copy of the Mini App's code.
  const useNativePackage = nativeKit?.isNative === true;
  if (useNativePackage) await saveNativePackage(nativeKit, app);
  const { files, ...metadata } = app;
  const stored: StoredInstalledApp = useNativePackage
    ? { ...metadata, fileCount: files.length, packageStorage: 'native-filesystem' }
    : { ...app, fileCount: files.length, packageStorage: 'indexeddb-web' };
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['apps', 'policies'], 'readwrite');
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
      reject(error);
    };
    let appRequest: IDBRequest<IDBValidKey>; let policyRequest: IDBRequest<IDBValidKey>;
    try {
      appRequest = transaction.objectStore('apps').put(stored);
      policyRequest = transaction.objectStore('policies').put(policy);
    } catch (error) {
      fail(error);
      return;
    }
    appRequest.onerror = () => fail(appRequest.error ?? new Error('Installed app save failed'));
    policyRequest.onerror = () => fail(policyRequest.error ?? new Error('Installed app policy save failed'));
    transaction.oncomplete = () => { db.close(); if (!failed) resolve(); };
    transaction.onabort = () => { db.close(); if (!failed) { failed = true; reject(transaction.error ?? new Error('Installed app transaction aborted')); } };
    transaction.onerror = () => fail(transaction.error ?? new Error('Installed app transaction failed'));
  });
}

type NativeResource =
  | { id: string; appId: string; kind: 'notification'; logicalId: string; nativeId: number }
  | { id: string; appId: string; kind: 'database'; logicalId: string; nativeName: string }
  | { id: string; appId: string; kind: 'preference'; logicalId: string; nativeKey: string }
  | { id: string; appId: string; kind: 'secure'; logicalId: string; nativeKey: string };

async function notificationNativeId(appId: string, input: unknown, create: boolean): Promise<number | null> {
  const logicalId = String(input ?? '');
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(logicalId)) throw new Error('Invalid notification id');
  const id = `notification:${appId}:${logicalId}`;
  const db = await openDatabase();
  return new Promise<number | null>((resolve, reject) => {
    const transaction = db.transaction('resources', create ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('resources');
    let answer: number | null = null;
    let failed = false;
    const fail = (error: unknown) => { if (!failed) { failed = true; reject(error); } };
    const found = store.get(id);
    found.onerror = () => fail(found.error ?? new Error('Notification mapping lookup failed'));
    found.onsuccess = () => {
      const existing = found.result as NativeResource | undefined;
      if (existing) {
        if (existing.kind !== 'notification') { fail(new Error('Native resource mapping is inconsistent')); transaction.abort(); return; }
        answer = existing.nativeId; return;
      }
      if (!create) return;
      const all = store.getAll();
      all.onerror = () => fail(all.error ?? new Error('Notification mapping allocation failed'));
      all.onsuccess = () => {
        const resources = all.result as NativeResource[];
        if (resources.filter((item) => item.kind === 'notification' && item.appId === appId).length >= 256) { fail(new Error('Notification ID mapping limit reached')); transaction.abort(); return; }
        const used = new Set(resources.filter((item): item is Extract<NativeResource, { kind: 'notification' }> => item.kind === 'notification').map((item) => item.nativeId));
        for (let attempt = 0; attempt < 128; attempt += 1) {
          const random = crypto.getRandomValues(new Uint32Array(1))[0];
          const candidate = 1_500_000_000 + (random % 500_000_000);
          if (used.has(candidate)) continue;
          answer = candidate;
          const put = store.put({ id, appId, kind: 'notification', logicalId, nativeId: candidate } satisfies NativeResource);
          put.onerror = () => fail(put.error ?? new Error('Notification mapping save failed'));
          return;
        }
        fail(new Error('Unable to allocate notification ID')); transaction.abort();
      };
    };
    transaction.oncomplete = () => { db.close(); if (!failed) resolve(answer); };
    transaction.onabort = () => { db.close(); if (!failed) fail(transaction.error ?? new Error('Notification mapping transaction aborted')); };
    transaction.onerror = () => { db.close(); fail(transaction.error ?? new Error('Notification mapping transaction failed')); };
  });
}

async function registerStorageKey(appId: string, kind: 'preference' | 'secure', logicalKey: unknown): Promise<{ nativeKey: string; resourceId: string; created: boolean }> {
  const logicalId = String(logicalKey ?? '');
  const nativeKey = appKey(appId, logicalId);
  const resourceId = `${kind}:${appId}:${logicalId}`;
  if (await idbGet<NativeResource>('resources', resourceId)) return { nativeKey, resourceId, created: false };
  const resources = await idbGetAll<NativeResource>('resources');
  if (resources.filter((item) => item.kind === kind && item.appId === appId).length >= 64) throw new Error(`At most 64 ${kind} keys are allowed per app`);
  const resource: NativeResource = kind === 'preference'
    ? { id: resourceId, appId, kind: 'preference', logicalId, nativeKey }
    : { id: resourceId, appId, kind: 'secure', logicalId, nativeKey };
  await idbPut('resources', resource);
  return { nativeKey, resourceId, created: true };
}

export async function writeOwnedStorage<T>(appId: string, kind: 'preference' | 'secure', logicalKey: unknown, write: (nativeKey: string) => Promise<T>): Promise<T> {
  const registration = await registerStorageKey(appId, kind, logicalKey);
  try {
    return await write(registration.nativeKey);
  } catch (error) {
    if (registration.created) {
      try { await idbDelete('resources', registration.resourceId); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Storage write failed and ownership registration rollback also failed'); }
    }
    throw error;
  }
}

async function registerSandboxDatabase(appId: string, logicalName: unknown): Promise<string> {
  const logicalId = String(logicalName ?? 'main');
  const nativeName = appDatabase(appId, logicalId);
  const id = `database:${appId}:${logicalId}`;
  const existing = await idbGet<NativeResource>('resources', id);
  if (existing?.kind === 'database') return existing.nativeName;
  const resources = await idbGetAll<NativeResource>('resources');
  if (resources.filter((item) => item.kind === 'database' && item.appId === appId).length >= 8) throw new Error('At most 8 sandbox databases are allowed per app');
  await idbPut('resources', { id, appId, kind: 'database', logicalId, nativeName } satisfies NativeResource);
  return nativeName;
}

async function deleteAppResources(appId: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('resources', 'readwrite');
    const index = transaction.objectStore('resources').index('appId');
    const cursor = index.openKeyCursor(IDBKeyRange.only(appId));
    cursor.onsuccess = () => { const value = cursor.result; if (value) { transaction.objectStore('resources').delete(value.primaryKey); value.continue(); } };
    cursor.onerror = () => reject(cursor.error ?? new Error('Resource cleanup failed'));
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error('Resource cleanup failed')); };
  });
}

function normalizePath(value: string): string {
  let path = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  try { path = decodeURIComponent(path); } catch { /* Keep literal malformed percent text for rejection below. */ }
  if (!PATH_RE.test(path) || path.startsWith('.') || path.endsWith('/') || path.length > 240) throw new Error(`Unsafe package path: ${value}`);
  return path;
}

function stripCommonRoot(files: PackageFile[]): PackageFile[] {
  const parts = files.map((file) => file.path.split('/'));
  if (!parts.length || parts.some((item) => item.length < 2)) return files;
  const root = parts[0][0];
  if (!parts.every((item) => item[0] === root)) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

function mimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({
    html: 'text/html;charset=utf-8', htm: 'text/html;charset=utf-8', css: 'text/css;charset=utf-8',
    js: 'text/javascript;charset=utf-8', mjs: 'text/javascript;charset=utf-8', json: 'application/json;charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    ico: 'image/x-icon', txt: 'text/plain;charset=utf-8', wasm: 'application/wasm', pdf: 'application/pdf',
    mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

function assertZipMetadata(bytes: Uint8Array, maxFiles: number, maxBytes: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + minimumEocd + view.getUint16(offset + 20, true) === bytes.length) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record is missing');
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk || centralDisk || diskEntries !== entries) throw new Error('Multi-disk ZIP package is not supported');
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 package is not supported');
  if (!entries) throw new Error('ZIP package is empty');
  if (entries > maxFiles) throw new Error(`ZIP contains more than ${maxFiles} entries`);
  if (centralOffset + centralSize > eocd) throw new Error('ZIP central directory is corrupt');
  let pointer = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) throw new Error('ZIP central directory entry is corrupt');
    const flags = view.getUint16(pointer + 8, true);
    const size = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    if (nameLength > 720) throw new Error('ZIP entry path is too long');
    if (flags & 1) throw new Error('Encrypted ZIP package is not supported');
    if (size === 0xffffffff) throw new Error('ZIP64 package is not supported');
    expanded += size;
    if (expanded > maxBytes) throw new Error(`Expanded ZIP exceeds ${maxBytes} bytes`);
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  if (pointer !== centralOffset + centralSize) throw new Error('ZIP central directory length is inconsistent');
}

export function inspectZipLimits(bytes: Uint8Array, maxFiles: number, maxBytes: number): void {
  assertZipMetadata(bytes, maxFiles, maxBytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    output += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(output);
}

function dataUrl(file: PackageFile, bytes = file.bytes): string {
  return `data:${file.type};base64,${bytesToBase64(bytes)}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index + 1);
}

function resolvePackagePath(from: string, specifier: string): string | null {
  if (!specifier || /^(?:[a-z]+:|\/\/|#)/i.test(specifier)) return null;
  const clean = specifier.split('#')[0].split('?')[0];
  const stack = dirname(from).split('/').filter(Boolean);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!stack.length) return null; stack.pop(); }
    else stack.push(part);
  }
  return stack.join('/');
}

function stableModuleKey(path: string): string {
  return `nativekit-module-${bytesToBase64(textEncoder.encode(path)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

function rewriteModule(source: string, path: string, files: Map<string, PackageFile>): string {
  const replace = (_match: string, prefix: string, quote: string, specifier: string, suffix = '') => {
    const resolved = resolvePackagePath(path, specifier);
    if (!resolved || !files.has(resolved)) return _match;
    return `${prefix}${quote}${stableModuleKey(resolved)}${quote}${suffix}`;
  };
  return source
    .replace(/((?:import|export)\s+(?:[^"']*?\s+from\s+)?)(["'])([^"']+)\2/g, (m, p, q, s) => replace(m, p, q, s))
    .replace(/(import\s*\(\s*)(["'])([^"']+)\2(\s*\))/g, (m, p, q, s, tail) => replace(m, p, q, s, tail));
}

function rewriteCss(source: string, path: string, files: Map<string, PackageFile>): string {
  return source.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote, specifier) => {
    const resolved = resolvePackagePath(path, specifier.trim());
    const file = resolved ? files.get(resolved) : undefined;
    return file ? `url("${dataUrl(file)}")` : match;
  });
}

function safeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';
}

/**
 * Extract the first registered custom-element tag from a web component module's source,
 * e.g. `customElements.define('native-status-card', NativeStatusCard)`. Returns a valid
 * custom-element name (lowercase, hyphenated) or undefined. Used by the "quick add" flow so
 * a developer can upload a single `.js`/`.mjs` component and get a working mini-app without
 * writing a manifest by hand. Only matches the common define call; a component that registers
 * its tag dynamically still needs an explicit `tag` argument.
 */
export function detectComponentTag(source: string): string | undefined {
  const match = /customElements\s*\.\s*define\s*\(\s*(["'])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\1\s*[,\s]/.exec(source);
  return match?.[2];
}

function compareUtf8(left: string, right: string): number {
  const a = textEncoder.encode(left); const b = textEncoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

async function sha256(files: PackageFile[]): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const file of files.slice().sort((a, b) => compareUtf8(a.path, b.path))) {
    const head = textEncoder.encode(`${file.path}\0${file.bytes.length}\0`);
    chunks.push(head, file.bytes); size += head.length + file.bytes.length;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

function validateCapabilities(value: unknown): AppBrowserCapability[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(APP_BROWSER_CAPABILITIES);
  const result = value.map(String);
  const unknown = result.filter((item) => !known.has(item));
  if (unknown.length) throw new Error(`Unknown requestedCapabilities: ${unknown.join(', ')}`);
  return Array.from(new Set(result)) as AppBrowserCapability[];
}

function validateHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(String).map((host) => host.trim().toLowerCase()).filter((host) => {
    const match = /^(\*\.)?([^:]+)(?::([0-9]{1,5}))?$/.exec(host);
    const hostname = match?.[2] ?? '';
    const labels = hostname.split('.');
    const validName = hostname.length <= 253 && labels.every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
    const port = match?.[3] ? Number(match[3]) : undefined;
    if (!match || !validName || (port != null && (port < 1 || port > 65535))) throw new Error(`Invalid allowed host: ${host}`);
    return true;
  })));
}

function parseManifest(files: PackageFile[], options: Record<string, any>, integrity: string): AppManifest {
  const map = new Map(files.map((file) => [file.path, file]));
  const manifestFile = map.get('nativekit.manifest.json');
  let raw: Record<string, any> = {};
  if (manifestFile) {
    try { raw = JSON.parse(textDecoder.decode(manifestFile.bytes)); }
    catch (error) { throw new Error(`nativekit.manifest.json is invalid: ${String(error)}`); }
  }
  const component = raw.webComponent ?? options.webComponent;
  const webComponent = component ? {
    tag: String(component.tag ?? ''),
    module: normalizePath(String(component.module ?? '')),
    attributes: component.attributes && typeof component.attributes === 'object'
      ? Object.fromEntries(Object.entries(component.attributes).map(([key, value]) => [key, String(value)])) : {},
  } : undefined;
  if (webComponent && (!COMPONENT_TAG_RE.test(webComponent.tag) || !map.has(webComponent.module))) {
    throw new Error('webComponent.tag must contain a hyphen and webComponent.module must exist');
  }
  let entry = String(raw.entry ?? options.entry ?? 'index.html');
  if (!map.has(entry) && webComponent) {
    entry = '__nativekit_component__.html';
    files.push({
      path: entry,
      type: 'text/html;charset=utf-8',
      bytes: textEncoder.encode(`<!doctype html><html><head><meta charset="utf-8"></head><body><${webComponent.tag}></${webComponent.tag}><script type="module" src="${webComponent.module}"></script></body></html>`),
    });
    map.set(entry, files[files.length - 1]);
  }
  entry = normalizePath(entry);
  if (!map.has(entry) || !/\.html?$/i.test(entry)) throw new Error(`HTML entry file not found: ${entry}`);
  const name = String(raw.name ?? options.name ?? entry.split('/').slice(-2, -1)[0] ?? 'Third-party app').trim().slice(0, 80) || 'Third-party app';
  const generatedId = `thirdparty.${safeIdPart(name)}.${integrity.slice(0, 10)}`;
  const id = String(raw.id ?? options.id ?? generatedId).toLowerCase();
  if (!ID_RE.test(id) || id.length > 120) throw new Error('Manifest id must be a stable lowercase dotted/dashed identifier');
  return {
    id,
    name,
    version: String(raw.version ?? options.version ?? '1.0.0').slice(0, 40),
    entry,
    description: String(raw.description ?? options.description ?? '').slice(0, 500),
    requestedCapabilities: validateCapabilities(raw.requestedCapabilities ?? options.requestedCapabilities),
    allowedHosts: validateHosts(raw.allowedHosts ?? options.allowedHosts),
    networkMode: normalizeAppBrowserNetworkMode(raw.networkMode),
    colorScheme: normalizeAppBrowserColorScheme(raw.colorScheme),
    ...(webComponent ? { webComponent } : {}),
  };
}

export function normalizePackagePath(value: string): string { return normalizePath(value); }

function publicApp(app: AppMetadata, policy?: AppPolicy): Record<string, any> {
  return {
    id: app.id,
    manifest: app.manifest,
    integrity: app.integrity,
    installedAt: app.installedAt,
    updatedAt: app.updatedAt,
    totalBytes: app.totalBytes,
    fileCount: app.fileCount ?? app.files?.length ?? 0,
    ...(policy ? { policy } : {}),
  };
}

export function safeRelativeDataPath(appId: string, value: unknown): string {
  const raw = String(value ?? '');
  const root = `nativekit-app-browser/${appId}`;
  return raw === '' ? root : `${root}/${normalizePath(raw)}`;
}

function appKey(appId: string, value: unknown): string {
  const key = String(value ?? '');
  if (!key || key.length > 200 || /[\0\r\n]/.test(key)) throw new Error('Storage key must be 1–200 safe characters');
  return `nativekit.appBrowser.${appId}.${key}`;
}

function boundedString(value: unknown, maxBytes: number, label: string): string {
  const output = String(value ?? '');
  if (textEncoder.encode(output).length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return output;
}

export function boundedJson(value: unknown, maxBytes: number, label = 'JSON value'): unknown {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error(`${label} must be JSON-serializable`); }
  if (serialized == null) return null;
  if (textEncoder.encode(serialized).length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return JSON.parse(serialized);
}

function boundedRpcPayload(value: unknown): unknown {
  return boundedJson(value, 2_097_152, 'RPC response or event payload');
}

export function appDatabase(appId: string, value: unknown): string {
  const name = String(value ?? 'main');
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error('Database name must be 1–40 letters, numbers, dots, underscores, or hyphens');
  const token = (input: string) => bytesToBase64(textEncoder.encode(input)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `nk_${token(appId)}_${token(name)}`;
}

export function safeSql(value: unknown): string {
  const sql = boundedString(value, 262_144, 'SQL statement');
  const tokens = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    // SQLite permits quoted identifiers in function position; retain their text for deny-list checks.
    .replace(/["`\[\]]/g, '');
  if (/\b(?:attach|detach|vacuum)\b|\bpragma(?:\b|_)/i.test(tokens)
      || /\bload_extension\s*\(/i.test(tokens)
      || /\b(?:readfile|writefile)\s*\(/i.test(tokens)
      || /\bcreate\s+(?:(?:temp|temporary)\s+)?virtual\s+table\b/i.test(tokens)) {
    throw new Error('This SQLite statement is not allowed in an App Browser sandbox');
  }
  return sql;
}

function safeSqlValues(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('SQLite values must be an array of at most 1,000 items');
  return boundedJson(value, 1_048_576, 'SQLite bind values') as unknown[];
}

function appAlarmId(appId: string, value: unknown): string {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('Alarm id must be 1–80 letters, numbers, dots, underscores, or hyphens');
  return `${appId}:${id}`;
}

function sanitizeGeolocationOptions(value: any): Record<string, any> {
  return {
    enableHighAccuracy: value?.enableHighAccuracy !== false,
    timeout: Math.min(60_000, Math.max(1_000, Number(value?.timeout) || 15_000)),
    maximumAge: Math.min(3_600_000, Math.max(0, Number(value?.maximumAge) || 0)),
  };
}

function finiteNumber(value: unknown, label: string): number {
  const output = Number(value);
  if (!Number.isFinite(output)) throw new Error(`Native ${label} result is invalid`);
  return output;
}

function optionalFiniteNumber(value: unknown, label: string): number | null {
  return value == null ? null : finiteNumber(value, label);
}

function sanitizePermissionState(value: unknown): string {
  const state = String(value ?? 'unknown').toLowerCase();
  return /^[a-z][a-z-]{0,39}$/.test(state) ? state : 'unknown';
}

function sanitizePermissionRecord(value: any, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => value?.[key] != null).map((key) => [key, sanitizePermissionState(value[key])]));
}

function sanitizeAlarmCapabilities(value: any): { exact: boolean; fullScreen: boolean; alarmKit: boolean } {
  return { exact: value?.exact === true, fullScreen: value?.fullScreen === true, alarmKit: value?.alarmKit === true };
}

function sanitizeBackgroundLocationStatus(value: any, ownedByApp = false): { running: boolean; permission: string; ownedByApp: boolean } {
  return { running: value?.running === true && ownedByApp, permission: sanitizePermissionState(value?.permission), ownedByApp };
}

function sanitizePosition(value: any): Record<string, any> {
  const coords = value?.coords;
  if (!coords || typeof coords !== 'object') throw new Error('Native location result is invalid');
  return {
    timestamp: finiteNumber(value?.timestamp, 'location timestamp'),
    coords: {
      latitude: finiteNumber(coords.latitude, 'latitude'),
      longitude: finiteNumber(coords.longitude, 'longitude'),
      accuracy: finiteNumber(coords.accuracy, 'accuracy'),
      altitude: optionalFiniteNumber(coords.altitude, 'altitude'),
      altitudeAccuracy: optionalFiniteNumber(coords.altitudeAccuracy, 'altitude accuracy'),
      speed: optionalFiniteNumber(coords.speed, 'speed'),
      heading: optionalFiniteNumber(coords.heading, 'heading'),
    },
  };
}

function sanitizeBackgroundLocationPoint(value: any): Record<string, any> {
  return {
    latitude: finiteNumber(value?.latitude, 'background latitude'),
    longitude: finiteNumber(value?.longitude, 'background longitude'),
    timestamp: finiteNumber(value?.timestamp, 'background location timestamp'),
    ...(value?.accuracy == null ? {} : { accuracy: finiteNumber(value.accuracy, 'background accuracy') }),
    ...(value?.altitude == null ? {} : { altitude: finiteNumber(value.altitude, 'background altitude') }),
    ...(value?.speed == null ? {} : { speed: finiteNumber(value.speed, 'background speed') }),
    ...(value?.bearing == null ? {} : { bearing: finiteNumber(value.bearing, 'background bearing') }),
  };
}

function sanitizeNetworkStatus(value: any): { connected: boolean; connectionType: 'wifi' | 'cellular' | 'none' | 'unknown' } {
  const type = ['wifi', 'cellular', 'none', 'unknown'].includes(value?.connectionType) ? value.connectionType : 'unknown';
  return { connected: value?.connected === true, connectionType: type };
}

function sanitizeAppState(value: any): { isActive: boolean } {
  return { isActive: value?.isActive === true };
}

function sanitizeHttpResponse(value: any): Record<string, unknown> {
  const status = Math.trunc(finiteNumber(value?.status, 'HTTP status'));
  const headers = sanitizeHeaders(value?.headers) ?? {};
  let url = '';
  if (value?.url != null) {
    const parsed = new URL(boundedString(value.url, 4_096, 'HTTP response URL'));
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Native HTTP response URL is invalid');
    url = parsed.toString();
  }
  return { data: value?.data ?? null, status, headers, url };
}

function boundedBase64(value: unknown, maxBytes: number, label: string): string {
  const data = boundedString(value, maxBytes, label);
  if (!data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.replace(/\s/g, ''))) throw new Error(`${label} is not valid base64`);
  return data;
}

function sanitizeCameraPhoto(value: any): { data: string; encoding: 'base64'; format: string; saved: boolean } {
  const data = boundedBase64(value?.base64String, 1_572_864, 'Camera image');
  const rawFormat = String(value?.format ?? 'jpeg').toLowerCase();
  const format = /^[a-z0-9.+-]{1,32}$/.test(rawFormat) ? rawFormat : 'jpeg';
  return { data, encoding: 'base64', format, saved: value?.saved === true };
}

async function cameraGalleryData(nativeKit: any, value: any): Promise<string> {
  if (typeof value?.path === 'string' && value.path) {
    try {
      const result = await nativeKit.filesystem.readFile({ path: value.path });
      if (typeof result?.data === 'string') return boundedBase64(result.data, 524_288, 'Picked image');
    } catch (error) {
      if (!(typeof value?.webPath === 'string' && value.webPath)) throw error;
    }
  }
  if (typeof value?.webPath === 'string' && value.webPath) {
    const response = await fetch(value.webPath);
    if (!response.ok) throw new Error('Picked image could not be read');
    const blob = await response.blob();
    if (blob.size > 393_216) throw new Error('Picked image exceeds the per-image broker limit');
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  throw new Error('Native gallery result did not include readable image data');
}

function sanitizeSqliteChanges(value: any): { changes: { changes: number; lastId?: number } } {
  const nested = value?.changes && typeof value.changes === 'object' ? value.changes : value;
  const changes = Math.max(0, Math.trunc(finiteNumber(nested?.changes ?? 0, 'SQLite changes')));
  const lastId = nested?.lastId == null ? undefined : finiteNumber(nested.lastId, 'SQLite lastId');
  return { changes: { changes, ...(lastId == null ? {} : { lastId }) } };
}

function sanitizeFilesystemInfo(value: any, includeName: boolean): Record<string, unknown> {
  const type = value?.type;
  if (type !== 'file' && type !== 'directory') throw new Error('Native filesystem entry type is invalid');
  const output: Record<string, unknown> = {
    type,
    size: Math.max(0, Math.trunc(finiteNumber(value?.size ?? 0, 'filesystem size'))),
  };
  if (includeName) {
    const name = boundedString(value?.name, 240, 'Filesystem entry name');
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Native filesystem entry name is invalid');
    output.name = name;
  }
  if (value?.ctime != null) output.ctime = finiteNumber(value.ctime, 'filesystem ctime');
  if (value?.mtime != null) output.mtime = finiteNumber(value.mtime, 'filesystem mtime');
  return output;
}

function sanitizeTransferUploadResult(value: any): { bytesSent: number; responseCode: string; response?: string; headers?: Record<string, string> } {
  const bytesSent = Math.max(0, Math.trunc(finiteNumber(value?.bytesSent, 'upload bytesSent')));
  const responseCode = boundedString(value?.responseCode, 20, 'Upload response code');
  const response = value?.response == null ? undefined : boundedString(value.response, 1_048_576, 'Upload response body');
  const headers = value?.headers == null ? undefined : sanitizeHeaders(value.headers);
  return { bytesSent, responseCode, ...(response == null ? {} : { response }), ...(headers == null ? {} : { headers }) };
}

function sanitizeNotificationEventSchedule(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  if (value.at != null) {
    const timestamp = value.at instanceof Date ? value.at.getTime() : typeof value.at === 'number' ? value.at : Date.parse(String(value.at));
    if (Number.isFinite(timestamp)) output.at = new Date(timestamp).toISOString();
  }
  if (['year', 'month', 'two-weeks', 'week', 'day', 'hour', 'minute'].includes(value.every)) output.every = value.every;
  if (value.repeats != null) output.repeats = value.repeats === true;
  if (value.count != null) output.count = Math.max(0, Math.trunc(finiteNumber(value.count, 'notification schedule count')));
  if (value.allowWhileIdle != null) output.allowWhileIdle = value.allowWhileIdle === true;
  if (value.on && typeof value.on === 'object') {
    const on: Record<string, number> = {};
    for (const key of ['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second']) if (value.on[key] != null) on[key] = Math.trunc(finiteNumber(value.on[key], `notification schedule ${key}`));
    if (Object.keys(on).length) output.on = on;
  }
  return Object.keys(output).length ? output : undefined;
}

function sanitizePushNotification(value: any): Record<string, unknown> {
  const sourceData = value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : {};
  const { nativeKitAppBrowserId: _ownershipMarker, ...data } = sourceData;
  return {
    id: boundedString(value?.id, 200, 'Push notification id'),
    ...(value?.title == null ? {} : { title: boundedString(value.title, 500, 'Push title') }),
    ...(value?.subtitle == null ? {} : { subtitle: boundedString(value.subtitle, 500, 'Push subtitle') }),
    ...(value?.body == null ? {} : { body: boundedString(value.body, 4_000, 'Push body') }),
    ...(value?.badge == null ? {} : { badge: Math.max(0, Math.trunc(finiteNumber(value.badge, 'push badge'))) }),
    data: boundedJson(data, 1_048_576, 'Push data'),
  };
}

function sandboxFileData(value: unknown, encoding: unknown): { data: string; encoding?: string; bytes: number } {
  const data = String(value ?? '');
  const normalizedEncoding = ['utf8', 'ascii', 'utf16'].includes(String(encoding).toLowerCase()) ? String(encoding).toLowerCase() : undefined;
  let bytes: number;
  if (normalizedEncoding === 'utf16') bytes = data.length * 2 + 2;
  else if (normalizedEncoding === 'ascii') bytes = data.length;
  else if (normalizedEncoding === 'utf8') bytes = textEncoder.encode(data).length;
  else {
    const compact = data.replace(/\s/g, '');
    if (compact.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error('Filesystem data must be valid base64 when encoding is omitted');
    bytes = Math.floor(compact.length * 3 / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0);
  }
  if (textEncoder.encode(data).length > 1_835_008 || bytes > 1_835_008) throw new Error('A brokered filesystem write is limited to 1,835,008 encoded bytes');
  return { data, ...(normalizedEncoding ? { encoding: normalizedEncoding } : {}), bytes };
}

export async function sandboxFilesystemUsage(nativeKit: any, appId: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0; let files = 0; let visited = 0;
  for (const directory of ['Data', 'Cache']) {
    const root = safeRelativeDataPath(appId, '');
    const pending = [root];
    while (pending.length) {
      const path = pending.pop()!;
      let response: any;
      try { response = await nativeKit.filesystem.readdir({ directory, path }); }
      catch (error) { if (path === root && isMissingResourceError(error)) continue; throw error; }
      for (const item of response?.files ?? []) {
        visited += 1;
        if (visited > 1_024) throw new Error('Sandbox filesystem entry limit exceeded');
        const name = String(item.name);
        if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Unsafe filesystem entry returned by native layer');
        const child = `${path}/${name}`;
        if (item.type === 'directory') pending.push(child);
        else {
          const size = Number(item.size);
          if (!Number.isFinite(size) || size < 0) throw new Error('Invalid filesystem size returned by native layer');
          files += 1; bytes += size;
        }
      }
    }
  }
  return { bytes, files };
}

export async function sandboxDestinationState(nativeKit: any, directory: string, path: string): Promise<{ exists: boolean; size: number }> {
  try {
    const stat = await nativeKit.filesystem.stat({ directory, path });
    const exists = stat?.type === 'file';
    const size = Number(stat?.size);
    if (exists && (!Number.isFinite(size) || size < 0)) throw new Error('Invalid filesystem size returned by native layer');
    return { exists, size: exists ? size : 0 };
  } catch (error) {
    if (isMissingResourceError(error)) return { exists: false, size: 0 };
    throw error;
  }
}

export async function discardSandboxDownload(nativeKit: any, directory: string, path: string, cause: unknown): Promise<never> {
  try {
    await nativeKit.filesystem.deleteFile({ directory, path });
  } catch (cleanupError) {
    if (!isMissingResourceError(cleanupError)) throw new AggregateError([cause, cleanupError], 'Download failed and partial-file cleanup also failed');
  }
  throw cause;
}

export async function releaseScheduledSandboxState(nativeKit: any, appId: string, capability?: AppBrowserCapability): Promise<void> {
  const errors: Error[] = [];
  const failure = (label: string, error: unknown) => new Error(`${label}: ${serializeError(error).message}`);
  if ((!capability || capability === 'notifications') && nativeKit.config.features.localNotifications === true) {
    try {
      const pending = await nativeKit.notifications.pending();
      const ids = (pending?.notifications ?? []).filter((item: any) => item?.extra?.nativeKitAppBrowserId === appId).map((item: any) => item.id);
      if (ids.length) await nativeKit.notifications.cancel(ids);
    } catch (error) { errors.push(failure('pending-notification cancellation', error)); }
    try {
      const delivered = await nativeKit.notifications.delivered();
      const ids = (delivered?.notifications ?? []).filter((item: any) => item?.extra?.nativeKitAppBrowserId === appId).map((item: any) => item.id);
      if (ids.length) await nativeKit.notifications.removeDelivered(ids);
    } catch (error) { errors.push(failure('delivered-notification removal', error)); }
  }
  if ((!capability || capability === 'alarms') && nativeKit.config.features.advancedAlarms === true) {
    try {
      const response = await nativeKit.alarms.list();
      const ids = (response?.alarms ?? []).filter((item: any) => item?.extra?.nativeKitAppBrowserId === appId).map((item: any) => item.id);
      for (const id of ids) {
        try { await nativeKit.alarms.cancel(id); }
        catch (error) { errors.push(failure(`alarm ${String(id)}`, error)); }
      }
    } catch (error) { errors.push(failure('alarm enumeration', error)); }
  }
  if (errors.length) throw new AggregateError(errors, `One or more scheduled resources owned by ${appId} could not be revoked`);
}

function sanitizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HTTP headers must be an object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error('At most 64 HTTP headers are allowed');
  const output: Record<string, string> = {};
  let bytes = 0;
  for (const [key, raw] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(key)) throw new Error('Invalid HTTP header name');
    const text = String(raw);
    if (/[\0\r\n]/.test(text)) throw new Error('Invalid HTTP header value');
    bytes += textEncoder.encode(key).length + textEncoder.encode(text).length;
    if (bytes > 32_768) throw new Error('HTTP headers exceed 32 KiB');
    output[key] = text;
  }
  return output;
}

function sanitizeHttpData(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return boundedString(value, 1_048_576, 'HTTP body');
  return boundedJson(value, 1_048_576);
}

function sanitizeNotificationSchedule(value: any): Record<string, any> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, any> = {};
  if (value.at != null) {
    const date = value.at instanceof Date ? value.at : new Date(value.at);
    if (!Number.isFinite(date.getTime())) throw new Error('Notification schedule.at is invalid');
    output.at = date;
  }
  const intervals = new Set(['year', 'month', 'two-weeks', 'week', 'day', 'hour', 'minute']);
  if (value.every != null) {
    if (!intervals.has(value.every)) throw new Error('Notification schedule.every is invalid');
    output.every = value.every;
  }
  if (value.on != null) {
    const on: Record<string, number> = {};
    for (const key of ['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second']) {
      if (value.on[key] != null && Number.isInteger(Number(value.on[key]))) on[key] = Number(value.on[key]);
    }
    output.on = on;
  }
  if (value.count != null) output.count = Math.min(1_000, Math.max(1, Math.trunc(Number(value.count) || 1)));
  output.allowWhileIdle = !!value.allowWhileIdle;
  return output;
}

export function isAllowedAppHost(input: string, allowed: string[]): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  return allowed.some((rawPattern) => {
    const pattern = rawPattern.toLowerCase();
    const separator = pattern.lastIndexOf(':');
    const hasPort = separator > -1;
    const patternHost = hasPort ? pattern.slice(0, separator) : pattern;
    const patternPort = hasPort ? pattern.slice(separator + 1) : '';
    const actualPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (patternPort && actualPort !== patternPort) return false;
    return patternHost.startsWith('*.')
      ? hostname.endsWith(patternHost.slice(1)) && hostname !== patternHost.slice(2)
      : hostname === patternHost;
  });
}

type NetUsageRecord = { appId: string; count: number; hosts: Record<string, number>; updatedAt: string };
const NET_HOST_CAP = 40;

async function bumpNetworkUsage(appId: string, add: number, hosts: Record<string, number>): Promise<void> {
  try {
    const current = (await idbGet<NetUsageRecord>('netstats', appId)) ?? { appId, count: 0, hosts: {}, updatedAt: '' };
    current.count += add;
    for (const [host, count] of Object.entries(hosts)) current.hosts[host] = (current.hosts[host] ?? 0) + count;
    const entries = Object.entries(current.hosts);
    if (entries.length > NET_HOST_CAP) { entries.sort((a, b) => b[1] - a[1]); current.hosts = Object.fromEntries(entries.slice(0, NET_HOST_CAP)); }
    current.updatedAt = new Date().toISOString();
    await idbPut('netstats', current);
  } catch { /* Usage tracking must never break a network call. */ }
}

function trackNetworkUsage(appId: string, host: string): void {
  void bumpNetworkUsage(appId, 1, { [host || 'unknown']: 1 });
}

export async function absorbNativeNetStats(appId: string, add: number, hosts: Record<string, number> = {}): Promise<void> {
  if (Number.isFinite(add) && add > 0) await bumpNetworkUsage(appId, Math.min(10_000, Math.floor(add)), hosts);
}

function checkAppUrl(context: MethodContext, input: unknown): string {
  const raw = String(input);
  const url = new URL(raw);
  const networkMode = context.policy.networkMode ?? 'full';
  // 'full' is an explicit owner-approved mode (policy card warns about data exfiltration);
  // 'hosts' stays whitelisted; 'sandboxed' allows nothing remote.
  if (networkMode !== 'full' && !isAllowedAppHost(raw, context.policy.allowedHosts)) throw new Error(`Host is not allowed for ${context.app.id}: ${url.host.toLowerCase()}`);
  trackNetworkUsage(context.app.id, url.host);
  return url.toString();
}

export async function enforceSandboxDatabaseQuota(sqlite: any, name: string): Promise<void> {
  await sqlite.open(name, { encrypted: false, mode: 'no-encryption' });
  try {
    const pageSizeResult = await sqlite.query(name, 'PRAGMA page_size');
    const pageSize = Math.max(512, Number(pageSizeResult?.values?.[0]?.page_size) || 4_096);
    const maxPages = Math.max(1, Math.floor((64 * 1024 * 1024) / pageSize));
    const pageCountResult = await sqlite.query(name, 'PRAGMA page_count');
    const pageCount = Math.max(0, Number(pageCountResult?.values?.[0]?.page_count) || 0);
    if (pageCount > maxPages) throw new Error('Sandbox database already exceeds its 64 MiB quota');
    await sqlite.execute(name, `PRAGMA max_page_count = ${maxPages}`, false);
    const verifiedResult = await sqlite.query(name, 'PRAGMA max_page_count');
    const verifiedPages = Number(verifiedResult?.values?.[0]?.max_page_count);
    if (!Number.isFinite(verifiedPages) || verifiedPages > maxPages) throw new Error('Unable to enforce the sandbox database size limit');
  } catch (error) {
    try { await sqlite.close(name); }
    catch (closeError) { throw new AggregateError([error, closeError], 'Database quota setup failed and the connection could not be closed'); }
    throw error;
  }
}

export function createAppBrowserMethodTable(nativeKit: any, configuredDatabases: Set<string> = new Set()): Record<string, MethodDefinition> {
  const table: Record<string, MethodDefinition> = {};
  let notificationQueue: Promise<unknown> = Promise.resolve();
  let alarmQueue: Promise<unknown> = Promise.resolve();
  let filesystemQueue: Promise<unknown> = Promise.resolve();
  let sqliteQueue: Promise<unknown> = Promise.resolve();
  let storageQueue: Promise<unknown> = Promise.resolve();
  const serialNotification = <T>(action: () => Promise<T>): Promise<T> => {
    const next = notificationQueue.then(action, action);
    notificationQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const serialAlarm = <T>(action: () => Promise<T>): Promise<T> => {
    const next = alarmQueue.then(action, action);
    alarmQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const serialFilesystem = <T>(action: () => Promise<T>): Promise<T> => {
    const next = filesystemQueue.then(action, action);
    filesystemQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const serialSqlite = <T>(action: () => Promise<T>): Promise<T> => {
    const next = sqliteQueue.then(action, action);
    sqliteQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const serialStorage = <T>(action: () => Promise<T>): Promise<T> => {
    const next = storageQueue.then(action, action);
    storageQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const ensureSandboxDatabase = async (name: string): Promise<void> => {
    if (configuredDatabases.has(name)) return;
    await enforceSandboxDatabaseQuota(nativeKit.sqlite, name);
    configuredDatabases.add(name);
  };
  table['browser.open'] = {
    capability: 'browser',
    run: async (ctx, [input]) => {
      await nativeKit.browser.open(checkAppUrl(ctx, typeof input === 'string' ? input : input?.url));
      return { opened: true };
    },
  };
  table['camera.getPhoto'] = {
    capability: 'camera',
    run: async (_ctx, [options]) => sanitizeCameraPhoto(await nativeKit.camera.getPhoto({
      quality: Math.min(75, Math.max(1, Number(options?.quality) || 70)),
      width: Math.min(1_024, Math.max(1, Number(options?.width) || 1_024)),
      height: Math.min(1_024, Math.max(1, Number(options?.height) || 1_024)),
      allowEditing: !!options?.allowEditing,
      correctOrientation: true,
      saveToGallery: false,
      resultType: 'base64',
      source: ['CAMERA', 'PHOTOS', 'PROMPT'].includes(options?.source) ? options.source : 'PROMPT',
    })),
  };
  table['camera.pickImages'] = {
    capability: 'camera',
    run: async (_ctx, [options]) => {
      const result = await nativeKit.camera.pickImages({
        quality: Math.min(65, Math.max(1, Number(options?.quality) || 65)),
        width: Math.min(640, Math.max(1, Number(options?.width) || 640)),
        height: Math.min(640, Math.max(1, Number(options?.height) || 640)),
        limit: Math.min(4, Math.max(1, Math.trunc(Number(options?.limit) || 1))),
        correctOrientation: true,
      });
      const photos = [];
      for (const item of (Array.isArray(result?.photos) ? result.photos : []).slice(0, 4)) {
        const data = await cameraGalleryData(nativeKit, item);
        const rawFormat = String(item?.format ?? 'jpeg').toLowerCase();
        photos.push({ data, encoding: 'base64', format: /^[a-z0-9.+-]{1,32}$/.test(rawFormat) ? rawFormat : 'jpeg' });
      }
      boundedJson(photos, 1_835_008, 'Picked images');
      return { photos };
    },
  };
  table['location.current'] = { capability: 'location', run: async (_ctx, [options]) => sanitizePosition(await nativeKit.location.current(sanitizeGeolocationOptions(options))) };
  table['haptics.impact'] = { capability: 'haptics', run: async (_ctx, [style]) => { await nativeKit.haptics.impact(['LIGHT', 'MEDIUM', 'HEAVY'].includes(style) ? style : 'MEDIUM'); } };
  table['haptics.notification'] = { capability: 'haptics', run: async (_ctx, [type]) => { await nativeKit.haptics.notification(['SUCCESS', 'WARNING', 'ERROR'].includes(type) ? type : 'WARNING'); } };
  table['haptics.vibrate'] = { capability: 'haptics', run: async (_ctx, [duration]) => { await nativeKit.haptics.vibrate(Math.min(5_000, Math.max(1, Number(duration) || 300))); } };

  table['background.dispatch'] = { capability: 'background', run: async (ctx) => { await nativeKit.background.dispatch({ syncUrl: nativeKit.config.backgroundRunner.defaultSyncUrl, source: `appBrowser:${ctx.app.id}` }); return { dispatched: true }; } };
  table['background.runSyncNow'] = { capability: 'background', run: async (ctx) => { await nativeKit.background.runSyncNow({ source: `appBrowser:${ctx.app.id}` }); return { dispatched: true }; } };
  table['background.checkPermissions'] = { capability: 'background', run: async () => {
    const value = await nativeKit.background.checkPermissions();
    return { geolocation: sanitizePermissionState(value?.geolocation), notifications: sanitizePermissionState(value?.notifications) };
  } };
  table['background.requestPermissions'] = {
    capability: 'background',
    run: async (_ctx, [apis]) => {
      const value = await nativeKit.background.requestPermissions((Array.isArray(apis) ? apis : []).filter((api: unknown) => api === 'geolocation' || api === 'notifications'));
      return { geolocation: sanitizePermissionState(value?.geolocation), notifications: sanitizePermissionState(value?.notifications) };
    },
  };
  table['network.status'] = { capability: 'networkStatus', run: async () => sanitizeNetworkStatus(await nativeKit.network.status()) };
  table['app.info'] = { capability: 'appInfo', run: async (ctx) => ({ id: ctx.app.id, name: ctx.app.manifest.name, version: ctx.app.manifest.version }) };
  table['app.state'] = { capability: 'appInfo', run: async () => sanitizeAppState(await nativeKit.app.state()) };
  table['permissions.check'] = { capability: 'permissions', run: async () => {
    const value = await nativeKit.permissions.check();
    return {
      camera: sanitizePermissionRecord(value?.camera, ['camera', 'photos']),
      location: sanitizePermissionRecord(value?.location, ['location', 'coarseLocation']),
      notifications: sanitizePermissionRecord(value?.notifications, ['display']),
      push: sanitizePermissionRecord(value?.push, ['receive']),
      alarms: sanitizeAlarmCapabilities(value?.alarms),
      backgroundLocation: sanitizeBackgroundLocationStatus(value?.backgroundLocation, false),
    };
  } };
  table['permissions.requestCamera'] = { capability: 'permissions', run: async () => sanitizePermissionRecord(await nativeKit.permissions.requestCamera(), ['camera', 'photos']) };
  table['permissions.requestLocation'] = { capability: 'permissions', run: async (_ctx, [coarseOnly]) => sanitizePermissionRecord(await nativeKit.permissions.requestLocation(coarseOnly === true), ['location', 'coarseLocation']) };
  table['permissions.requestNotifications'] = { capability: 'permissions', run: async () => sanitizePermissionRecord(await nativeKit.permissions.requestNotifications(), ['display']) };
  table['permissions.openAppSettings'] = { capability: 'permissions', run: async () => { await nativeKit.permissions.openAppSettings(); } };
  const httpOptions = (ctx: MethodContext, options: any, forcedMethod?: string): Record<string, any> => {
    const method = forcedMethod ?? String(options?.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) throw new Error('HTTP method is not allowed');
    return {
      url: checkAppUrl(ctx, options?.url), method,
      headers: sanitizeHeaders(options?.headers),
      params: options?.params == null ? undefined : boundedJson(options.params, 65_536),
      data: sanitizeHttpData(options?.data),
      responseType: ['json', 'text'].includes(options?.responseType) ? options.responseType : undefined,
      // Installed pages cannot tune broker transport controls. Keep bounded host-owned defaults.
      connectTimeout: 15_000,
      readTimeout: 30_000,
      disableRedirects: true,
    };
  };
  table['http.request'] = { capability: 'http', run: async (ctx, [options]) => sanitizeHttpResponse(await nativeKit.http.request(httpOptions(ctx, options))) };
  table['http.get'] = { capability: 'http', run: async (ctx, [url, options]) => sanitizeHttpResponse(await nativeKit.http.request(httpOptions(ctx, { ...(options ?? {}), url }, 'GET'))) };
  table['http.post'] = { capability: 'http', run: async (ctx, [url, data, options]) => sanitizeHttpResponse(await nativeKit.http.request(httpOptions(ctx, { ...(options ?? {}), url, data }, 'POST'))) };
  table['preferences.set'] = { capability: 'preferences', run: (ctx, [key, value]) => serialStorage(async () => { await writeOwnedStorage(ctx.app.id, 'preference', key, (nativeKey) => nativeKit.preferences.set(nativeKey, boundedString(value, 1_048_576, 'Preferences value'))); }) };
  table['preferences.get'] = { capability: 'preferences', run: async (ctx, [key]) => { const value = await nativeKit.preferences.get(appKey(ctx.app.id, key)); return value == null ? null : boundedString(value, 1_048_576, 'Preferences value'); } };
  table['preferences.remove'] = { capability: 'preferences', run: (ctx, [key]) => serialStorage(async () => { await nativeKit.preferences.remove(appKey(ctx.app.id, key)); await idbDelete('resources', `preference:${ctx.app.id}:${String(key)}`); }) };
  table['preferences.setJSON'] = { capability: 'preferences', run: (ctx, [key, value]) => serialStorage(async () => { await writeOwnedStorage(ctx.app.id, 'preference', key, (nativeKey) => nativeKit.preferences.setJSON(nativeKey, boundedJson(value, 1_048_576))); }) };
  table['preferences.getJSON'] = { capability: 'preferences', run: async (ctx, [key]) => boundedJson(await nativeKit.preferences.getJSON(appKey(ctx.app.id, key)), 1_048_576, 'Preferences JSON value') };
  table['secureStorage.set'] = { capability: 'secureStorage', run: (ctx, [key, value]) => serialStorage(async () => { await writeOwnedStorage(ctx.app.id, 'secure', key, (nativeKey) => nativeKit.secureStorage.set(nativeKey, boundedString(value, 65_536, 'Secure-storage value'))); }) };
  table['secureStorage.get'] = { capability: 'secureStorage', run: async (ctx, [key]) => { const value = await nativeKit.secureStorage.get(appKey(ctx.app.id, key)); return value == null ? null : boundedString(value, 65_536, 'Secure-storage value'); } };
  table['secureStorage.remove'] = { capability: 'secureStorage', run: (ctx, [key]) => serialStorage(async () => { await nativeKit.secureStorage.remove(appKey(ctx.app.id, key)); await idbDelete('resources', `secure:${ctx.app.id}:${String(key)}`); }) };
  table['sqlite.execute'] = {
    capability: 'sqlite',
    run: (ctx, [logicalName, statements, transaction]) => serialSqlite(async () => { const name = await registerSandboxDatabase(ctx.app.id, logicalName); await ensureSandboxDatabase(name); return sanitizeSqliteChanges(await nativeKit.sqlite.execute(name, safeSql(statements), transaction !== false)); }),
  };
  table['sqlite.run'] = {
    capability: 'sqlite',
    run: (ctx, [logicalName, statement, values, transaction]) => serialSqlite(async () => { const name = await registerSandboxDatabase(ctx.app.id, logicalName); await ensureSandboxDatabase(name); return sanitizeSqliteChanges(await nativeKit.sqlite.run(name, safeSql(statement), safeSqlValues(values ?? []), transaction !== false)); }),
  };
  table['sqlite.query'] = {
    capability: 'sqlite',
    run: (ctx, [logicalName, statement, values]) => serialSqlite(async () => {
      const name = await registerSandboxDatabase(ctx.app.id, logicalName); await ensureSandboxDatabase(name);
      const result = await nativeKit.sqlite.query(name, safeSql(statement), safeSqlValues(values ?? []));
      const rows = Array.isArray(result?.values) ? result.values : [];
      return { values: boundedJson(rows, 2_000_000, 'SQLite rows') };
    }),
  };
  table['sqlite.close'] = {
    capability: 'sqlite',
    run: (ctx, [logicalName]) => serialSqlite(async () => { const name = appDatabase(ctx.app.id, logicalName); configuredDatabases.delete(name); await nativeKit.sqlite.close(name); }),
  };
  table['sqlite.open'] = {
    capability: 'sqlite',
    run: (ctx, [logicalName]) => serialSqlite(async () => { const name = await registerSandboxDatabase(ctx.app.id, logicalName); await ensureSandboxDatabase(name); return { name: String(logicalName ?? 'main'), open: true, encrypted: false }; }),
  };
  table['sqlite.delete'] = {
    capability: 'sqlite',
    run: (ctx, [logicalName]) => serialSqlite(async () => {
      const logicalId = String(logicalName ?? 'main'); const name = appDatabase(ctx.app.id, logicalId);
      configuredDatabases.delete(name); await nativeKit.sqlite.delete(name); await idbDelete('resources', `database:${ctx.app.id}:${logicalId}`); return { deleted: true };
    }),
  };
  table['filesystem.readFile'] = {
    capability: 'filesystem',
    run: (ctx, [options]) => serialFilesystem(async () => {
      const directory = options?.directory === 'Cache' ? 'Cache' : 'Data';
      const path = safeRelativeDataPath(ctx.app.id, options?.path);
      const file = await sandboxDestinationState(nativeKit, directory, path);
      const encoding = ['utf8', 'ascii', 'utf16'].includes(String(options?.encoding).toLowerCase()) ? String(options.encoding).toLowerCase() : undefined;
      const maxFileBytes = encoding ? 1_835_008 : 1_376_256;
      if (!file.exists || file.size > maxFileBytes) throw new Error(`Sandbox file exceeds the brokered read limit of ${maxFileBytes} bytes`);
      const result = await nativeKit.filesystem.readFile({ directory, path, encoding });
      return { data: boundedString(result?.data, 1_835_008, 'Filesystem read result') };
    }),
  };
  table['filesystem.writeFile'] = {
    capability: 'filesystem',
    run: (ctx, [options]) => serialFilesystem(async () => {
      const directory = options?.directory === 'Cache' ? 'Cache' : 'Data';
      const logicalPath = normalizePath(String(options?.path ?? ''));
      const path = safeRelativeDataPath(ctx.app.id, logicalPath);
      const payload = sandboxFileData(options?.data, options?.encoding);
      const usage = await sandboxFilesystemUsage(nativeKit, ctx.app.id);
      const destination = await sandboxDestinationState(nativeKit, directory, path);
      if ((!destination.exists && usage.files >= 512) || usage.bytes - destination.size + payload.bytes > 64 * 1024 * 1024) throw new Error('Sandbox filesystem quota exceeded');
      await nativeKit.filesystem.writeFile({ directory, path, data: payload.data, encoding: payload.encoding, recursive: !!options?.recursive });
      return { path: logicalPath };
    }),
  };
  table['filesystem.appendFile'] = {
    capability: 'filesystem',
    run: (ctx, [options]) => serialFilesystem(async () => {
      const directory = options?.directory === 'Cache' ? 'Cache' : 'Data';
      const path = safeRelativeDataPath(ctx.app.id, options?.path);
      const payload = sandboxFileData(options?.data, options?.encoding);
      const usage = await sandboxFilesystemUsage(nativeKit, ctx.app.id);
      const destination = await sandboxDestinationState(nativeKit, directory, path);
      if ((!destination.exists && usage.files >= 512) || usage.bytes + payload.bytes > 64 * 1024 * 1024) throw new Error('Sandbox filesystem quota exceeded');
      await nativeKit.filesystem.appendFile({ directory, path, data: payload.data, encoding: payload.encoding });
    }),
  };
  for (const method of ['deleteFile', 'mkdir', 'rmdir']) {
    table[`filesystem.${method}`] = {
      capability: 'filesystem',
      run: (ctx, [options]) => serialFilesystem(async () => { await nativeKit.filesystem[method]({ directory: options?.directory === 'Cache' ? 'Cache' : 'Data', path: safeRelativeDataPath(ctx.app.id, options?.path), recursive: !!options?.recursive }); }),
    };
  }
  table['filesystem.readdir'] = {
    capability: 'filesystem',
    run: async (ctx, [options]) => {
      const result = await nativeKit.filesystem.readdir({ directory: options?.directory === 'Cache' ? 'Cache' : 'Data', path: safeRelativeDataPath(ctx.app.id, options?.path) });
      if (!Array.isArray(result?.files) || result.files.length > 1_024) throw new Error('Native filesystem directory result is invalid or too large');
      return { files: result.files.map((item: any) => sanitizeFilesystemInfo(item, true)) };
    },
  };
  table['filesystem.stat'] = {
    capability: 'filesystem',
    run: async (ctx, [options]) => sanitizeFilesystemInfo(await nativeKit.filesystem.stat({ directory: options?.directory === 'Cache' ? 'Cache' : 'Data', path: safeRelativeDataPath(ctx.app.id, options?.path) }), false),
  };
  table['transfer.download'] = {
    capability: 'fileTransfer',
    run: (ctx, [options]) => serialFilesystem(async () => {
      const directory = options?.directory === 'Cache' ? 'Cache' : 'Data';
      const path = safeRelativeDataPath(ctx.app.id, options?.path);
      const before = await sandboxFilesystemUsage(nativeKit, ctx.app.id);
      const destination = await sandboxDestinationState(nativeKit, directory, path);
      if (!destination.exists && before.files >= 512) throw new Error('Sandbox filesystem file-count quota exceeded');
      const discardDownload = (cause: unknown): Promise<never> => discardSandboxDownload(nativeKit, directory, path, cause);
      try {
        await nativeKit.transfer.download({ url: checkAppUrl(ctx, options?.url), directory, path, headers: sanitizeHeaders(options?.headers), onProgress: undefined, disableRedirects: true });
      } catch (error) { return discardDownload(error); }
      let downloaded: { exists: boolean; size: number }; let after: { bytes: number; files: number };
      try { downloaded = await sandboxDestinationState(nativeKit, directory, path); after = await sandboxFilesystemUsage(nativeKit, ctx.app.id); }
      catch (error) { return discardDownload(error); }
      if (!downloaded.exists || downloaded.size > 32 * 1024 * 1024 || after.bytes > 64 * 1024 * 1024 || after.files > 512) return discardDownload(new Error('Downloaded file exceeded the sandbox filesystem quota'));
      return { path: normalizePath(String(options?.path ?? '')), bytes: downloaded.size };
    }),
  };
  table['transfer.upload'] = {
    capability: 'fileTransfer',
    run: (ctx, [options]) => serialFilesystem(async () => {
      const directory = options?.directory === 'Cache' ? 'Cache' : 'Data';
      const path = safeRelativeDataPath(ctx.app.id, options?.path);
      const file = await sandboxDestinationState(nativeKit, directory, path);
      if (!file.exists || file.size > 32 * 1024 * 1024) throw new Error('Sandbox uploads are limited to 32 MiB files');
      const method = ['POST', 'PUT', 'PATCH'].includes(String(options?.method).toUpperCase()) ? String(options.method).toUpperCase() : 'POST';
      const mimeType = typeof options?.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(options.mimeType) ? options.mimeType : 'application/octet-stream';
      return sanitizeTransferUploadResult(await nativeKit.transfer.upload({ url: checkAppUrl(ctx, options?.url), directory, path, headers: sanitizeHeaders(options?.headers), method, mimeType, onProgress: undefined, disableRedirects: true }));
    }),
  };
  table['share.canShare'] = { capability: 'sharing', run: async () => ({ value: (await nativeKit.share.canShare())?.value === true }) };
  table['share.show'] = {
    capability: 'sharing',
    run: async (_ctx, [options]) => {
      let url: string | undefined;
      if (options?.url != null) {
        const parsed = new URL(boundedString(options.url, 2_000, 'Share URL'));
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) share URLs are allowed');
        url = parsed.toString();
      }
      const result = await nativeKit.share.show({
        title: options?.title == null ? undefined : boundedString(options.title, 200, 'Share title'),
        text: options?.text == null ? undefined : boundedString(options.text, 10_000, 'Share text'),
        url,
        dialogTitle: options?.dialogTitle == null ? undefined : boundedString(options.dialogTitle, 200, 'Share dialog title'),
      });
      return { completed: result?.completed === true, activityType: result?.activityType == null ? undefined : boundedString(result.activityType, 200, 'Share activity type') };
    },
  };
  table['notifications.check'] = { capability: 'notifications', run: async () => sanitizePermissionRecord(await nativeKit.notifications.check(), ['display']) };
  table['notifications.request'] = { capability: 'notifications', run: async () => sanitizePermissionRecord(await nativeKit.notifications.request(), ['display']) };
  table['notifications.schedule'] = {
    capability: 'notifications',
    run: (ctx, [items]) => serialNotification(async () => {
      if (!Array.isArray(items) || !items.length) throw new Error('At least one notification is required');
      if (items.length > 16) throw new Error('At most 16 notifications may be scheduled in one broker call');
      const requested = items;
      const logicalIds = requested.map((item: any) => String(item?.id ?? ''));
      if (new Set(logicalIds).size !== logicalIds.length) throw new Error('Notification IDs must be unique in a batch');
      const pendingResult = await nativeKit.notifications.pending();
      const pending = Array.isArray(pendingResult?.notifications) ? pendingResult.notifications : [];
      const appPending = pending.filter((item: any) => item?.extra?.nativeKitAppBrowserId === ctx.app.id);
      const brokerPending = pending.filter((item: any) => typeof item?.extra?.nativeKitAppBrowserId === 'string');
      const existingLogical = new Set(appPending.map((item: any) => String(item?.extra?.logicalId)));
      const additions = logicalIds.filter((id) => !existingLogical.has(id)).length;
      if (appPending.length + additions > 16 || brokerPending.length + additions > 32) throw new Error('App Browser notification quota exceeded');
      const notifications = await Promise.all(requested.map(async (item: any) => {
        const nativeId = await notificationNativeId(ctx.app.id, item.id, true);
        if (nativeId == null) throw new Error('Unable to allocate notification ID');
        const collision = pending.find((entry: any) => entry.id === nativeId && entry?.extra?.nativeKitAppBrowserId !== ctx.app.id);
        if (collision) throw new Error('Reserved notification ID is already in use by the host');
        return {
          id: nativeId,
          title: boundedString(item.title, 200, 'Notification title'),
          body: boundedString(item.body, 2_000, 'Notification body'),
          schedule: sanitizeNotificationSchedule(item.schedule),
          sound: item.sound === 'default' ? 'default' : undefined,
          extra: { nativeKitAppBrowserId: ctx.app.id, logicalId: String(item.id) },
        };
      }));
      await nativeKit.notifications.schedule(notifications);
      return { scheduled: true, ids: logicalIds };
    }),
  };
  table['notifications.cancel'] = {
    capability: 'notifications',
    run: (ctx, [ids]) => serialNotification(async () => {
      const logicalIds = (Array.isArray(ids) ? ids : []).slice(0, 64);
      const mapped = (await Promise.all(logicalIds.map((id: any) => notificationNativeId(ctx.app.id, id, false)))).filter((id): id is number => id != null);
      if (!mapped.length) return undefined;
      const pendingResult = await nativeKit.notifications.pending();
      const ownedIds = new Set((pendingResult?.notifications ?? []).filter((item: any) => item?.extra?.nativeKitAppBrowserId === ctx.app.id).map((item: any) => item.id));
      await nativeKit.notifications.cancel(mapped.filter((id) => ownedIds.has(id)));
    }),
  };
  table['alarms.capabilities'] = { capability: 'alarms', run: async () => sanitizeAlarmCapabilities(await nativeKit.alarms.capabilities()) };
  table['alarms.requestExactAccess'] = { capability: 'alarms', run: async () => sanitizeAlarmCapabilities(await nativeKit.alarms.requestExactAccess()) };
  table['alarms.requestFullScreenAccess'] = { capability: 'alarms', run: async () => sanitizeAlarmCapabilities(await nativeKit.alarms.requestFullScreenAccess()) };
  table['alarms.schedule'] = {
    capability: 'alarms',
    run: (ctx, [options]) => serialAlarm(async () => {
      const nativeId = appAlarmId(ctx.app.id, options?.id);
      const response = await nativeKit.alarms.list();
      const alarms = Array.isArray(response?.alarms) ? response.alarms : [];
      const appAlarms = alarms.filter((item: any) => item?.extra?.nativeKitAppBrowserId === ctx.app.id);
      const brokerAlarms = alarms.filter((item: any) => typeof item?.extra?.nativeKitAppBrowserId === 'string');
      const exists = appAlarms.some((item: any) => item.id === nativeId);
      const collision = alarms.find((item: any) => item?.id === nativeId && item?.extra?.nativeKitAppBrowserId !== ctx.app.id);
      if (collision) throw new Error('Reserved alarm ID is already in use by the host');
      if (!exists && (appAlarms.length >= 16 || brokerAlarms.length >= 32)) throw new Error('App Browser alarm quota exceeded');
      const at = options?.at instanceof Date ? options.at.getTime() : typeof options?.at === 'number' ? options.at : new Date(options?.at).getTime();
      if (!Number.isFinite(at)) throw new Error('Alarm at must be a valid date or epoch milliseconds');
      const repeatInput = Number(options?.repeatIntervalMinutes) || 0;
      const repeatIntervalMinutes = repeatInput > 0 ? Math.min(525_600, Math.max(15, repeatInput)) : 0;
      await nativeKit.alarms.schedule({
        id: nativeId,
        title: boundedString(options?.title, 200, 'Alarm title'),
        body: boundedString(options?.body, 2_000, 'Alarm body'),
        at,
        repeatIntervalMinutes,
        fullScreen: !!options?.fullScreen,
        sound: options?.sound === 'default' ? 'default' : undefined,
        extra: { nativeKitAppBrowserId: ctx.app.id, logicalId: String(options?.id) },
      });
      return { id: String(options.id), scheduled: true };
    }),
  };
  table['alarms.cancel'] = {
    capability: 'alarms',
    run: (ctx, [id]) => serialAlarm(async () => {
      const nativeId = appAlarmId(ctx.app.id, id);
      const response = await nativeKit.alarms.list();
      const owned = (response?.alarms ?? []).some((item: any) => item.id === nativeId && item?.extra?.nativeKitAppBrowserId === ctx.app.id);
      if (owned) await nativeKit.alarms.cancel(nativeId);
    }),
  };
  table['alarms.stop'] = {
    capability: 'alarms',
    run: (ctx, [id]) => serialAlarm(async () => {
      const nativeId = appAlarmId(ctx.app.id, id);
      const response = await nativeKit.alarms.list();
      const owned = (response?.alarms ?? []).some((item: any) => item.id === nativeId && item?.extra?.nativeKitAppBrowserId === ctx.app.id);
      if (owned) await nativeKit.alarms.stop(nativeId);
    }),
  };
  table['alarms.list'] = {
    capability: 'alarms',
    run: async (ctx) => {
      const response = await nativeKit.alarms.list();
      const owned = (Array.isArray(response?.alarms) ? response.alarms : []).filter((item: any) => item?.extra?.nativeKitAppBrowserId === ctx.app.id).slice(0, 16);
      return { alarms: owned.map((item: any) => ({
        id: boundedString(item?.extra?.logicalId, 80, 'Alarm id'),
        title: boundedString(item?.title, 200, 'Alarm title'),
        body: boundedString(item?.body, 2_000, 'Alarm body'),
        scheduledAt: finiteNumber(item?.scheduledAt ?? item?.at, 'alarm scheduledAt'),
        repeatIntervalMinutes: Math.max(0, finiteNumber(item?.repeatIntervalMinutes ?? 0, 'alarm repeat interval')),
      })) };
    },
  };
  return table;
}

export function serializeError(error: unknown): { message: string; code?: string } {
  const value = error as any;
  const raw = String(value?.message ?? value ?? 'Unknown error').slice(0, 2_000);
  const message = raw
    .replace(/\b(?:file|content|capacitor):\/\/[^\s"'<>]+/gi, '[redacted resource]')
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>]*/g, '[redacted path]')
    .replace(/(^|[\s(])\/(?:data|private|var|storage|Users|home|tmp|sdcard)\/[^\s"'<>)]*/gi, '$1[redacted path]')
    .replace(/\bnk_[a-z0-9_]{4,}\b/gi, '[redacted identifier]')
    .replace(/nativekit-app-browser\/[^\s"'<>)]*/gi, '[redacted resource]')
    .slice(0, 500);
  const code = typeof value?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value.code) ? value.code : undefined;
  return { message, ...(code ? { code } : {}) };
}

function permissionFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'NativeKitPermissionError', code });
}

export function summarizePermissionArguments(value: unknown): string {
  const summarize = (item: unknown, depth: number): string => {
    if (item == null) return String(item);
    if (typeof item === 'string') return `string(${textEncoder.encode(item).length} bytes)`;
    if (typeof item === 'number') return Number.isFinite(item) ? 'number' : 'non-finite number';
    if (typeof item === 'boolean') return 'boolean';
    if (typeof item === 'bigint') return 'bigint';
    if (typeof item === 'function') return 'function';
    if (item instanceof Uint8Array) return `bytes(${item.byteLength})`;
    if (Array.isArray(item)) {
      if (depth >= 2) return `array(${item.length})`;
      const kinds = Array.from(new Set(item.slice(0, 8).map((entry) => summarize(entry, depth + 1))));
      return `array(${item.length}${kinds.length ? `: ${kinds.join(', ')}` : ''})`;
    }
    if (typeof item === 'object') {
      const keys = Object.keys(item as Record<string, unknown>);
      if (depth >= 2) return `object(${keys.length} keys)`;
      const safeKeys = keys.slice(0, 12).map((key) => /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(key) ? key : 'field');
      return `object(${keys.length} keys${safeKeys.length ? `: ${safeKeys.join(', ')}` : ''})`;
    }
    return typeof item;
  };
  const args = Array.isArray(value) ? value : [];
  return `${args.length} argument${args.length === 1 ? '' : 's'}${args.length ? ` · ${args.slice(0, 8).map((item) => summarize(item, 0)).join(' · ')}` : ''}`.slice(0, 500);
}

function isMissingResourceError(error: unknown): boolean {
  const value = serializeError(error);
  return /not[ -]?found|not exist|does not exist|OS-PLUG-FILE-0008/i.test(`${value.code ?? ''} ${value.message}`);
}

function bootstrapSource(token: string, app: InstalledApp): string {
  const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const methods = [
    'permissions.check', 'permissions.requestCamera', 'permissions.requestLocation', 'permissions.requestNotifications', 'permissions.openAppSettings',
    'http.request', 'http.get', 'http.post', 'camera.getPhoto', 'camera.pickImages', 'location.current',
    'backgroundLocation.start', 'backgroundLocation.stop', 'backgroundLocation.status',
    'haptics.impact', 'haptics.notification', 'haptics.vibrate', 'notifications.check', 'notifications.request', 'notifications.schedule', 'notifications.cancel',
    'alarms.capabilities', 'alarms.requestExactAccess', 'alarms.requestFullScreenAccess', 'alarms.schedule', 'alarms.cancel', 'alarms.list', 'alarms.stop',
    'background.dispatch', 'background.runSyncNow', 'background.checkPermissions', 'background.requestPermissions',
    'preferences.set', 'preferences.get', 'preferences.remove', 'preferences.setJSON', 'preferences.getJSON',
    'secureStorage.set', 'secureStorage.get', 'secureStorage.remove', 'sqlite.open', 'sqlite.execute', 'sqlite.run', 'sqlite.query', 'sqlite.close', 'sqlite.delete',
    'filesystem.readFile', 'filesystem.writeFile', 'filesystem.appendFile', 'filesystem.deleteFile', 'filesystem.mkdir', 'filesystem.rmdir', 'filesystem.readdir', 'filesystem.stat',
    'transfer.download', 'transfer.upload', 'browser.open', 'share.canShare', 'share.show', 'network.status', 'app.info', 'app.state',
    'miniUI.publish', 'miniUI.list', 'miniUI.get', 'miniUI.remove',
    'floatingUI.publish', 'floatingUI.list', 'floatingUI.get', 'floatingUI.remove',
    'floatingUI.checkPermission', 'floatingUI.requestPermission', 'floatingUI.show', 'floatingUI.hide',
    'homeWidget.publish', 'homeWidget.list', 'homeWidget.get', 'homeWidget.remove', 'homeWidget.activate', 'homeWidget.requestPin',
  ];
  return `(() => {
    'use strict';
    const CHANNEL=${scriptJson(RPC_CHANNEL)}, TOKEN=${scriptJson(token)}, APP=${scriptJson({ id: app.id, name: app.manifest.name, version: app.manifest.version })};
    document.currentScript?.remove();
    let sequence=0; const pending=new Map(), callbacks=new Map(), transport=window.NativeKitIsolatedTransport;
    const send=(message)=>transport?.postMessage?transport.postMessage(JSON.stringify(message)):parent.postMessage(message,'*');
    const call=(method,...args)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({channel:CHANNEL,direction:'request',token:TOKEN,id,method,args});setTimeout(()=>{const p=pending.get(id);if(p){pending.delete(id);p.reject(new Error('NativeKit broker timeout'));}},120000);});
    const receive=(message)=>{if(message?.channel!==CHANNEL||message?.token!==TOKEN)return;if(message.direction==='response'){const p=pending.get(message.id);if(!p)return;pending.delete(message.id);message.ok?p.resolve(message.result):p.reject(Object.assign(new Error(message.error?.message||'Native API error'),message.error));}else if(message.direction==='event'){callbacks.get(message.subscriptionId)?.(message.payload);}};
    Object.defineProperty(window,'__NativeKitIsolatedReceive',{value:receive,configurable:false,writable:false});
    if(transport){transport.onmessage=(event)=>{try{receive(typeof event.data==='string'?JSON.parse(event.data):event.data)}catch{}};}else addEventListener('message',(event)=>{if(event.source!==parent||event.data?.channel!==CHANNEL||event.data?.token!==TOKEN)return;receive(event.data);});
    const kit={version:'app-browser-1.1.0',appIdentity:Object.freeze(APP),ready:async()=>kit,call,capabilities:()=>call('@capabilities'),
      subscribe:async(eventName,callback,options={})=>{const result=await call('@subscribe',eventName,options);callbacks.set(result.subscriptionId,callback);return{id:result.subscriptionId,remove:async()=>{callbacks.delete(result.subscriptionId);await call('@unsubscribe',result.subscriptionId);}};}};
    for(const path of ${scriptJson(methods)}){const parts=path.split('.');let owner=kit;for(let i=0;i<parts.length-1;i++)owner=owner[parts[i]]??={};owner[parts.at(-1)]=(...args)=>call(path,...args);}
    kit.http.stream=async(options,handlers={})=>{const sub=await kit.subscribe('http.stream',(event)=>{if(event.type==='message')handlers.onMessage?.(event.payload);else if(event.type==='error')handlers.onError?.(Object.assign(new Error(event.payload.message),event.payload));else if(event.type==='end')handlers.onEnd?.(event.payload);},options);return{id:sub.id,close:sub.remove};};
    kit.location.watch=async(callback,options={})=>kit.subscribe('location.watch',(event)=>callback(event.position,event.error),options);
    Object.defineProperty(window,'NativeKit',{value:kit,enumerable:true,configurable:false,writable:false});
    dispatchEvent(new CustomEvent('nativekitready',{detail:{app:APP,brokered:true}}));
  })();`;
}

function buildDocument(app: InstalledApp, config: AppBrowserConfig, token: string, policy: AppPolicy): string {
  const files = new Map(app.files.map((file) => [file.path, file]));
  const entry = files.get(app.manifest.entry);
  if (!entry) throw new Error('Installed entry file is missing');
  const parser = new DOMParser();
  const documentValue = parser.parseFromString(textDecoder.decode(entry.bytes), 'text/html');
  documentValue.querySelectorAll('base,meta[http-equiv="refresh" i],meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove());
  const approvedHttps = policy.allowedHosts.map((host) => `https://${host}`).join(' ');
  const approvedWss = policy.allowedHosts.map((host) => `wss://${host}`).join(' ');
  const directSources = [approvedHttps, approvedWss].filter(Boolean).join(' ');
  const networkMode = policy.networkMode ?? 'full';
  let csp: string;
  if (networkMode === 'full') {
    // Owner-approved full internet: open HTTPS/WSS + form posts; everything else stays locked down.
    csp = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob: https:; media-src data: blob: https:; font-src data: blob: https:; connect-src https: wss: data: blob:; worker-src blob: data:; frame-src data: blob: https:; form-action https:; navigate-to 'self'; base-uri 'none'; object-src 'none'";
  } else if (config.allowDirectWebNetwork && directSources) {
    csp = `default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob: ${approvedHttps}; media-src data: blob: ${approvedHttps}; font-src data: blob:; connect-src ${directSources}; worker-src blob:; frame-src data: blob:; form-action 'none'; navigate-to 'self'; base-uri 'none'; object-src 'none'`;
  } else {
    csp = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; worker-src blob:; frame-src data: blob:; form-action 'none'; navigate-to 'self'; base-uri 'none'; object-src 'none'";
  }
  const cspNode = documentValue.createElement('meta'); cspNode.httpEquiv = 'Content-Security-Policy'; cspNode.content = csp; documentValue.head.prepend(cspNode);
  const charset = documentValue.createElement('meta'); charset.setAttribute('charset', 'utf-8'); documentValue.head.prepend(charset);

  const moduleImports: Record<string, string> = {};
  for (const file of app.files.filter((item) => /\.(?:m?js)$/i.test(item.path))) {
    const rewritten = rewriteModule(textDecoder.decode(file.bytes), file.path, files);
    moduleImports[stableModuleKey(file.path)] = dataUrl({ ...file, bytes: textEncoder.encode(rewritten) });
  }
  if (Object.keys(moduleImports).length) {
    const importMap = documentValue.createElement('script'); importMap.type = 'importmap'; importMap.textContent = JSON.stringify({ imports: moduleImports });
    documentValue.head.prepend(importMap);
  }

  for (const link of Array.from(documentValue.querySelectorAll<HTMLLinkElement>('link[href]'))) {
    const resolved = resolvePackagePath(app.manifest.entry, link.getAttribute('href') ?? '');
    const file = resolved ? files.get(resolved) : undefined;
    if (!file) { link.remove(); continue; }
    if ((link.rel || '').toLowerCase().includes('stylesheet')) {
      const style = documentValue.createElement('style'); style.textContent = rewriteCss(textDecoder.decode(file.bytes), file.path, files); link.replaceWith(style);
    } else link.href = dataUrl(file);
  }
  for (const style of Array.from(documentValue.querySelectorAll('style'))) style.textContent = rewriteCss(style.textContent ?? '', app.manifest.entry, files);
  for (const script of Array.from(documentValue.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const resolved = resolvePackagePath(app.manifest.entry, script.getAttribute('src') ?? '');
    const file = resolved ? files.get(resolved) : undefined;
    if (!file) { script.remove(); continue; }
    if (script.type === 'module' || /\.mjs$/i.test(file.path)) {
      script.removeAttribute('src'); script.type = 'module'; script.textContent = `import ${JSON.stringify(stableModuleKey(file.path))};`;
    } else script.src = dataUrl(file);
  }
  for (const script of Array.from(documentValue.querySelectorAll<HTMLScriptElement>('script[type="module"]:not([src])'))) {
    if (!script.textContent?.startsWith('import "nativekit-module-')) script.textContent = rewriteModule(script.textContent ?? '', app.manifest.entry, files);
  }
  for (const element of Array.from(documentValue.querySelectorAll<HTMLElement>('[src],[poster]'))) {
    for (const attribute of ['src', 'poster']) {
      const raw = element.getAttribute(attribute); if (!raw || raw.startsWith('data:')) continue;
      const resolved = resolvePackagePath(app.manifest.entry, raw); const file = resolved ? files.get(resolved) : undefined;
      if (file) element.setAttribute(attribute, dataUrl(file)); else if (!config.allowDirectWebNetwork) element.removeAttribute(attribute);
    }
  }
  const broker = documentValue.createElement('script'); broker.textContent = bootstrapSource(token, app); documentValue.head.prepend(broker);
  const fsNotify = documentValue.createElement('script');
  fsNotify.textContent = "document.addEventListener('fullscreenchange',function(){try{if(window.NativeKitImmersive)window.NativeKitImmersive.setFullscreen(!!document.fullscreenElement);}catch(e){}});";
  (documentValue.body ?? documentValue.documentElement).appendChild(fsNotify);
  return `<!doctype html>\n${documentValue.documentElement.outerHTML}`;
}

export function gateAppBrowserHostSurface<T extends object>(surface: T, enabled: () => boolean): T {
  // hostSurface is deeply frozen before it reaches this function. A Proxy may not
  // return a different object/function for a frozen non-configurable data property,
  // so build a separately frozen gated façade instead of proxying the frozen target.
  const cache = new WeakMap<object, object>();
  const wrap = (value: object): object => {
    const cached = cache.get(value);
    if (cached) return cached;
    if (Array.isArray(value)) {
      const array: unknown[] = [];
      cache.set(value, array);
      for (const member of value) array.push(member && typeof member === 'object' ? wrap(member) : member);
      return Object.freeze(array);
    }
    const output: Record<PropertyKey, unknown> = {};
    cache.set(value, output);
    for (const property of Reflect.ownKeys(value)) {
      const member = Reflect.get(value, property);
      output[property] = typeof member === 'function'
        ? (...args: unknown[]) => {
            if (!enabled()) throw new Error('Feature is disabled in app.config.json: appBrowser');
            return member.apply(value, args);
          }
        : member && typeof member === 'object' ? wrap(member) : member;
    }
    return Object.freeze(output);
  };
  return wrap(surface) as T;
}

export function createAppBrowser(nativeKit: any, config: AppBrowserConfig): any {
  const sessions = new Map<string, RpcSession>();
  const remoteUrlSessions = new Map<string, { id: string; url: string; native: boolean; window?: Window | null }>();
  const configuredDatabases = new Set<string>();
  const packageCache = new Map<string, { integrity: string; files: PackageFile[] }>();
  const artifactStore = createNativeArtifactStore(nativeKit as NativeObjectKit);
  const artifactManager = createMiniAppArtifactManager(nativeKit, artifactStore, config);
  const methods = createAppBrowserMethodTable(nativeKit, configuredDatabases);
  const stoppingSessions = new Set<string>();
  const pendingPermissions = new Map<string, PendingPermissionInternal>();
  const permissionQueue: string[] = [];
  const permissionPrompts = {
    enabled: true,
    requestTimeoutMs: 90_000,
    requestedCapabilityDefault: 'ask' as AppBrowserPermissionDecision,
    unrequestedCapabilityDefault: 'block' as AppBrowserPermissionDecision,
    ...(config.permissionPrompts ?? {}),
  };
  let activePermissionId: string | null = null;
  let nativeListenersReady: Promise<void> | undefined;
  let backgroundLocationOwner: string | null = null;
  methods['backgroundLocation.start'] = {
    capability: 'backgroundLocation',
    run: async (ctx, [options]) => {
      const state = await nativeKit.backgroundLocation.status();
      if (state?.running && backgroundLocationOwner !== ctx.app.id) throw new Error('Background location is already managed by the host or another app');
      const safeOptions = {
        minTimeMs: Math.min(3_600_000, Math.max(10_000, Number(options?.minTimeMs) || 30_000)),
        minDistanceM: Math.min(10_000, Math.max(0, Number(options?.minDistanceM) || 10)),
        maxBuffer: Math.min(1_000, Math.max(10, Number(options?.maxBuffer) || 100)),
        desiredAccuracy: options?.desiredAccuracy === 'low' ? 'low' : 'high',
      };
      const result = await nativeKit.backgroundLocation.start(safeOptions);
      backgroundLocationOwner = ctx.app.id;
      return sanitizeBackgroundLocationStatus(result, true);
    },
  };
  methods['backgroundLocation.stop'] = {
    capability: 'backgroundLocation',
    run: async (ctx) => {
      if (backgroundLocationOwner !== ctx.app.id) throw new Error('This app does not own the background-location session');
      await nativeKit.backgroundLocation.stop(); backgroundLocationOwner = null;
    },
  };
  methods['backgroundLocation.status'] = {
    capability: 'backgroundLocation',
    run: async (ctx) => sanitizeBackgroundLocationStatus(await nativeKit.backgroundLocation.status(), backgroundLocationOwner === ctx.app.id),
  };
  methods['permissions.check'] = { capability: 'permissions', run: async (ctx) => {
    const value = await nativeKit.permissions.check();
    return {
      camera: sanitizePermissionRecord(value?.camera, ['camera', 'photos']),
      location: sanitizePermissionRecord(value?.location, ['location', 'coarseLocation']),
      notifications: sanitizePermissionRecord(value?.notifications, ['display']),
      push: sanitizePermissionRecord(value?.push, ['receive']),
      alarms: sanitizeAlarmCapabilities(value?.alarms),
      backgroundLocation: sanitizeBackgroundLocationStatus(value?.backgroundLocation, backgroundLocationOwner === ctx.app.id),
    };
  } };
  const globalFeatureMap: Partial<Record<AppBrowserCapability, string>> = {
    camera: 'camera', location: 'location', backgroundLocation: 'backgroundLocation', haptics: 'haptics',
    notifications: 'localNotifications', alarms: 'advancedAlarms', background: 'backgroundRunner', sqlite: 'sqlite',
    secureStorage: 'secureStorage', filesystem: 'filesystem', fileTransfer: 'fileTransfer', sharing: 'sharing',
    networkStatus: 'networkStatus', pushNotifications: 'pushNotificationsReady', browser: 'inAppBrowser',
    floatingUI: 'widget', homeWidget: 'widget',
  };

  function publicPendingPermission(request: PendingPermissionInternal): AppBrowserPendingPermission {
    const { requestId, appId, appName, sessionId, renderer, capability, method, argumentSummary, requestedByManifest, createdAt, expiresAt } = request;
    return { requestId, appId, appName, sessionId, renderer, capability, method, argumentSummary, requestedByManifest, createdAt, expiresAt };
  }

  function permissionAction(value: unknown): value is AppBrowserPermissionAction {
    return value === 'allow_once' || value === 'allow_always' || value === 'block_once' || value === 'block_always';
  }

  function finishPermission(request: PendingPermissionInternal, action?: AppBrowserPermissionAction, error?: Error): void {
    if (!pendingPermissions.has(request.requestId)) return;
    request.settled = true;
    if (request.timer) clearTimeout(request.timer);
    pendingPermissions.delete(request.requestId);
    if (activePermissionId === request.requestId) activePermissionId = null;
    if (request.renderer === 'isolated' && nativeKit.isNative) {
      void NativeKitIsolatedBrowser.dismissPermission({ sessionId: request.sessionId, requestId: request.requestId }).catch(() => undefined);
    }
    window.dispatchEvent(new CustomEvent('nativekitappbrowserpermissionresolved', {
      detail: { ...publicPendingPermission(request), action, ...(error ? { error: serializeError(error) } : {}) },
    }));
    if (error) request.reject(error); else request.resolve(action!);
    queueMicrotask(pumpPermissionQueue);
  }

  async function resolvePermissionRequest(requestId: string, action: AppBrowserPermissionAction): Promise<void> {
    if (!permissionAction(action)) throw new Error('Unknown permission action');
    const request = pendingPermissions.get(requestId);
    if (!request || request.settled) throw new Error('Permission request is no longer pending');
    if (Date.parse(request.expiresAt) <= Date.now()) {
      finishPermission(request, undefined, permissionFailure('PERMISSION_TIMEOUT', 'Native API permission request timed out'));
      return;
    }
    request.settled = true; // A request ID can be consumed exactly once, even if durable persistence is slow.
    try {
      const session = sessions.get(request.sessionId);
      if (!session || session.app.id !== request.appId || stoppingSessions.has(session.id)) throw permissionFailure('PERMISSION_CANCELLED', 'The requesting app session is no longer active');
      const current = await getApp(request.appId);
      if (current.integrity !== session.app.integrity) throw permissionFailure('PERMISSION_CANCELLED', 'The app package changed while permission was pending');
      if (action === 'allow_always' || action === 'block_always') {
        const policy = await getPolicy(current);
        if (!policy.enabled) throw permissionFailure('PERMISSION_CANCELLED', 'The app was disabled while permission was pending');
        policy.methodDecisions[request.method] = action === 'allow_always' ? 'allow' : 'block';
        const normalized = normalizePolicy({ ...policy, updatedAt: new Date().toISOString() });
        await idbPut('policies', normalized);
      }
      request.settled = false;
      finishPermission(request, action);
    } catch (error) {
      request.settled = false;
      finishPermission(request, undefined, error instanceof Error ? error : permissionFailure('PERMISSION_CANCELLED', String(error)));
      throw error;
    }
  }

  function pumpPermissionQueue(): void {
    if (activePermissionId) return;
    let request: PendingPermissionInternal | undefined;
    while (permissionQueue.length && !request) {
      const candidate = pendingPermissions.get(permissionQueue.shift()!);
      if (candidate && !candidate.settled) request = candidate;
    }
    if (!request) return;
    activePermissionId = request.requestId;
    const detail = publicPendingPermission(request);
    window.dispatchEvent(new CustomEvent('nativekitappbrowserpermissionrequest', { detail }));
    if (request.renderer === 'isolated' && nativeKit.isNative) {
      void NativeKitIsolatedBrowser.requestPermission({
        sessionId: request.sessionId,
        requestId: request.requestId,
        appName: request.appName,
        capability: request.capability,
        method: request.method,
        argumentSummary: request.argumentSummary,
        timeoutMs: Math.max(1_000, Date.parse(request.expiresAt) - Date.now()),
      }).then((result: { action: AppBrowserPermissionAction }) => resolvePermissionRequest(request!.requestId, result.action)).catch((error: unknown) => {
        const active = pendingPermissions.get(request!.requestId);
        if (active && !active.settled) finishPermission(active, undefined, permissionFailure('PERMISSION_UI_FAILED', `Trusted permission UI failed: ${serializeError(error).message}`));
      });
    }
  }

  function requestPermission(session: RpcSession, callId: number, capability: AppBrowserCapability, method: string, args: any[]): Promise<AppBrowserPermissionAction> {
    if (!permissionPrompts.enabled) return Promise.reject(permissionFailure('POLICY_DENIED', 'Call-time permission prompts are disabled'));
    const requestId = crypto.randomUUID();
    const now = Date.now();
    const timeoutMs = Math.min(110_000, Math.max(5_000, Number(permissionPrompts.requestTimeoutMs) || 90_000));
    return new Promise<AppBrowserPermissionAction>((resolve, reject) => {
      const request: PendingPermissionInternal = {
        requestId,
        appId: session.app.id,
        appName: session.app.manifest.name,
        sessionId: session.id,
        renderer: session.renderer,
        capability,
        method,
        argumentSummary: summarizePermissionArguments(args),
        requestedByManifest: session.app.manifest.requestedCapabilities.includes(capability),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + timeoutMs).toISOString(),
        callId,
        settled: false,
        resolve,
        reject,
      };
      request.timer = setTimeout(() => {
        if (pendingPermissions.get(requestId) === request && !request.settled) finishPermission(request, undefined, permissionFailure('PERMISSION_TIMEOUT', 'Native API permission request timed out'));
      }, timeoutMs);
      pendingPermissions.set(requestId, request);
      permissionQueue.push(requestId);
      pumpPermissionQueue();
    });
  }

  function cancelPendingPermissions(predicate: (request: PendingPermissionInternal) => boolean, message: string): void {
    for (const request of Array.from(pendingPermissions.values())) {
      if (predicate(request) && !request.settled) finishPermission(request, undefined, permissionFailure('PERMISSION_CANCELLED', message));
    }
  }

  async function authorize(session: RpcSession, callId: number, method: string, capability: AppBrowserCapability, args: any[], audit: AuditRecord): Promise<{ policy: AppPolicy; authorization: AuditRecord['authorization'] }> {
    let policy = await getPolicy(session.app);
    const decision = getAppBrowserPermissionDecision(policy, method, capability);
    if (decision === 'block') throw permissionFailure('POLICY_DENIED', `Native API blocked for ${session.app.id}: ${method}`);
    if (decision === 'allow') return { policy, authorization: 'stored_allow' };
    const pendingPromise = requestPermission(session, callId, capability, method, args);
    const pending = Array.from(pendingPermissions.values()).find((item) => item.sessionId === session.id && item.callId === callId);
    if (pending) audit.permissionRequestId = pending.requestId;
    const action = await pendingPromise;
    if (action === 'block_once' || action === 'block_always') throw permissionFailure(action === 'block_always' ? 'POLICY_BLOCKED_ALWAYS' : 'POLICY_BLOCKED_ONCE', `Native API blocked by the host: ${method}`);
    const active = sessions.get(session.id);
    const current = await getApp(session.app.id);
    if (active !== session || stoppingSessions.has(session.id) || current.integrity !== session.app.integrity) throw permissionFailure('PERMISSION_CANCELLED', 'The app session or package changed before permission could be used');
    policy = await getPolicy(current);
    const currentDecision = getAppBrowserPermissionDecision(policy, method, capability);
    if (!policy.enabled || currentDecision === 'block') throw permissionFailure('PERMISSION_CANCELLED', 'Permission was revoked before the native operation started');
    return { policy, authorization: action };
  }

  async function ensureNativeListeners(): Promise<void> {
    if (!nativeListenersReady) {
      const setup = (async () => {
        await Promise.all([
          NativeKitIsolatedBrowser.addListener('isolatedBrowserRequest', (event: any) => {
            const session = sessions.get(String(event.sessionId ?? ''));
            if (!session || session.renderer !== 'isolated' || event.appId !== session.app.id || event.token !== session.token || typeof event.origin !== 'string' || typeof event.request !== 'string') return;
            // The event origin is supplied by the authenticated native transport, never by page JSON.
            if (!session.nativeOrigin) session.nativeOrigin = event.origin;
            if (event.origin !== session.nativeOrigin) return;
            try {
              const message = boundedJson(JSON.parse(event.request), 2_097_152, 'Isolated RPC envelope') as any;
              if (message?.channel !== RPC_CHANNEL || message.direction !== 'request' || message.token !== session.token || !Number.isSafeInteger(message.id) || typeof message.method !== 'string') return;
              void execute(session, message.id, message.method, message.args);
            } catch { /* Malformed isolated messages fail closed in the native and host transports. */ }
          }),
          NativeKitIsolatedBrowser.addListener('isolatedBrowserStatus', (event: any) => {
            const sessionId = String(event.sessionId ?? '');
            const session = sessions.get(sessionId);
            if (!session || event.appId !== session.app.id) return;
            const state = String(event.state ?? 'unknown');
            if (state === 'netStats' && typeof event.reason === 'string') {
              try { const stats = JSON.parse(event.reason) as any; void absorbNativeNetStats(session.app.id, Number(stats?.add), (stats?.hosts && typeof stats.hosts === 'object') ? stats.hosts : {}); } catch { /* Malformed stats are ignored. */ }
            }
            window.dispatchEvent(new CustomEvent('nativekitappbrowserstatus', { detail: { sessionId, appId: session.app.id, renderer: 'isolated', state, reason: event.reason } }));
            if (state === 'rendererGone') {
              cancelPendingPermissions((request) => request.sessionId === sessionId, 'The requesting renderer failed');
              void runCleanupOperations(`Renderer failure cleanup for ${session.app.id} was incomplete`, [
                ['subscription cleanup', () => cleanupSessionSubscriptions(session)],
                ['native resource revocation', () => releaseOwnedNativeState(session.app.id)],
              ]).catch((error) => window.dispatchEvent(new CustomEvent('nativekitappbrowserstatus', { detail: { sessionId, appId: session.app.id, renderer: 'isolated', state: 'cleanupFailed', reason: serializeError(error).message } })));
            } else if (['closed', 'processGone'].includes(state) && !stoppingSessions.has(sessionId)) void stop(sessionId).catch(() => undefined);
          }),
          NativeKitIsolatedBrowser.addListener('remoteBrowserStatus', (event: any) => {
            const sessionId = String(event.sessionId ?? '');
            if (!remoteUrlSessions.has(sessionId)) return;
            const state = String(event.state ?? 'unknown');
            window.dispatchEvent(new CustomEvent('nativekitappbrowserurlstatus', { detail: { sessionId, mode: 'url', state, reason: String(event.reason ?? '') } }));
            if (['closed', 'failed'].includes(state)) remoteUrlSessions.delete(sessionId);
          }),
        ]);
      })();
      nativeListenersReady = setup.catch((error) => { nativeListenersReady = undefined; throw error; });
    }
    return nativeListenersReady;
  }

  async function stageNativeApp(app: InstalledApp): Promise<void> {
    const state = await NativeKitIsolatedBrowser.isStaged({ appId: app.id, integrity: app.integrity });
    if (state.staged) return;
    const stage = await NativeKitIsolatedBrowser.beginStage({ appId: app.id, integrity: app.integrity, entry: app.manifest.entry, fileCount: app.files.length, totalBytes: app.totalBytes });
    try {
      const chunkSize = config.isolated.stageChunkBytes;
      for (const file of app.files) {
        if (!file.bytes.length) {
          await NativeKitIsolatedBrowser.writeStageChunk({ stageId: stage.stageId, path: file.path, offset: 0, data: '', final: true });
          continue;
        }
        for (let offset = 0; offset < file.bytes.length; offset += chunkSize) {
          const next = Math.min(file.bytes.length, offset + chunkSize);
          await NativeKitIsolatedBrowser.writeStageChunk({
            stageId: stage.stageId,
            path: file.path,
            offset,
            data: bytesToBase64(file.bytes.subarray(offset, next)),
            final: next === file.bytes.length,
          });
        }
      }
      await NativeKitIsolatedBrowser.commitStage({ stageId: stage.stageId });
    } catch (error) {
      try { await NativeKitIsolatedBrowser.abortStage({ stageId: stage.stageId }); }
      catch (abortError) { throw new AggregateError([error, abortError], 'Native package staging and rollback failed'); }
      throw error;
    }
  }

  async function canUseNativeUrlRenderer(): Promise<boolean> {
    if (!config.urlMode?.enabled || !config.isolated.enabled || !nativeKit.isNative) return false;
    try {
      const info = await NativeKitIsolatedBrowser.runtimeInfo();
      if (!info.supported) return false;
      if (info.platform === 'android' && Number(info.apiLevel) < config.isolated.androidMinApi) return false;
      return true;
    } catch { return false; }
  }

  async function canUseIsolatedRenderer(): Promise<boolean> {
    if (config.renderer !== 'isolated' || !config.isolated.enabled || !nativeKit.isNative) return false;
    try {
      const info = await NativeKitIsolatedBrowser.runtimeInfo();
      if (!info.supported) return false;
      if (info.platform === 'android' && Number(info.apiLevel) < config.isolated.androidMinApi) return false;
      return true;
    } catch { return false; }
  }

  async function getApp(appId: string, loadFiles = true): Promise<InstalledApp> {
    const stored = await idbGet<StoredInstalledApp>('apps', appId);
    if (!stored) throw new Error(`Third-party app not found: ${appId}`);
    if (!loadFiles) return { ...stored, files: packageCache.get(appId)?.files ?? stored.files ?? [] };
    if (!nativeKit.isNative) return { ...stored, files: stored.files ?? [] };

    const cached = packageCache.get(appId);
    if (cached?.integrity === stored.integrity) return { ...stored, files: cached.files };
    let files: PackageFile[];
    if (stored.packageStorage === 'native-filesystem') {
      files = await readNativePackage(nativeKit, appId, stored.integrity);
    } else {
      // One-time migration of legacy IndexedDB packages. The native copy is
      // committed before the metadata stops referencing the web copy.
      files = stored.files ?? [];
      const legacyApp = { ...stored, files } as InstalledApp;
      await saveNativePackage(nativeKit, legacyApp);
      const { files: _legacyFiles, ...metadata } = legacyApp;
      await idbPut('apps', { ...metadata, fileCount: files.length, packageStorage: 'native-filesystem' } satisfies StoredInstalledApp);
    }
    packageCache.set(appId, { integrity: stored.integrity, files });
    return { ...stored, files, fileCount: files.length, packageStorage: undefined } as InstalledApp;
  }
  function artifactOwner(app: AppMetadata): NativeArtifactOwner {
    return { type: 'mini-app', id: app.id, name: app.manifest.name, version: app.manifest.version };
  }
  function hostArtifactOwner(): NativeArtifactOwner {
    return { type: 'host', id: nativeKit.config.app.id, name: nativeKit.config.app.name, version: nativeKit.config.app.versionName };
  }
  async function resolveArtifactOwner(sourceType: unknown, appId?: string): Promise<NativeArtifactOwner> {
    if (sourceType === 'host') return hostArtifactOwner();
    if (sourceType !== 'mini-app') throw new Error("Artifact sourceType must be 'mini-app' or 'host'");
    return artifactOwner(await getApp(String(appId ?? ''), false));
  }
  function registerArtifactBrokerMethods(): void {
    const definitions: Array<[string, NativeArtifactKind, 'miniUI' | 'floatingUI' | 'homeWidget']> = [
      ['miniUI', 'mini-ui', 'miniUI'],
      ['floatingUI', 'floating-ui', 'floatingUI'],
      ['homeWidget', 'home-widget', 'homeWidget'],
    ];
    for (const [group, kind, capability] of definitions) {
      methods[`${group}.publish`] = { capability, run: async (ctx, [input]) => artifactManager.publish(artifactOwner(ctx.app), kind, input ?? {}) };
      methods[`${group}.list`] = { capability, run: async (ctx) => ({ artifacts: await artifactManager.list(artifactOwner(ctx.app), kind) }) };
      methods[`${group}.get`] = { capability, run: async (ctx, [id]) => artifactManager.read(artifactOwner(ctx.app), kind, String(id ?? 'main')) };
      methods[`${group}.remove`] = { capability, run: async (ctx, [id]) => artifactManager.remove(artifactOwner(ctx.app), kind, String(id ?? 'main')) };
    }
    methods['floatingUI.checkPermission'] = { capability: 'floatingUI', run: async () => artifactManager.checkFloatingPermission() };
    methods['floatingUI.requestPermission'] = { capability: 'floatingUI', run: async () => artifactManager.requestFloatingPermission() };
    methods['floatingUI.show'] = { capability: 'floatingUI', run: async (ctx, [id]) => artifactManager.showFloating(artifactOwner(ctx.app), String(id ?? 'main')) };
    methods['floatingUI.hide'] = { capability: 'floatingUI', run: async (ctx, [id]) => { await artifactManager.hideFloating(artifactOwner(ctx.app), id == null ? undefined : String(id)); return { hidden: true }; } };
    methods['homeWidget.activate'] = { capability: 'homeWidget', run: async (ctx, [id]) => artifactManager.activateHomeWidget(artifactOwner(ctx.app), String(id ?? 'main')) };
    methods['homeWidget.requestPin'] = { capability: 'homeWidget', run: async (ctx, [id]) => artifactManager.requestPinHomeWidget(artifactOwner(ctx.app), String(id ?? 'main')) };
  }
  registerArtifactBrokerMethods();

  async function getPolicy(app: AppMetadata): Promise<AppPolicy> {
    const stored = await idbGet<AppPolicy>('policies', app.id);
    if (stored) {
      const migrated = normalizePolicy(stored);
      if (!stored.capabilityDecisions || !stored.methodDecisions) await idbPut('policies', migrated);
      return migrated;
    }
    const capabilityDecisions = Object.fromEntries(APP_BROWSER_CAPABILITIES.map((capability) => {
      const requested = app.manifest.requestedCapabilities.includes(capability);
      const configured = config.defaultCapabilities.includes(capability) && requested
        ? 'allow'
        : requested ? permissionPrompts.requestedCapabilityDefault : permissionPrompts.unrequestedCapabilityDefault;
      return [capability, validPermissionDecision(configured) ? configured : requested ? 'ask' : 'block'];
    })) as Record<string, AppBrowserPermissionDecision>;
    return normalizePolicy({
      appId: app.id,
      enabled: true,
      grants: Object.fromEntries(APP_BROWSER_CAPABILITIES.map((capability) => [capability, capabilityDecisions[capability] === 'allow'])),
      methodOverrides: {},
      capabilityDecisions,
      methodDecisions: {},
      allowedHosts: app.manifest.allowedHosts,
      networkMode: normalizeAppBrowserNetworkMode(app.manifest.networkMode),
      mediaAutoplay: false,
      colorScheme: normalizeAppBrowserColorScheme(app.manifest.colorScheme),
      updatedAt: new Date().toISOString(),
    });
  }
  async function saveAudit(record: AuditRecord, notify = true): Promise<void> {
    const key = await idbPut('audit', record);
    if (record.id == null && typeof key === 'number') record.id = key;
    const rows = await idbGetAll<AuditRecord>('audit');
    const overflow = rows.length - config.auditLogLimit;
    if (overflow > 0) for (const row of rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).slice(0, overflow)) if (row.id != null) await idbDelete('audit', row.id);
    if (notify) window.dispatchEvent(new CustomEvent('nativekitappbrowseraudit', { detail: record }));
  }
  function withinRateLimit(session: RpcSession): boolean {
    const now = Date.now(); session.requests = session.requests.filter((value) => value > now - 60_000);
    if (session.requests.length >= config.maxRequestsPerMinute) return false;
    session.requests.push(now); return true;
  }
  function post(session: RpcSession, message: Record<string, any>): void {
    const payload = boundedRpcPayload({ channel: RPC_CHANNEL, token: session.token, ...message });
    if (session.renderer === 'isolated') {
      void NativeKitIsolatedBrowser.postMessage({ sessionId: session.id, message: JSON.stringify(payload) }).catch(() => undefined);
    } else {
      session.frame?.contentWindow?.postMessage(payload, '*');
    }
  }
  async function execute(session: RpcSession, id: number, method: string, args: any[]): Promise<void> {
    const started = performance.now();
    let auditedMethod = method.slice(0, 200);
    let capability = 'broker'; let outcome: AuditOutcome = 'error'; let errorText: string | undefined; let errorCode: string | undefined;
    const auditRecord: AuditRecord = {
      appId: session.app.id,
      appName: session.app.manifest.name,
      capability,
      method: auditedMethod,
      outcome,
      timestamp: new Date().toISOString(),
      durationMs: 0,
      error: 'OUTCOME_PENDING',
    };
    let auditInitialized = false;
    try {
      // Persist invocation ownership before prompting or performing any brokered native side effect.
      await runWithDurablePrecondition(
        () => saveAudit(auditRecord, false),
        async () => {
          auditInitialized = true;
          args = boundedJson(Array.isArray(args) ? args : [], 2_097_152, 'RPC arguments') as any[];
          if (!withinRateLimit(session)) { outcome = 'rate_limited'; throw permissionFailure('RATE_LIMITED', 'Third-party native API rate limit exceeded'); }
          let policy = await getPolicy(session.app);
          if (method === '@capabilities') {
            auditRecord.authorization = 'control';
            post(session, { direction: 'response', id, ok: true, result: {
              appEnabled: policy.enabled,
              grants: policy.grants,
              methodOverrides: policy.methodOverrides,
              capabilityDecisions: policy.capabilityDecisions,
              methodDecisions: policy.methodDecisions,
              allowedHosts: policy.allowedHosts,
            } });
            outcome = 'success'; return;
          }
          if (method === '@unsubscribe') {
            auditRecord.authorization = 'control';
            const subId = String(args[0] ?? ''); const sub = session.subscriptions.get(subId); await sub?.remove(); session.subscriptions.delete(subId);
            post(session, { direction: 'response', id, ok: true, result: {} }); outcome = 'success'; return;
          }
          if (method === '@subscribe') {
            const eventName = String(args[0] ?? ''); const options = args[1] ?? {};
            auditedMethod = eventName === 'location.watch' || eventName === 'http.stream' ? eventName : `events.${eventName}`;
            const subscriptionCapabilities: Record<string, AppBrowserCapability> = {
              'location.watch': 'location', 'http.stream': 'http', 'network.change': 'networkStatus',
              'app.stateChange': 'appInfo', 'backgroundLocation.location': 'backgroundLocation',
              'alarms.fired': 'alarms', 'notifications.received': 'notifications', 'notifications.action': 'notifications',
              'push.received': 'pushNotifications', 'push.action': 'pushNotifications',
            };
            const subscriptionCapability = subscriptionCapabilities[eventName];
            if (!subscriptionCapability) throw new Error(`Subscription is not exposed to App Browser: ${eventName}`);
            capability = subscriptionCapability;
            const globalFeature = globalFeatureMap[subscriptionCapability];
            if (globalFeature && nativeKit.config.features[globalFeature] !== true) throw new Error(`Global NativeKit feature is disabled: ${globalFeature}`);
            if (eventName === 'http.stream' && nativeKit.config.features.nativeSSE !== true) throw new Error('Global NativeKit nativeSSE feature is disabled');
            const authorized = await authorize(session, id, auditedMethod, subscriptionCapability, [options], auditRecord);
            policy = authorized.policy; auditRecord.authorization = authorized.authorization;
            const subscription = await subscribe(session, policy, eventName, options);
            capability = subscription.capability;
            post(session, { direction: 'response', id, ok: true, result: { subscriptionId: subscription.id } }); outcome = 'success'; return;
          }
          if (!METHOD_RE.test(method) || !methods[method]) throw new Error(`Native API is not exposed to App Browser: ${method}`);
          const definition = methods[method]; capability = definition.capability;
          const globalFeature = globalFeatureMap[definition.capability];
          if (globalFeature && nativeKit.config.features[globalFeature] !== true) throw new Error(`Global NativeKit feature is disabled: ${globalFeature}`);
          const authorized = await authorize(session, id, method, definition.capability, args, auditRecord);
          policy = authorized.policy; auditRecord.authorization = authorized.authorization;
          const result = await definition.run({ app: session.app, policy }, args);
          post(session, { direction: 'response', id, ok: true, result }); outcome = 'success';
        },
      );
    } catch (error) {
      const serialized = serializeError(error);
      errorText = serialized.message; errorCode = serialized.code;
      if (errorCode === 'PERMISSION_TIMEOUT') outcome = 'timeout';
      else if (errorCode === 'PERMISSION_CANCELLED' || errorCode === 'PERMISSION_UI_FAILED') outcome = 'cancelled';
      else if (errorCode === 'RATE_LIMITED') outcome = 'rate_limited';
      else if (outcome === 'error' && (/denied|disabled|not exposed|not allowed|blocked/i.test(errorText) || /^POLICY_/.test(errorCode ?? ''))) outcome = 'denied';
      post(session, { direction: 'response', id, ok: false, error: serialized });
    } finally {
      if (auditInitialized) {
        const finalOutcome = String(outcome) as AuditOutcome;
        const auditError = finalOutcome === 'success' ? undefined
          : finalOutcome === 'denied' ? errorCode ?? 'POLICY_DENIED'
          : finalOutcome === 'rate_limited' ? 'RATE_LIMITED'
          : finalOutcome === 'timeout' ? 'PERMISSION_TIMEOUT'
          : finalOutcome === 'cancelled' ? errorCode ?? 'PERMISSION_CANCELLED'
          : 'CALL_FAILED';
        Object.assign(auditRecord, {
          capability,
          method: auditedMethod.slice(0, 200),
          outcome: finalOutcome,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
        });
        if (auditError) auditRecord.error = auditError; else delete auditRecord.error;
        // If this outcome update fails, the durable OUTCOME_PENDING invocation record remains.
        await saveAudit(auditRecord).catch(() => undefined);
      }
    }
  }
  async function subscribe(session: RpcSession, policy: AppPolicy, eventName: string, options: any): Promise<{ id: string; capability: AppBrowserCapability }> {
    const id = crypto.randomUUID();
    const emit = (payload: any) => {
      try { post(session, { direction: 'event', subscriptionId: id, payload }); }
      catch {
        try { post(session, { direction: 'event', subscriptionId: id, payload: { type: 'error', error: { name: 'PayloadLimitError', message: 'Native event exceeded the App Browser payload limit' } } }); }
        catch { /* The frame may already be gone. */ }
      }
    };
    let capability: AppBrowserCapability; let handle: any;
    const listenerTable: Record<string, { capability: AppBrowserCapability; setup: () => Promise<any> }> = {
      'network.change': { capability: 'networkStatus', setup: () => nativeKit.network.onChange((payload: any) => emit(sanitizeNetworkStatus(payload))) },
      'app.stateChange': { capability: 'appInfo', setup: () => nativeKit.app.onStateChange((payload: any) => emit(sanitizeAppState(payload))) },
      'backgroundLocation.location': { capability: 'backgroundLocation', setup: () => nativeKit.backgroundLocation.onLocation((payload: any) => { if (backgroundLocationOwner === session.app.id) emit(sanitizeBackgroundLocationPoint(payload)); }) },
      'alarms.fired': { capability: 'alarms', setup: () => nativeKit.alarms.onFired((payload: any) => {
        const prefix = `${session.app.id}:`;
        if (String(payload?.id ?? '').startsWith(prefix)) emit({ id: String(payload.id).slice(prefix.length) });
      }) },
      'notifications.received': { capability: 'notifications', setup: () => nativeKit.notifications.onReceived((payload: any) => {
        if (payload?.extra?.nativeKitAppBrowserId === session.app.id) emit({
          id: boundedString(payload.extra.logicalId, 80, 'Notification id'),
          title: boundedString(payload.title, 200, 'Notification title'),
          body: boundedString(payload.body, 2_000, 'Notification body'),
          ...(sanitizeNotificationEventSchedule(payload.schedule) ? { schedule: sanitizeNotificationEventSchedule(payload.schedule) } : {}),
        });
      }) },
      'notifications.action': { capability: 'notifications', setup: () => nativeKit.notifications.onAction((payload: any) => {
        const notification = payload?.notification;
        if (notification?.extra?.nativeKitAppBrowserId === session.app.id) emit({
          actionId: boundedString(payload?.actionId, 100, 'Notification action id'),
          ...(payload?.inputValue == null ? {} : { inputValue: boundedString(payload.inputValue, 4_000, 'Notification action input') }),
          notification: {
            id: boundedString(notification.extra.logicalId, 80, 'Notification id'),
            title: boundedString(notification.title, 200, 'Notification title'),
            body: boundedString(notification.body, 2_000, 'Notification body'),
          },
        });
      }) },
      'push.received': { capability: 'pushNotifications', setup: () => nativeKit.push.onReceived((payload: any) => {
        if (payload?.data?.nativeKitAppBrowserId === session.app.id) emit(sanitizePushNotification(payload));
      }) },
      'push.action': { capability: 'pushNotifications', setup: () => nativeKit.push.onAction((payload: any) => {
        if (payload?.notification?.data?.nativeKitAppBrowserId === session.app.id) emit({
          actionId: boundedString(payload?.actionId, 100, 'Push action id'),
          ...(payload?.inputValue == null ? {} : { inputValue: boundedString(payload.inputValue, 4_000, 'Push action input') }),
          notification: sanitizePushNotification(payload.notification),
        });
      }) },
    };
    if (eventName === 'location.watch') {
      capability = 'location';
      if (nativeKit.config.features.location !== true) throw new Error('Global NativeKit location feature is disabled');
      handle = await nativeKit.location.watch((position: any, error: any) => emit({ position: position == null ? null : sanitizePosition(position), ...(error ? { error: serializeError(error) } : {}) }), sanitizeGeolocationOptions(options));
    } else if (eventName === 'http.stream') {
      capability = 'http';
      if (nativeKit.config.features.nativeSSE !== true) throw new Error('Global NativeKit nativeSSE feature is disabled');
      const streamMethod = ['GET', 'POST'].includes(String(options?.method).toUpperCase()) ? String(options.method).toUpperCase() : 'GET';
      const checked = {
        url: checkAppUrl({ app: session.app, policy }, options?.url),
        method: streamMethod,
        headers: sanitizeHeaders(options?.headers),
        body: options?.body == null ? undefined : boundedString(options.body, 1_048_576, 'Stream body'),
        format: ['sse', 'text', 'ndjson'].includes(options?.format) ? options.format : 'sse',
        disableRedirects: true,
      };
      handle = await nativeKit.http.stream(checked, {
        onMessage: (payload: any) => emit({ type: 'message', payload: {
          data: boundedString(payload?.data, 1_048_576, 'Stream message'),
          ...(payload?.event == null ? {} : { event: boundedString(payload.event, 200, 'Stream event') }),
          ...(payload?.id == null ? {} : { id: boundedString(payload.id, 500, 'Stream event id') }),
          format: ['sse', 'text', 'ndjson'].includes(payload?.format) ? payload.format : checked.format,
        } }),
        onError: (error: any) => emit({ type: 'error', payload: serializeError(error) }),
        onEnd: (payload: any) => emit({ type: 'end', payload: payload?.status == null ? {} : { status: Math.trunc(finiteNumber(payload.status, 'stream status')) } }),
      });
      handle = { remove: () => handle.close() };
    } else {
      const item = listenerTable[eventName]; if (!item) throw new Error(`Unsupported subscription: ${eventName}`);
      capability = item.capability;
      const globalFeature = globalFeatureMap[capability];
      if (globalFeature && nativeKit.config.features[globalFeature] !== true) throw new Error(`Global NativeKit feature is disabled: ${globalFeature}`);
      handle = await item.setup();
    }
    session.subscriptions.set(id, { ...handle, capability, method: eventName === 'location.watch' || eventName === 'http.stream' ? eventName : `events.${eventName}` });
    return { id, capability };
  }

  async function installPackage(inputFiles: PackageFile[], options: Record<string, any> = {}): Promise<Record<string, any>> {
    if (!config.enabled) throw new Error('App Browser is disabled in app.config.json');
    let files = stripCommonRoot(inputFiles.map((file) => ({ ...file, path: normalizePath(file.path), type: file.type || mimeType(file.path) })));
    const unique = new Set<string>(); let totalBytes = 0;
    for (const file of files) { if (unique.has(file.path)) throw new Error(`Duplicate package path: ${file.path}`); unique.add(file.path); totalBytes += file.bytes.length; }
    if (!files.length || files.length > config.maxFiles) throw new Error(`Package must contain 1–${config.maxFiles} files`);
    if (totalBytes > config.maxPackageBytes) throw new Error(`Package exceeds ${config.maxPackageBytes} bytes`);
    const installed = await idbGetAll<StoredInstalledApp>('apps');
    const integrity = await sha256(files);
    const manifest = parseManifest(files, options, integrity);
    const existing = await idbGet<StoredInstalledApp>('apps', manifest.id);
    if (!existing && installed.length >= config.maxApps) throw new Error(`At most ${config.maxApps} third-party apps can be installed`);
    const now = new Date().toISOString();
    const app: InstalledApp = { id: manifest.id, manifest, files, integrity, totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), installedAt: existing?.installedAt ?? now, updatedAt: now };
    const integrityChanged = !!existing && existing.integrity !== integrity;
    let policy = await idbGet<AppPolicy>('policies', app.id);
    if (!policy) policy = await getPolicy(app);
    else {
      policy = normalizePolicy(policy);
      policy.allowedHosts = policy.allowedHosts.filter((host) => manifest.allowedHosts.includes(host));
    }
    // Package IDs are not signatures. A changed package must be reviewed and explicitly re-enabled.
    if (integrityChanged) {
      cancelPendingPermissions((request) => request.appId === app.id, 'The app package was replaced while permission was pending');
      policy.enabled = false;
    }
    policy.updatedAt = now;
    // Commit changed bytes and their disabled policy atomically so a crash cannot launch new code under an old enabled policy.
    await saveInstalledAppAndPolicy(app, policy, nativeKit);
    packageCache.set(app.id, { integrity: app.integrity, files: app.files });
    if (existing && integrityChanged && nativeKit.isNative) {
      // The new commit is already durable. An old, unreachable package may be
      // removed afterwards without putting the newly installed app at risk.
      try { await deleteNativePackage(nativeKit, app.id, existing.integrity); } catch { /* Orphan cleanup can be retried on removal. */ }
    }
    if (integrityChanged) {
      await runCleanupOperations(`Changed package ${app.id} was disabled, but some active resources could not be revoked`, [
        ['session shutdown', () => stopAppSessions(app.id)],
        ['native resource revocation', () => releaseOwnedNativeState(app.id)],
        ['UI artifact deactivation', () => artifactManager.deactivateOwner(artifactOwner(app))],
      ]);
    }
    return publicApp(app, policy);
  }

  async function installFromFiles(source: FileList | File[], options: Record<string, any> = {}): Promise<Record<string, any>> {
    const browserFiles = Array.from(source as ArrayLike<File>);
    if (browserFiles.length === 1 && /\.zip$/i.test(browserFiles[0].name)) return installFromZip(browserFiles[0], options);
    const files: PackageFile[] = [];
    for (const file of browserFiles) files.push({ path: file.webkitRelativePath || file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || mimeType(file.name) });
    return installPackage(files, options);
  }

  async function installFromZip(file: Blob, options: Record<string, any> = {}): Promise<Record<string, any>> {
    if (file.size > config.maxPackageBytes) throw new Error('Compressed ZIP exceeds package byte limit');
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertZipMetadata(bytes, config.maxFiles, config.maxPackageBytes);
    const unpacked = unzipSync(bytes);
    const files = Object.entries(unpacked).filter(([path]) => !path.endsWith('/')).map(([path, data]) => ({ path, bytes: data, type: mimeType(path) }));
    return installPackage(files, options);
  }

  const cleanupError = (label: string, error: unknown): Error => new Error(`${label}: ${serializeError(error).message}`);
  const throwCleanupErrors = (errors: Error[], message: string): void => { if (errors.length) throw new AggregateError(errors, message); };

  async function deleteOwnedDatabases(appId: string): Promise<void> {
    const errors: Error[] = [];
    const resources = (await idbGetAll<NativeResource>('resources')).filter((item): item is Extract<NativeResource, { kind: 'database' }> => item.kind === 'database' && item.appId === appId);
    for (const resource of resources) {
      configuredDatabases.delete(resource.nativeName);
      try {
        try { await nativeKit.sqlite.delete(resource.nativeName); }
        catch (error) { if (!isMissingResourceError(error)) throw error; }
        await idbDelete('resources', resource.id);
      } catch (error) { errors.push(cleanupError(`database ${resource.logicalId}`, error)); }
    }
    throwCleanupErrors(errors, `One or more databases owned by ${appId} could not be deleted`);
  }

  async function deleteOwnedStorageAndFiles(appId: string): Promise<void> {
    const errors: Error[] = [];
    const prefix = `nativekit.appBrowser.${appId}.`;
    const resources = (await idbGetAll<NativeResource>('resources')).filter((item) => item.appId === appId);
    const preferenceTargets = new Map(resources.filter((item): item is Extract<NativeResource, { kind: 'preference' }> => item.kind === 'preference').map((item) => [item.nativeKey, item]));
    try {
      const preferenceKeys = await nativeKit.preferences.keys();
      for (const key of preferenceKeys?.keys ?? []) if (String(key).startsWith(prefix) && !preferenceTargets.has(String(key))) preferenceTargets.set(String(key), undefined as any);
    } catch (error) { errors.push(cleanupError('preference key enumeration', error)); }
    for (const [nativeKey, resource] of preferenceTargets) {
      try { await nativeKit.preferences.remove(nativeKey); if (resource) await idbDelete('resources', resource.id); }
      catch (error) { errors.push(cleanupError(`preference ${nativeKey}`, error)); }
    }
    for (const resource of resources.filter((item): item is Extract<NativeResource, { kind: 'secure' }> => item.kind === 'secure')) {
      try { await nativeKit.secureStorage.remove(resource.nativeKey); await idbDelete('resources', resource.id); }
      catch (error) { errors.push(cleanupError(`secure-storage key ${resource.logicalId}`, error)); }
    }
    if (nativeKit.config.features.filesystem === true) for (const directory of ['Data', 'Cache']) {
      try { await nativeKit.filesystem.rmdir({ directory, path: safeRelativeDataPath(appId, ''), recursive: true }); }
      catch (error) { if (!isMissingResourceError(error)) errors.push(cleanupError(`${directory} filesystem root`, error)); }
    }
    throwCleanupErrors(errors, `One or more storage resources owned by ${appId} could not be deleted`);
  }

  async function releaseOwnedNativeState(appId: string, capability?: AppBrowserCapability): Promise<void> {
    const errors: Error[] = [];
    if ((!capability || capability === 'backgroundLocation') && backgroundLocationOwner === appId) {
      try { await nativeKit.backgroundLocation.stop(); backgroundLocationOwner = null; }
      catch (error) { errors.push(cleanupError('background-location stop', error)); }
    }
    try { await releaseScheduledSandboxState(nativeKit, appId, capability); }
    catch (error) {
      if (error instanceof AggregateError) errors.push(...error.errors.map((item) => item instanceof Error ? item : cleanupError('scheduled-resource cleanup', item)));
      else errors.push(cleanupError('scheduled-resource cleanup', error));
    }
    throwCleanupErrors(errors, `One or more active native resources owned by ${appId} could not be revoked`);
  }

  async function cleanupSessionSubscriptions(session: RpcSession): Promise<void> {
    const errors: Error[] = [];
    for (const [subscriptionId, subscription] of session.subscriptions) {
      try { await Promise.resolve(subscription.remove()); session.subscriptions.delete(subscriptionId); }
      catch (error) { errors.push(cleanupError(`subscription ${subscription.method}`, error)); }
    }
    throwCleanupErrors(errors, `One or more subscriptions for ${session.app.id} could not be removed`);
  }

  async function stopRemoteUrl(sessionId: string): Promise<void> {
    const session = remoteUrlSessions.get(sessionId);
    if (!session) return;
    remoteUrlSessions.delete(sessionId);
    if (session.native) await NativeKitIsolatedBrowser.closeUrl({ sessionId });
    else if (session.window && !session.window.closed) session.window.close();
  }

  async function stop(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId); if (!session || stoppingSessions.has(sessionId)) return;
    stoppingSessions.add(sessionId);
    cancelPendingPermissions((request) => request.sessionId === sessionId, 'The requesting app session was closed');
    const errors: Error[] = [];
    try {
      try { await cleanupSessionSubscriptions(session); }
      catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors.map((item) => item instanceof Error ? item : cleanupError('subscription cleanup', item)));
        else errors.push(cleanupError('subscription cleanup', error));
      }
      if (session.renderer === 'isolated') {
        try { await NativeKitIsolatedBrowser.close({ sessionId }); }
        catch (error) { errors.push(cleanupError('isolated renderer close', error)); }
      }
      session.frame?.remove();
      const hasAnotherAppSession = Array.from(sessions.values()).some((candidate) => candidate.id !== sessionId && candidate.app.id === session.app.id);
      if (!hasAnotherAppSession) {
        try { await releaseOwnedNativeState(session.app.id); }
        catch (error) {
          if (error instanceof AggregateError) errors.push(...error.errors.map((item) => item instanceof Error ? item : cleanupError('native resource revocation', item)));
          else errors.push(cleanupError('native resource revocation', error));
        }
      }
      if (!errors.length) sessions.delete(sessionId);
    } finally { stoppingSessions.delete(sessionId); }
    throwCleanupErrors(errors, `One or more resources for ${session.app.id} could not be removed`);
  }

  async function runCleanupOperations(message: string, operations: Array<[string, () => Promise<void>]>): Promise<void> {
    const errors: Error[] = [];
    for (const [label, operation] of operations) {
      try { await operation(); }
      catch (error) { errors.push(cleanupError(label, error)); }
    }
    throwCleanupErrors(errors, message);
  }

  async function stopAppSessions(appId: string): Promise<void> {
    const appSessions = Array.from(sessions.values()).filter((item) => item.app.id === appId);
    await runCleanupOperations(`One or more sessions for ${appId} could not be stopped`, appSessions.map((session) => [`session ${session.id}`, () => stop(session.id)]));
  }

  async function appUsage(appId: string): Promise<Record<string, any>> {
    await getApp(appId);
    const resources = (await idbGetAll<NativeResource>('resources')).filter((item) => item.appId === appId);
    const appSessions = Array.from(sessions.values()).filter((item) => item.app.id === appId);
    const filesystem = nativeKit.config.features.filesystem === true ? await sandboxFilesystemUsage(nativeKit, appId) : null;
    let notifications: number | null = null;
    if (nativeKit.config.features.localNotifications === true) {
      const [pending, delivered] = await Promise.all([nativeKit.notifications.pending(), nativeKit.notifications.delivered()]);
      const logicalIds = new Set<string>();
      for (const item of [...(pending?.notifications ?? []), ...(delivered?.notifications ?? [])]) {
        if (item?.extra?.nativeKitAppBrowserId === appId) logicalIds.add(String(item.extra.logicalId));
      }
      notifications = logicalIds.size;
    }
    let alarms: number | null = null;
    if (nativeKit.config.features.advancedAlarms === true) {
      const result = await nativeKit.alarms.list();
      alarms = (result?.alarms ?? []).filter((item: any) => item?.extra?.nativeKitAppBrowserId === appId).length;
    }
    return {
      appId,
      storage: {
        preferenceKeys: resources.filter((item) => item.kind === 'preference').length,
        secureStorageKeys: resources.filter((item) => item.kind === 'secure').length,
        databases: resources.filter((item) => item.kind === 'database').length,
        filesystem,
      },
      scheduled: { notifications, alarms },
      active: {
        sessions: appSessions.length,
        subscriptions: appSessions.reduce((total, session) => total + session.subscriptions.size, 0),
        backgroundLocation: backgroundLocationOwner === appId,
      },
    };
  }

  async function cleanupApp(appId: string): Promise<void> {
    await getApp(appId);
    cancelPendingPermissions((request) => request.appId === appId, 'The host cleaned up resources for the requesting app');
    await runCleanupOperations(`One or more resources for ${appId} could not be cleaned; retry after resolving the reported native cleanup failures`, [
      ['session shutdown', () => stopAppSessions(appId)],
      ['native resource revocation', () => releaseOwnedNativeState(appId)],
      ['database deletion', () => deleteOwnedDatabases(appId)],
      ['storage and filesystem deletion', () => deleteOwnedStorageAndFiles(appId)],
    ]);
    await deleteAppResources(appId);
  }

  async function removeSubscriptions(appId: string, predicate: (subscription: RpcSubscription) => boolean): Promise<void> {
    const errors: Error[] = [];
    for (const session of Array.from(sessions.values()).filter((item) => item.app.id === appId)) {
      for (const [id, subscription] of session.subscriptions) if (predicate(subscription)) {
        try { await Promise.resolve(subscription.remove()); session.subscriptions.delete(id); }
        catch (error) { errors.push(cleanupError(`subscription ${subscription.method}`, error)); }
      }
    }
    throwCleanupErrors(errors, `One or more subscriptions for ${appId} could not be revoked`);
  }

  const subscriptionMethods = new Set(['location.watch', 'http.stream', 'events.network.change', 'events.app.stateChange', 'events.backgroundLocation.location', 'events.alarms.fired', 'events.notifications.received', 'events.notifications.action', 'events.push.received', 'events.push.action']);

  function assertExposedMethod(method: string): void {
    if (!METHOD_RE.test(method) || (!methods[method] && !subscriptionMethods.has(method))) throw new Error('Method is not exposed by App Browser');
  }

  async function setCapabilityDecision(appId: string, capability: AppBrowserCapability, decision: AppBrowserPermissionDecision): Promise<AppPolicy> {
    if (!APP_BROWSER_CAPABILITIES.includes(capability)) throw new Error(`Unknown capability: ${capability}`);
    if (!validPermissionDecision(decision)) throw new Error('Capability decision must be ask, allow, or block');
    cancelPendingPermissions((request) => request.appId === appId && request.capability === capability, `Capability ${capability} policy changed while permission was pending`);
    const app = await getApp(appId); const policy = await getPolicy(app);
    policy.capabilityDecisions[capability] = decision;
    const normalized = normalizePolicy({ ...policy, updatedAt: new Date().toISOString() });
    await idbPut('policies', normalized);
    if (decision !== 'allow') await runCleanupOperations(`Capability ${capability} was revoked, but some active resources could not be released`, [
      ['subscription revocation', () => removeSubscriptions(appId, (subscription) => subscription.capability === capability)],
      ['native resource revocation', () => releaseOwnedNativeState(appId, capability)],
      ...((capability === 'miniUI' || capability === 'floatingUI' || capability === 'homeWidget')
        ? [['UI artifact deactivation', () => artifactManager.deactivateOwner(artifactOwner(app), capability === 'miniUI' ? 'mini-ui' : capability === 'floatingUI' ? 'floating-ui' : 'home-widget')] as [string, () => Promise<void>]] : []),
    ]);
    return normalized;
  }

  async function setMethodDecision(appId: string, method: string, decision: AppBrowserPermissionDecision | 'inherit'): Promise<AppPolicy> {
    assertExposedMethod(method);
    if (decision !== 'inherit' && !validPermissionDecision(decision)) throw new Error('Method decision must be inherit, ask, allow, or block');
    cancelPendingPermissions((request) => request.appId === appId && request.method === method, `Method ${method} policy changed while permission was pending`);
    const app = await getApp(appId); const policy = await getPolicy(app);
    if (decision === 'inherit') delete policy.methodDecisions[method]; else policy.methodDecisions[method] = decision;
    const normalized = normalizePolicy({ ...policy, updatedAt: new Date().toISOString() });
    await idbPut('policies', normalized);
    if (decision === 'ask' || decision === 'block') {
      const resourceCapability = method === 'backgroundLocation.start' ? 'backgroundLocation' : method === 'notifications.schedule' ? 'notifications' : method === 'alarms.schedule' ? 'alarms' : undefined;
      const operations: Array<[string, () => Promise<void>]> = [['subscription revocation', () => removeSubscriptions(appId, (subscription) => subscription.method === method)]];
      if (resourceCapability) operations.push(['native resource revocation', () => releaseOwnedNativeState(appId, resourceCapability)]);
      if (method === 'floatingUI.show') operations.push(['floating artifact deactivation', () => artifactManager.deactivateOwner(artifactOwner(app), 'floating-ui')]);
      if (method === 'homeWidget.activate' || method === 'homeWidget.requestPin') operations.push(['home widget artifact deactivation', () => artifactManager.deactivateOwner(artifactOwner(app), 'home-widget')]);
      await runCleanupOperations(`Method ${method} was revoked, but some active resources could not be released`, operations);
    }
    return normalized;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.channel !== RPC_CHANNEL || message.direction !== 'request' || typeof message.token !== 'string') return;
    const session = Array.from(sessions.values()).find((item) => {
      if (item.renderer !== 'iframe' || !item.frame) return false;
      return item.token === message.token && event.source === item.frame.contentWindow;
    });
    if (!session || !Number.isSafeInteger(message.id) || typeof message.method !== 'string') return;
    void execute(session, message.id, message.method, message.args);
  });

  const artifactHostSurface = Object.freeze({
    kinds: ARTIFACT_KINDS,
    limits: Object.freeze({ ...NATIVE_ARTIFACT_LIMITS, maxActiveHomeWidgets: artifactManager.limits.maxActiveHomeWidgets, slotPrefix: MINI_APP_HOME_WIDGET_SLOT_PREFIX }),
    storage: 'native-filesystem',
    publish: (kind: NativeArtifactKind, input: Record<string, any>) => artifactManager.publish(hostArtifactOwner(), kind, input as any),
    list: async (filter: { sourceType?: 'mini-app' | 'host'; appId?: string; kind?: NativeArtifactKind } = {}) => {
      let owners: NativeArtifactOwner[];
      if (filter.sourceType || filter.appId) owners = [await resolveArtifactOwner(filter.sourceType ?? 'mini-app', filter.appId)];
      else owners = [hostArtifactOwner(), ...(await idbGetAll<StoredInstalledApp>('apps')).map(artifactOwner)];
      const nested = await Promise.all(owners.map((owner) => artifactManager.list(owner, filter.kind)));
      return nested.flat();
    },
    read: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; kind: NativeArtifactKind; artifactId: string }) => artifactManager.read(await resolveArtifactOwner(input.sourceType ?? 'mini-app', input.appId), input.kind, input.artifactId),
    remove: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; kind: NativeArtifactKind; artifactId: string }) => artifactManager.remove(await resolveArtifactOwner(input.sourceType ?? 'mini-app', input.appId), input.kind, input.artifactId),
    removeOwner: async (appId: string) => artifactManager.removeOwner(artifactOwner(await getApp(appId, false))),
    mountMiniUI: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; artifactId: string; target: HTMLElement; replace?: boolean; className?: string }) => artifactManager.mountMiniUI(await resolveArtifactOwner(input.sourceType ?? 'mini-app', input.appId), input.artifactId, input.target, input),
    activateHomeWidget: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; artifactId: string }) => artifactManager.activateHomeWidget(await resolveArtifactOwner(input.sourceType ?? 'mini-app', input.appId), input.artifactId),
    requestPinHomeWidget: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; artifactId: string }) => artifactManager.requestPinHomeWidget(await resolveArtifactOwner(input.sourceType ?? 'mini-app', input.appId), input.artifactId),
    showFloatingUI: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; artifactId: string }) => artifactManager.showFloating(await resolveArtifactOwner(input.sourceType ?? 'mini-app', input.appId), input.artifactId),
    hideFloatingUI: async (input: { sourceType?: 'mini-app' | 'host'; appId?: string; artifactId?: string } = {}) => {
      // A trusted host/user emergency stop may omit the selector. A supplied
      // selector remains owner-checked, matching the untrusted broker behavior.
      if (input.sourceType || input.appId || input.artifactId) {
        const owner = await resolveArtifactOwner(input.sourceType ?? (input.appId ? 'mini-app' : 'host'), input.appId);
        await artifactManager.hideFloating(owner, input.artifactId);
      } else await artifactManager.hideFloating();
      return { hidden: true };
    },
    activations: () => artifactManager.listActivations(),
  });

  const hostSurface = Object.freeze({
    capabilities: APP_BROWSER_CAPABILITIES,
    install: async (packageValue: { files: Array<{ path: string; data: string | Uint8Array; type?: string }>; manifest?: Record<string, any> }) => installPackage(packageValue.files.map((file) => ({ path: file.path, bytes: typeof file.data === 'string' ? textEncoder.encode(file.data) : file.data, type: file.type ?? mimeType(file.path) })), packageValue.manifest ?? {}),
    /**
     * Zero-config quick add: the developer uploads a single web component module (`.js`/`.mjs`)
     * or a full HTML page. For a JS module we auto-detect the registered custom-element tag and
     * synthesize a manifest + entry wrapper, so "upload one file" is enough. For `.html` the file
     * itself is used as the entry. Pass `tag` explicitly when detection isn't possible.
     */
    installWebComponent: async (input: { fileName: string; data?: string | Uint8Array; source?: string; tag?: string; name?: string; id?: string; description?: string }): Promise<Record<string, any>> => {
      if (!config.enabled) throw new Error('App Browser is disabled in app.config.json');
      const fileName = normalizePath(String(input.fileName ?? ''));
      if (!fileName) throw new Error('fileName is required');
      const isHtml = /\.html?$/i.test(fileName);
      const bytes: Uint8Array = input.data == null
        ? textEncoder.encode(String(input.source ?? ''))
        : typeof input.data === 'string' ? textEncoder.encode(input.data) : input.data;
      const source = typeof input.data === 'string' ? input.data : (input.source ?? textDecoder.decode(bytes));
      const detected = detectComponentTag(source);
      const isModule = /\.m?js$/i.test(fileName);
      if (!isHtml && isModule) {
        const tag = String(input.tag ?? '').trim() || detected || '';
        if (!COMPONENT_TAG_RE.test(tag)) throw new Error(`No custom-element tag detected in ${fileName}. Register one with customElements.define('my-tag', …) or pass an explicit tag.`);
        const rawName = String(input.name ?? '').trim() || tag;
        const id = String(input.id ?? '').trim() || `nativekit.quick.${safeIdPart(tag)}`;
        if (!ID_RE.test(id) || id.length > 120) throw new Error('Manifest id must be a stable lowercase dotted/dashed identifier');
        return installPackage([{ path: fileName, bytes, type: mimeType(fileName) }], {
          id, name: rawName.slice(0, 80), version: '1.0.0',
          description: String(input.description ?? `Quick-added web component ${tag}`).slice(0, 500),
          requestedCapabilities: [],
          webComponent: { tag, module: fileName, attributes: {} },
        });
      }
      const stem = fileName.replace(/\.html?$/i, '');
      const rawName = String(input.name ?? '').trim() || stem;
      const id = String(input.id ?? '').trim() || `nativekit.quick.${safeIdPart(stem)}`;
      if (!ID_RE.test(id) || id.length > 120) throw new Error('Manifest id must be a stable lowercase dotted/dashed identifier');
      return installPackage([{ path: fileName, bytes, type: mimeType(fileName) }], {
        id, name: rawName.slice(0, 80), version: '1.0.0',
        description: String(input.description ?? `Quick-added ${rawName}`).slice(0, 500),
        entry: fileName,
        requestedCapabilities: [],
      });
    },
    installFromFiles,
    installFromZip,
    list: async () => Promise.all((await idbGetAll<StoredInstalledApp>('apps')).map(async (app) => publicApp(app, await getPolicy(app)))),
    get: async (appId: string) => { const app = await getApp(appId); return publicApp(app, await getPolicy(app)); },
    usage: appUsage,
    cleanup: cleanupApp,
    remove: async (appId: string) => {
      cancelPendingPermissions((request) => request.appId === appId, 'The requesting app was removed');
      const app = await getApp(appId); const policy = await getPolicy(app);
      policy.enabled = false; policy.updatedAt = new Date().toISOString(); await idbPut('policies', policy);
      await runCleanupOperations(`App ${appId} was disabled but could not be fully removed; retry removal after resolving the reported native cleanup failures`, [
        ['session shutdown', () => stopAppSessions(appId)],
        ['native resource revocation', () => releaseOwnedNativeState(appId)],
        ['UI artifact activation and native-store deletion', () => artifactManager.removeOwner(artifactOwner(app))],
        ['database deletion', () => deleteOwnedDatabases(appId)],
        ['storage and filesystem deletion', () => deleteOwnedStorageAndFiles(appId)],
        ...(nativeKit.isNative ? [['native package deletion', () => deleteNativePackage(nativeKit, appId)] as [string, () => Promise<void>], ['isolated package and web-storage deletion', () => NativeKitIsolatedBrowser.removeStagedApp({ appId })] as [string, () => Promise<void>]] : []),
      ]);
      packageCache.delete(appId);
      await deleteAppResources(appId); await idbDelete('apps', appId); await idbDelete('policies', appId);
    },
    openUrl: async (input: string, options: { title?: string } = {}) => {
      if (!config.urlMode?.enabled) throw new Error('App Browser remote URL mode is disabled');
      let url: URL;
      try { url = new URL(String(input)); } catch { throw new Error('Remote URL is invalid'); }
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error('Remote URL mode accepts HTTPS URLs without embedded credentials only');
      const allowedHosts = validateHosts(config.urlMode.allowedHosts);
      if (allowedHosts.length && !isAllowedAppHost(url.toString(), allowedHosts)) throw new Error(`Remote URL host is not allowed: ${url.host.toLowerCase()}`);
      const sessionId = crypto.randomUUID();
      if (nativeKit.isNative) {
        if (!await canUseNativeUrlRenderer()) throw new Error('The isolated browser-only URL renderer is unavailable on this platform');
        await ensureNativeListeners();
        for (const active of Array.from(sessions.values()).filter((item) => item.renderer === 'isolated')) await stop(active.id);
        for (const remote of Array.from(remoteUrlSessions.keys())) await stopRemoteUrl(remote);
        remoteUrlSessions.set(sessionId, { id: sessionId, url: url.toString(), native: true });
        try {
          await NativeKitIsolatedBrowser.openUrl({ sessionId, url: url.toString(), title: String(options.title ?? url.hostname).slice(0, 120), allowedHosts });
        } catch (error) { remoteUrlSessions.delete(sessionId); throw error; }
      } else {
        const opened = window.open(url.toString(), '_blank', 'noopener,noreferrer');
        if (!opened) throw new Error('The browser blocked the remote URL window');
        try { opened.opener = null; } catch { /* noopener is already requested. */ }
        remoteUrlSessions.set(sessionId, { id: sessionId, url: url.toString(), native: false, window: opened });
      }
      return Object.freeze({ id: sessionId, mode: 'url', url: url.toString(), nativeKit: false, stop: () => stopRemoteUrl(sessionId) });
    },
    closeUrl: stopRemoteUrl,
    urlSessions: () => Array.from(remoteUrlSessions.values()).map(({ id, url, native }) => ({ id, url, native, nativeKit: false })),
    launch: async (appId: string, target: HTMLElement, options: { replace?: boolean; className?: string } = {}) => {
      if (!(target instanceof HTMLElement)) throw new Error('launch target must be an HTMLElement');
      const app = await getApp(appId); const policy = await getPolicy(app);
      if (!policy.enabled) throw new Error(`Third-party app is disabled: ${appId}`);

      let isolatedFailure: unknown;
      if (config.renderer === 'isolated') {
        try {
          if (!await canUseIsolatedRenderer()) throw new Error('The isolated native renderer is unavailable on this platform');
          await ensureNativeListeners();
          await stageNativeApp(app);
          for (const remote of Array.from(remoteUrlSessions.keys())) await stopRemoteUrl(remote);
          for (const active of Array.from(sessions.values()).filter((item) => item.renderer === 'isolated')) await stop(active.id);
          const sessionId = crypto.randomUUID(); const token = crypto.randomUUID();
          const session: RpcSession = { id: sessionId, app, renderer: 'isolated', token, requests: [], subscriptions: new Map(), loadCount: 0 };
          sessions.set(sessionId, session);
          try {
            const opened = await NativeKitIsolatedBrowser.open({
              sessionId,
              token,
              appId: app.id,
              title: app.manifest.name,
              integrity: app.integrity,
              entry: app.manifest.entry,
              bootstrap: bootstrapSource(token, app),
              allowedHosts: policy.allowedHosts,
              allowDirectNetwork: config.allowDirectWebNetwork && (policy.networkMode ?? 'full') !== 'sandboxed',
              networkMode: policy.networkMode ?? 'full',
              mediaAutoplay: policy.mediaAutoplay === true,
              colorScheme: policy.colorScheme ?? 'dark',
              hangTerminationDelayMs: config.isolated.hangTerminationDelayMs,
            });
            if (session.nativeOrigin && session.nativeOrigin !== opened.origin) throw new Error('Isolated renderer origin changed during launch');
            session.nativeOrigin = opened.origin;
            if (options.replace !== false) target.replaceChildren();
            return { id: sessionId, appId, renderer: 'isolated', stop: () => stop(sessionId) };
          } catch (error) {
            try { await stop(sessionId); }
            catch (cleanupFailure) {
              throw new AggregateError([cleanupError('isolated renderer launch', error), cleanupError('isolated renderer cleanup', cleanupFailure)], 'Isolated renderer launch and cleanup failed');
            }
            throw error;
          }
        } catch (error) {
          isolatedFailure = error;
          window.dispatchEvent(new CustomEvent('nativekitappbrowserstatus', { detail: { appId, renderer: 'isolated', state: 'launchFailed', reason: serializeError(error).message } }));
          if (!config.isolated.fallbackToIframe) throw error;
        }
      }

      const sessionId = crypto.randomUUID(); const token = crypto.randomUUID();
      const frame = document.createElement('iframe'); frame.className = options.className ?? 'nativekit-app-browser-frame'; frame.title = app.manifest.name;
      frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'");
      const session: RpcSession = { id: sessionId, app, renderer: 'iframe', frame, token, requests: [], subscriptions: new Map(), loadCount: 0 }; sessions.set(sessionId, session);
      frame.addEventListener('load', () => { session.loadCount += 1; if (session.loadCount > 1) void stop(sessionId).catch(() => undefined); });
      frame.srcdoc = buildDocument(app, config, token, policy);
      if (options.replace !== false) target.replaceChildren(frame); else target.append(frame);
      if (isolatedFailure) window.dispatchEvent(new CustomEvent('nativekitappbrowserstatus', { detail: { sessionId, appId, renderer: 'iframe', state: 'fallback', reason: serializeError(isolatedFailure).message } }));
      return { id: sessionId, appId, renderer: 'iframe', frame, stop: () => stop(sessionId) };
    },
    stop,
    stopAll: async () => runCleanupOperations('One or more App Browser sessions could not be stopped', [
      ...Array.from(sessions.keys()).map((id) => [`session ${id}`, () => stop(id)] as [string, () => Promise<void>]),
      ...Array.from(remoteUrlSessions.keys()).map((id) => [`URL session ${id}`, () => stopRemoteUrl(id)] as [string, () => Promise<void>]),
    ]),
    sessions: () => Array.from(sessions.values()).map((session) => ({ id: session.id, appId: session.app.id, renderer: session.renderer, started: true })),
    getPolicy: async (appId: string) => getPolicy(await getApp(appId)),
    listPendingPermissions: () => Array.from(pendingPermissions.values()).map(publicPendingPermission),
    resolvePermissionRequest: async (requestId: string, action: AppBrowserPermissionAction) => resolvePermissionRequest(String(requestId), action),
    setEnabled: async (appId: string, enabled: boolean) => {
      if (!enabled) cancelPendingPermissions((request) => request.appId === appId, 'The requesting app was disabled');
      const app = await getApp(appId); const policy = await getPolicy(app); policy.enabled = !!enabled;
      const normalized = normalizePolicy({ ...policy, updatedAt: new Date().toISOString() }); await idbPut('policies', normalized);
      if (!enabled) await runCleanupOperations(`App ${appId} was disabled, but some active resources could not be revoked`, [
        ['session shutdown', () => stopAppSessions(appId)],
        ['native resource revocation', () => releaseOwnedNativeState(appId)],
        ['UI artifact deactivation', () => artifactManager.deactivateOwner(artifactOwner(app))],
      ]);
      return normalized;
    },
    setCapabilityDecision,
    setCapability: async (appId: string, capability: AppBrowserCapability, enabled: boolean) => setCapabilityDecision(appId, capability, enabled ? 'allow' : 'block'),
    setMethodDecision,
    setMethodPermission: async (appId: string, method: string, enabled: boolean | null) => setMethodDecision(appId, method, enabled == null ? 'inherit' : enabled ? 'allow' : 'block'),
    setAllowedHosts: async (appId: string, hosts: string[]) => { const app = await getApp(appId); const policy = await getPolicy(app); const requested = new Set(app.manifest.allowedHosts); const previous = policy.allowedHosts.join('\n'); policy.allowedHosts = validateHosts(hosts).filter((host) => requested.has(host)); policy.updatedAt = new Date().toISOString(); await idbPut('policies', policy); if (policy.allowedHosts.join('\n') !== previous) await stopAppSessions(appId); return policy; },
    setNetworkMode: async (appId: string, mode: string) => {
      const app = await getApp(appId); const policy = await getPolicy(app);
      const next = normalizeAppBrowserNetworkMode(mode);
      const previous = policy.networkMode ?? 'full';
      if (next === previous) return policy;
      policy.networkMode = next;
      policy.updatedAt = new Date().toISOString();
      const normalized = normalizePolicy(policy);
      await idbPut('policies', normalized);
      // Running sessions keep their launch-time network mode; stop them so the new mode applies.
      await stopAppSessions(appId);
      return normalized;
    },
    setMediaAutoplay: async (appId: string, enabled: boolean) => {
      const app = await getApp(appId); const policy = await getPolicy(app);
      policy.mediaAutoplay = !!enabled;
      policy.updatedAt = new Date().toISOString();
      const normalized = normalizePolicy(policy);
      await idbPut('policies', normalized);
      return normalized;
    },
    networkStats: async (appId?: string) => {
      if (appId) return (await idbGet<NetUsageRecord>('netstats', appId)) ?? { appId, count: 0, hosts: {}, updatedAt: '' };
      return idbGetAll<NetUsageRecord>('netstats');
    },
    artifacts: artifactHostSurface,
    audit: Object.freeze({
      list: async (filter: { appId?: string; capability?: string; outcome?: AuditOutcome; limit?: number } = {}) => (await idbGetAll<AuditRecord>('audit')).filter((row) => (!filter.appId || row.appId === filter.appId) && (!filter.capability || row.capability === filter.capability) && (!filter.outcome || row.outcome === filter.outcome)).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, Math.min(1000, Math.max(1, filter.limit ?? 100))),
      summary: async (appId?: string) => { const rows = (await idbGetAll<AuditRecord>('audit')).filter((row) => !appId || row.appId === appId); const summary: Record<string, any> = {}; for (const row of rows) { const key = `${row.appId}|${row.method}`; const item = summary[key] ??= { appId: row.appId, appName: row.appName, method: row.method, capability: row.capability, calls: 0, success: 0, denied: 0, errors: 0, lastUsedAt: row.timestamp }; item.calls += 1; if (row.outcome === 'success') item.success += 1; else if (row.outcome === 'denied' || row.outcome === 'rate_limited') item.denied += 1; else item.errors += 1; if (row.timestamp > item.lastUsedAt) item.lastUsedAt = row.timestamp; } return Object.values(summary).sort((a: any, b: any) => b.lastUsedAt.localeCompare(a.lastUsedAt)); },
      clear: async (appId?: string) => { for (const row of await idbGetAll<AuditRecord>('audit')) if (row.id != null && (!appId || row.appId === appId)) await idbDelete('audit', row.id); },
    }),
  });
  return gateAppBrowserHostSurface(hostSurface, () => config.enabled);
}
