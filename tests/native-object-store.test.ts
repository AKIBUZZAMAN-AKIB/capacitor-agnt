import { describe, expect, it } from 'vitest';
import {
  createNativeArtifactStore,
  deleteNativePackage,
  readNativePackage,
  saveNativePackage,
  type NativeArtifactOwner,
  type NativeObjectKit,
} from '../bridge/native-object-store';

function fakeNativeKit() {
  const files = new Map<string, string>();
  const failOnce = new Set<string>();
  const kit: NativeObjectKit = {
    isNative: true,
    config: { features: { filesystem: true } },
    filesystem: {
      writeFile: async ({ path, data }) => {
        if (failOnce.delete(path)) throw new Error(`injected write failure: ${path}`);
        files.set(path, data);
        return {};
      },
      readFile: async ({ path }) => {
        if (!files.has(path)) throw Object.assign(new Error('File does not exist'), { code: 'OS-PLUG-FILE-0008' });
        return { data: files.get(path)! };
      },
      readdir: async ({ path }) => {
        const prefix = `${path}/`;
        if (![...files.keys()].some((key) => key.startsWith(prefix))) throw Object.assign(new Error('Directory does not exist'), { code: 'OS-PLUG-FILE-0008' });
        const children = new Map<string, string>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const [name, ...tail] = rest.split('/');
          children.set(name, tail.length ? 'directory' : 'file');
        }
        return { files: [...children].map(([name, type]) => ({ name, type })) };
      },
      rmdir: async ({ path }) => {
        const prefix = `${path}/`;
        const matches = [...files.keys()].filter((key) => key === path || key.startsWith(prefix));
        if (!matches.length) throw Object.assign(new Error('Directory does not exist'), { code: 'OS-PLUG-FILE-0008' });
        for (const key of matches) files.delete(key);
        return {};
      },
    },
  };
  return { kit, files, failOnce };
}

const owner: NativeArtifactOwner = { type: 'mini-app', id: 'com.example.time', name: 'Time', version: '1.2.3' };

describe('native Mini App artifact stores', () => {
  it('requires native filesystem storage instead of silently using web storage', async () => {
    const { kit } = fakeNativeKit();
    kit.isNative = false;
    const store = createNativeArtifactStore(kit);
    await expect(store.publish(owner, 'mini-ui', { html: '<p>web</p>' })).rejects.toThrow(/unavailable on the hosted web/);
  });

  it('keeps Mini UI, Floating UI, and Home Widget in separate attributed native stores', async () => {
    const { kit, files } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    await store.publish(owner, 'mini-ui', { id: 'stopwatch', title: 'Stopwatch UI', html: '<main>Mini</main>' });
    await store.publish(owner, 'floating-ui', { id: 'stopwatch', title: 'Stopwatch Floating', html: '<main>Float</main>' });
    await store.publish(owner, 'home-widget', { id: 'stopwatch', title: 'Stopwatch Home', html: '<main>Home</main>' });

    const records = await store.list(owner);
    expect(records.map((record) => record.kind)).toEqual(['floating-ui', 'home-widget', 'mini-ui']);
    expect(records.every((record) => record.nativeKitAppBrowserId === owner.id)).toBe(true);
    expect(records.every((record) => record.storage.backend === 'native-filesystem')).toBe(true);
    expect(new Set(records.map((record) => record.storage.store)).size).toBe(3);
    expect((await store.read(owner, 'floating-ui', 'stopwatch')).html).toBe('<main>Float</main>');
    expect([...files.keys()].some((path) => path.includes('/artifacts/mini-ui/'))).toBe(true);
    expect([...files.keys()].some((path) => path.includes('/artifacts/floating-ui/'))).toBe(true);
    expect([...files.keys()].some((path) => path.includes('/artifacts/home-widget/'))).toBe(true);
  });

  it('supports the maximum valid owner and artifact IDs without truncating attribution', async () => {
    const { kit } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    const longOwner = { ...owner, id: `com.${'a'.repeat(116)}` };
    const id = `a${'b'.repeat(63)}`;
    await store.publish(longOwner, 'home-widget', { id, html: '<p>long path</p>' });
    await expect(store.read(longOwner, 'home-widget', id)).resolves.toMatchObject({ html: '<p>long path</p>', record: { id, source: { id: longOwner.id } } });
  });

  it('uses independent ownership namespaces for identical artifact IDs', async () => {
    const { kit } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    const other: NativeArtifactOwner = { ...owner, id: 'com.example.other', name: 'Other' };
    await store.publish(owner, 'mini-ui', { id: 'main', html: 'time app' });
    await store.publish(other, 'mini-ui', { id: 'main', html: 'other app' });
    expect((await store.read(owner, 'mini-ui', 'main')).html).toBe('time app');
    expect((await store.read(other, 'mini-ui', 'main')).html).toBe('other app');
    await store.remove(owner, 'mini-ui', 'main');
    expect((await store.read(other, 'mini-ui', 'main')).html).toBe('other app');
  });

  it('keeps the previous committed UI when a new publish fails before pointer commit', async () => {
    const { kit, failOnce } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    const first = await store.publish(owner, 'mini-ui', { id: 'clock', html: 'version one' });
    const pointer = `nativekit-object-store/artifacts/mini-ui/${encodeURIComponent(`mini-app:${owner.id}`)}/clock/current.json`;
    failOnce.add(pointer);
    await expect(store.publish(owner, 'mini-ui', { id: 'clock', html: 'version two' })).rejects.toThrow(/injected write failure/);
    const current = await store.read(owner, 'mini-ui', 'clock');
    expect(current.html).toBe('version one');
    expect(current.record.revision).toBe(first.revision);
  });

  it('keeps the live code readable when a same-HTML metadata update fails', async () => {
    const { kit, failOnce, files } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    await store.publish(owner, 'mini-ui', { id: 'clock', title: 'Old title', html: 'same code' });
    const pointer = `nativekit-object-store/artifacts/mini-ui/${encodeURIComponent(`mini-app:${owner.id}`)}/clock/current.json`;
    failOnce.add(pointer);
    await expect(store.publish(owner, 'mini-ui', { id: 'clock', title: 'New title', html: 'same code', config: { width: 300 } })).rejects.toThrow(/injected write failure/);
    await expect(store.read(owner, 'mini-ui', 'clock')).resolves.toMatchObject({ html: 'same code', record: { title: 'Old title', revision: 1 } });
    const updated = await store.publish(owner, 'mini-ui', { id: 'clock', title: 'New title', html: 'same code', config: { width: 300 } });
    expect(updated.revision).toBe(2);
    await expect(store.read(owner, 'mini-ui', 'clock')).resolves.toMatchObject({ record: { title: 'New title', revision: 2, config: { width: 300 } } });
    expect([...files.keys()].some((path) => path.endsWith('/revisions/1/artifact.json'))).toBe(false);
  });

  it('enforces per-kind size, config size, and artifact-count quotas', async () => {
    const { kit } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    await expect(store.publish(owner, 'mini-ui', { html: 'x'.repeat(512 * 1024 + 1) })).rejects.toThrow(/524288 bytes/);
    await expect(store.publish(owner, 'mini-ui', { html: 'ok', config: { value: 'x'.repeat(33 * 1024) } })).rejects.toThrow(/32 KiB/);
    for (let index = 0; index < 8; index += 1) await store.publish(owner, 'mini-ui', { id: `card-${index}`, html: `<p>${index}</p>` });
    await expect(store.publish(owner, 'mini-ui', { id: 'card-9', html: 'overflow' })).rejects.toThrow(/At most 8/);
    await expect(store.publish(owner, 'floating-ui', { id: 'card-9', html: 'separate store' })).resolves.toMatchObject({ kind: 'floating-ui' });
  });

  it('increments revisions, verifies code integrity, and removes only the selected artifact', async () => {
    const { kit, files } = fakeNativeKit();
    const store = createNativeArtifactStore(kit);
    await store.publish(owner, 'mini-ui', { id: 'clock', html: 'one' });
    const second = await store.publish(owner, 'mini-ui', { id: 'clock', html: 'two' });
    expect(second.revision).toBe(2);
    const versionRoot = `nativekit-object-store/artifacts/mini-ui/${encodeURIComponent(`mini-app:${owner.id}`)}/clock/versions/${second.integrity}`;
    files.set(`${versionRoot}/code.html`, 'tampered');
    await expect(store.read(owner, 'mini-ui', 'clock')).rejects.toThrow(/integrity verification/);
    files.set(`${versionRoot}/code.html`, 'two');
    await store.remove(owner, 'mini-ui', 'clock');
    await expect(store.read(owner, 'mini-ui', 'clock')).rejects.toThrow(/not found/);
  });
});

describe('native Mini App package storage', () => {
  it('round-trips arbitrary package bytes and deletes all package versions for one app', async () => {
    const { kit } = fakeNativeKit();
    const integrity = 'a'.repeat(64);
    const app = {
      id: 'com.example.time',
      integrity,
      files: [
        { path: 'index.html', bytes: new TextEncoder().encode('<title>Time</title>'), type: 'text/html' },
        { path: 'assets/logo.bin', bytes: new Uint8Array([0, 1, 2, 255]), type: 'application/octet-stream' },
      ],
    };
    await saveNativePackage(kit, app);
    const restored = await readNativePackage(kit, app.id, integrity);
    expect(restored.map((file) => file.path)).toEqual(['index.html', 'assets/logo.bin']);
    expect(new TextDecoder().decode(restored[0].bytes)).toBe('<title>Time</title>');
    expect([...restored[1].bytes]).toEqual([0, 1, 2, 255]);
    await deleteNativePackage(kit, app.id);
    await expect(readNativePackage(kit, app.id, integrity)).rejects.toThrow(/does not exist/);
  });

  it('does not rewrite a valid package when the same integrity is saved again', async () => {
    const { kit, files, failOnce } = fakeNativeKit();
    const integrity = 'd'.repeat(64);
    const app = { id: 'com.example.time', integrity, files: [{ path: 'index.html', bytes: new TextEncoder().encode('<title>Same</title>'), type: 'text/html' }] };
    await saveNativePackage(kit, app);
    const filePath = `nativekit-object-store/packages/${encodeURIComponent(app.id)}/${integrity}/files/index.html`;
    failOnce.add(filePath);
    await expect(saveNativePackage(kit, app)).resolves.toBeUndefined();
    expect(files.has(filePath)).toBe(true);
    await expect(readNativePackage(kit, app.id, integrity)).resolves.toHaveLength(1);
  });

  it('rejects traversal paths and incomplete package commits', async () => {
    const { kit } = fakeNativeKit();
    await expect(saveNativePackage(kit, {
      id: 'com.example.bad', integrity: 'b'.repeat(64), files: [{ path: '../host', bytes: new Uint8Array([1]), type: 'text/plain' }],
    })).rejects.toThrow(/Unsafe native object path/);
    await expect(readNativePackage(kit, 'com.example.bad', 'b'.repeat(64))).rejects.toThrow();
  });
});
