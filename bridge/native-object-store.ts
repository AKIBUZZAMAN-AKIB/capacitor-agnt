/**
 * Native, app-private object storage for installed Mini App packages and their
 * separately-published UI artifacts.
 *
 * Native platforms never silently fall back to IndexedDB/localStorage here. The
 * hosted web target keeps the legacy package path in app-browser.ts, while the
 * artifact API intentionally reports that native storage is unavailable.
 */

export type NativeObjectFilesystem = {
  writeFile(options: { path: string; directory: 'Data'; data: string; encoding?: 'utf8'; recursive?: boolean }): Promise<unknown>;
  readFile(options: { path: string; directory: 'Data'; encoding?: 'utf8' }): Promise<{ data: string }>;
  readdir(options: { path: string; directory: 'Data' }): Promise<{ files: Array<{ name: string; type: string }> }>;
  rmdir(options: { path: string; directory: 'Data'; recursive: boolean }): Promise<unknown>;
};

export type NativeObjectKit = {
  isNative: boolean;
  config: { features: Record<string, boolean> };
  filesystem: NativeObjectFilesystem;
};

export type NativePackageFile = { path: string; bytes: Uint8Array; type: string };
export type NativePackageValue = {
  id: string;
  integrity: string;
  files: NativePackageFile[];
};

export const NATIVE_OBJECT_ROOT = 'nativekit-object-store';
export const NATIVE_PACKAGE_STORE = 'packages';
export const ARTIFACT_KINDS = Object.freeze(['mini-ui', 'floating-ui', 'home-widget'] as const);
export type NativeArtifactKind = typeof ARTIFACT_KINDS[number];
export type NativeArtifactOwnerType = 'mini-app' | 'host';

export type NativeArtifactOwner = {
  type: NativeArtifactOwnerType;
  id: string;
  name: string;
  version: string;
};

export type NativeArtifactInput = {
  id?: string;
  title?: string;
  description?: string;
  html: string;
  config?: Record<string, unknown>;
};

export type NativeArtifactRecord = {
  schemaVersion: 1;
  id: string;
  kind: NativeArtifactKind;
  title: string;
  description: string;
  source: NativeArtifactOwner;
  appId?: string;
  nativeKitAppBrowserId?: string;
  integrity: string;
  bytes: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
  storage: { backend: 'native-filesystem'; directory: 'Data'; store: string };
};

export type NativeArtifactValue = { record: NativeArtifactRecord; html: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ARTIFACT_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const INTEGRITY_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_LIMITS: Record<NativeArtifactKind, number> = {
  'mini-ui': 512 * 1024,
  'floating-ui': 256 * 1024,
  'home-widget': 256 * 1024,
};
const MAX_ARTIFACTS_PER_KIND = 8;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 4 * 1024 * 1024;

function missing(error: unknown): boolean {
  const value = error as any;
  return value?.code === 'OS-PLUG-FILE-0008' || /not[ -]?found|not exist|does not exist/i.test(String(value?.message ?? error ?? ''));
}

export function assertNativeObjectStorage(nativeKit: NativeObjectKit): void {
  if (!nativeKit.isNative) throw new Error('Native object storage is unavailable on the hosted web target');
  if (nativeKit.config.features.filesystem !== true) throw new Error('Native object storage requires features.filesystem=true');
  if (!nativeKit.filesystem) throw new Error('Native object storage filesystem is unavailable');
}

function safeSegment(value: unknown, label: string, max = 120): string {
  const text = String(value ?? '');
  if (!text || text.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function ownerKey(owner: NativeArtifactOwner): string {
  return `${owner.type}:${safeSegment(owner.id, 'artifact owner id')}`;
}

function ownerPath(owner: NativeArtifactOwner, kind: NativeArtifactKind): string {
  return `${NATIVE_OBJECT_ROOT}/artifacts/${kind}/${encodeURIComponent(ownerKey(owner))}`;
}

function artifactPath(owner: NativeArtifactOwner, kind: NativeArtifactKind, id: string): string {
  return `${ownerPath(owner, kind)}/${id}`;
}

function packagePath(appId: string, integrity: string): string {
  return `${NATIVE_OBJECT_ROOT}/${NATIVE_PACKAGE_STORE}/${encodeURIComponent(safeSegment(appId, 'app id'))}/${safeSegment(integrity, 'package integrity', 64)}`;
}

export function assertNativeRelativePath(value: string): string {
  if (!value || value.length > 1024 || value.startsWith('/') || value.startsWith('.') || value.endsWith('/') || /[\\\0]/.test(value)) throw new Error(`Unsafe native object path: ${value}`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe native object path: ${value}`);
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function writeText(nativeKit: NativeObjectKit, path: string, value: string): Promise<void> {
  assertNativeObjectStorage(nativeKit);
  await nativeKit.filesystem.writeFile({ directory: 'Data', path: assertNativeRelativePath(path), data: value, encoding: 'utf8', recursive: true });
}

async function readText(nativeKit: NativeObjectKit, path: string): Promise<string> {
  assertNativeObjectStorage(nativeKit);
  const result = await nativeKit.filesystem.readFile({ directory: 'Data', path: assertNativeRelativePath(path), encoding: 'utf8' });
  return result.data;
}

async function writeJson(nativeKit: NativeObjectKit, path: string, value: unknown): Promise<void> {
  await writeText(nativeKit, path, JSON.stringify(value));
}

async function readJson<T>(nativeKit: NativeObjectKit, path: string): Promise<T> {
  return JSON.parse(await readText(nativeKit, path)) as T;
}

async function removeTree(nativeKit: NativeObjectKit, path: string): Promise<void> {
  try { await nativeKit.filesystem.rmdir({ directory: 'Data', path: assertNativeRelativePath(path), recursive: true }); }
  catch (error) { if (!missing(error)) throw error; }
}

async function directoryNames(nativeKit: NativeObjectKit, path: string, accepted: RegExp = /^[a-f0-9]{64}$/): Promise<string[]> {
  try {
    const result = await nativeKit.filesystem.readdir({ directory: 'Data', path: assertNativeRelativePath(path) });
    return result.files.filter((item) => item.type === 'directory').map((item) => item.name).filter((name) => ARTIFACT_ID_RE.test(name) || accepted.test(name));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** Write a package completely before publishing its package.json commit record. */
export async function saveNativePackage(nativeKit: NativeObjectKit, app: NativePackageValue): Promise<void> {
  assertNativeObjectStorage(nativeKit);
  if (!INTEGRITY_RE.test(app.integrity)) throw new Error('Native package integrity must be a SHA-256 hex digest');
  const root = packagePath(app.id, app.integrity);
  const files = app.files.map((file) => ({ path: assertNativeRelativePath(file.path), type: String(file.type || 'application/octet-stream').slice(0, 200), bytes: file.bytes.byteLength }));
  // Re-saving the exact integrity is a no-op when the existing commit is
  // readable. This avoids destroying a live package merely to rewrite bytes
  // that are already identical; corrupt/incomplete commits are rebuilt below.
  try {
    const committed = await readNativePackage(nativeKit, app.id, app.integrity);
    if (committed.length === files.length && committed.every((file, index) => file.path === files[index].path && file.bytes.byteLength === files[index].bytes)) return;
  } catch { /* A missing/corrupt commit must be replaced. */ }
  await removeTree(nativeKit, root);
  try {
    for (const file of app.files) {
      await nativeKit.filesystem.writeFile({
        directory: 'Data',
        path: `${root}/files/${assertNativeRelativePath(file.path)}`,
        data: bytesToBase64(file.bytes),
        recursive: true,
      });
    }
    await writeJson(nativeKit, `${root}/package.json`, { schemaVersion: 1, appId: app.id, integrity: app.integrity, files });
  } catch (error) {
    try { await removeTree(nativeKit, root); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

export async function readNativePackage(nativeKit: NativeObjectKit, appId: string, integrity: string): Promise<NativePackageFile[]> {
  assertNativeObjectStorage(nativeKit);
  const root = packagePath(appId, integrity);
  const metadata = await readJson<{ schemaVersion: number; appId: string; integrity: string; files: Array<{ path: string; type: string; bytes: number }> }>(nativeKit, `${root}/package.json`);
  if (metadata.schemaVersion !== 1 || metadata.appId !== appId || metadata.integrity !== integrity || !Array.isArray(metadata.files)) throw new Error('Native package commit record is invalid');
  const files: NativePackageFile[] = [];
  for (const item of metadata.files) {
    const path = assertNativeRelativePath(item.path);
    const result = await nativeKit.filesystem.readFile({ directory: 'Data', path: `${root}/files/${path}` });
    const bytes = base64ToBytes(result.data);
    if (bytes.byteLength !== item.bytes) throw new Error(`Native package file length mismatch: ${path}`);
    files.push({ path, bytes, type: item.type });
  }
  return files;
}

export async function deleteNativePackage(nativeKit: NativeObjectKit, appId: string, integrity?: string): Promise<void> {
  assertNativeObjectStorage(nativeKit);
  if (integrity) await removeTree(nativeKit, packagePath(appId, integrity));
  else await removeTree(nativeKit, `${NATIVE_OBJECT_ROOT}/${NATIVE_PACKAGE_STORE}/${encodeURIComponent(safeSegment(appId, 'app id'))}`);
}

function normalizeOwner(owner: NativeArtifactOwner): NativeArtifactOwner {
  if (owner.type !== 'mini-app' && owner.type !== 'host') throw new Error('Invalid artifact source type');
  return {
    type: owner.type,
    id: safeSegment(owner.id, 'artifact owner id'),
    name: String(owner.name ?? '').trim().slice(0, 80) || owner.id,
    version: String(owner.version ?? '').slice(0, 40) || '0.0.0',
  };
}

function normalizeKind(kind: string): NativeArtifactKind {
  if (!ARTIFACT_KINDS.includes(kind as NativeArtifactKind)) throw new Error(`Unknown UI artifact store: ${kind}`);
  return kind as NativeArtifactKind;
}

function normalizeInput(kind: NativeArtifactKind, input: NativeArtifactInput): { id: string; title: string; description: string; html: string; config: Record<string, unknown>; bytes: number } {
  const id = String(input.id ?? 'main').toLowerCase();
  if (!ARTIFACT_ID_RE.test(id) || id.length > 64) throw new Error('Artifact id must be 1–64 lowercase letters, digits, hyphens, or underscores');
  const html = String(input.html ?? '');
  const bytes = encoder.encode(html).byteLength;
  if (!html.trim() || bytes > ARTIFACT_LIMITS[kind]) throw new Error(`${kind} HTML must be non-empty and at most ${ARTIFACT_LIMITS[kind]} bytes`);
  const title = String(input.title ?? id).trim().slice(0, 80) || id;
  const description = String(input.description ?? '').slice(0, 500);
  let config: Record<string, unknown> = {};
  if (input.config != null) {
    if (typeof input.config !== 'object' || Array.isArray(input.config)) throw new Error('Artifact config must be an object');
    const raw = JSON.stringify(input.config);
    if (encoder.encode(raw).byteLength > MAX_CONFIG_BYTES) throw new Error('Artifact config exceeds 32 KiB');
    config = JSON.parse(raw);
  }
  return { id, title, description, html, config, bytes };
}

/**
 * Versioned artifact store. Code and metadata are committed before current.json
 * switches readers to the new revision, so a failed publish keeps the old UI.
 */
export function createNativeArtifactStore(nativeKit: NativeObjectKit) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action, action);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  async function currentPointer(owner: NativeArtifactOwner, kind: NativeArtifactKind, id: string): Promise<{ integrity: string; revision?: number } | null> {
    try {
      const pointer = await readJson<{ integrity?: string; revision?: number }>(nativeKit, `${artifactPath(owner, kind, id)}/current.json`);
      if (typeof pointer.integrity !== 'string' || !INTEGRITY_RE.test(pointer.integrity)) return null;
      return { integrity: pointer.integrity, ...(Number.isSafeInteger(pointer.revision) && Number(pointer.revision) > 0 ? { revision: Number(pointer.revision) } : {}) };
    } catch (error) {
      if (missing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function readUnserialized(ownerInput: NativeArtifactOwner, kindInput: string, idInput: string): Promise<NativeArtifactValue> {
    const owner = normalizeOwner(ownerInput);
    const kind = normalizeKind(kindInput);
    const id = String(idInput).toLowerCase();
    if (!ARTIFACT_ID_RE.test(id)) throw new Error('Invalid artifact id');
    const pointer = await currentPointer(owner, kind, id);
    if (!pointer) throw new Error(`UI artifact not found: ${kind}/${owner.id}/${id}`);
    const { integrity } = pointer;
    const root = `${artifactPath(owner, kind, id)}/versions/${integrity}`;
    // revisioned metadata is the current format; artifact.json is the legacy
    // v1 fallback so already-published stores remain readable.
    const metadataPath = pointer.revision ? `${root}/revisions/${pointer.revision}/artifact.json` : `${root}/artifact.json`;
    const record = await readJson<NativeArtifactRecord>(nativeKit, metadataPath);
    if (record.integrity !== integrity || record.id !== id || record.kind !== kind || (pointer.revision != null && record.revision !== pointer.revision) || record.source.type !== owner.type || record.source.id !== owner.id) throw new Error('UI artifact ownership or integrity metadata is invalid');
    const html = await readText(nativeKit, `${root}/code.html`);
    const bytes = encoder.encode(html);
    if (bytes.byteLength !== record.bytes || await digest(bytes) !== integrity) throw new Error('UI artifact code failed integrity verification');
    return { record, html };
  }

  async function listUnserialized(ownerInput: NativeArtifactOwner, kindInput?: string): Promise<NativeArtifactRecord[]> {
    const owner = normalizeOwner(ownerInput);
    const kinds = kindInput ? [normalizeKind(kindInput)] : [...ARTIFACT_KINDS];
    const records: NativeArtifactRecord[] = [];
    for (const kind of kinds) {
      for (const id of await directoryNames(nativeKit, ownerPath(owner, kind))) {
        if (!ARTIFACT_ID_RE.test(id)) continue;
        try { records.push((await readUnserialized(owner, kind, id)).record); }
        catch (error) { if (!missing(error)) throw error; }
      }
    }
    return records.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  return Object.freeze({
    publish: (ownerInput: NativeArtifactOwner, kindInput: string, input: NativeArtifactInput): Promise<NativeArtifactRecord> => serial(async () => {
      assertNativeObjectStorage(nativeKit);
      const owner = normalizeOwner(ownerInput);
      const kind = normalizeKind(kindInput);
      const normalized = normalizeInput(kind, input);
      const existingRecords = await listUnserialized(owner);
      const previous = existingRecords.find((item) => item.kind === kind && item.id === normalized.id);
      if (!previous && existingRecords.filter((item) => item.kind === kind).length >= MAX_ARTIFACTS_PER_KIND) throw new Error(`At most ${MAX_ARTIFACTS_PER_KIND} ${kind} artifacts are allowed per source app`);
      const nextTotal = existingRecords.reduce((sum, item) => sum + item.bytes, 0) - (previous?.bytes ?? 0) + normalized.bytes;
      if (nextTotal > MAX_TOTAL_ARTIFACT_BYTES) throw new Error('Source app UI artifact storage quota exceeded (4 MiB)');
      const integrity = await digest(encoder.encode(normalized.html));
      const now = new Date().toISOString();
      const record: NativeArtifactRecord = {
        schemaVersion: 1,
        id: normalized.id,
        kind,
        title: normalized.title,
        description: normalized.description,
        source: owner,
        ...(owner.type === 'mini-app' ? { appId: owner.id, nativeKitAppBrowserId: owner.id } : {}),
        integrity,
        bytes: normalized.bytes,
        revision: previous ? previous.revision + 1 : 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        config: normalized.config,
        storage: { backend: 'native-filesystem', directory: 'Data', store: `${kind}/${ownerKey(owner)}` },
      };
      const root = `${artifactPath(owner, kind, normalized.id)}/versions/${integrity}`;
      const sameCode = previous?.integrity === integrity;
      // A title/config-only update has the same code hash. Never delete that
      // live code before the new pointer commits. Each revision gets separate
      // metadata, so even a same-HTML publish is atomic from a reader's view.
      if (!sameCode) await removeTree(nativeKit, root);
      try {
        if (!sameCode) await writeText(nativeKit, `${root}/code.html`, normalized.html);
        await writeJson(nativeKit, `${root}/revisions/${record.revision}/artifact.json`, record);
        await writeJson(nativeKit, `${artifactPath(owner, kind, normalized.id)}/current.json`, { integrity, revision: record.revision, updatedAt: now });
      } catch (error) {
        try {
          await removeTree(nativeKit, `${root}/revisions/${record.revision}`);
          if (!sameCode) await removeTree(nativeKit, root);
        } catch { /* Keep the publish failure primary. */ }
        throw error;
      }
      // Old code and metadata are unreachable only after the pointer commit.
      for (const oldIntegrity of await directoryNames(nativeKit, `${artifactPath(owner, kind, normalized.id)}/versions`)) {
        if (oldIntegrity !== integrity) await removeTree(nativeKit, `${artifactPath(owner, kind, normalized.id)}/versions/${oldIntegrity}`);
      }
      for (const oldRevision of await directoryNames(nativeKit, `${root}/revisions`, /^[0-9]+$/)) {
        if (Number(oldRevision) !== record.revision) await removeTree(nativeKit, `${root}/revisions/${oldRevision}`);
      }
      return record;
    }),
    read: (owner: NativeArtifactOwner, kind: string, id: string): Promise<NativeArtifactValue> => serial(() => readUnserialized(owner, kind, id)),
    list: (owner: NativeArtifactOwner, kind?: string): Promise<NativeArtifactRecord[]> => serial(() => listUnserialized(owner, kind)),
    remove: (ownerInput: NativeArtifactOwner, kindInput: string, id: string): Promise<{ removed: true; id: string; kind: NativeArtifactKind }> => serial(async () => {
      const owner = normalizeOwner(ownerInput);
      const kind = normalizeKind(kindInput);
      await readUnserialized(owner, kind, id);
      await removeTree(nativeKit, artifactPath(owner, kind, id));
      return { removed: true, id, kind };
    }),
    removeOwner: (ownerInput: NativeArtifactOwner): Promise<void> => serial(async () => {
      const owner = normalizeOwner(ownerInput);
      for (const kind of ARTIFACT_KINDS) await removeTree(nativeKit, ownerPath(owner, kind));
    }),
  });
}

export type NativeArtifactStore = ReturnType<typeof createNativeArtifactStore>;
export const NATIVE_ARTIFACT_LIMITS = Object.freeze({
  maxPerKind: MAX_ARTIFACTS_PER_KIND,
  maxTotalBytes: MAX_TOTAL_ARTIFACT_BYTES,
  maxConfigBytes: MAX_CONFIG_BYTES,
  htmlBytes: ARTIFACT_LIMITS,
});
