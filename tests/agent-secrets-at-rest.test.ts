import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Contract tests for how the agent's credentials are stored.
//
// `auth-profiles.json` holds provider API keys and OAuth refresh tokens, and
// the engine's SQLite file holds the whole conversation history. These assert
// the protections that keep them on the device, because every one of them is a
// single line that is easy to delete by accident and impossible to notice
// missing — nothing fails, the secrets just start leaving.

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const SWIFT_PLUGIN = 'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift';
const RUST_AUTH = 'plugins/native-agent/rust/native-agent-ffi/src/auth.rs';
const APP_MANIFEST = 'android/app/src/main/AndroidManifest.xml';

describe('secrets at rest — iOS', () => {
  const swift = () => read(SWIFT_PLUGIN);

  it('excludes the auth store and database from iCloud backup', () => {
    const src = swift();
    expect(src).toContain('isExcludedFromBackup');
    // A backup is the one place these secrets leave the device without the
    // user choosing to send them anywhere.
    expect(src).toMatch(/hardenAtRest\s*\(/);
  });

  it('applies the hardening on BOTH entry points', () => {
    const src = swift();
    // initWorkspace() and initialize() each build their own paths; hardening
    // only one of them leaves the other unprotected.
    const calls = [...src.matchAll(/self\.hardenAtRest\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('covers the auth file AND the database', () => {
    const src = swift();
    expect(src).toMatch(/hardenAtRest\(\[[^\]]*Auth[^\]]*\]/);
    expect(src).toMatch(/hardenAtRest\(\[[^\]]*[Dd]b[^\]]*\]/);
  });

  it('uses completeUntilFirstUserAuthentication, never complete', () => {
    const src = swift();
    expect(src).toContain('completeUntilFirstUserAuthentication');
    // `.complete` makes a file unreadable while the device is locked, which
    // would break the entire point of this plugin: background cron wakes fire
    // with the phone in a pocket and must be able to read auth and the DB.
    expect(src).not.toMatch(/FileProtectionType\.complete\b/);
  });

  it('never lets a hardening failure break initialization', () => {
    const src = swift();
    const body = src.slice(src.indexOf('private func hardenAtRest'));
    const fn = body.slice(0, body.indexOf('\n    }\n') + 6);
    // Being unable to set a file attribute is not a reason to leave the user
    // without a working agent.
    expect(fn).toContain('try?');
    expect(fn).not.toMatch(/\btry\s+[A-Za-z]/);
  });
});

describe('secrets at rest — Android', () => {
  it('disables cloud backup for the whole app', () => {
    // Otherwise the auth store is copied into the user's Google Drive backup.
    expect(read(APP_MANIFEST)).toContain('android:allowBackup="false"');
  });
});

describe('secrets at rest — engine', () => {
  const auth = () => read(RUST_AUTH);

  it('writes the auth store owner-only', () => {
    expect(auth()).toContain('0o600');
  });

  it('writes atomically so a crash cannot destroy every stored key', () => {
    const src = auth();
    expect(src).toMatch(/\.tmp/);
    expect(src).toContain('fs::rename');
  });

  it('keeps a corrupt store instead of overwriting it', () => {
    expect(auth()).toContain('.corrupt.');
  });

  it('masks keys by character, never by byte slice', () => {
    const src = auth();
    expect(src).toContain('fn mask_key');
    // Strip comments first: the file deliberately DESCRIBES the old
    // `&key[..7]` bug, and matching that prose would be a false positive.
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // A byte slice panics on any multi-byte key.
    expect(code).not.toMatch(/&key\[\.\.\d+\]/);
    expect(code).toContain('chars()');
  });

  it('bounds a provider error body before putting it in an error string', () => {
    const src = auth();
    const idx = src.indexOf('OAuth refresh failed');
    expect(idx).toBeGreaterThan(-1);
    // An HTML error page from a proxy is routinely tens of KB.
    expect(src.slice(Math.max(0, idx - 400), idx)).toContain('safe_excerpt');
  });
});
