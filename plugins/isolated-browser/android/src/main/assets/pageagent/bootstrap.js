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
 *  - The agent is only instantiated when the native side enabled it for this
 *    session; the page cannot start it on its own (no API is exposed to page
 *    code beyond PageAgent's own UI).
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

  var agent;
  try {
    agent = new window.PageAgent({
      baseURL: cfg.baseURL,
      apiKey: '',
      model: cfg.model,
      language: cfg.language || 'en-US',
      maxRetries: 1,
      customFetch: function (url, init) {
        return relayFetch(url, init).then(function (res) {
          return new Response(res.body, {
            status: res.status || 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });
      },
    });
  } catch (error) {
    return;
  }

  window.__nativekitPageAgent = agent;

  if (cfg.autoShow !== false && agent.panel && typeof agent.panel.show === 'function') {
    setTimeout(function () {
      try { agent.panel.show(); } catch (error) { /* the page may be mid-navigation */ }
    }, 800);
  }
})();
