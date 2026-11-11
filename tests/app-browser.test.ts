import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  appDatabase,
  detectComponentTag,
  gateAppBrowserHostSurface,
  inspectZipLimits,
  isAllowedAppHost,
  normalizeAppBrowserColorScheme,
  normalizeAppBrowserNetworkMode,
  normalizePackagePath,
  safeRelativeDataPath,
  safeSql,
} from '../bridge/app-browser';

const root = process.cwd();

describe('App Browser package boundary', () => {
  it('normalizes safe paths and rejects traversal/absolute/hidden paths', () => {
    expect(normalizePackagePath('assets\\main.js')).toBe('assets/main.js');
    expect(normalizePackagePath('./index.html')).toBe('index.html');
    for (const unsafe of ['../secret', 'assets/../../secret', '/absolute.html', '.hidden', 'a\0b']) {
      expect(() => normalizePackagePath(unsafe)).toThrow();
    }
  });

  it('checks ZIP central-directory file and expanded-byte limits before extraction', () => {
    const zip = zipSync({ 'index.html': strToU8('<h1>ok</h1>'), 'main.js': strToU8('console.log(1)') });
    expect(() => inspectZipLimits(zip, 2, 100)).not.toThrow();
    expect(() => inspectZipLimits(zip, 1, 100)).toThrow(/more than 1/);
    expect(() => inspectZipLimits(zip, 2, 5)).toThrow(/exceeds 5/);
    expect(() => inspectZipLimits(new Uint8Array([1, 2, 3]), 10, 100)).toThrow(/end-of-central-directory/);
  });

  it('normalizes per-app network modes fail-closed', () => {
    expect(normalizeAppBrowserNetworkMode('full')).toBe('full');
    expect(normalizeAppBrowserNetworkMode('hosts')).toBe('hosts');
    // OWNER RULE: absent/empty → 'full' (default always-allow); corrupted garbage fails closed.
    expect(normalizeAppBrowserNetworkMode('sandboxed')).toBe('sandboxed');
    for (const value of ['', undefined, null]) expect(normalizeAppBrowserNetworkMode(value)).toBe('full');
    for (const value of ['open', 3, {}, ['full']]) expect(normalizeAppBrowserNetworkMode(value)).toBe('sandboxed');
  });

  it('defaults colorScheme to dark, honors light only when explicit', () => {
    expect(normalizeAppBrowserColorScheme('light')).toBe('light');
    expect(normalizeAppBrowserColorScheme('dark')).toBe('dark');
    for (const value of ['', 'auto', undefined, null, 1, {}]) expect(normalizeAppBrowserColorScheme(value)).toBe('dark');
  });

  it('wires the single-file quick-add web component upload in the shell UI', () => {
    const manager = readFileSync(path.join(root, 'www/app-browser-manager.js'), 'utf8');
    const html = readFileSync(path.join(root, 'www/index.html'), 'utf8');
    expect(manager).toContain('kit.appBrowser.installWebComponent');
    expect(manager).toContain('function detectComponentTag');
    expect(html).toContain('QUICK ADD');
    expect(html).toContain('id="wc-install"');
    expect(html).toContain('id="wc-file"');
  });

  it('detects a registered custom-element tag from a quick-add web component module', () => {
    const source = `class NativeStatusCard extends HTMLElement {}\ncustomElements.define('native-status-card', NativeStatusCard);`;
    expect(detectComponentTag(source)).toBe('native-status-card');
    expect(detectComponentTag(`customElements.define("my-widget", MyWidget);`)).toBe('my-widget');
    expect(detectComponentTag(`window.customElements.define("nested.tag", C);`)).toBeUndefined();
    expect(detectComponentTag(`const tag = 'my-widget'; customElements.define(tag, MyWidget);`)).toBeUndefined();
    expect(detectComponentTag(`console.log('no component here');`)).toBeUndefined();
    expect(detectComponentTag(`customElements.define('notag', C);`)).toBeUndefined();
  });

  it('matches only explicit HTTP(S) host policy, including safe wildcards and ports', () => {
    expect(isAllowedAppHost('https://api.example.com/v1', ['*.example.com'])).toBe(true);
    expect(isAllowedAppHost('https://example.com/v1', ['*.example.com'])).toBe(false);
    expect(isAllowedAppHost('https://evil-example.com/v1', ['*.example.com'])).toBe(false);
    expect(isAllowedAppHost('https://api.example.com:8443/v1', ['api.example.com:8443'])).toBe(true);
    expect(isAllowedAppHost('https://api.example.com/v1', ['api.example.com:8443'])).toBe(false);
    expect(isAllowedAppHost('file:///etc/passwd', ['*'])).toBe(false);
  });

  it('uses collision-free app IDs in filesystem and SQLite namespaces', () => {
    expect(safeRelativeDataPath('demo.a_b', '')).not.toBe(safeRelativeDataPath('demo.a-b', ''));
    expect(appDatabase('demo.a_b', 'main')).not.toBe(appDatabase('demo.a-b', 'main'));
    expect(appDatabase('demo.app', 'a_b')).not.toBe(appDatabase('demo.app', 'a-b'));
    expect(() => safeRelativeDataPath('demo.app', '../host')).toThrow();
    expect(() => appDatabase('demo.app', '../../host')).toThrow();
  });

  it('blocks SQLite file/database escape primitives and bounds SQL text', () => {
    expect(safeSql("select 'ATTACH x' as harmless")).toContain('harmless');
    for (const sql of [
      "ATTACH DATABASE '/tmp/x' AS other",
      'DETACH DATABASE other',
      "VACUUM INTO '/tmp/x'",
      'PRAGMA database_list',
      'SELECT * FROM pragma_database_list',
      "SELECT load_extension('/tmp/x')",
      "SELECT \"load_extension\"('/tmp/x')",
      "SELECT readfile('/etc/passwd')",
      "SELECT \"readfile\"('/etc/passwd')",
      'CREATE TEMP VIRTUAL TABLE x USING fts5(body)',
    ]) expect(() => safeSql(sql)).toThrow(/not allowed/);
    expect(() => safeSql('x'.repeat(262_145))).toThrow(/exceeds/);
  });
});

describe('App Browser host feature gate', () => {
  it('wraps an already-frozen nested surface without Proxy invariant failures', async () => {
    const calls: string[] = [];
    const frozen = Object.freeze({
      capabilities: Object.freeze(['http']),
      list: async () => { calls.push('list'); return ['ok']; },
      audit: Object.freeze({ summary: async () => { calls.push('summary'); return { total: 1 }; } }),
    });
    let enabled = true;
    const gated = gateAppBrowserHostSurface(frozen, () => enabled);

    expect(gated).not.toBe(frozen);
    expect(Object.isFrozen(gated)).toBe(true);
    expect(Object.isFrozen(gated.audit)).toBe(true);
    expect(gated.capabilities).toEqual(['http']);
    await expect(gated.list()).resolves.toEqual(['ok']);
    await expect(gated.audit.summary()).resolves.toEqual({ total: 1 });
    enabled = false;
    expect(gated.capabilities).toEqual(['http']);
    expect(() => gated.list()).toThrow(/appBrowser/);
    expect(() => gated.audit.summary()).toThrow(/appBrowser/);
    expect(calls).toEqual(['list', 'summary']);
  });
});

describe('App Browser broker security invariants', () => {
  const source = readFileSync(path.join(root, 'bridge/app-browser.ts'), 'utf8');
  const nativeSource = readFileSync(path.join(root, 'bridge/nativekit.ts'), 'utf8');
  const declarationSource = readFileSync(path.join(root, 'types/nativekit.d.ts.template'), 'utf8');
  const installedDeclaration = declarationSource.slice(declarationSource.indexOf('/* Installed-package façade'), declarationSource.indexOf('\ndeclare global {'));
  const androidPluginSource = readFileSync(path.join(root, 'plugins/custom-native/android/src/main/java/dev/nativekit/custom/NativeKitCustomPlugin.java'), 'utf8');
  const iosPluginSource = readFileSync(path.join(root, 'plugins/custom-native/ios/Sources/NativeKitCustomPlugin/NativeKitCustomPlugin.swift'), 'utf8');

  it('uses the minimum opaque-origin iframe sandbox', () => {
    expect(source).toContain("frame.setAttribute('sandbox', 'allow-scripts')");
    expect(source).not.toContain('allow-same-origin');
    expect(source).not.toContain('allow-top-navigation');
    expect(source).not.toContain('allow-downloads');
    expect(source).not.toContain('allow-modals');
  });

  it('blocks non-local native WebView navigations that could reset sandbox CSP', () => {
    expect(androidPluginSource).toContain('@Override public Boolean shouldOverrideLoad(Uri url)');
    expect(androidPluginSource).toContain('"about:srcdoc".equalsIgnoreCase(url.toString())');
    expect(androidPluginSource).toContain('return true;');
    expect(iosPluginSource).toContain('override func shouldOverrideLoad(_ navigationAction: WKNavigationAction)');
    expect(iosPluginSource).toContain('url.absoluteString.lowercased() == "about:srcdoc"');
    expect(iosPluginSource).toContain('return NSNumber(value: true)');
  });

  it('binds RPC to both an unguessable token and exact frame window', () => {
    expect(source).toContain('item.token === message.token && event.source === item.frame.contentWindow');
    expect(source).toContain("event.source!==parent||event.data?.channel!==CHANNEL||event.data?.token!==TOKEN");
    expect(source).toContain("args = boundedJson(Array.isArray(args) ? args : [], 2_097_152, 'RPC arguments')");
  });

  it('escapes injected script data and removes the bootstrap script node', () => {
    expect(source).toContain("JSON.stringify(value).replaceAll('<', '\\\\u003c')");
    expect(source).toContain('document.currentScript?.remove()');
  });

  it('defaults policy to tri-state call-time consent and limits configured automatic grants to requested capabilities', () => {
    expect(source).toContain('config.defaultCapabilities.includes(capability) && requested');
    expect(source).toContain("requested ? 'ask' : 'block'");
    expect(source).toContain("type AppBrowserPermissionAction = 'allow_once' | 'allow_always' | 'block_once' | 'block_always'");
  });

  it('forces redirect denial and host checks for requests, streams, and transfers', () => {
    expect(source.match(/disableRedirects: true/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(source).toContain('checkAppUrl(ctx, options?.url)');
    expect(nativeSource).toContain("if (options.disableRedirects) requestInit.redirect = 'manual'");
  });

  it('does not expose deep links, global push tokens, or delivered push inventory', () => {
    expect(source).not.toContain("'app.urlOpen'");
    expect(source).not.toContain("'push.register'");
    expect(source).not.toContain("'push.delivered'");
    expect(source).not.toContain("'push.registration'");
    expect(source).toContain("payload?.data?.nativeKitAppBrowserId === session.app.id");
  });

  it('routes notifications and alarms by app and requires explicit alarm IDs', () => {
    expect(source).toContain('notificationNativeId(ctx.app.id, item.id, true)');
    expect(source).toContain('nativeKitAppBrowserId: ctx.app.id');
    expect(source).toContain('const nativeId = appAlarmId(ctx.app.id, id)');
    expect(source).toContain('item?.extra?.nativeKitAppBrowserId === ctx.app.id');
    expect(source).toContain('nativeKit.alarms.stop(nativeId)');
    expect(source).not.toContain('nativeKit.alarms.stop()');
    expect(source).toContain('App Browser notification quota exceeded');
    expect(source).toContain('App Browser alarm quota exceeded');
  });

  it('bounds sandbox persistence, verifies SQLite quota, and rolls back failed ownership writes', () => {
    expect(source).toContain("boundedString(value, 1_048_576, 'Preferences value')");
    expect(source).toContain("boundedString(value, 65_536, 'Secure-storage value')");
    expect(source).toContain('Sandbox filesystem quota exceeded');
    expect(source).toContain("sqlite.query(name, 'PRAGMA max_page_count')");
    expect(source).toContain('Unable to enforce the sandbox database size limit');
    expect(source).toContain("await idbDelete('resources', registration.resourceId)");
    expect(source).toContain('Storage write failed and ownership registration rollback also failed');
  });

  it('persists an invocation record before native side effects and waits for IndexedDB commit', () => {
    expect(source).toContain('transaction.oncomplete = () => { db.close(); if (!failed) resolve(result); }');
    expect(source).toContain('await runWithDurablePrecondition(');
    expect(source).toContain('() => saveAudit(auditRecord, false)');
    expect(source.indexOf('() => saveAudit(auditRecord, false)')).toBeLessThan(source.indexOf('const result = await definition.run'));
    expect(source).toContain("error: 'OUTCOME_PENDING'");
  });

  it('keeps hidden URI/plugin APIs out of dispatch, bootstrap, and installed declarations', () => {
    expect(source).not.toContain("'filesystem.getUri'");
    expect(source).not.toContain("'preferences.keys'");
    expect(source).not.toContain("'secureStorage.clear'");
    expect(source).not.toContain("'app.exit'");
    expect(installedDeclaration).not.toContain('getUri(');
    expect(installedDeclaration).not.toContain("NativeKitAPI['haptics']");
    expect(installedDeclaration).not.toContain("Pick<NativeKitAPI['preferences']");
    expect(installedDeclaration).not.toContain("Pick<NativeKitAPI['secureStorage']");
  });

  it('keeps installed declarations aligned to exact broker-safe results and events', () => {
    expect(installedDeclaration).toContain("getPhoto(options?: NativeKitInstalledCameraOptions): Promise<NativeKitInstalledPhoto>");
    expect(installedDeclaration).toContain("readFile(options: NativeKitInstalledFilesystemOptions & { encoding?: NativeKitEncoding }): Promise<{ data: string }>");
    expect(installedDeclaration).toContain("download(options: NativeKitInstalledFilesystemOptions & { url: string; headers?: Record<string, string> }): Promise<NativeKitInstalledDownloadResult>");
    expect(installedDeclaration).toContain("backgroundLocation: NativeKitInstalledBackgroundLocationStatus");
    expect(installedDeclaration).toContain("subscribe<K extends NativeKitInstalledEventName>(eventName: K, callback: (event: NativeKitInstalledEventMap[K]) => void");
    expect(installedDeclaration).toContain("'http.stream':");
    expect(installedDeclaration).toContain("schedule?: NativeKitInstalledNotificationEventSchedule");
  });

  it('bounds all broker responses/events and preserves failed cleanup for retry', () => {
    expect(source).toContain("return boundedJson(value, 2_097_152, 'RPC response or event payload')");
    expect(source).toContain('const payload = boundedRpcPayload');
    expect(source).toContain('throwCleanupErrors(errors');
    expect(source).toContain('could not be fully removed; retry removal');
    expect(source).toContain('deleteOwnedStorageAndFiles(appId)');
    expect(source).toContain('deleteOwnedDatabases(appId)');
  });

  it('skips unavailable cleanup facades while retaining retryable cleanup metadata', () => {
    expect(source).toContain('nativeKit.config.features.filesystem === true');
    expect(source).toContain('nativeKit.config.features.localNotifications === true');
    expect(source).toContain('nativeKit.config.features.advancedAlarms === true');
    expect(source).toContain("catch (error) { errors.push(cleanupError(`database ${resource.logicalId}`, error)); }");
    expect(source).toContain("catch (error) { errors.push(cleanupError(`secure-storage key ${resource.logicalId}`, error)); }");
  });

  it('releases active native side effects on update, final-session close, and renderer failure', () => {
    expect(source).toMatch(/if \(integrityChanged\) \{[\s\S]*?policy\.enabled = false;/);
    expect(source).toContain('await saveInstalledAppAndPolicy(app, policy, nativeKit)');
    expect(source).toContain("['native resource revocation', () => releaseOwnedNativeState(app.id)]");
    expect(source).toContain("releaseOwnedNativeState(appId, capability)");
    expect(source).toContain('const hasAnotherAppSession = Array.from(sessions.values()).some');
    expect(source).toContain('if (!hasAnotherAppSession)');
    expect(source).toContain("cancelPendingPermissions((request) => request.sessionId === sessionId, 'The requesting renderer failed')");
    expect(source).toContain("['native resource revocation', () => releaseOwnedNativeState(session.app.id)]");
  });

  it('limits direct-web CSP to the app policy and restarts sessions after host-policy changes', () => {
    expect(source).toContain('policy.allowedHosts.map((host) => `https://${host}`)');
    // Open internet exists ONLY behind the owner-approved 'full' network mode.
    expect(source).toContain("const networkMode = policy.networkMode ?? 'full';");
    expect(source).toContain("if (networkMode === 'full') {");
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("if (policy.allowedHosts.join('\\n') !== previous)");
  });
});
