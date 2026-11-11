import {
  ARTIFACT_KINDS,
  assertNativeObjectStorage,
  createNativeArtifactStore,
  type NativeArtifactInput,
  type NativeArtifactKind,
  type NativeArtifactOwner,
  type NativeArtifactRecord,
  type NativeArtifactStore,
  type NativeObjectKit,
} from './native-object-store';

export const MINI_APP_HOME_WIDGET_SLOT_PREFIX = 'nativekit-miniapp-slot-';
const DEFAULT_HOME_WIDGET_SLOTS = 8;

type ArtifactManagerConfig = { maxActiveHomeWidgets?: number };
type MountedArtifact = {
  id: string;
  owner: NativeArtifactOwner;
  artifactId: string;
  frame: HTMLIFrameElement;
};
type FloatingOwner = { owner: NativeArtifactOwner; artifactId: string } | null;

function sameOwner(a: NativeArtifactOwner, b: NativeArtifactOwner): boolean {
  return a.type === b.type && a.id === b.id;
}

function sameArtifact(config: any, owner: NativeArtifactOwner, artifactId: string): boolean {
  const marker = config?.extra?.nativeKitArtifact;
  return marker === true && config.extra.sourceType === owner.type && config.extra.sourceId === owner.id && config.extra.artifactId === artifactId;
}

function sourceMarker(owner: NativeArtifactOwner, artifactId: string, integrity: string) {
  return {
    nativeKitArtifact: true,
    sourceType: owner.type,
    sourceId: owner.id,
    sourceName: owner.name,
    sourceVersion: owner.version,
    ...(owner.type === 'mini-app' ? { nativeKitAppBrowserId: owner.id } : {}),
    artifactId,
    integrity,
  };
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function artifactDocument(html: string, record: NativeArtifactRecord): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('base,meta[http-equiv="refresh" i],meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove());
  const csp = parsed.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  // Published Mini UI previews are intentionally broker-less and offline. The
  // original Mini App keeps using its normal token-bound App Browser session.
  csp.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
  parsed.head.prepend(csp);
  const source = parsed.createElement('meta');
  source.setAttribute('name', 'nativekit-artifact-source');
  source.setAttribute('content', `${record.source.type}:${record.source.id}:${record.id}:${record.integrity}`);
  parsed.head.prepend(source);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

export function createMiniAppArtifactManager(
  nativeKit: any,
  artifactStore: NativeArtifactStore = createNativeArtifactStore(nativeKit as NativeObjectKit),
  config: ArtifactManagerConfig = {},
) {
  const mounts = new Map<string, MountedArtifact>();
  let floatingOwner: FloatingOwner = null;
  let homeQueue: Promise<void> = Promise.resolve();
  let floatingQueue: Promise<void> = Promise.resolve();
  function serializedHome<T>(operation: () => Promise<T>): Promise<T> {
    const result = homeQueue.then(operation, operation);
    homeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  function serializedFloating<T>(operation: () => Promise<T>): Promise<T> {
    const result = floatingQueue.then(operation, operation);
    floatingQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  const maxSlots = Math.min(32, Math.max(1, Math.trunc(config.maxActiveHomeWidgets ?? DEFAULT_HOME_WIDGET_SLOTS)));

  function assertAndroidWidget(): void {
    assertNativeObjectStorage(nativeKit as NativeObjectKit);
    if (nativeKit.platform !== 'android') throw new Error('Mini App HTML widgets are currently supported on Android only');
    if (nativeKit.config.features.widget !== true) throw new Error('Native widget feature is disabled');
  }

  function notifyRefreshFailure(record: NativeArtifactRecord, error: unknown): void {
    try {
      window.dispatchEvent(new CustomEvent('nativekitappbrowserstatus', { detail: {
        appId: record.source.id,
        state: 'artifactRefreshFailed',
        reason: String((error as Error)?.message ?? error).slice(0, 500),
        artifactId: record.id,
        artifactKind: record.kind,
      } }));
    } catch { /* Non-DOM unit-test hosts have no status event surface. */ }
  }

  async function homeConfigurations(): Promise<Record<string, any>> {
    assertAndroidWidget();
    return await nativeKit.widget.listConfigs() ?? {};
  }

  function homeConfig(record: NativeArtifactRecord, html: string): Record<string, unknown> {
    return {
      render: 'html',
      html,
      title: record.title,
      widthPx: boundedNumber(record.config.widthPx, 320, 64, 1024),
      heightPx: boundedNumber(record.config.heightPx, 320, 64, 1024),
      sandboxed: true,
      // Artifact snapshots only open the trusted host; no arbitrary Mini App
      // action broadcast is exposed to the exported Android provider.
      extra: sourceMarker(record.source, record.id, record.integrity),
    };
  }

  async function refreshHomeActivations(record: NativeArtifactRecord, html: string): Promise<void> {
    if (record.kind !== 'home-widget' || nativeKit.platform !== 'android' || nativeKit.config.features.widget !== true) return;
    await serializedHome(async () => {
      const configurations = await homeConfigurations();
      for (const [kind, current] of Object.entries(configurations)) {
        if (kind.startsWith(MINI_APP_HOME_WIDGET_SLOT_PREFIX) && sameArtifact(current, record.source, record.id)) await nativeKit.widget.update(kind, homeConfig(record, html));
      }
    });
  }

  async function refreshFloatingActivation(record: NativeArtifactRecord, html: string): Promise<void> {
    if (record.kind !== 'floating-ui') return;
    await serializedFloating(async () => {
      if (!floatingOwner || !sameOwner(floatingOwner.owner, record.source) || floatingOwner.artifactId !== record.id) return;
      const current = await currentFloatingConfig();
      if (!sameArtifact({ extra: current?.data }, record.source, record.id)) return;
      await nativeKit.widget.updateFloating({ html, sandboxed: true, data: sourceMarker(record.source, record.id, record.integrity) });
    });
  }

  async function refreshMounts(record: NativeArtifactRecord, html: string): Promise<void> {
    if (record.kind !== 'mini-ui') return;
    for (const mount of mounts.values()) {
      if (sameOwner(mount.owner, record.source) && mount.artifactId === record.id) mount.frame.srcdoc = artifactDocument(html, record);
    }
  }

  async function publish(owner: NativeArtifactOwner, kind: NativeArtifactKind, input: NativeArtifactInput): Promise<NativeArtifactRecord> {
    const record = await artifactStore.publish(owner, kind, input);
    // A successful durable publish must not turn into a failed API call merely
    // because a currently-active native surface could not refresh.
    try {
      await refreshMounts(record, input.html);
      await refreshHomeActivations(record, input.html);
      await refreshFloatingActivation(record, input.html);
    } catch (error) { notifyRefreshFailure(record, error); }
    return record;
  }

  async function deactivateHome(owner: NativeArtifactOwner, artifactId?: string): Promise<void> {
    if (nativeKit.platform !== 'android' || nativeKit.config.features.widget !== true) return;
    await serializedHome(async () => {
      const configurations = await homeConfigurations();
      for (const [kind, current] of Object.entries(configurations)) {
        if (!kind.startsWith(MINI_APP_HOME_WIDGET_SLOT_PREFIX)) continue;
        const matchesOwner = current?.extra?.nativeKitArtifact === true && current.extra.sourceType === owner.type && current.extra.sourceId === owner.id;
        if (!matchesOwner || (artifactId && current.extra.artifactId !== artifactId)) continue;
        await nativeKit.widget.update(kind, {
          render: 'native', title: 'Unavailable', value: '',
          extra: { ...sourceMarker(owner, current.extra.artifactId, ''), nativeKitArtifactRemoved: true },
        });
      }
    });
  }

  async function currentFloatingConfig(): Promise<any> {
    try { return (await nativeKit.widget.getConfig('floating'))?.config ?? {}; }
    catch { return {}; }
  }

  async function hideFloating(owner?: NativeArtifactOwner, artifactId?: string): Promise<void> {
    if (nativeKit.platform !== 'android' || nativeKit.config.features.widget !== true) { floatingOwner = null; return; }
    await serializedFloating(async () => {
      const configValue = await currentFloatingConfig();
      const visible = (await nativeKit.widget.isFloatingVisible())?.visible === true;
      if (!visible) {
        floatingOwner = null;
        if (!owner) await nativeKit.widget.hideFloating(); // stop a failed/stale host service too
        return;
      }
      const marker = configValue?.data ?? {};
      if (owner && (!marker.nativeKitArtifact || marker.sourceType !== owner.type || marker.sourceId !== owner.id || (artifactId && marker.artifactId !== artifactId))) {
        throw new Error('The active floating UI belongs to the host or another source app');
      }
      await nativeKit.widget.hideFloating();
      floatingOwner = null;
    });
  }

  async function activeFloatingMatches(owner: NativeArtifactOwner, artifactId?: string): Promise<boolean> {
    if (nativeKit.platform !== 'android' || nativeKit.config.features.widget !== true) return false;
    const current = await currentFloatingConfig();
    const visible = (await nativeKit.widget.isFloatingVisible())?.visible === true;
    if (!visible) { floatingOwner = null; return false; }
    return sameArtifact({ extra: current?.data }, owner, artifactId ?? current?.data?.artifactId);
  }

  async function deactivateOwner(owner: NativeArtifactOwner, kind?: NativeArtifactKind): Promise<void> {
    if (!kind || kind === 'mini-ui') {
      for (const [id, mount] of mounts) if (sameOwner(mount.owner, owner)) { mount.frame.remove(); mounts.delete(id); }
    }
    if (!kind || kind === 'home-widget') await deactivateHome(owner);
    if ((!kind || kind === 'floating-ui') && await activeFloatingMatches(owner)) await hideFloating(owner);
  }

  async function activateHomeWidget(owner: NativeArtifactOwner, artifactId: string): Promise<{ kind: string; artifact: NativeArtifactRecord }> {
    assertAndroidWidget();
    return serializedHome(async () => {
      const { record, html } = await artifactStore.read(owner, 'home-widget', artifactId);
      const configurations = await homeConfigurations();
      let selected = Object.entries(configurations).find(([kind, current]) => kind.startsWith(MINI_APP_HOME_WIDGET_SLOT_PREFIX) && sameArtifact(current, owner, artifactId))?.[0];
      if (!selected) {
        for (let index = 1; index <= maxSlots; index += 1) {
          const candidate = `${MINI_APP_HOME_WIDGET_SLOT_PREFIX}${String(index).padStart(2, '0')}`;
          const current = configurations[candidate];
          if (!current || current?.extra?.nativeKitArtifactRemoved === true) { selected = candidate; break; }
        }
      }
      if (!selected) throw new Error(`All ${maxSlots} active Mini App home-widget slots are in use`);
      await nativeKit.widget.update(selected, homeConfig(record, html));
      return { kind: selected, artifact: record };
    });
  }

  async function showFloating(owner: NativeArtifactOwner, artifactId: string): Promise<Record<string, unknown>> {
    assertAndroidWidget();
    return serializedFloating(async () => {
      const permission = await nativeKit.widget.checkFloatingPermission();
      if (permission?.granted !== true) throw new Error('Display-over-other-apps permission is required; call floatingUI.requestPermission() first');
      const current = await currentFloatingConfig();
      const visible = (await nativeKit.widget.isFloatingVisible())?.visible === true;
      if (!visible) floatingOwner = null;
      if (visible && current?.data?.nativeKitArtifact !== true) throw new Error('The host currently owns the floating UI');
      if (visible && (current.data.sourceType !== owner.type || current.data.sourceId !== owner.id)) throw new Error('Another Mini App currently owns the floating UI');
      const { record, html } = await artifactStore.read(owner, 'floating-ui', artifactId);
      const result = await nativeKit.widget.showFloating({
        title: record.title,
        html,
        width: boundedNumber(record.config.width, 280, 80, 600),
        height: boundedNumber(record.config.height, 240, 80, 900),
        collapsed: record.config.collapsed === true,
        fullscreen: record.config.fullscreen === true,
        focusable: record.config.focusable === true,
        touchThrough: record.config.touchThrough === true,
        chrome: record.config.chrome === 'none' ? 'none' : 'bar',
        draggable: record.config.draggable !== false,
        sandboxed: true,
        data: sourceMarker(record.source, record.id, record.integrity),
      });
      floatingOwner = result?.shown === true ? { owner, artifactId } : null;
      return { ...result, artifact: record };
    });
  }

  return Object.freeze({
    limits: Object.freeze({ maxActiveHomeWidgets: maxSlots }),
    publish,
    read: (owner: NativeArtifactOwner, kind: NativeArtifactKind, id: string) => artifactStore.read(owner, kind, id),
    list: (owner: NativeArtifactOwner, kind?: NativeArtifactKind) => artifactStore.list(owner, kind),
    remove: async (owner: NativeArtifactOwner, kind: NativeArtifactKind, id: string) => {
      await artifactStore.read(owner, kind, id);
      if (kind === 'home-widget') await deactivateHome(owner, id);
      else if (kind === 'floating-ui') {
        if (await activeFloatingMatches(owner, id)) await hideFloating(owner, id);
      } else for (const [mountId, mount] of mounts) if (sameOwner(mount.owner, owner) && mount.artifactId === id) { mount.frame.remove(); mounts.delete(mountId); }
      return artifactStore.remove(owner, kind, id);
    },
    removeOwner: async (owner: NativeArtifactOwner) => {
      await deactivateOwner(owner);
      if (nativeKit.isNative) await artifactStore.removeOwner(owner);
    },
    deactivateOwner,
    mountMiniUI: async (owner: NativeArtifactOwner, artifactId: string, target: HTMLElement, options: { replace?: boolean; className?: string } = {}) => {
      assertNativeObjectStorage(nativeKit as NativeObjectKit);
      if (!(target instanceof HTMLElement)) throw new Error('Mini UI mount target must be an HTMLElement');
      const { record, html } = await artifactStore.read(owner, 'mini-ui', artifactId);
      const frame = document.createElement('iframe');
      frame.className = options.className ?? 'nativekit-mini-ui-artifact-frame';
      frame.title = record.title;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'");
      frame.dataset.nativekitArtifactSource = `${record.source.type}:${record.source.id}`;
      frame.dataset.nativekitArtifactId = record.id;
      frame.dataset.nativekitArtifactIntegrity = record.integrity;
      frame.srcdoc = artifactDocument(html, record);
      if (options.replace !== false) target.replaceChildren(frame); else target.append(frame);
      const id = crypto.randomUUID();
      mounts.set(id, { id, owner, artifactId, frame });
      return Object.freeze({ id, artifact: record, frame, stop: async () => { frame.remove(); mounts.delete(id); } });
    },
    activateHomeWidget,
    requestPinHomeWidget: async (owner: NativeArtifactOwner, artifactId: string) => {
      const active = await activateHomeWidget(owner, artifactId);
      const result = await nativeKit.widget.requestPin(active.kind);
      return { ...result, kind: active.kind, artifact: active.artifact };
    },
    showFloating,
    hideFloating,
    checkFloatingPermission: () => { assertAndroidWidget(); return nativeKit.widget.checkFloatingPermission(); },
    requestFloatingPermission: () => { assertAndroidWidget(); return nativeKit.widget.requestFloatingPermission(); },
    listActivations: async () => {
      const home = nativeKit.platform === 'android' && nativeKit.config.features.widget === true
        ? Object.entries(await homeConfigurations()).filter(([kind, value]) => kind.startsWith(MINI_APP_HOME_WIDGET_SLOT_PREFIX) && value?.extra?.nativeKitArtifact === true).map(([kind, value]) => ({ kind, ...value.extra }))
        : [];
      let floating: Record<string, unknown> | null = null;
      if (nativeKit.platform === 'android' && nativeKit.config.features.widget === true) {
        const current = await currentFloatingConfig();
        const visible = (await nativeKit.widget.isFloatingVisible())?.visible === true;
        if (visible && current?.data?.nativeKitArtifact === true) floating = current.data;
        if (!visible) floatingOwner = null;
      }
      return { home, floating, miniUI: [...mounts.values()].map((mount) => ({ id: mount.id, sourceType: mount.owner.type, sourceId: mount.owner.id, artifactId: mount.artifactId })) };
    },
  });
}

export type MiniAppArtifactManager = ReturnType<typeof createMiniAppArtifactManager>;
export { ARTIFACT_KINDS };
