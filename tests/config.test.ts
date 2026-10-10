import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const config = JSON.parse(readFileSync(path.join(root, 'app.config.json'), 'utf8'));
const schema = JSON.parse(readFileSync(path.join(root, 'app.config.schema.json'), 'utf8'));

describe('central app configuration', () => {
  it('matches the strict JSON schema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    expect(ajv.validate(schema, config), JSON.stringify(ajv.errors)).toBe(true);
  });

  it('keeps the background task identifiers aligned', () => {
    expect(config.backgroundRunner.label).toBe(config.backgroundRunner.taskIdentifier);
    expect(config.backgroundRunner.intervalMinutes).toBeGreaterThanOrEqual(15);
  });

  it('uses trusted local content without a production remote server URL', () => {
    expect(config.security.trustedLocalContentOnly).toBe(true);
    expect(JSON.stringify(config)).not.toContain('server.url');
    expect(config.security.allowNavigation).toEqual([]);
  });

  it('keeps uploaded apps deny-by-default behind explicit broker limits', () => {
    expect(config.features.appBrowser).toBe(config.appBrowser.enabled);
    expect(config.appBrowser.defaultCapabilities).toEqual([]);
    expect(config.appBrowser.allowDirectWebNetwork).toBe(false);
    expect(config.appBrowser.maxPackageBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
    expect(config.appBrowser.maxRequestsPerMinute).toBeGreaterThanOrEqual(10);
  });

  it('does not silently enable policy-sensitive capabilities', () => {
    if (config.features.backgroundLocation) {
      expect(config.android.backgroundLocationForegroundService || config.ios.backgroundLocation).toBe(true);
    }
    if (config.ios.alarmKitOnIOS26) expect(config.features.advancedAlarms).toBe(true);
    if (config.android.fullScreenAlarm) expect(config.features.advancedAlarms).toBe(true);
  });

  it('rebuilds the Android signing preamble at a physical android block boundary', () => {
    const configure = readFileSync(path.join(root, 'scripts/configure-native.mjs'), 'utf8');
    const gradle = readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
    expect(configure).toContain("const androidBlockStart = build.indexOf('\\nandroid {')");
    expect(configure).toContain('build = `${applicationPlugin}\\n\\n${signingPreamble}${build.slice(androidBlockStart)}`');
    expect(gradle).toContain('def nativeKitKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")');
    expect(gradle).not.toContain("def nativeKitKeystorePa\n\t\tdirs");
  });
});
