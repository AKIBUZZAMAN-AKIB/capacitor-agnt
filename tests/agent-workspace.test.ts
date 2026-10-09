import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('owner-facing AI Workspace', () => {
  const html = read('www/index.html');
  const app = read('www/app.js');
  const ui = read('www/agent-workspace.js');
  const css = read('www/agent-workspace.css');

  it('ships the workspace in the trusted app and preserves the advanced lab', () => {
    expect(html).toContain('id="agent-workspace"');
    expect(html).toContain('./agent-workspace.css');
    expect(html).toContain('class="agent-lab-advanced"');
    expect(app).toContain("import('./agent-workspace.js')");
    expect(app).toContain("import('./agent-lab.js')");
  });

  it('offers real-user controls for the complete customization surface', () => {
    for (const id of [
      'aw-chat-input', 'aw-approval-queue', 'aw-cron-form', 'aw-wake-minutes',
      'aw-skill-form', 'aw-memory-form', 'aw-persona-editor', 'aw-mcp-form',
      'aw-provider-key', 'aw-tool-list', 'aw-router-form', 'aw-router-list',
      'aw-router-check', 'aw-router-live-test', 'aw-heartbeat-form', 'aw-cron-skill', 'aw-heartbeat-skill',
    ]) {
      expect(html, `workspace is missing #${id}`).toContain(`id="${id}"`);
    }
    for (const operation of [
      'addCronJob', 'scheduleBackgroundWakes', 'addSkill', 'memory_store',
      'read_file', 'write_file', 'connectMcp', 'setToolPermission',
      'setHeartbeatConfig', 'autoRouting', 'getAuthStatus', 'provider.fallback',
    ]) {
      expect(ui, `workspace does not wire ${operation}`).toContain(operation);
    }
  });

  it('keeps one native handle across the user workspace and the diagnostic Lab', () => {
    expect(ui).toContain('globalThis.__nativeKitAgentInitialized = true');
    const lab = read('www/agent-lab.js');
    expect(lab).toContain('globalThis.__nativeKitAgentInitialized');
    expect(lab).toContain('reused: true');
  });

  it('does not persist MCP tokens in preferences or transcript configuration', () => {
    expect(ui).toContain('secureStorage.set(mcpTokenKey(name), token)');
    expect(ui).toContain('secureStorage.get(mcpTokenKey(config.name))');
    expect(ui).toContain('preferences.setJSON(MCP_PREF_KEY, state.mcpConfigs)');
    expect(ui).not.toContain('token: $(\'aw-mcp-token\')');
    expect(ui).toContain("approvalPolicy: config.alwaysAsk === false ? 'always_allow' : 'always_ask'");
  });

  it('uses responsive and mobile-safe workspace layouts', () => {
    expect(css).toContain('.aw-shell{display:grid');
    expect(css).toContain('@media(max-width:900px)');
    expect(css).toContain('@media(max-width:560px)');
  });
});
