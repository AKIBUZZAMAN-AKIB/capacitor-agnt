import { describe, expect, it, vi } from 'vitest';
import { createMiniAppArtifactManager } from '../bridge/mini-app-artifacts';
import type { NativeArtifactOwner } from '../bridge/native-object-store';

function nativeHarness(maxActiveHomeWidgets = 8) {
  const files = new Map<string, string>();
  const configs: Record<string, any> = {};
  const kit: any = {
    isNative: true,
    platform: 'android',
    config: { features: { filesystem: true, widget: true }, app: { id: 'host.app', name: 'Host', versionName: '1' } },
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
    widget: {
      listConfigs: vi.fn(async () => configs),
      update: vi.fn(async (kind: string, config: any) => { configs[kind] = config; return { kind, saved: true }; }),
      requestPin: vi.fn(async (kind: string) => ({ requested: true, kind })),
      getConfig: vi.fn(async (kind: string) => ({ kind, config: configs[kind] ?? null })),
      checkFloatingPermission: vi.fn(async () => ({ granted: true })),
      requestFloatingPermission: vi.fn(async () => undefined),
      isFloatingVisible: vi.fn(async () => ({ visible: !!configs.floating })),
      showFloating: vi.fn(async (config: any) => { configs.floating = config; return { running: true, shown: true }; }),
      updateFloating: vi.fn(async (patch: any) => { configs.floating = { ...configs.floating, ...patch }; return { delivered: true, running: true }; }),
      hideFloating: vi.fn(async () => { delete configs.floating; }),
    },
  };
  return { kit, files, configs };
}

const time: NativeArtifactOwner = { type: 'mini-app', id: 'com.example.time', name: 'Time', version: '1.0.0' };
const weather: NativeArtifactOwner = { type: 'mini-app', id: 'com.example.weather', name: 'Weather', version: '2.0.0' };

describe('owner-bound native home widget slots', () => {
  it('allocates separate attributed slots and refreshes only the matching artifact', async () => {
    const { kit, configs } = nativeHarness();
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'home-widget', { id: 'stopwatch', html: '<p>00:00</p>' });
    await manager.publish(weather, 'home-widget', { id: 'stopwatch', html: '<p>Rain</p>' });
    const first = await manager.activateHomeWidget(time, 'stopwatch');
    const second = await manager.activateHomeWidget(weather, 'stopwatch');
    expect(first.kind).toBe('nativekit-miniapp-slot-01');
    expect(second.kind).toBe('nativekit-miniapp-slot-02');
    expect(configs[first.kind].extra).toMatchObject({ nativeKitArtifact: true, nativeKitAppBrowserId: time.id, artifactId: 'stopwatch' });
    expect(configs[second.kind].extra).toMatchObject({ nativeKitAppBrowserId: weather.id });
    expect(configs[first.kind].sandboxed).toBe(true);

    const updated = await manager.publish(time, 'home-widget', { id: 'stopwatch', html: '<p>00:01</p>' });
    expect(updated.revision).toBe(2);
    expect(configs[first.kind].html).toBe('<p>00:01</p>');
    expect(configs[first.kind].extra.integrity).toBe(updated.integrity);
    expect(configs[second.kind].html).toBe('<p>Rain</p>');
    expect(await manager.requestPinHomeWidget(time, 'stopwatch')).toMatchObject({ requested: true, kind: first.kind });
  });

  it('fails instead of overwriting another app when all active slots are occupied', async () => {
    const { kit } = nativeHarness(1);
    const manager = createMiniAppArtifactManager(kit, undefined, { maxActiveHomeWidgets: 1 });
    await manager.publish(time, 'home-widget', { id: 'main', html: 'time' });
    await manager.publish(weather, 'home-widget', { id: 'main', html: 'weather' });
    await manager.activateHomeWidget(time, 'main');
    await expect(manager.activateHomeWidget(weather, 'main')).rejects.toThrow(/All 1 active/);
    expect((await manager.read(weather, 'home-widget', 'main')).html).toBe('weather');
  });

  it('serializes concurrent allocation so two owners cannot claim the same slot', async () => {
    const { kit, configs } = nativeHarness();
    kit.widget.listConfigs.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return configs;
    });
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'home-widget', { id: 'main', html: 'time' });
    await manager.publish(weather, 'home-widget', { id: 'main', html: 'weather' });
    const activations = await Promise.all([
      manager.activateHomeWidget(time, 'main'),
      manager.activateHomeWidget(weather, 'main'),
    ]);
    expect(new Set(activations.map((item) => item.kind)).size).toBe(2);
    expect(configs['nativekit-miniapp-slot-01'].extra.sourceId).not.toBe(configs['nativekit-miniapp-slot-02'].extra.sourceId);
  });

  it('marks vacated slots without deleting another app activation', async () => {
    const { kit, configs } = nativeHarness();
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'home-widget', { id: 'main', html: 'time' });
    await manager.publish(weather, 'home-widget', { id: 'main', html: 'weather' });
    const first = await manager.activateHomeWidget(time, 'main');
    const second = await manager.activateHomeWidget(weather, 'main');
    await manager.remove(time, 'home-widget', 'main');
    expect(configs[first.kind].extra.nativeKitArtifactRemoved).toBe(true);
    expect(configs[second.kind].html).toBe('weather');
    await expect(manager.read(time, 'home-widget', 'main')).rejects.toThrow(/not found/);
  });
});

describe('single-owner floating artifact activation', () => {
  it('requires overlay permission and publishes sandboxed self-contained HTML', async () => {
    const { kit, configs } = nativeHarness();
    kit.widget.checkFloatingPermission.mockResolvedValueOnce({ granted: false });
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'floating-ui', { id: 'stopwatch', html: '<button>Start</button>', config: { width: 300, chrome: 'none' } });
    await expect(manager.showFloating(time, 'stopwatch')).rejects.toThrow(/permission/);
    const result = await manager.showFloating(time, 'stopwatch');
    expect(result).toMatchObject({ running: true, shown: true });
    expect(configs.floating).toMatchObject({ html: '<button>Start</button>', sandboxed: true, width: 300, chrome: 'none' });
    expect(configs.floating.data).toMatchObject({ nativeKitArtifact: true, sourceId: time.id, artifactId: 'stopwatch' });
    await manager.publish(time, 'floating-ui', { id: 'stopwatch', html: '<button>Restart</button>' });
    expect(configs.floating.html).toBe('<button>Restart</button>');
    await manager.hideFloating(time, 'stopwatch');
    expect(configs.floating).toBeUndefined();
  });

  it('recovers floating ownership from native state after a manager restart', async () => {
    const { kit, configs } = nativeHarness();
    const first = createMiniAppArtifactManager(kit);
    await first.publish(time, 'floating-ui', { id: 'main', html: 'time' });
    await first.publish(weather, 'floating-ui', { id: 'main', html: 'weather' });
    await first.showFloating(time, 'main');
    const restarted = createMiniAppArtifactManager(kit);
    await restarted.remove(weather, 'floating-ui', 'main');
    expect(configs.floating.data.sourceId).toBe(time.id);
    await restarted.publish(weather, 'floating-ui', { id: 'main', html: 'weather' });
    await expect(restarted.showFloating(weather, 'main')).rejects.toThrow(/Another Mini App/);
    delete configs.floating; // OS/user stopped the overlay while the host was away.
    await restarted.showFloating(weather, 'main');
    expect(configs.floating.data.sourceId).toBe(weather.id);
  });

  it('prevents cross-owner hide, overwrite, and removal side effects', async () => {
    const { kit, configs } = nativeHarness();
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'floating-ui', { id: 'main', html: 'time' });
    await manager.publish(weather, 'floating-ui', { id: 'main', html: 'weather' });
    await manager.showFloating(time, 'main');
    await expect(manager.showFloating(weather, 'main')).rejects.toThrow(/Another Mini App/);
    await expect(manager.hideFloating(weather, 'main')).rejects.toThrow(/another source app/);
    await manager.remove(weather, 'floating-ui', 'main');
    expect(configs.floating.html).toBe('time');
  });
});

describe('artifact lifecycle and platform boundaries', () => {
  it('deactivates all native surfaces before removing an owner store', async () => {
    const { kit, configs } = nativeHarness();
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'home-widget', { id: 'main', html: 'home' });
    await manager.publish(time, 'floating-ui', { id: 'main', html: 'float' });
    await manager.activateHomeWidget(time, 'main');
    await manager.showFloating(time, 'main');
    await manager.removeOwner(time);
    expect(configs.floating).toBeUndefined();
    expect(configs['nativekit-miniapp-slot-01'].extra.nativeKitArtifactRemoved).toBe(true);
    await expect(manager.list(time)).resolves.toEqual([]);
  });

  it('does not pretend HTML widget activation works on iOS or web', async () => {
    const { kit } = nativeHarness();
    kit.platform = 'ios';
    const manager = createMiniAppArtifactManager(kit);
    await manager.publish(time, 'home-widget', { id: 'main', html: 'stored natively' });
    await expect(manager.activateHomeWidget(time, 'main')).rejects.toThrow(/Android only/);
    kit.isNative = false;
    await expect(manager.publish(time, 'mini-ui', { html: 'no web fallback' })).rejects.toThrow(/unavailable on the hosted web/);
  });
});
