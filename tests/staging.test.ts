import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const staged = path.join(root, '.nativekit/staged-www');

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/prepare-web.mjs', '--target', 'native'], {
    cwd: root,
    stdio: 'pipe'
  });
});

describe('native web staging', () => {
  it('injects the generated bridge before application scripts on every native page', () => {
    const html = readFileSync(path.join(staged, 'index.html'), 'utf8');
    const bridgeIndex = html.indexOf('nativekit.js');
    const appIndex = html.indexOf('app.js');
    expect(bridgeIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeGreaterThan(bridgeIndex);

    const agentHtml = readFileSync(path.join(staged, 'agent.html'), 'utf8');
    const agentBridgeIndex = agentHtml.indexOf('nativekit.js');
    const agentAppIndex = agentHtml.indexOf('agent-page.js');
    expect(agentBridgeIndex).toBeGreaterThan(-1);
    expect(agentAppIndex).toBeGreaterThan(agentBridgeIndex);
    expect(agentHtml).toContain('Content-Security-Policy');
    expect(existsSync(path.join(staged, 'nativekit.js'))).toBe(true);
  });

  it('keeps native output local and removes service-worker registration', () => {
    const html = readFileSync(path.join(staged, 'index.html'), 'utf8');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toMatch(/serviceWorker\.register/i);
    expect(existsSync(path.join(staged, 'service-worker.js'))).toBe(false);
  });

  it('contains no staged symbolic links', () => {
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        expect(lstatSync(target).isSymbolicLink()).toBe(false);
        if (entry.isDirectory()) visit(target);
      }
    };
    visit(staged);
  });
});
