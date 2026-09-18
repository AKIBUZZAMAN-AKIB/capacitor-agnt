const logNode = document.querySelector('#log');
const statusNode = document.querySelector('#status');
const platformNode = document.querySelector('#platform');

function log(label, value) {
  const stamp = new Date().toLocaleTimeString();
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  logNode.textContent = `[${stamp}] ${label}\n${text}\n\n${logNode.textContent}`;
}
window.nativeKitDemoLog = log;

// ── Widget lab state (home-screen counter + floating event listeners) ──
let widgetCount = 0;
let widgetListenersWired = false;
const widgetBaseSpec = {
  layout: 'medium',
  title: 'NativeKit',
  subtitle: 'Counter',
  accentColor: '#4FC3F7',
  valueColor: '#4FC3F7',
  titleColor: '#FFFFFF',
  subtitleColor: '#B0BEC5',
  backgroundColor: '#0F172A',
  buttonColor: '#1E293B',
  buttonTextColor: '#FFFFFF',
  valueSize: 40,
  titleSize: 14,
  subtitleSize: 11,
  align: 'center',
  progress: 0,
  progressMax: 100,
  action: 'open-counter',
  buttonLabel: 'Open',
};

async function execute(label, task, button) {
  button.disabled = true;
  try { log(label, await task()); }
  catch (error) { log(`${label} · ERROR`, { message: error.message, code: error.code, data: error.data }); }
  finally { button.disabled = false; }
}

async function refresh() {
  const kit = await window.NativeKit.ready();
  platformNode.textContent = `${kit.platform.toUpperCase()} · ${kit.isNative ? 'NATIVE APP' : 'WEB FALLBACK'} · v${kit.version}`;
  statusNode.textContent = JSON.stringify(kit.capabilities(), null, 2);
}

// Auto-detect permission changes: user grants in Settings, comes back → panel refreshes itself.
window.NativeKit.ready().then((kit) => {
  if (kit.isNative) {
    kit.app.onStateChange((state) => {
      if (state.isActive) {
        log('app resumed · permission re-check', 'Refreshing capability state…');
        refresh().catch(() => {});
      }
    });
  }
}).catch(() => {});

const actions = {
  permissions: () => window.NativeKit.permissions.check(),
  location: () => window.NativeKit.location.current(),
  camera: () => window.NativeKit.camera.getPhoto(),
  haptic: async () => { await window.NativeKit.haptics.impact('MEDIUM'); return { completed: true }; },
  notification: async () => {
    let state = await window.NativeKit.notifications.check();
    if (state.display !== 'granted') state = await window.NativeKit.notifications.request();
    if (state.display !== 'granted') throw new Error('Notification permission was not granted');
    const id = Math.floor(Date.now() / 1000) % 2147483647;
    return window.NativeKit.notifications.schedule([{ id, title: 'NativeKit reminder', body: 'Local notification bridge কাজ করছে।', schedule: { at: new Date(Date.now() + 5000) }, sound: 'default' }]);
  },
  background: () => window.NativeKit.background.runSyncNow({ source: 'demo-button' }),
  storage: async () => {
    const old = await window.NativeKit.preferences.getJSON('demo.counter') || { count: 0 };
    const next = { count: old.count + 1, updatedAt: new Date().toISOString() };
    await window.NativeKit.preferences.setJSON('demo.counter', next);
    return next;
  },
  alarms: () => window.NativeKit.alarms.capabilities(),
  alarmset: async () => {
    const caps = await window.NativeKit.alarms.capabilities();
    if (caps.exact === false) {
      log('alarm exact access', 'Settings খুলছে — "Alarms & reminders" অনুমতি দিয়ে ফিরে এসে আবার চাপুন।');
      await window.NativeKit.alarms.requestExactAccess();
      return { requested: true, hint: 'Grant করার পর আবার চাপুন, তখনই schedule হবে।' };
    }
    const id = `demo-${Date.now()}`;
    const at = Date.now() + 15000;
    const result = await window.NativeKit.alarms.schedule({ id, title: 'NativeKit TestLab alarm', body: 'Exact alarm কাজ করছে।', at, fullScreen: false, sound: 'default' });
    return { ...result, firesAt: new Date(at).toISOString() };
  },
  sqlite: async () => {
    await window.NativeKit.sqlite.execute('testlab', 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL);');
    const insert = await window.NativeKit.sqlite.run('testlab', 'INSERT INTO notes (text) VALUES (?);', [`TestLab row @ ${new Date().toISOString()}`]);
    const total = await window.NativeKit.sqlite.query('testlab', 'SELECT COUNT(*) AS n FROM notes;');
    const last = await window.NativeKit.sqlite.query('testlab', 'SELECT text FROM notes ORDER BY id DESC LIMIT 1;');
    return { inserted: insert.changes, totalRows: total.values?.[0]?.n, lastRow: last.values?.[0]?.text };
  },
  secure: async () => {
    const value = `token-${Math.random().toString(36).slice(2, 10)}`;
    await window.NativeKit.secureStorage.set('demo.token', value);
    const readBack = await window.NativeKit.secureStorage.get('demo.token');
    return { stored: value, readBack, match: value === readBack };
  },
  fs: async () => {
    // 'Data' = app-private storage: কোনো permission ছাড়াই সব Android version-এ কাজ করে।
    // (public 'Documents' লাগলে পুরনো Android-এ legacy storage permission prompt আসে।)
    const path = 'nativekit-lab/hello.txt';
    const data = `NativeKit FS test @ ${new Date().toISOString()}`;
    await window.NativeKit.filesystem.writeFile({ path, data, directory: 'Data', recursive: true });
    const stat = await window.NativeKit.filesystem.stat({ path, directory: 'Data' });
    const read = await window.NativeKit.filesystem.readFile({ path, directory: 'Data' });
    return { size: stat.size, uri: stat.uri, contents: read.data };
  },
  download: async () => {
    let lastPct = -25;
    const result = await window.NativeKit.transfer.download({
      url: 'https://httpbin.org/image/png',
      path: 'nativekit-lab/download.png',
      directory: 'Data',
      onProgress: (p) => {
        const pct = p.lengthComputable ? Math.round((p.bytes / p.contentLength) * 100) : 0;
        if (pct >= lastPct + 25) { lastPct = pct; log('download.progress', { bytes: p.bytes, pct }); }
      },
    });
    const stat = await window.NativeKit.filesystem.stat({ path: 'nativekit-lab/download.png', directory: 'Data' });
    return { path: result.path, sizeOnDisk: stat.size };
  },
  stream: () => new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    window.NativeKit.http.stream({ url: 'https://httpbin.org/stream/5', format: 'text' }, {
      onMessage: (m) => { chunks.push(m.data); log('stream.chunk', m.data.trim()); },
      onError: (e) => { if (!settled) { settled = true; reject(e); } },
      onEnd: (d) => { if (!settled) { settled = true; resolve({ status: d?.status, chunksReceived: chunks.length }); } },
    });
    setTimeout(() => { if (!settled) { settled = true; resolve({ note: '30s timeout', chunksReceived: chunks.length }); } }, 30000);
  }),
  share: async () => {
    const can = await window.NativeKit.share.canShare();
    if (!can.value) return { canShare: false, platform: 'কোনো share target নেই (web?)' };
    return window.NativeKit.share.show({ title: 'NativeKit TestLab', text: 'Native share bridge কাজ করছে।', dialogTitle: 'শেয়ার করুন' });
  },
  network: () => window.NativeKit.network.status(),
  pushstatus: async () => {
    const state = (await window.NativeKit.permissions.check()).push;
    return { push: state, note: 'Firebase/google-services এখনো বসানো হয়নি — তাই register করব না, শুধু status।' };
  },
  bgstart: async () => {
    const perm = await window.NativeKit.permissions.check();
    if (perm.location?.location !== 'granted') {
      const req = await window.NativeKit.permissions.requestLocation();
      if (req.location !== 'granted') return { running: false, hint: 'Foreground location permission ছাড়া background tracking চালু হয় না।' };
    }
    try {
      return await window.NativeKit.backgroundLocation.start({ minTimeMs: 5000, minDistanceM: 5 });
    } catch (error) {
      log('bg gps needs background access', `${error.message} — App settings খুলছে, সেখানে Location → 'Allow all the time' দিন।`);
      await window.NativeKit.permissions.openAppSettings();
      return { running: false, hint: 'Grant করে ফিরে এসে আবার Start চাপুন।' };
    }
  },
  bgstop: async () => {
    await window.NativeKit.backgroundLocation.stop();
    return window.NativeKit.backgroundLocation.status();
  },
  widgetset: async () => {
    const spec = { ...widgetBaseSpec, value: String(widgetCount), progress: (widgetCount % 100), actionValue: JSON.stringify({ count: widgetCount }) };
    return window.NativeKit.widget.setConfig('nativekit-widget', spec);
  },
  widgetinc: async () => {
    widgetCount += 1;
    const spec = { ...widgetBaseSpec, value: String(widgetCount), progress: (widgetCount % 100), actionValue: JSON.stringify({ count: widgetCount }) };
    return window.NativeKit.widget.update('nativekit-widget', spec);
  },
  widgetstyle: async () => {
    // Rich style round-trip: recolor, resize text, right-align, and show a progress bar —
    // all from web with no new layout.
    const spec = { ...widgetBaseSpec, layout: 'large', value: String(widgetCount), progress: (widgetCount % 100),
      backgroundColor: '#052e16', accentColor: '#34d399', titleColor: '#ecfdf5', subtitleColor: '#6ee7b7',
      buttonColor: '#065f46', buttonTextColor: '#ecfdf5', valueSize: 64, titleSize: 16, subtitleSize: 12,
      align: 'start', action: 'open-counter', actionValue: JSON.stringify({ count: widgetCount }) };
    return window.NativeKit.widget.update('nativekit-widget', spec);
  },
  widgethero: async () => {
    // Free-design mode: reference a layout resource your app ships ('hero') — RelativeLayout +
    // gradient background + ImageView + rounded Button, all baked into the XML. The renderer fills
    // the same id contract, so it works with zero layout code here.
    const spec = { layout: 'hero', value: String(widgetCount), title: 'NativeKit', subtitle: 'Free design',
      valueColor: '#4FC3F7', titleColor: '#E2E8F0', subtitleColor: '#94A3B8',
      image: 'widget_hero_badge', progress: (widgetCount % 100), progressMax: 100,
      action: 'open-counter', actionValue: JSON.stringify({ count: widgetCount }), buttonLabel: 'Open' };
    return window.NativeKit.widget.update('nativekit-widget', spec);
  },
  widgethtml: async () => {
    // HTML/CSS/JS on the HOME-SCREEN widget: the developer's HTML is rendered to a snapshot bitmap.
    // (Static snapshot; re-update to refresh. Live/interactive HTML lives on the floating overlay.)
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;font-family:system-ui;background:linear-gradient(150deg,#7c3aed,#2563eb);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;user-select:none}p{margin:0;font-size:15px;opacity:.9}.v{font-size:44px;font-weight:800}</style></head><body><div class="v">' + widgetCount + '</div><p>HTML widget on home screen</p></body></html>';
    const res = await window.NativeKit.widget.setConfig('nativekit-widget', { render: 'html', html, widthPx: 320, heightPx: 160, action: 'open-counter', actionValue: JSON.stringify({ count: widgetCount }) });
    await window.NativeKit.widget.reload('nativekit-widget');
    return { ...res, hint: 'Home-screen widget agora HTML-diya render hocche (snapshot). Live HTML floating-e।' };
  },
  widgetreload: () => window.NativeKit.widget.reload('nativekit-widget'),
  widgetpin: () => window.NativeKit.widget.requestPin('nativekit-widget'),
  floatcheck: () => window.NativeKit.widget.checkFloatingPermission(),
  floatrequest: async () => {
    const perm = await window.NativeKit.widget.checkFloatingPermission();
    if (perm.granted) return { granted: true, hint: 'ইতিমধ্যেই অনুমতি আছে — Show bubble চাপুন।' };
    await window.NativeKit.widget.requestFloatingPermission();
    log('floating permit', 'Settings খুলছে — "Display over other apps" অনুমতি দিয়ে ফিরে এসে Show bubble চাপুন।');
    return { granted: false, hint: 'Grant করে ফিরে এসে Show bubble চাপুন।' };
  },
  floatshow: async () => {
    const perm = await window.NativeKit.widget.checkFloatingPermission();
    if (!perm.granted) return { running: false, hint: 'আগে Request permit দিন (Settings থেকে allow), তারপর আবার Show bubble।' };
    const res = await window.NativeKit.widget.showFloating({ title: 'NativeKit', page: 'public/widgets/floating.html', width: 240, height: 220, collapsed: false, data: { value: widgetCount } });
    if (res && res.shown === false) {
      return { ...res, hint: res.error ? `Bubble না আসার কারণ: ${res.error}` : 'Bubble attach failed — check log.' };
    }
    return res;
  },
  floatsend: async () => {
    const res = await window.NativeKit.widget.sendToFloating({ value: widgetCount });
    return { pushed: widgetCount, delivered: res.delivered, running: res.running, hint: res.delivered ? null : 'Bubble এখন দেখা যাচ্ছে না — আগে Show bubble দিন।' };
  },
  floathide: () => window.NativeKit.widget.hideFloating(),
  floatpos: async () => {
    const perm = await window.NativeKit.widget.checkFloatingPermission();
    if (!perm.granted) return { running: false, hint: 'আগে permit দিন।' };
    return window.NativeKit.widget.showFloating({ page: 'public/widgets/floating.html', width: 200, height: 160, data: { value: widgetCount }, position: { gravity: 'bottom', align: 'end', marginX: 16, marginY: 16 } });
  },
  floatfull: async () => {
    const perm = await window.NativeKit.widget.checkFloatingPermission();
    if (!perm.granted) return { running: false, hint: 'আগে permit দিন।' };
    return window.NativeKit.widget.showFloating({ fullscreen: true, chrome: 'none', page: 'public/widgets/floating.html', data: { value: widgetCount } });
  },
  floatchrome: async () => {
    const perm = await window.NativeKit.widget.checkFloatingPermission();
    if (!perm.granted) return { running: false, hint: 'আগে permit দিন।' };
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:linear-gradient(160deg,#7c3aed,#2563eb);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui;user-select:none;text-align:center}button{margin-top:10px;border:0;border-radius:999px;padding:8px 14px;font-weight:700}</style></head><body><div style="font-size:40px">🎨</div><div>chrome:"none" + inline html</div><button onclick="window.NativeKitFloating.close()">✕ close</button></body></html>';
    return window.NativeKit.widget.showFloating({ chrome: 'none', draggable: false, width: 220, height: 200, html, data: { value: widgetCount } });
  },
  floatupdate: async () => {
    const res = await window.NativeKit.widget.updateFloating({ width: 320, height: 260, position: { gravity: 'center', align: 'center' } });
    return { ...res, hint: 'Bubble-টা resize ও center-এ move করা হলো (নতুন আবার show না করেই)।' };
  },
  floatjs: async () => {
    const res = await window.NativeKit.widget.runFloatingJavascript("document.body.style.background='linear-gradient(180deg,#0f172a,#0b1220)'; var el=document.getElementById('value'); if(el) el.textContent='JS⏺';");
    return { ...res, hint: 'Overlay-র WebView-এ arbitrary JS ঢোকানো হলো।' };
  },
  widgetlisten: async () => {
    if (widgetListenersWired) return { wired: true, hint: 'Listeners ইতিমধ্যেই active।' };
    widgetListenersWired = true;
    await window.NativeKit.widget.onWidgetTap((event) => log('widget.tap', event));
    await window.NativeKit.widget.onFloatingMessage((event) => log('widget.floating', event));
    return { wired: true, hint: 'Widget tap ও floating message listen শুরু।' };
  },
  browser: async () => {
    await window.NativeKit.browser.open('https://example.com');
    return { opened: 'https://example.com' };
  },
};

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => execute(button.dataset.action, actions[button.dataset.action], button));
});

// ── Agent lab (on-device Rust AI agent) ──────────────────────────────────────
// Loaded as a module so its ~47 API tests stay out of this file. It reuses the
// same execute()/log() contract, so results land in the shared Host Event Log.
import('./agent-lab.js')
  .then((mod) => mod.wireAgentButtons(execute))
  .catch((error) => log('agent-lab load failed', error.message));
document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#clear').addEventListener('click', () => { logNode.textContent = ''; });
document.querySelector('#http-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  execute('http.get', () => window.NativeKit.http.get(document.querySelector('#url').value), button);
});
window.addEventListener('nativekitready', (event) => log('nativekitready', event.detail));
refresh().catch((error) => log('startup error', error.message));

// ── BAR BLEND TEST ───────────────────────────────────────────────────────────
// দৃশ্যমান প্রমাণ যে status/nav bar এখন transparent: পেজের background বদলালেই
// দুই স্ট্রিপেও সঙ্গে সঙ্গে সেই রঙে মিলে যায় (কোনো আলাদা সিস্টেম color-fill নেই)।
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(alpha / 100).toFixed(2)})`;
}
(() => {
  const byId = (id) => document.getElementById(id);
  const colorEl = byId('bt-color'), opEl = byId('bt-opacity'), opVal = byId('bt-opacity-val');
  const topEl = byId('bt-top'), bottomEl = byId('bt-bottom');
  if (!colorEl || !opEl) return;
  const bn = ['শূন্য', '১০', '২০', '৩০', '৪০', '৫০', '৬০', '৭০', '৮০', '৯০', '১০০'];
  opEl.addEventListener('input', () => { opVal.textContent = bn[Math.round(opEl.value / 10)] + '% (আসল ' + opEl.value + '%)'; });
  byId('bt-solid').addEventListener('click', () => {
    const op = +opEl.value;
    document.body.style.background = hexToRgba(colorEl.value, op);
    // opacity কমালে নিচের decor/page-through-ও মিলে যায় — সেটাই blend-এর প্রমাণ
    log('blend-test', `solid ${colorEl.value} opacity ${op}%`);
  });
  byId('bt-gradient').addEventListener('click', () => {
    document.body.style.background = `linear-gradient(180deg, ${topEl.value} 0%, ${bottomEl.value} 100%)`;
    log('blend-test', `gradient ${topEl.value} → ${bottomEl.value} — উপরে ${topEl.value}, নিচে ${bottomEl.value} দেখায় কিনা খেয়াল করুন`);
  });
  byId('bt-rainbow').addEventListener('click', () => {
    document.body.style.background = 'linear-gradient(180deg,#ff0000,#ff9800,#ffeb3b,#4caf50,#2196f3,#3f51b5,#9c27b0)';
    log('blend-test', 'VERTICAL rainbow — উপরে লাল, নিচে বেগুনি: দুই স্ট্রিপ দুই রঙ!');
  });
  byId('bt-rainbow-diag').addEventListener('click', () => {
    document.body.style.background = 'linear-gradient(135deg,#ff0000,#ff9800,#ffeb3b,#4caf50,#2196f3,#3f51b5,#9c27b0)';
    log('blend-test', 'DIAGONAL rainbow — উপরের ডান/বাঁ আর নিচের ডান/বাঁ আলাদা রঙ!');
  });
  byId('bt-reset').addEventListener('click', () => {
    document.body.style.background = '';
    document.body.style.backgroundColor = '';
    log('blend-test', 'মূল dark theme-এ ফিরলো');
  });
})();

// ── BLEND DIAGNOSTICS ── page সত্যিই পুরো screen-এ ছড়িয়ে গেছে কিনা সরাসরি প্রমাণ
(() => {
  const diag = document.getElementById('bt-diag');
  if (!diag) return;
  function runDiag() {
    const ua = /Android\s+([\d.]+)/.exec(navigator.userAgent);
    const insetB = getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom') || '(none)';
    const insetT = getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top') || '(none)';
    const full = Math.abs(window.innerHeight - screen.height) <= 4;
    const body = getComputedStyle(document.body);
    diag.textContent = [
      'BLEND DIAGNOSTICS (এই তথ্য আমাদের জানালে দ্রুত ঠিক করতে পারব):',
      '  Android version: ' + (ua ? ua[1] : 'unknown (UA: ' + navigator.userAgent.slice(0, 60) + '…)'),
      '  window.innerHeight: ' + window.innerHeight + 'px   screen.height: ' + screen.height + 'px',
      '  page spans FULL screen (bars-এর নিচ পর্যন্ত): ' + (full ? '✅ হ্যাঁ' : '❌ না — কনটেন্ট বারের নিচে যাচ্ছে না'),
      '  safe-area-inset-top: ' + insetT + '   bottom: ' + insetB,
      '  body background-Image: ' + (body.backgroundImage.includes('gradient') ? 'gradient আছে ✓' : body.backgroundImage.slice(0, 30)),
      '  body background-Color: ' + body.backgroundColor,
    ].join('\n');
  }
  runDiag();
  window.addEventListener('resize', runDiag);
  setTimeout(runDiag, 1500);
})();

// ── FULLSCREEN TEST PAGE (owner spec: fullscreen ভিউ + নিচে মাল্টিবল বাটন) ──
(() => {
  const btn = document.getElementById('bt-fullscreen');
  if (!btn) return;
  let overlay = null;
  function notifyNative() {
    try { if (window.NativeKitImmersive) window.NativeKitImmersive.setFullscreen(!!document.fullscreenElement); } catch (e) {}
  }
  document.addEventListener('fullscreenchange', () => {
    notifyNative();
    if (!document.fullscreenElement && overlay) { overlay.remove(); overlay = null; }
  });
  btn.addEventListener('click', () => {
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:relative;width:100%;height:100%;background:radial-gradient(circle at 20% 15%,#ff006e,#3a0ca3 45%,#03071e);color:#fff;display:flex;flex-direction:column;justify-content:space-between;font-family:inherit';
    overlay.innerHTML = [
      '<div style="padding:28px 20px;text-align:center">',
      '  <div style="font-size:60px">📺</div>',
      '  <h2 style="margin:6px 0;color:#fff">Fullscreen Test Page</h2>',
      '  <p style="opacity:.85;max-width:480px;margin:8px auto 0">এই ভিউ fullscreen-এ আছে — system bar-গুলো <b>লুকিয়ে যাওয়া উচিত</b> (নিচের ফোনো বোতাম এলাকা সহ), শুধু হাল্কা swipe-এ ফিরে আসবে। নিচের বাটনগুলো এখন নিরাপদে ব্যবহারযোগ্য।</p>',
      '</div>',
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;padding:6px 12px 10px">',
      '  <button data-fs="a" style="background:#ffffff;color:#111;border:0;border-radius:10px;padding:12px 14px;font-weight:800">🎨 রঙ বদলাও</button>',
      '  <button data-fs="b" style="background:#ffd166;color:#221;border:0;border-radius:10px;padding:12px 14px;font-weight:800">🔃 বাটন জায়গা বদলাও</button>',
      '  <button data-fs="c" style="background:#06d6a0;color:#021;border:0;border-radius:10px;padding:12px 14px;font-weight:800">📊 Diagnostic</button>',
      '  <button data-fs="x" style="background:#ef476f;color:#fff;border:0;border-radius:10px;padding:12px 14px;font-weight:900">✖ Exit fullscreen</button>',
      '</div>'
    ].join('');
    const palette = ['radial-gradient(circle at 20% 15%,#ff006e,#3a0ca3 45%,#03071e)', 'radial-gradient(circle at 80% 20%,#06d6a0,#0b6623 45%,#021a06)', 'radial-gradient(circle at 50% 10%,#ffd166,#e09f3e 45%,#331e03)', 'radial-gradient(circle at 30% 30%,#8338ec,#3a86ff 45%,#04132b)'];
    let colorIdx = 0, swapped = false;
    overlay.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-fs]');
      if (!t) return;
      const a = t.dataset.fs;
      if (a === 'x') { document.exitFullscreen && document.exitFullscreen(); }
      else if (a === 'a') { colorIdx = (colorIdx + 1) % palette.length; overlay.style.background = palette[colorIdx]; }
      else if (a === 'b') { swapped = !swapped; overlay.style.flexDirection = swapped ? 'column-reverse' : 'column'; }
      else if (a === 'c') { alert('window: ' + window.innerHeight + 'px / screen: ' + screen.height + 'px\nfullscreen: ' + (document.fullscreenElement ? 'YES' : 'NO')); }
    });
    document.body.appendChild(overlay);
    overlay.requestFullscreen().catch((err) => alert('fullscreen ব্যর্থ: ' + err.message));
  });
})();

/* ================= Nearby P2P Lab (চ্যাট + ফাইল ট্রান্সফার) =================
 * সম্পূর্ণ অফলাইন device-to-device: @capacitor-trancee/nearby-connections
 * Protocol: JSON messages base64-encoded inside BYTES payloads (max 1,047,552 bytes).
 *   {t:'chat',from,ts,text} | {t:'nick',from} |
 *   {t:'fmeta',id,name,size,mime,chunks} | {t:'fchunk',id,seq,b64} |
 *   {t:'fend',id} | {t:'fcancel',id}
 * Chunk raw size = 262143 bytes (multiple of 3 -> per-chunk base64 strings concatenate
 * into a valid base64 file; each JSON message stays well under the 1 MiB limit).
 */
(() => {
  const CHUNK = 262143;
  let overlay;
  let nick = 'TestLab-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  let booted = false;
  let advertising = false;
  let discovering = false;
  let autoAccept = true;
  let pendingFile = null;
  const discovered = new Map();   // id -> { name, incoming, token }
  const peers = new Map();        // id -> { name, quality }
  const outgoing = new Map();     // fileId -> { name, total, sent, payloadIDs: number[] }
  const incoming = new Map();     // fileId -> { meta, parts: string[], got, bytes }
  const listenerHandles = [];

  const $ = (sel) => overlay && overlay.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

  function sysLog(msg) {
    const box = $('#nk-log');
    if (!box) return;
    const time = new Date().toLocaleTimeString();
    box.insertAdjacentHTML('beforeend', `<div style="opacity:.9"><span style="opacity:.5">${time}</span> ${msg}</div>`);
    box.scrollTop = box.scrollHeight;
  }

  function chatLog(from, text, mine) {
    const box = $('#nk-chat');
    if (!box) return;
    const color = mine ? '#0ea5e9' : '#22c55e';
    box.insertAdjacentHTML('beforeend', `<div style="margin:3px 0"><b style="color:${color}">${esc(from)}:</b> ${esc(text)}</div>`);
    box.scrollTop = box.scrollHeight;
  }

  function refreshStatus() {
    const s = $('#nk-statusline');
    if (!s) return;
    s.innerHTML = `strategy: <b>${esc($('#nk-strategy').value)}</b> &nbsp;·&nbsp; advertise: <b style="color:${advertising ? '#22c55e' : '#94a3b8'}">${advertising ? 'ON' : 'off'}</b> &nbsp;·&nbsp; discover: <b style="color:${discovering ? '#22c55e' : '#94a3b8'}">${discovering ? 'ON' : 'off'}</b> &nbsp;·&nbsp; connected: <b>${peers.size}</b>`;
  }

  function refreshDiscovery() {
    const box = $('#nk-discovered');
    if (!box) return;
    if (!discovered.size) { box.innerHTML = '<div style="opacity:.55;padding:6px 2px">এখনো কারো পাওয়া যায়নি…</div>'; return; }
    box.innerHTML = '';
    discovered.forEach((d, id) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0';
      row.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📱 <b>${esc(d.name || id.slice(0, 8))}</b>${d.token ? ` <small style="opacity:.6">🔑${esc(d.token)}</small>` : ''}</span>` +
        (d.incoming
          ? `<button data-nk="accept" data-id="${esc(id)}" style="${btnMini('#22c55e')}">✔ Accept</button><button data-nk="reject" data-id="${esc(id)}" style="${btnMini('#ef4444')}">✖ Reject</button>`
          : `<button data-nk="connect" data-id="${esc(id)}" style="${btnMini('#3b82f6')}">🔗 Connect</button>`);
      box.appendChild(row);
    });
  }

  function refreshPeers() {
    const box = $('#nk-peers');
    if (!box) return;
    if (!peers.size) { box.innerHTML = '<div style="opacity:.55;padding:4px 2px">কেউ সংযুক্ত নয়</div>'; return; }
    box.innerHTML = '';
    peers.forEach((p, id) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0';
      row.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🟢 <b>${esc(p.name)}</b>${p.quality ? ` <small style="opacity:.6">~${esc(p.quality)}</small>` : ''}</span><button data-nk="disconnect" data-id="${esc(id)}" style="${btnMini('#64748b')}">✖ বিচ্ছিন্ন</button>`;
      box.appendChild(row);
    });
  }

  const btnMini = (bg) => `background:${bg};color:#fff;border:0;border-radius:8px;padding:6px 10px;font-weight:700;font-size:12px;white-space:nowrap`;

  function progressLine(id, label) {
    const wrap = $('#nk-progress');
    if (!wrap) return null;
    let el = wrap.querySelector(`[data-pgid="${id}"]`);
    if (el) return el;
    el = document.createElement('div');
    el.dataset.pgid = id;
    el.style.cssText = 'margin:4px 0;font-size:12px';
    el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span><small data-pct></small></div><div style="background:#1e293b;border-radius:6px;height:8px;margin-top:3px;overflow:hidden"><div data-bar style="background:linear-gradient(90deg,#3b82f6,#22c55e);height:100%;width:0%;transition:width .2s"></div></div>`;
    wrap.appendChild(el);
    return el;
  }
  function setProgress(id, pct, note) {
    const el = progressLine(id, note || id);
    if (!el) return;
    el.querySelector('[data-bar]').style.width = Math.min(100, Math.max(0, pct)) + '%';
    el.querySelector('[data-pct]').textContent = Math.round(pct) + '%';
  }
  function clearProgress(id) { const el = overlay && overlay.querySelector(`[data-pgid="${id}"]`); el && el.remove(); }

  function friendlyErr(raw) {
    if (/8001|ALREADY_ADVERTISING/i.test(raw)) return 'ℹ️ ইতিমধ্যেই advertise চলছে (native state sync ✓)';
    if (/8002|ALREADY_DISCOVERING/i.test(raw)) return 'ℹ️ ইতিমধ্যেই discovery চলছে (native state sync ✓)';
    if (/8034|MISSING_PERMISSION/i.test(raw)) return '⛔ Location পারমিশন নেই — ⚙️ Settings → Location → Allowed করুন';
    if (/8003|ALREADY_CONNECTED/i.test(raw)) return 'ℹ️ ওই peer-এর সাথে ইতিমধ্যে সংযোগ আছে';
    if (/8047|MISSING_FEATURE/i.test(raw)) return '⛔ ডিভাইসে Wi-Fi/Bluetooth ফিচার নেই';
    return null;
  }

  async function api(promise, okLog) {
    try {
      const r = await promise;
      if (okLog) sysLog(okLog);
      return r;
    } catch (e) {
      const raw = (e && e.message) ? String(e.message) : String(e);
      const f = friendlyErr(raw);
      if (f) {
        sysLog(f);
        if (/8001|8002|8003|ALREADY/i.test(raw)) return { already: true };
      } else {
        sysLog(`⚠️ ${esc(raw)}`);
      }
      throw e;
    }
  }

  async function sendJSON(msg, endpointID) {
    const nkc = window.NativeKit.nearby;
    const ids = endpointID ? { endpointID } : { endpointIDs: [...peers.keys()] };
    if (!ids.endpointID && !ids.endpointIDs.length) throw new Error('এখনো কোনো peer সংযুক্ত নেই — আগে 🔍 Discover চালিয়ে একজনের সাথে 🔗 Connect করুন।');
    return nkc.sendPayload({ ...ids, payload: JSON.stringify(msg) });
  }

  async function sendChat() {
    const input = $('#nk-msg');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await api(sendJSON({ t: 'chat', from: nick, ts: Date.now(), text }));
    chatLog('আমি (' + nick + ')', text, true);
  }

  async function sendFile(target) {
    if (!pendingFile) { sysLog('⚠️ আগে একটি ফাইল বাছুন'); return; }
    const nkc = window.NativeKit.nearby;
    const buf = new Uint8Array(await pendingFile.arrayBuffer());
    const chunks = Math.ceil(buf.length / CHUNK) || 1;
    const fileId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    outgoing.set(fileId, { name: pendingFile.name, total: chunks, sent: 0, payloadIDs: [] });
    progressLine(fileId, '⬆️ ' + pendingFile.name);
    sysLog(`⬆️ পাঠানো শুরু: <b>${esc(pendingFile.name)}</b> (${fmtBytes(buf.length)}, ${chunks} chunk${chunks > 1 ? 's' : ''})`);
    await api(sendJSON({ t: 'fmeta', id: fileId, name: pendingFile.name, size: buf.length, mime: pendingFile.type || 'application/octet-stream', chunks }, target));
    for (let seq = 0; seq < chunks; seq++) {
      const o = outgoing.get(fileId);
      if (!o) { sysLog('⚠️ transfer বাতিল'); return; }
      let binary = '';
      const slice = buf.subarray(seq * CHUNK, Math.min(buf.length, (seq + 1) * CHUNK));
      for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
      const res = await api(sendJSON({ t: 'fchunk', id: fileId, seq, b64: btoa(binary) }, target));
      if (res && typeof res.payloadID === 'number') o.payloadIDs.push(res.payloadID);
      o.sent += 1;
      setProgress(fileId, (o.sent / chunks) * 100, '⬆️ ' + pendingFile.name);
    }
    await api(sendJSON({ t: 'fend', id: fileId }, target));
    sysLog(`✅ পাঠানো সম্পন্ন: <b>${esc(pendingFile.name)}</b>`);
    outgoing.delete(fileId);
  }

  async function handleReceived(endpointID, decoded) {
    let msg;
    try { msg = JSON.parse(decoded); } catch { chatLog(peers.get(endpointID)?.name || endpointID, decoded, false); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'chat') { chatLog(msg.from || 'peer', msg.text || '', false); return; }
    if (msg.t === 'nick') { const p = peers.get(endpointID); if (p) { p.name = msg.from || p.name; refreshPeers(); } return; }
    if (msg.t === 'fmeta') {
      const parts = new Array(msg.chunks);
      incoming.set(msg.id, { meta: msg, parts, got: 0, bytes: 0 });
      progressLine(msg.id, '⬇️ ' + (msg.name || msg.id));
      sysLog(`⬇️ ফাইল আসছে: <b>${esc(msg.name)}</b> (${fmtBytes(msg.size)}, ${msg.chunks} chunks, ${esc(msg.mime || '')})`);
      return;
    }
    if (msg.t === 'fchunk') {
      const rec = incoming.get(msg.id);
      if (!rec || rec.parts[msg.seq] !== undefined) return;
      rec.parts[msg.seq] = msg.b64;
      rec.got += 1;
      rec.bytes += Math.floor(msg.b64.length * 3 / 4);
      setProgress(msg.id, (rec.got / rec.meta.chunks) * 100, '⬇️ ' + rec.meta.name);
      return;
    }
    if (msg.t === 'fend') {
      const rec = incoming.get(msg.id);
      if (!rec) return;
      incoming.delete(msg.id);
      if (rec.got !== rec.meta.chunks) {
        sysLog(`⚠️ <b>${esc(rec.meta.name)}</b>: ${rec.got}/${rec.meta.chunks} chunks এসেছে — ফাইল অসম্পূর্ণ, সংরক্ষণ হলো না`);
        clearProgress(msg.id);
        return;
      }
      const safeName = (rec.meta.name || 'file').replace(/[^\w.\-\u0980-\u09FF ]/g, '_').slice(-80);
      const b64 = rec.parts.join('');
      try {
        await window.NativeKit.filesystem.writeFile({ path: 'nativekit-lab/received/' + safeName, data: b64, directory: 'Data', recursive: true });
        const stat = await window.NativeKit.filesystem.stat({ path: 'nativekit-lab/received/' + safeName, directory: 'Data' });
        sysLog(`✅ প্রাপ্ত ও সংরক্ষিত: <b>${esc(safeName)}</b> (${fmtBytes(stat.size)}) — Data/nativekit-lab/received/`);
      } catch (e) {
        sysLog(`⚠️ ফাইল save ব্যর্থ: ${esc(e.message || e)}`);
      }
      clearProgress(msg.id);
      return;
    }
    if (msg.t === 'fcancel') {
      const rec = incoming.get(msg.id);
      if (rec) { incoming.delete(msg.id); clearProgress(msg.id); sysLog(`⚠️ প্রেরক transfer বাতিল করেছেন: ${esc(rec.meta.name)}`); }
    }
  }

  async function wireListeners() {
    const nkc = window.NativeKit.nearby;
    const on = (name, fn) => nkc.addListener(name, fn).then((h) => listenerHandles.push(h)).catch((e) => sysLog(`⚠️ listener ${name}: ${esc(e.message || e)}`));
    await on('onPermissionChanged', (granted) => sysLog(`permission changed → ${granted ? '✅ granted' : '⛔ revoked'}`));
    await on('onBluetoothStateChanged', (state) => sysLog(`bluetooth → ${esc(state)}`));
    await on('onEndpointFound', (e) => {
      discovered.set(e.endpointID, { name: e.endpointName || e.endpointID });
      sysLog(`🔍 পাওয়া গেছে: <b>${esc(e.endpointName || e.endpointID)}</b>`);
      refreshDiscovery();
    });
    await on('onEndpointLost', (e) => {
      discovered.delete(e.endpointID);
      sysLog(`…হারিয়ে গেছে: ${esc(e.endpointName || e.endpointID)}`);
      refreshDiscovery();
    });
    await on('onEndpointInitiated', async (e) => {
      const d = { name: e.endpointName || e.endpointID, incoming: e.isIncomingConnection, token: e.authenticationToken };
      discovered.set(e.endpointID, d);
      sysLog(`🤝 handshake: <b>${esc(d.name)}</b> (token <b>${esc(e.authenticationToken)}</b>${e.isIncomingConnection ? ', incoming' : ''})`);
      refreshDiscovery();
      if (autoAccept) {
        await api(window.NativeKit.nearby.acceptConnection({ endpointID: e.endpointID }), '✔ auto-accept করা হলো').catch(() => {});
      }
    });
    await on('onEndpointConnected', async (e) => {
      peers.set(e.endpointID, { name: discovered.get(e.endpointID)?.name || e.endpointName || e.endpointID });
      discovered.delete(e.endpointID);
      sysLog(`🟢 সংযুক্ত: <b>${esc(peers.get(e.endpointID).name)}</b>`);
      refreshDiscovery(); refreshPeers(); refreshStatus();
      await api(sendJSON({ t: 'nick', from: nick }, e.endpointID)).catch(() => {});
    });
    await on('onEndpointRejected', (e) => { discovered.delete(e.endpointID); sysLog(`⛔ সংযোগ প্রত্যাখ্যাত: ${esc(e.endpointName || e.endpointID)}`); refreshDiscovery(); });
    await on('onEndpointFailed', (e) => { discovered.delete(e.endpointID); sysLog(`⚠️ সংযোগ ব্যর্থ (${esc(e.status || '?')}): ${esc(e.endpointName || e.endpointID)}`); refreshDiscovery(); });
    await on('onEndpointDisconnected', (e) => {
      peers.delete(e.endpointID);
      sysLog(`🔴 বিচ্ছিন্ন: ${esc(e.endpointName || e.endpointID)}`);
      refreshPeers(); refreshStatus();
    });
    await on('onEndpointBandwidthChanged', (e) => {
      const p = peers.get(e.endpointID);
      if (p) { p.quality = e.quality; sysLog(`📶 bandwidth: ${esc(p.name)} → <b>${esc(e.quality)}</b>`); refreshPeers(); }
    });
    await on('onPayloadReceived', async (e) => {
      const text = window.NativeKit.nearby.decodeBase64Utf8(e.payload || '');
      await handleReceived(e.endpointID, text).catch((err) => sysLog(`⚠️ ${esc(err.message || err)}`));
    });
    await on('onPayloadTransferUpdate', () => { /* per-chunk progress tracked via send ack + receiver counters */ });
  }

  async function bootNearby() {
    if (booted) return;
    const nkc = window.NativeKit.nearby;
    sysLog('⏳ পারমিশন চেক হচ্ছে…');
    let perms = await api(nkc.requestPermissions(), null).catch(() => null);
    let missing = perms ? Object.entries(perms).filter(([, v]) => v !== 'granted').map(([k]) => k) : ['?'];
    // 8034 fix: Location ছাড়া প্লাগিন advertise/discovery ঠুকে দেয় — আমাদের Geolocation ফ্লো দিয়ে রিট্রাই
    if (missing.some((k) => k === 'location' || k === 'locationCoarse')) {
      try {
        sysLog('📍 Location পারমিশন জিজ্ঞেস করা হচ্ছে (Geolocation ফ্লো)…');
        const g = await window.NativeKit.permissions.requestLocation();
        sysLog(`📍 ফল: ${esc(JSON.stringify(g))}`);
        perms = await nkc.requestPermissions(['location', 'locationCoarse']);
        missing = Object.entries(perms).filter(([, v]) => v !== 'granted').map(([k]) => k);
      } catch (e) { sysLog(`⚠️ ${esc(e.message || e)}`); }
    }
    if (missing.length) {
      sysLog(`⛔ বাকি: <b>${missing.join(', ')}</b>`);
      sysLog('👉 Android দুইবার deny করলে আর জিজ্ঞেস করে না — উপরের <b>⚙️</b> বাটনে Settings খুলে Location / Nearby devices / Bluetooth দিন, তারপর আবার ▶ Start');
    } else sysLog('✅ সব permission granted');
    await api(nkc.initialize({ endpointName: nick, strategy: $('#nk-strategy').value }), '✅ initialize OK (strategy: ' + $('#nk-strategy').value + ')');
    await wireListeners();
    booted = true;
    refreshStatus();
    await syncNativeStatus();
  }

  async function syncNativeStatus() {
    // overlay reopen / আবার Start — native state-এর সাথে UI flag সিঙ্ক (8001/8002-এর কারণ)
    try {
      const st = await window.NativeKit.nearby.status();
      if (typeof st.isAdvertising === 'boolean' && st.isAdvertising !== advertising) {
        advertising = st.isAdvertising;
        const b = overlay.querySelector('[data-nk="adv"]'); if (b) b.textContent = '📢 Advertise: ' + (advertising ? 'ON' : 'OFF');
      }
      if (typeof st.isDiscovering === 'boolean' && st.isDiscovering !== discovering) {
        discovering = st.isDiscovering;
        const b = overlay.querySelector('[data-nk="disc"]'); if (b) b.textContent = '🔍 Discover: ' + (discovering ? 'ON' : 'OFF');
      }
      refreshStatus();
    } catch { /* pre-init native */ }
  }

  function build() {
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:radial-gradient(circle at 25% 10%,#0f2f4e,#081527 55%,#030a12);color:#e2e8f0;display:flex;flex-direction:column;font-family:inherit;font-size:14px';
    overlay.innerHTML = [
      '<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(2,8,20,.8)">',
      '  <span style="font-size:22px">📡</span><b style="flex:1;font-size:16px">Nearby P2P Lab</b>',
      '  <button data-nk="reset" style="background:#334155;color:#fff;border:0;border-radius:8px;padding:7px 10px;font-weight:700">🔄 Reset</button>',
      '  <button data-nk="settings" style="background:#475569;color:#fff;border:0;border-radius:8px;padding:7px 10px;font-weight:700">⚙️</button>',
      '  <button data-nk="close" style="background:#ef4444;color:#fff;border:0;border-radius:8px;padding:7px 12px;font-weight:800">✖</button>',
      '</div>',
      '<div style="flex:1;min-height:0;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:10px">',
      '  <div id="nk-statusline" style="font-size:12px;opacity:.9"></div>',
      '  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">',
      '    <input id="nk-nick" style="flex:1;min-width:120px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:8px 10px" placeholder="তোমার নাম">',
      '    <select id="nk-strategy" style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:8px"><option value="star">⭐ star (1↔N)</option><option value="cluster">🕸 cluster (M↔N)</option><option value="pointToPoint">↔ pointToPoint (1↔1)</option></select>',
      '    <button data-nk="boot" style="background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:800">▶ Start</button>',
      '  </div>',
      '  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">',
      '    <button data-nk="adv" style="background:#16a34a;color:#fff;border:0;border-radius:8px;padding:9px 12px;font-weight:800">📢 Advertise: OFF</button>',
      '    <button data-nk="disc" style="background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:9px 12px;font-weight:800">🔍 Discover: OFF</button>',
      '    <label style="font-size:12px;display:flex;gap:5px;align-items:center;opacity:.9"><input type="checkbox" id="nk-autoaccept" checked> auto-accept</label>',
      '  </div>',
      '  <div style="background:rgba(15,23,42,.6);border:1px solid #1e293b;border-radius:10px;padding:8px 10px"><b style="font-size:12px;opacity:.8">🔍 পাওয়া ডিভাইস</b><div id="nk-discovered" style="margin-top:4px"><div style="opacity:.55;padding:6px 2px">এখনো কারো পাওয়া যায়নি…</div></div></div>',
      '  <div style="background:rgba(15,23,42,.6);border:1px solid #1e293b;border-radius:10px;padding:8px 10px"><b style="font-size:12px;opacity:.8">🟢 সংযুক্ত peer</b><div id="nk-peers" style="margin-top:4px"><div style="opacity:.55;padding:4px 2px">কেউ সংযুক্ত নয়</div></div></div>',
      '  <div style="background:rgba(15,23,42,.6);border:1px solid #1e293b;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-height:120px">',
      '    <b style="font-size:12px;opacity:.8">💬 চ্যাট</b>',
      '    <div id="nk-chat" style="flex:1;min-height:80px;max-height:160px;overflow-y:auto;background:rgba(2,8,20,.5);border-radius:8px;padding:6px 8px;font-size:13px"></div>',
      '    <div style="display:flex;gap:6px"><input id="nk-msg" style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:8px 10px" placeholder="বার্তা লেখো (সব সংযুক্ত peer-এ যাবে)…"><button data-nk="send" style="background:#0ea5e9;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:800">➤</button></div>',
      '  </div>',
      '  <div style="background:rgba(15,23,42,.6);border:1px solid #1e293b;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px">',
      '    <b style="font-size:12px;opacity:.8">📎 ফাইল ট্রান্সফার (যেকোনো ফাইল, chunk-এ ভাগ হয়ে যায়)</b>',
      '    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">',
      '      <input type="file" id="nk-file" style="display:none">',
      '      <button data-nk="pick" style="background:#475569;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:700">📂 ফাইল বাছো</button>',
      '      <button data-nk="sendfile" style="background:#f59e0b;color:#1a1005;border:0;border-radius:8px;padding:8px 12px;font-weight:800">⬆ সবাইকে পাঠাও</button>',
      '      <button data-nk="cancelfile" style="background:#b91c1c;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:700">⏹ cancel</button>',
      '    </div>',
      '    <div id="nk-fileinfo" style="font-size:12px;opacity:.8">কোনো ফাইল বেছে নেওয়া হয়নি</div>',
      '    <div id="nk-progress"></div>',
      '  </div>',
      '  <div style="background:rgba(15,23,42,.6);border:1px solid #1e293b;border-radius:10px;padding:8px 10px"><b style="font-size:12px;opacity:.8">📋 ইভেন্ট লগ</b><div id="nk-log" style="margin-top:4px;height:120px;overflow-y:auto;background:rgba(2,8,20,.5);border-radius:8px;padding:6px 8px;font-size:12px;line-height:1.5"></div></div>',
      '</div>'
    ].join('');

    overlay.querySelector('#nk-nick').value = nick;
    overlay.addEventListener('change', (ev) => {
      if (ev.target.id === 'nk-file' && ev.target.files[0]) {
        pendingFile = ev.target.files[0];
        overlay.querySelector('#nk-fileinfo').textContent = `📄 ${pendingFile.name} (${fmtBytes(pendingFile.size)}, ${pendingFile.type || 'unknown type'})`;
      }
      if (ev.target.id === 'nk-nick') nick = ev.target.value.trim() || nick;
      if (ev.target.id === 'nk-autoaccept') autoAccept = ev.target.checked;
      if (ev.target.id === 'nk-strategy' && booted) sysLog('ℹ️ strategy বদলাতে Reset → Start করো (ALREADY_HAVE_ACTIVE_STRATEGY এড়াতে)');
    });
    overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'nk-msg') sendChat(); });
    overlay.addEventListener('click', async (ev) => {
      const t = ev.target.closest('[data-nk]');
      if (!t) return;
      const a = t.dataset.nk;
      const nkc = window.NativeKit.nearby;
      try {
        if (a === 'close') { overlay.remove(); return; }
        if (a === 'boot') { await bootNearby(); return; }
        if (a === 'settings') {
          sysLog('⚙️ App Settings খুলছি — Location / Nearby devices / Bluetooth allow করে ফিরে আসুন');
          await window.NativeKit.permissions.openAppSettings().catch((e) => sysLog(`⚠️ ${esc(e.message || e)}`));
          return;
        }
        if (!booted && a !== 'reset') { sysLog('⚠️ আগে ▶ Start চাপ'); return; }
        if (a === 'reset') {
          await api(nkc.stopAdvertising().catch(() => {}), null);
          await api(nkc.stopDiscovery().catch(() => {}), null);
          [...peers.keys()].forEach((id) => nkc.disconnect({ endpointID: id }).catch(() => {}));
          await api(nkc.reset().catch(() => {}), null);
          advertising = false; discovering = false; booted = false;
          peers.clear(); discovered.clear();
          t.textContent = '🔄 Reset ✓';
          const advBtn = overlay.querySelector('[data-nk="adv"]'); if (advBtn) advBtn.textContent = '📢 Advertise: OFF';
          const discBtn = overlay.querySelector('[data-nk="disc"]'); if (discBtn) discBtn.textContent = '🔍 Discover: OFF';
          refreshDiscovery(); refreshPeers(); refreshStatus();
          sysLog('🔄 সব বন্ধ — আবার ▶ Start চাপ');
          return;
        }
        if (a === 'adv') {
          if (!advertising) { await api(nkc.startAdvertising({ endpointName: nick }), '📢 advertise শুরু'); advertising = true; }
          else { await api(nkc.stopAdvertising(), '📢 advertise বন্ধ'); advertising = false; }
          t.textContent = '📢 Advertise: ' + (advertising ? 'ON' : 'OFF');
          refreshStatus(); return;
        }
        if (a === 'disc') {
          if (!discovering) { await api(nkc.startDiscovery(), '🔍 discovery শুরু'); discovering = true; }
          else { await api(nkc.stopDiscovery(), '🔍 discovery বন্ধ'); discovering = false; }
          t.textContent = '🔍 Discover: ' + (discovering ? 'ON' : 'OFF');
          refreshStatus(); return;
        }
        if (a === 'connect') { await api(nkc.requestConnection({ endpointID: t.dataset.id, endpointName: nick }), '🔗 connection request পাঠানো হলো'); return; }
        if (a === 'accept') { await api(nkc.acceptConnection({ endpointID: t.dataset.id }), '✔ accept'); return; }
        if (a === 'reject') { await api(nkc.rejectConnection({ endpointID: t.dataset.id }), '✖ reject'); discovered.delete(t.dataset.id); refreshDiscovery(); return; }
        if (a === 'disconnect') { await api(nkc.disconnect({ endpointID: t.dataset.id }), '🔴 বিচ্ছিন্ন'); return; }
        if (a === 'send') { await sendChat(); return; }
        if (a === 'pick') { overlay.querySelector('#nk-file').click(); return; }
        if (a === 'sendfile') { await sendFile(); return; }
        if (a === 'cancelfile') {
          for (const [fileId, o] of outgoing) {
            for (const pid of o.payloadIDs) await nkc.cancelPayload({ payloadID: pid }).catch(() => {});
            await sendJSON({ t: 'fcancel', id: fileId }).catch(() => {});
            outgoing.delete(fileId); clearProgress(fileId); sysLog(`⏹ transfer বাতিল: ${esc(o.name)}`);
          }
        }
      } catch { /* api() already logged */ }
    });
  }

  document.getElementById('bt-nearby').addEventListener('click', () => {
    if (!window.NativeKit || !window.NativeKit.nearby) { alert('এই ডিভাইসে Nearby natively নেই (web build?)'); return; }
    if (!window.NativeKit.isNative) { alert('Nearby Connections শুধু native Android/iOS-এ চলে — web-এ নয়।'); return; }
    if (!overlay) build();
    document.body.appendChild(overlay);
    refreshStatus();
    sysLog('📡 P2P Lab খোলা হলো — ▶ Start চেপে permissions + initialize করো');
  });
})();
