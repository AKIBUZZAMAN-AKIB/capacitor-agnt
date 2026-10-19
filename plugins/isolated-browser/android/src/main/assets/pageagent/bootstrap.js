/*
 * NativeKit PageAgent bootstrap — session-aware edition.
 * Runs at document start (injected together with the vendored PageAgent IIFE).
 * window.__NATIVEKIT_PAGE_AGENT__ is written by the native side immediately
 * before this script; it carries the session relay token, the free-route model
 * name/base URL and UX flags.
 *
 * Architecture:
 *  - LLM calls never touch page networking: they go through the
 *    NativeKitPageAgent WebMessageListener channel, relayed natively to the
 *    engine's free route (CSP-proof, no secrets in page JS, usage capped).
 *  - TRUE document start: document.body/(.head) do not exist yet, so booting
 *    is deferred until DOMContentLoaded.
 *  - SESSION CONTINUITY: a real navigation destroys the page (and with it the
 *    panel, the task and the history). The native side outlives the page, so
 *    this bootstrap mirrors {task, status, compact history} to the native
 *    store as the run progresses, and on every new page asks it back:
 *      status 'running' -> auto-resume the task (prior steps are injected
 *                          into the system message via transformRequestBody)
 *      task finished    -> panel re-opens with the task pre-filled
 *      nothing yet      -> normal boot
 *  - UX: persistent launcher button (draggable, tap = open panel, spinner
 *    while a run is active), a draggable panel handle, and a top status toast
 *    ("Thinking…", "Clicking element 3", …) so the agent's activity is always
 *    visible.
 *  - Everything is CSP-hardened: styles via CSSOM only, DOM built with the
 *    DOM API (no innerHTML), spinner animation via SMIL (no stylesheets).
 */
(function () {
  'use strict';
  if (window.__nativekitPageAgentBooted) return;
  var cfg = window.__NATIVEKIT_PAGE_AGENT__;
  if (!cfg || typeof cfg !== 'object' || !window.PageAgent) return;
  var bridge = window[cfg.bridge || 'NativeKitPageAgent'];
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  window.__nativekitPageAgentBooted = true;

  // ---------- relay (LLM) + state channel to the native side -------------
  var pending = Object.create(null);
  var seq = 0;

  function send(payload) {
    try { bridge.postMessage(JSON.stringify(payload)); } catch (error) { /* best effort */ }
  }

  bridge.onmessage = function (event) {
    var data = event && event.data;
    if (typeof data !== 'string') return;
    try { data = JSON.parse(data); } catch (error) { return; }
    if (!data || typeof data.id !== 'string' && data.kind !== 'state-resp') return;
    if (data.kind === 'state-resp') { onRestored(data); return; }
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve({ status: data.status | 0, body: typeof data.body === 'string' ? data.body : '' });
    else entry.reject(new Error(String(data.error || 'NativeKit relay failed')));
  };

  function sanitizeWireRequest(bodyStr) {
    try {
      var body = JSON.parse(bodyStr);
      var changed = false;
      var disallowed = ["parallel_tool_calls","thinking","enable_thinking","reasoning","reasoning_effort","verbosity","temperature","top_p","top_k","top_logprobs","logprobs","logit_bias","store","metadata","safety_identifier","prompt_cache_key","max_tokens","max_completion_tokens","n","presence_penalty","frequency_penalty","stop","stream_options","service_tier","seed"];
      for (var i=0;i<disallowed.length;i++) {
        var k = disallowed[i];
        if (k in body) { delete body[k]; changed = true; }
      }
      for (var key in body) {
        if (key.indexOf("reasoning_")===0 || key.indexOf("thinking_")===0) { delete body[key]; changed = true; }
      }
      if (body.model && body.model !== cfg.model) { body.model = cfg.model; changed = true; }
      if (body.tool_choice) {
        if (typeof body.tool_choice === "string" && (body.tool_choice === "required" || body.tool_choice.indexOf("function")>=0)) {
          body.tool_choice = "auto"; changed = true;
        } else if (typeof body.tool_choice === "object") {
          body.tool_choice = "auto"; changed = true;
        }
      }
      if (body.response_format) {
        try {
          if (body.response_format.type && body.response_format.type.indexOf("json_schema")>=0) { delete body.response_format; changed = true; }
          else if (body.response_format.json_schema) { delete body.response_format; changed = true; }
        } catch(e) { delete body.response_format; changed = true; }
      }
      if (Array.isArray(body.tools)) {
        for (var t=0;t<body.tools.length;t++) {
          var tool = body.tools[t];
          if (tool && tool.function && tool.function.strict) { delete tool.function.strict; changed = true; }
        }
      }
      if (Array.isArray(body.messages)) {
        for (var m=0;m<body.messages.length;m++) {
          var msg = body.messages[m];
          if (msg && msg.name) {
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(msg.name)) { delete msg.name; changed = true; }
          }
          if (msg && msg.cache_control) { delete msg.cache_control; changed = true; }
        }
      }
      return changed ? JSON.stringify(body) : bodyStr;
    } catch(e) { return bodyStr; }
  }

  function relayFetch(url, init) {
    return new Promise(function (resolve, reject) {
      var id = 'nk' + (++seq);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('NativeKit LLM relay timed out'));
      }, 150000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var rawBody = init && init.body ? String(init.body) : '';
      var cleanBody = sanitizeWireRequest(rawBody);
      send({
        v: 1, kind: 'llm', token: cfg.token, id: id,
        url: String(url),
        body: cleanBody,
      });
    });
  }

  function sendState(patch) {
    var payload = { v: 1, kind: 'state', token: cfg.token };
    if (patch && 'task' in patch) payload.task = String(patch.task || '').slice(0, 2000);
    if (patch && 'status' in patch) payload.status = String(patch.status || '').slice(0, 40);
    send(payload);
  }

  var historyTimer = null;
  function scheduleHistorySync() {
    if (historyTimer) return;
    historyTimer = setTimeout(function () {
      historyTimer = null;
      if (!agent) return;
      try {
        var entries = [];
        var source = Array.isArray(agent.history) ? agent.history : [];
        for (var i = Math.max(0, source.length - 120); i < source.length; i += 1) {
          var item = source[i] || {};
          var compact = { type: String(item.type || '') };
          if (item.tool) compact.tool = String(item.tool);
          if (item.message) compact.message = String(item.message).slice(0, 300);
          entries.push(compact);
        }
        send({ v: 1, kind: 'history', token: cfg.token, body: JSON.stringify(entries) });
      } catch (error) { /* best effort */ }
    }, 400);
  }

  function requestRestore() {
    send({ v: 1, kind: 'restore', token: cfg.token });
  }

  // ---------- tiny UI helpers (all CSP-safe) ------------------------------
  function applyStyles(node, styles) {
    for (var key in styles) {
      try { node.style[key] = styles[key]; } catch (error) { /* best effort */ }
    }
  }

  var toast = null;
  var toastTimer = null;
  function showToast(text, sticky) {
    if (!toast || !toast.isConnected) {
      toast = document.createElement('div');
      toast.id = 'nativekit-agent-toast';
      toast.setAttribute('aria-live', 'polite');
      toast.setAttribute('data-page-agent-ignore', 'true');
      toast.setAttribute('data-browser-use-ignore', 'true');
      applyStyles(toast, {
        position: 'fixed', top: '10px', left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: '86vw', padding: '6px 14px', borderRadius: '999px',
        background: 'rgba(15, 23, 42, 0.92)', color: '#ffffff',
        font: '600 12px system-ui, sans-serif', lineHeight: '1.4',
        zIndex: '2147483647', display: 'none',
        pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', boxShadow: '0 4px 14px rgba(0, 0, 0, 0.3)',
      });
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = String(text || '');
    toast.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(function () { toast.style.display = 'none'; }, 2600);
  }
  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    if (toast) toast.style.display = 'none';
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var key in attrs) node.setAttributeNS(null, key, attrs[key]);
    return node;
  }

  // ---------- agent lifecycle ---------------------------------------------
  var agent = null;
  var disposed = false;
  var lastActivityText = '';

  function resumeContextFrom(historyJson) {
    try {
      var entries = JSON.parse(historyJson || '[]');
      if (!Array.isArray(entries) || !entries.length) return '';
      var lines = [];
      for (var i = Math.max(0, entries.length - 15); i < entries.length; i += 1) {
        var item = entries[i] || {};
        var line = item.type || 'step';
        if (item.tool) line += ' ' + item.tool;
        if (item.message) line += ' — ' + String(item.message).slice(0, 160);
        lines.push((lines.length + 1) + '. ' + line);
      }
      var text = '[NativeKit session continuation] The page navigated mid-task, so this is a NEW page; the previous conversation state was: '
        + lines.join(' | ');
      return text.slice(0, 3000);
    } catch (error) { return ''; }
  }

  function createAgent(resumeContext) {
    var config = {
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
    };
    if (resumeContext) {
      config.transformRequestBody = function (body) {
        try {
          if (body && Array.isArray(body.messages) && body.messages.length
              && body.messages[0] && body.messages[0].role === 'system') {
            body.messages[0].content = String(body.messages[0].content) + '\n\n' + resumeContext;
          }
        } catch (error) { /* leave the request untouched */ }
        return body;
      };
    }
    var created = new window.PageAgent(config);
    disposed = false;
    window.__nativekitPageAgent = created;
    wireAgent(created);
    return created;
  }

  function activityText(detail) {
    try {
      var tool = detail && detail.tool;
      var input = (detail && detail.input) || {};
      if (tool === 'click_element_by_index') return 'Clicking element ' + (input.index ?? '?');
      if (tool === 'input_text') return 'Typing\u2026';
      if (tool === 'select_dropdown_option') return 'Selecting\u2026';
      if (tool === 'scroll' || tool === 'scroll_horizontally') return 'Scrolling\u2026';
      if (tool === 'wait') return 'Waiting\u2026';
      if (tool === 'ask_user') return 'Asking you\u2026';
      if (tool === 'done') return 'Task completed';
      if (tool) return 'Running ' + tool + '\u2026';
    } catch (error) { /* fall through */ }
    return 'Thinking\u2026';
  }

  function wireAgent(target) {
    // Capture the task text the panel submits, and mirror it to the native
    // session store so the next page (after navigation) can resume it.
    var originalExecute = target.execute.bind(target);
    target.execute = function (task) {
      sendState({ task: task, status: 'running' });
      lastActivityText = 'Thinking\u2026';
      showToast('Thinking\u2026', true);
      setLauncherBusy(true);
      try { if (target.panel && target.panel.expand) target.panel.expand(); } catch (error) { /* optional */ }
      return originalExecute(task);
    };

    target.addEventListener('statuschange', function () {
      var status = target.status;
      sendState({ status: status });
      if (status === 'running') { setLauncherBusy(true); }
      else {
        setLauncherBusy(false);
        if (status === 'completed') showToast('Task completed \u2713');
        else if (status === 'error') showToast('Task stopped with an error');
        else if (status === 'stopped') showToast('Task stopped');
      }
    });

    target.addEventListener('historychange', scheduleHistorySync);

    target.addEventListener('activity', function (event) {
      var detail = event && event.detail;
      lastActivityText = activityText(detail);
      if (target.status === 'running') showToast(lastActivityText, true);
    });

    installPanelDragHandle(target);
  }

  // ---------- panel drag handle --------------------------------------------
  var panelOffset = { x: 0, y: 0 };

  function applyPanelOffset(wrapper) {
    wrapper.style.transform = 'translateX(calc(-50% + ' + panelOffset.x + 'px)) translateY(' + panelOffset.y + 'px)';
  }

  function installPanelDragHandle(target) {
    try {
      var wrapper = document.getElementById('page-agent-runtime_agent-panel');
      if (!wrapper || wrapper.__nativekitHandle) return;
      var handle = document.createElement('div');
      handle.setAttribute('aria-label', 'Drag to move the agent panel');
      handle.setAttribute('data-page-agent-ignore', 'true');
      handle.setAttribute('data-browser-use-ignore', 'true');
      applyStyles(handle, {
        position: 'absolute', top: '0', left: '0', right: '0', height: '26px',
        cursor: 'grab', touchAction: 'none', zIndex: '10',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(148, 163, 184, 0.9)', font: '600 11px system-ui, sans-serif',
        userSelect: 'none',
      });
      handle.textContent = '\u2b24\u2b24\u2b24';
      wrapper.appendChild(handle);
      wrapper.__nativekitHandle = handle;

      var dragging = false;
      var startX = 0, startY = 0, baseX = 0, baseY = 0;
      handle.addEventListener('pointerdown', function (event) {
        dragging = true;
        startX = event.clientX; startY = event.clientY;
        baseX = panelOffset.x; baseY = panelOffset.y;
        handle.style.cursor = 'grabbing';
        try { handle.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
        event.preventDefault();
      });
      handle.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        panelOffset.x = baseX + (event.clientX - startX);
        panelOffset.y = baseY + (event.clientY - startY);
        applyPanelOffset(wrapper);
        event.preventDefault();
      });
      function endDrag(event) {
        if (!dragging) return;
        dragging = false;
        handle.style.cursor = 'grab';
        var maxY = Math.max(120, window.innerHeight - 120);
        panelOffset.y = Math.max(-maxY, Math.min(maxY, panelOffset.y));
        applyPanelOffset(wrapper);
      }
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);

      // Upstream show()/hide() rewrite style.transform — re-apply our offset.
      var panel = target.panel;
      if (panel && typeof panel.show === 'function') {
        var originalShow = panel.show.bind(panel);
        panel.show = function () {
          var result = originalShow();
          applyPanelOffset(wrapper);
          return result;
        };
      }
    } catch (error) { /* the panel stays usable without dragging */ }
  }

  // ---------- launcher button (draggable) ----------------------------------
  var launcher = null;
  var launcherBusy = false;
  var launcherPos = null; // {x, y} once dragged

  function launcherIcon() {
    return svgEl('path', {
      d: 'M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z',
      fill: '#ffffff',
    });
  }

  function launcherSpinner() {
    // SMIL animation — works without any stylesheet, so page CSP cannot kill it.
    var group = svgEl('g', {});
    var ring = svgEl('circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: '#ffffff', 'stroke-width': '3', 'stroke-dasharray': '42 15' });
    var animate = document.createElementNS('http://www.w3.org/2000/svg', 'animateTransform');
    animate.setAttribute('attributeName', 'transform');
    animate.setAttribute('type', 'rotate');
    animate.setAttribute('from', '0 12 12');
    animate.setAttribute('to', '360 12 12');
    animate.setAttribute('dur', '0.9s');
    animate.setAttribute('repeatCount', 'indefinite');
    ring.appendChild(animate);
    group.appendChild(ring);
    return group;
  }

  function renderLauncherIcon() {
    if (!launcher) return;
    while (launcher.firstChild) launcher.removeChild(launcher.firstChild);
    var svg = svgEl('svg', { width: '26', height: '26', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.appendChild(launcherBusy ? launcherSpinner() : launcherIcon());
    launcher.appendChild(svg);
  }

  function applyLauncherPosition() {
    if (!launcher) return;
    if (launcherPos) {
      launcher.style.right = 'auto';
      launcher.style.bottom = 'auto';
      launcher.style.left = Math.max(4, Math.min(window.innerWidth - 56, launcherPos.x)) + 'px';
      launcher.style.top = Math.max(4, Math.min(window.innerHeight - 56, launcherPos.y)) + 'px';
    } else {
      launcher.style.left = 'auto';
      launcher.style.top = 'auto';
      launcher.style.right = '16px';
      launcher.style.bottom = '24px';
    }
  }

  function ensureLauncher() {
    if (launcher && launcher.isConnected) return launcher;
    var button = document.createElement('button');
    button.id = 'nativekit-agent-launcher';
    button.type = 'button';
    button.setAttribute('aria-label', 'Open the AI page agent');
    button.setAttribute('data-page-agent-ignore', 'true');
    button.setAttribute('data-browser-use-ignore', 'true');
    applyStyles(button, {
      position: 'fixed', width: '52px', height: '52px', margin: '0', padding: '0',
      border: 'none', borderRadius: '50%',
      background: '#2563eb', color: '#ffffff',
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
      cursor: 'pointer', zIndex: '2147483647',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      webkitTapHighlightColor: 'transparent', touchAction: 'none',
      userSelect: 'none', fontFamily: 'system-ui, sans-serif',
    });
    button.appendChild((function () {
      var svg = svgEl('svg', { width: '26', height: '26', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
      svg.appendChild(launcherIcon());
      return svg;
    })());

    var dragging = false, moved = false, startX = 0, startY = 0;
    button.addEventListener('pointerdown', function (event) {
      dragging = true; moved = false;
      startX = event.clientX; startY = event.clientY;
      try { button.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
    });
    button.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var dx = event.clientX - startX, dy = event.clientY - startY;
      if (!moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      moved = true;
      launcherPos = { x: event.clientX - 26, y: event.clientY - 26 };
      applyLauncherPosition();
      event.preventDefault();
    });
    function endTap(event) {
      if (!dragging) return;
      dragging = false;
      if (!moved) showPanel();
    }
    button.addEventListener('pointerup', endTap);
    button.addEventListener('pointercancel', function () { dragging = false; });

    (document.body || document.documentElement).appendChild(button);
    launcher = button;
    renderLauncherIcon();
    applyLauncherPosition();
    return launcher;
  }

  function showLauncher() {
    var node = ensureLauncher();
    if (node) node.style.display = 'flex';
  }

  function hideLauncher() {
    if (launcher) launcher.style.display = 'none';
  }

  function setLauncherBusy(busy) {
    launcherBusy = !!busy;
    renderLauncherIcon();
  }

  // ---------- panel ---------------------------------------------------------
  function showPanel() {
    try {
      if (!agent || disposed || agent.disposed) agent = createAgent(resumeContextForNextRun);
      if (agent.panel && typeof agent.panel.show === 'function') agent.panel.show();
      hideLauncher();
    } catch (error) {
      /* keep the launcher up so the user can retry */
    }
  }

  function prefillTask(task) {
    try {
      var wrapper = document.getElementById('page-agent-runtime_agent-panel');
      var input = wrapper && wrapper.querySelector('input[type="text"]');
      if (input) input.value = String(task).slice(0, 1000);
    } catch (error) { /* optional nicety */ }
  }

  // ---------- boot + restore -------------------------------------------------
  var resumeContextForNextRun = '';
  var restoreHandled = false;

  function onRestored(data) {
    if (restoreHandled) return;
    restoreHandled = true;
    var task = typeof data.task === 'string' && data.task ? data.task : null;
    var status = typeof data.status === 'string' ? data.status : '';
    var historyJson = typeof data.history === 'string' ? data.history : '';

    if (task && status === 'running') {
      // The page navigated mid-task: bring everything back and continue.
      resumeContextForNextRun = resumeContextFrom(historyJson);
      showPanel();
      showToast('Resuming task on this page\u2026', true);
      setTimeout(function () {
        if (agent && !agent.disposed) {
          try { agent.execute(task); } catch (error) { /* surfaced in the panel */ }
        }
      }, 600);
      return;
    }
    if (task) {
      // A finished task from the previous page: reopen with it pre-filled.
      showPanel();
      prefillTask(task);
      showToast('Previous task ended \u2014 input restored');
      return;
    }
    defaultBoot();
  }

  function defaultBoot() {
    ensureLauncher();
    if (cfg.autoShow !== false) showPanel();
    else showLauncher();
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 100);
      return;
    }
    ensureLauncher();
    requestRestore();
    // If the native side never answers (older host, race), boot normally.
    setTimeout(function () { if (!restoreHandled) { restoreHandled = true; defaultBoot(); } }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
