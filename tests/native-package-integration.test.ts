import { IDBKeyRange as FakeIDBKeyRange, indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { createAppBrowser, saveInstalledAppAndPolicy } from '../bridge/app-browser';

Object.defineProperties(globalThis, {
  indexedDB: { configurable: true, value: fakeIndexedDB },
  IDBKeyRange: { configurable: true, value: FakeIDBKeyRange },
  window: { configurable: true, value: { addEventListener: vi.fn(), dispatchEvent: vi.fn(), open: vi.fn() } },
});

function config() {
  return {
    enabled: true, maxApps: 20, maxPackageBytes: 1_000_000, maxFiles: 20, auditLogLimit: 100,
    maxRequestsPerMinute: 100, maxActiveHomeWidgets: 2, defaultCapabilities: [], allowDirectWebNetwork: false,
    urlMode: { enabled: false, allowedHosts: [] }, renderer: 'iframe',
    permissionPrompts: { enabled: true, requestTimeoutMs: 90_000, requestedCapabilityDefault: 'ask', unrequestedCapabilityDefault: 'block' },
    isolated: { enabled: false, fallbackToIframe: true, stageChunkBytes: 1000, androidMinApi: 28, hangTerminationDelayMs: 1000 },
  } as any;
}

function nativeKit() {
  const files = new Map<string, string>();
  const kit: any = {
    isNative: true,
    platform: 'android',
    config: {
      app: { id: 'host.app', name: 'Host', versionName: '1' },
      features: { filesystem: true, localNotifications: false, advancedAlarms: false, widget: false },
      backgroundRunner: { defaultSyncUrl: '' },
    },
    filesystem: {
      writeFile: vi.fn(async ({ path, data }) => { files.set(path, data); return {}; }),
      readFile: vi.fn(async ({ path }) => {
        if (!files.has(path)) throw Object.assign(new Error('File does not exist'), { code: 'OS-PLUG-FILE-0008' });
        return { data: files.get(path)! };
      }),
      readdir: vi.fn(async ({ path }) => {
        const prefix = `${path}/`;
        if (![...files.keys()].some((key) => key.startsWith(prefix))) throw Object.assign(new Error('Directory does not exist'), { code: 'OS-PLUG-FILE-0008' });
        const children = new Map<string, string>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const [name, ...tail] = key.slice(prefix.length).split('/');
          children.set(name, tail.length ? 'directory' : 'file');
        }
        return { files: [...children].map(([name, type]) => ({ name, type })) };
      }),
      rmdir: vi.fn(async ({ path }) => {
        const matches = [...files.keys()].filter((key) => key === path || key.startsWith(`${path}/`));
        if (!matches.length) throw Object.assign(new Error('Directory does not exist'), { code: 'OS-PLUG-FILE-0008' });
        matches.forEach((key) => files.delete(key));
        return {};
      }),
    },
    preferences: { keys: vi.fn(async () => ({ keys: [] })), remove: vi.fn() },
    secureStorage: { remove: vi.fn() }, sqlite: { delete: vi.fn() },
    backgroundLocation: { status: vi.fn(async () => ({ running: false })), stop: vi.fn() },
    notifications: { pending: vi.fn(async () => ({ notifications: [] })), delivered: vi.fn(async () => ({ notifications: [] })), cancel: vi.fn(), removeDelivered: vi.fn() },
    alarms: { list: vi.fn(async () => ({ alarms: [] })), cancel: vi.fn() },
  };
  return { kit, files };
}

function readStoredApp(id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open('nativekit-app-browser-v1', 4);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('apps', 'readonly').objectStore('apps').get(id);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    };
  });
}

describe('native installed-package integration', () => {
  it('stores package bytes natively and leaves only metadata in IndexedDB', async () => {
    const { kit, files } = nativeKit();
    const host = createAppBrowser(kit, config());
    const id = `test.native-${crypto.randomUUID()}`;
    await host.install({ files: [{ path: 'index.html', data: '<title>Native</title>' }], manifest: { id, name: 'Native', requestedCapabilities: [] } });
    const stored = await readStoredApp(id);
    expect(stored.packageStorage).toBe('native-filesystem');
    expect(stored.files).toBeUndefined();
    expect(stored.fileCount).toBe(1);
    expect([...files.keys()].some((path) => path.includes('/packages/') && path.endsWith('/files/index.html'))).toBe(true);
    const reloadedHost = createAppBrowser(kit, config());
    await expect(reloadedHost.get(id)).resolves.toMatchObject({ id, fileCount: 1 });
    expect(kit.filesystem.readFile).toHaveBeenCalled();
  });

  it('migrates a legacy IndexedDB package before returning it on native', async () => {
    const { kit, files } = nativeKit();
    const host = createAppBrowser(kit, config());
    const id = `test.legacy-${crypto.randomUUID()}`;
    const html = '<title>Legacy</title>';
    const app = {
      id,
      manifest: { id, name: 'Legacy', version: '1', entry: 'index.html', description: '', requestedCapabilities: [], allowedHosts: [] },
      files: [{ path: 'index.html', bytes: new TextEncoder().encode(html), type: 'text/html' }],
      integrity: 'c'.repeat(64), installedAt: '', updatedAt: '', totalBytes: html.length,
    };
    await saveInstalledAppAndPolicy(app as any, {
      appId: id, enabled: true, grants: {}, methodOverrides: {}, capabilityDecisions: {}, methodDecisions: {}, allowedHosts: [], networkMode: 'sandboxed', mediaAutoplay: false, colorScheme: 'dark', updatedAt: '',
    } as any);
    await expect(host.get(id)).resolves.toMatchObject({ id, fileCount: 1 });
    const stored = await readStoredApp(id);
    expect(stored.packageStorage).toBe('native-filesystem');
    expect(stored.files).toBeUndefined();
    expect([...files.keys()].some((path) => path.endsWith('/files/index.html'))).toBe(true);
  });
});
