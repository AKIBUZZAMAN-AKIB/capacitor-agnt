import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const config = JSON.parse(read('app.config.json'));

describe('Mini App artifact native build contract', () => {
  it('generates every configured owner-bound Android provider slot', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    for (let index = 1; index <= config.appBrowser.maxActiveHomeWidgets; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const kind = `nativekit-miniapp-slot-${suffix}`;
      const name = `nativekit_miniapp_slot_${suffix}`;
      expect(manifest).toContain(`dev.nativekit.shell.Widget_${name}`);
      expect(manifest).toContain(`@xml/${name}_widget_provider`);
      expect(read(`android/app/src/main/java/dev/nativekit/shell/Widget_${name}.java`)).toContain(`return "${kind}"`);
      expect(read(`android/app/src/main/res/xml/${name}_widget_provider.xml`)).toContain('<appwidget-provider');
    }
    expect(read('scripts/configure-native.mjs')).toContain('function allHomeWidgetKinds()');
  });

  it('keeps untrusted artifact WebViews offline and away from host files/interfaces', () => {
    for (const file of [
      'plugins/widget/android/src/main/java/dev/nativekit/widget/HtmlWidgetRenderer.java',
      'plugins/widget/android/src/main/java/dev/nativekit/widget/FloatingWidgetService.java',
    ]) {
      const source = read(file);
      expect(source).toContain('setBlockNetworkLoads(sandboxed)');
      expect(source).toContain('setAllowFileAccess(!sandboxed)');
      expect(source).toContain('setAllowContentAccess(!sandboxed)');
      expect(source).toContain('https://miniapp.invalid/');
    }
    expect(read('plugins/widget/android/src/main/java/dev/nativekit/widget/FloatingWidgetService.java')).toContain('if (!sandboxed) webView.addJavascriptInterface');
  });

  it('enforces source attribution for every reserved native slot update', () => {
    const plugin = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetPlugin.java');
    expect(plugin).toContain('enforceArtifactSlotBinding(getContext(), kind, config)');
    expect(plugin).toContain('nativeKitAppBrowserId');
    expect(plugin).toContain('This widget slot belongs to another Mini App');
    const provider = read('plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetProvider.java');
    expect(provider).toContain('Trust only the currently persisted action');
    expect(provider).not.toContain('forward.putExtra("action", intent.getStringExtra("action"))');
  });

  it('mirrors the three capabilities and both host/Mini App declaration surfaces', () => {
    for (const file of ['bridge/app-browser.ts', 'bridge/device-tools.ts', 'types/nativekit.d.ts.template', 'app.config.schema.json']) {
      const source = read(file);
      for (const capability of ['miniUI', 'floatingUI', 'homeWidget']) expect(source).toContain(capability);
    }
    const declarations = read('types/nativekit.d.ts.template');
    expect(declarations).toContain('readonly artifacts: NativeKitArtifactHostSurface');
    expect(declarations).toContain('miniUI: NativeKitInstalledArtifactGroup');
    expect(declarations).toContain('homeWidget: NativeKitInstalledArtifactGroup');
    expect(declarations).toContain("storage: { backend: 'native-filesystem'; directory: 'Data'; store: string }");
  });

  it('ships an installable three-artifact sample and host lifecycle controls', () => {
    const manifest = JSON.parse(read('examples/app-browser-artifacts/nativekit.manifest.json'));
    expect(manifest.requestedCapabilities).toEqual(['miniUI', 'floatingUI', 'homeWidget']);
    expect(read('examples/app-browser-artifacts/app.js')).toContain("publish('miniUI'");
    expect(read('www/app-browser-manager.js')).toContain('mountMiniUI');
    expect(read('www/app-browser-manager.js')).toContain('requestPinHomeWidget');
    expect(read('www/index.html')).toContain('artifacts-list');
  });
});
