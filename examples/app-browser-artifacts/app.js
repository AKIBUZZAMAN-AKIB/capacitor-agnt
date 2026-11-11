const output = document.getElementById('output');
const log = (label, value) => { output.textContent = `${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`; };
const fail = (label, error) => log(`${label} ব্যর্থ`, error?.message || String(error));
const on = (id, action) => document.getElementById(id).addEventListener('click', () => action().catch((error) => fail(labelFor(id), error)));
const labelFor = (id) => ({ 'publish-mini': 'Mini UI publish', 'publish-floating': 'Floating publish', 'show-floating': 'Floating show', 'hide-floating': 'Floating hide', 'publish-home': 'Home snapshot publish', 'pin-home': 'Home pin', 'delete-all': 'Artifact delete' })[id] || id;

let elapsed = 0;
let startedAt = null;
const currentElapsed = () => elapsed + (startedAt == null ? 0 : Date.now() - startedAt);
const format = (milliseconds) => {
  const tenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
};
setInterval(() => { document.getElementById('main-time').textContent = format(currentElapsed()); }, 100);
document.getElementById('main-toggle').addEventListener('click', () => {
  if (startedAt == null) startedAt = Date.now();
  else { elapsed += Date.now() - startedAt; startedAt = null; }
  document.getElementById('main-toggle').textContent = startedAt == null ? 'Start' : 'Pause';
});
document.getElementById('main-reset').addEventListener('click', () => { elapsed = 0; startedAt = null; document.getElementById('main-toggle').textContent = 'Start'; });

const artifactStyle = `*{box-sizing:border-box}body{margin:0;background:#07111f;color:#e6f2ff;font:16px system-ui,sans-serif}.card{min-height:100vh;display:grid;place-content:center;text-align:center;padding:18px;background:radial-gradient(circle at top,#123a50,#07111f 65%)}.time{font:800 48px/1.1 ui-monospace,monospace;color:#5eead4;letter-spacing:-.06em}.label{color:#9db4c8;font-size:12px;letter-spacing:.12em;text-transform:uppercase}.row{display:flex;justify-content:center;gap:8px;margin-top:16px}button{border:0;border-radius:9px;padding:9px 13px;background:#0ea5e9;color:#fff;font-weight:700}button.alt{background:#29445d}`;
const stopwatchScript = `(()=>{let elapsed=0,started=null;const time=document.getElementById('time'),toggle=document.getElementById('toggle');const value=()=>elapsed+(started===null?0:Date.now()-started);const draw=()=>{const t=Math.floor(value()/100),m=Math.floor(t/600),s=Math.floor(t/10)%60;time.textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+(t%10)};toggle.onclick=()=>{if(started===null)started=Date.now();else{elapsed+=Date.now()-started;started=null}toggle.textContent=started===null?'Start':'Pause';draw()};document.getElementById('reset').onclick=()=>{elapsed=0;started=null;toggle.textContent='Start';draw()};setInterval(draw,100);draw()})();`;
const miniHtml = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${artifactStyle}</style></head><body><div class="card"><div class="label">Offline Mini UI</div><div class="time" id="time">00:00.0</div><div class="row"><button id="toggle">Start</button><button class="alt" id="reset">Reset</button></div></div><script>${stopwatchScript}<\/script></body></html>`;
const floatingHtml = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${artifactStyle}body{background:transparent}.card{min-height:100vh;border-radius:18px;background:#07111f}.time{font-size:38px}</style></head><body><div class="card"><div class="label">Floating stopwatch</div><div class="time" id="time">00:00.0</div><div class="row"><button id="toggle">Start</button><button class="alt" id="reset">Reset</button></div></div><script>${stopwatchScript}<\/script></body></html>`;
const homeHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>${artifactStyle}.card{min-height:100vh}.time{font-size:42px}</style></head><body><div class="card"><div class="label">Static home snapshot</div><div class="time">${format(currentElapsed())}</div><p>Published ${new Date().toLocaleTimeString()}</p></div></body></html>`;

const publish = async (group, kind, html, title) => {
  const record = await window.NativeKit[group].publish({ id: 'stopwatch', title, description: 'NativeKit artifact demo; self-contained offline HTML', html, config: kind === 'floating-ui' ? { width: 300, height: 250, chrome: 'none' } : { widthPx: 420, heightPx: 300 } });
  log(`${kind} saved`, { id: record.id, source: record.source, revision: record.revision, integrity: record.integrity, storage: record.storage });
  return record;
};
on('publish-mini', () => publish('miniUI', 'mini-ui', miniHtml(), 'Stopwatch Mini UI'));
on('publish-floating', () => publish('floatingUI', 'floating-ui', floatingHtml(), 'Stopwatch Floating UI'));
on('show-floating', async () => {
  let permission = await window.NativeKit.floatingUI.checkPermission();
  if (!permission.granted) {
    await window.NativeKit.floatingUI.requestPermission();
    permission = await window.NativeKit.floatingUI.checkPermission();
  }
  if (!permission.granted) throw new Error('Display over other apps permission দেওয়া হয়নি');
  const result = await window.NativeKit.floatingUI.show('stopwatch');
  log('Floating UI visible', result);
});
on('hide-floating', async () => log('Floating UI', await window.NativeKit.floatingUI.hide('stopwatch')));
on('publish-home', () => publish('homeWidget', 'home-widget', homeHtml(), 'Stopwatch snapshot'));
on('pin-home', async () => {
  const result = await window.NativeKit.homeWidget.requestPin('stopwatch');
  log(result.requested ? 'Launcher pin request পাঠানো হয়েছে' : 'Config saved; launcher pin unsupported—picker থেকে যোগ করুন', result);
});
on('delete-all', async () => {
  const results = await Promise.allSettled([
    window.NativeKit.miniUI.remove('stopwatch'),
    window.NativeKit.floatingUI.hide('stopwatch').then(() => window.NativeKit.floatingUI.remove('stopwatch')),
    window.NativeKit.homeWidget.remove('stopwatch'),
  ]);
  log('Delete lifecycle', results.map((result) => result.status === 'fulfilled' ? result.value : { error: result.reason?.message }));
});
window.NativeKit.ready().then((kit) => log('Ready · publish করতে উপরের button চাপুন', { app: kit.appIdentity, note: 'Mini UI preview host management UI থেকে করুন' })).catch((error) => fail('NativeKit ready', error));
