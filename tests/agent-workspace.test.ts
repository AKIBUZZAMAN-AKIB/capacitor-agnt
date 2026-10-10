import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('owner-facing AI Workspace', () => {
  const home = read('www/index.html');
  const agent = read('www/agent.html');
  const app = read('www/app.js');
  const page = read('www/agent-page.js');
  const ui = read('www/agent-workspace.js');
  const css = read('www/agent-workspace.css');
  const pageCss = read('www/agent-page.css');

  it('ships the workspace on a dedicated page with clear two-way navigation', () => {
    expect(home).toContain('href="./agent.html"');
    expect(home).not.toContain('id="agent-workspace"');
    expect(home).toContain('class="agent-lab-advanced"');
    expect(agent).toContain('id="agent-workspace"');
    expect(agent).toContain('href="./index.html"');
    expect(agent).toContain('./agent-page.js');
    expect(page).toContain("import { wireAgentWorkspace } from './agent-workspace.js'");
    expect(app).not.toContain("import('./agent-workspace.js')");
    expect(app).toContain("import('./agent-lab.js')");
    expect(pageCss).toContain('.agent-page-header');
  });

  it('offers real-user controls for the complete customization surface', () => {
    for (const id of [
      'aw-chat-input', 'aw-approval-queue', 'aw-cron-form', 'aw-wake-minutes',
      'aw-skill-form', 'aw-memory-form', 'aw-persona-editor', 'aw-mcp-form',
      'aw-provider-key', 'aw-key-provider', 'aw-tool-list', 'aw-router-form',
      'aw-router-list', 'aw-router-check', 'aw-router-live-test', 'aw-heartbeat-form',
      'aw-cron-skill', 'aw-heartbeat-skill', 'aw-tab-files', 'aw-files-list',
      'aw-files-picker', 'aw-files-include-skipped', 'aw-file-content', 'aw-file-save',
      'aw-file-delete', 'aw-file-insert-chat',
    ]) {
      expect(agent, `workspace is missing #${id}`).toContain(`id="${id}"`);
    }
    for (const operation of [
      'addCronJob', 'scheduleBackgroundWakes', 'addSkill', 'memory_store',
      'read_file', 'write_file', 'connectMcp', 'setToolPermission',
      'setHeartbeatConfig', 'autoRouting', 'getAuthStatus', 'provider.fallback',
    ]) {
      expect(ui, `workspace does not wire ${operation}`).toContain(operation);
    }
  });

  it('initializes automatically and leaves Free Router as the no-selection default', () => {
    expect(agent).toContain('<option value="auto">Free Router');
    expect(agent).toContain('Kilo আগে, verified free only');
    expect(ui).toContain('FREE_ROUTER_ROUTES');
    expect(ui).toContain('VERIFIED FREE');
    expect(agent).toContain('id="aw-chat-input" rows="3"');
    expect(ui).toContain('void initialize();');
    expect(ui).toContain('setComposerAvailability(true);');
    expect(ui).toContain("const provider = clean($('aw-provider').value || 'auto');");
    expect(ui).toContain("const provider = clean($('aw-key-provider').value);");
    expect(ui).toContain('Route choice and key management are intentionally separate');
  });

  it('makes the native private workspace auditable, including uploads and hidden folders', () => {
    expect(agent).toContain('data-aw-tab="files"');
    expect(agent).toContain('uploads/');
    expect(agent).toContain('hidden/system folder');
    expect(ui).toContain("invokeFile('list_files'");
    expect(ui).toContain("invokeFile('find_files'");
    expect(ui).toContain("invokeFile('write_file'");
    expect(ui).toContain("invokeFile('delete_file'");
    expect(ui).toContain('uploadWorkspaceFiles');
    expect(ui).toContain('include_skipped');
    expect(ui).toContain('data-aw-approval-queue');
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

  it('keeps raw conversation context on follow-ups and makes history reachable on phones', () => {
    expect(agent).toContain('id="aw-history-drawer"');
    expect(agent).toContain('id="aw-history-list"');
    expect(agent).toContain('./agent-workspace-icons.css');
    expect(agent).toContain('aw-icon-sprite');
    expect(ui).toContain('sessionReady: false');
    expect(ui).toContain('await nativeAgent().followUp({ prompt });');
    expect(ui).toContain("await nativeAgent().resumeSession({ sessionKey: state.sessionKey, agentId: 'main' });");
    expect(ui).toContain("await nativeAgent().resumeSession({ sessionKey, agentId: 'main' });");
    expect(ui).toContain('async function openHistory()');
    expect(ui).toContain("$('aw-refresh-sessions').addEventListener('click', () => void guarded('চ্যাট ইতিহাস', openHistory))");
    expect(ui).toContain('renderSessionList($(\'aw-history-list\'), 100);');
    const iconCss = read('www/agent-workspace-icons.css');
    expect(iconCss).toContain('.aw-history-drawer{position:fixed');
    expect(iconCss).toContain('.aw-icon-sprite');
  });

  it('removes decorative startup chrome and keeps touch scrolling owned by the active view', () => {
    for (const obsoleteCopy of ['PRIVATE ON-DEVICE AGENT', 'আমার AI Workspace', 'Agent শুরু হচ্ছে']) {
      expect(agent).not.toContain(obsoleteCopy);
    }
    expect(agent).not.toContain('id="aw-start"');
    expect(ui).not.toContain('Web preview-এ agent চলে না; Android/iOS build-এ ব্যবহার করুন।');
    expect(css).toContain('grid-template-rows:auto auto minmax(0,1fr) auto');
    expect(css).toContain('min-height:0;overflow-x:hidden;overflow-y:auto');
    expect(ui).toContain('window.visualViewport?.addEventListener(\'resize\'');
    expect(ui).toContain('chatAutoScroll');
    expect(ui).toContain('scrollChatToBottom();');
    const iconCss = read('www/agent-workspace-icons.css');
    expect(iconCss).toContain('touch-action:pan-y pinch-zoom');
    expect(iconCss).toContain('body.agent-page{height:var(--aw-viewport-height,100dvh)');
  });
});

describe('standalone native-page packaging', () => {
  const prepare = read('scripts/prepare-web.mjs');

  it('injects the bridge and CSP into agent.html as well as index.html', () => {
    expect(prepare).toContain("const agentPath = path.join(destination, 'agent.html')");
    expect(prepare).toContain('agentHtml = injectHeadAsset(agentHtml, bridgeTag, BRIDGE_MARKER)');
    expect(prepare).toContain('agentHtml = injectCsp(agentHtml, config.security.contentSecurityPolicy)');
    expect(prepare).toContain('await fs.writeFile(agentPath, agentHtml)');
  });
});
