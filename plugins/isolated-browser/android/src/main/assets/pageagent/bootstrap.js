/*
 * NativeKit PageAgent bootstrap.
 * Runs at document start (injected together with the vendored PageAgent IIFE).
 * window.__NATIVEKIT_PAGE_AGENT__ is written by the native side immediately
 * before this script; it carries the session relay token, the free-route model
 * name/base URL and UX flags.
 *
 * Design notes:
 *  - The LLM never talks to the network from page JS: every model call goes
 *    through window.NativeKitPageAgent (a WebMessageListener channel owned by
 *    the native side) which relays it to the engine's free route. That keeps
 *    the page CSP irrelevant (the bridge is not a network request), keeps any
 *    provider secret out of the page, and lets the native side cap usage.
 *  - IMPORTANT: this script runs at TRUE document start — document.body (and
 *    usually document.head) do not exist yet. Instantiating the agent now
 *    would crash (the panel appends to document.body), so booting is deferred
 *    until the DOM is ready.
 *  - A small persistent launcher button (bottom-right) is always available:
 *    the panel's close button disposes the agent, so after a close the
 *    launcher is the way back in — it re-creates the agent on demand.
 *  - Styling is applied through the CSSOM (element.style), which page CSP
 *    cannot block; DOM is built with the DOM API (no innerHTML), which
 *    survives Trusted Types policies on strict sites.
 */
(function () {
  'use strict';
  if (window.__nativekitPageAgentBooted) return;
  var cfg = window.__NATIVEKIT_PAGE_AGENT__;
  if (!cfg || typeof cfg !== 'object' || !window.PageAgent) return;
  var bridge = window[cfg.bridge || 'NativeKitPageAgent'];
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  window.__nativekitPageAgentBooted = true;

  var pending = Object.create(null);
  var seq = 0;

  bridge.onmessage = function (event) {
    var data = event && event.data;
    if (typeof data !== 'string') return;
    try { data = JSON.parse(data); } catch (error) { return; }
    if (!data || typeof data.id !== 'string') return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve({ status: data.status | 0, body: typeof data.body === 'string' ? data.body : '' });
    else entry.reject(new Error(String(data.error || 'NativeKit relay failed')));
  };

  function relayFetch(url, init) {
    return new Promise(function (resolve, reject) {
      var id = 'nk' + (++seq);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('NativeKit LLM relay timed out'));
      }, 150000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        bridge.postMessage(JSON.stringify({
          v: 1,
          kind: 'llm',
          token: cfg.token,
          id: id,
          url: String(url),
          body: init && init.body ? String(init.body) : '',
        }));
      } catch (error) {
        clearTimeout(timer);
        delete pending[id];
        reject(error);
      }
    });
  }

  var agent = null;
  var disposed = false;

  function createAgent() {
    var created = new window.PageAgent({
      baseURL: cfg.baseURL,
      apiKey: '',
      model: cfg.model,
      language: cfg.language || 'en-US',
      maxRetries: 1,
      onDispose: function () {
        disposed = true;
        showLauncher();
      },
      customFetch: function (url, init) {
        return relayFetch(url, init).then(function (res) {
          return new Response(res.body, {
            status: res.status || 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });
      },
    });
    disposed = false;
    window.__nativekitPageAgent = created;
    return created;
  }

  function showPanel() {
    try {
      if (!agent || disposed || agent.disposed) agent = createAgent();
      if (agent.panel && typeof agent.panel.show === 'function') agent.panel.show();
      hideLauncher();
    } catch (error) {
      /* Keep the launcher up so the user can retry. */
    }
  }

  // ---- Persistent launcher button -------------------------------------
  var launcher = null;

  function applyLauncherStyles(node) {
    var styles = {
      position: 'fixed', right: '16px', bottom: '24px',
      width: '52px', height: '52px', margin: '0', padding: '0',
      border: 'none', borderRadius: '50%',
      background: '#2563eb', color: '#ffffff',
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
      cursor: 'pointer', zIndex: '2147483647',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      webkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
      userSelect: 'none', fontFamily: 'system-ui, sans-serif',
    };
    for (var key in styles) {
      try { node.style[key] = styles[key]; } catch (error) { /* best effort */ }
    }
  }

  function buildLauncherIcon() {
    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttributeNS(null, 'width', '26');
    svg.setAttributeNS(null, 'height', '26');
    svg.setAttributeNS(null, 'viewBox', '0 0 24 24');
    svg.setAttributeNS(null, 'aria-hidden', 'true');
    var path = document.createElementNS(svgNs, 'path');
    path.setAttributeNS(null, 'd', 'M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z');
    path.setAttributeNS(null, 'fill', '#ffffff');
    svg.appendChild(path);
    return svg;
  }

  function ensureLauncher() {
    if (launcher && launcher.isConnected) return launcher;
    var button = document.createElement('button');
    button.id = 'nativekit-agent-launcher';
    button.type = 'button';
    button.setAttribute('aria-label', 'Open the AI page agent');
    // Keep the agent's own DOM extraction away from our UI.
    button.setAttribute('data-page-agent-ignore', 'true');
    button.setAttribute('data-browser-use-ignore', 'true');
    applyLauncherStyles(button);
    button.appendChild(buildLauncherIcon());
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      showPanel();
    });
    (document.body || document.documentElement).appendChild(button);
    launcher = button;
    return launcher;
  }

  function showLauncher() {
    var node = ensureLauncher();
    if (node) node.style.display = 'flex';
  }

  function hideLauncher() {
    if (launcher) launcher.style.display = 'none';
  }

  // ---- Boot -------------------------------------------------------------
  function boot() {
    if (!document.body) {
      // Extremely defensive: DOMContentLoaded fired without a body yet.
      setTimeout(boot, 100);
      return;
    }
    ensureLauncher();
    if (cfg.autoShow !== false) {
      // First visit on this page: show the panel straight away. Closing it
      // disposes the agent — onDispose then brings the launcher back.
      showPanel();
    } else {
      showLauncher();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
