// AS Screen Recorder - main process. Made by AS Technology.
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let ffmpegPath = require('ffmpeg-static');
if (app.isPackaged) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');

const ICON = path.join(__dirname, 'assets', 'icon.png');
const LOW_DISK_WARN = 2 * 1024 ** 3;   // warn below 2 GB free
const LOW_DISK_STOP = 200 * 1024 ** 2; // safely finalize below 200 MB free
const MIN_START_FREE = 500 * 1024 ** 2;

let mainWin = null, recorderWin = null, barWin = null, selectorWin = null;
let rec = null; // active recording state
let pendingDisplayId = null;

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  mode: 'full', displayId: null, area: null,
  webcam: false, camId: '', camCorner: 'bottom-right', camSize: 'medium',
  mic: false, micId: '', system: false,
  resolution: '1080p', fps: 30, quality: 'balanced',
  folder: path.join(app.getPath('videos'), 'AS Screen Recorder'),
  fileName: 'AS Recording {date}'
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch {}
}

// ---------- helpers ----------
const webPrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
const sendMain = (ch, data) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data); };
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function uniquePath(folder, base) {
  const clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\.mp4$/i, '') || 'AS Recording';
  let p = path.join(folder, clean + '.mp4'), n = 1;
  while (fs.existsSync(p)) p = path.join(folder, `${clean} (${n++}).mp4`);
  return p;
}
function displayById(id) {
  const all = screen.getAllDisplays();
  return all.find(d => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

// ---------- windows ----------
function createMain() {
  mainWin = new BrowserWindow({
    width: 1020, height: 760, minWidth: 900, minHeight: 640, backgroundColor: '#0b1226',
    title: 'AS Screen Recorder', icon: ICON, autoHideMenuBar: true, show: false, webPreferences: webPrefs
  });
  mainWin.removeMenu();
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; });
}

function createBar(display) {
  const w = 400, h = 60;
  const b = display.workArea;
  barWin = new BrowserWindow({
    width: w, height: h, x: Math.round(b.x + (b.width - w) / 2), y: b.y + 14,
    frame: false, resizable: false, maximizable: false, minimizable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: true, backgroundColor: '#0b1226', hasShadow: true, show: false,
    webPreferences: webPrefs
  });
  barWin.setAlwaysOnTop(true, 'screen-saver');
  barWin.setContentProtection(true); // keeps the control bar OUT of the recorded video
  barWin.loadFile(path.join(__dirname, 'src', 'bar.html'));
  barWin.once('ready-to-show', () => barWin && barWin.showInactive());
  barWin.on('closed', () => { barWin = null; });
}

// ---------- permissions & screen capture hookup ----------
function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(perm)));
  ses.setPermissionCheckHandler((wc, perm) => ['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(perm));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find(s => String(s.display_id) === String(pendingDisplayId)) || sources[0];
      const wantAudio = request.audioRequested;
      callback(wantAudio ? { video: src, audio: 'loopback' } : { video: src });
    } catch (e) { callback({}); }
  }, { useSystemPicker: false });
}

// ---------- IPC: settings / displays / folders ----------
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (e, s) => { saveSettings(s); return true; });
ipcMain.handle('displays:list', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, label: `Display ${i + 1}${d.id === primary ? ' (Main)' : ''} - ${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}`,
    width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor)
  }));
});
ipcMain.handle('folder:choose', async (e, current) => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'Choose where to save recordings', defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('file:saveCopy', async (e, src) => {
  const r = await dialog.showSaveDialog(mainWin, { title: 'Save a copy of the video', defaultPath: path.join(path.dirname(src), path.basename(src)), filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  if (r.canceled || !r.filePath) return null;
  try { fs.copyFileSync(src, r.filePath); return r.filePath; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('shell:open', async (e, p) => { const err = await shell.openPath(p); return err || ''; });
ipcMain.handle('shell:show', (e, p) => { shell.showItemInFolder(p); return true; });

// ---------- IPC: area selector ----------
ipcMain.handle('area:select', (e, displayId, existing) => new Promise(resolve => {
  const d = displayById(displayId);
  if (selectorWin) { try { selectorWin.close(); } catch {} }
  selectorWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, fullscreenable: false, show: false, webPreferences: webPrefs
  });
  selectorWin.setAlwaysOnTop(true, 'screen-saver');
  selectorWin.setBounds(d.bounds);
  selectorWin.loadFile(path.join(__dirname, 'src', 'selector.html'), { query: { rect: existing ? JSON.stringify(existing) : '' } });
  selectorWin.once('ready-to-show', () => { selectorWin.show(); selectorWin.focus(); });
  let done = false;
  const finish = (val) => {
    if (done) return; done = true;
    ipcMain.removeListener('area:result', onResult);
    if (selectorWin && !selectorWin.isDestroyed()) selectorWin.close();
    selectorWin = null;
    if (mainWin) { mainWin.show(); mainWin.focus(); }
    resolve(val);
  };
  const onResult = (ev, rect) => finish(rect ? { displayId: d.id, ...rect } : null);
  ipcMain.on('area:result', onResult);
  selectorWin.on('closed', () => finish(null));
  if (mainWin) mainWin.hide();
}));

// ---------- recording ----------
ipcMain.handle('rec:start', async (e, cfg) => {
  if (rec) return { error: 'A recording is already in progress.' };
  try {
    fs.mkdirSync(cfg.folder, { recursive: true });
    fs.accessSync(cfg.folder, fs.constants.W_OK);
  } catch (err) {
    return { error: `The save folder can't be used (${err.code || err.message}). Please choose a different folder.` };
  }
  if (freeBytes(cfg.folder) < MIN_START_FREE) return { error: 'Not enough free disk space to start recording (less than 500 MB free). Free up some space or pick another folder.' };

  const display = displayById(cfg.displayId);
  pendingDisplayId = display.id;
  const tmpPath = path.join(cfg.folder, `.as-recording-${Date.now()}.part`);
  let stream;
  try { stream = fs.createWriteStream(tmpPath); } catch (err) { return { error: 'Could not create the recording file: ' + err.message }; }

  rec = {
    cfg, display, tmpPath, stream, hasAudio: !!(cfg.mic || cfg.system), mime: '', fps: cfg.fps,
    startedAt: 0, elapsedBefore: 0, paused: false, resumedAt: 0, tickTimer: null, diskTimer: null,
    warned: false, stopping: false, writeError: null
  };
  stream.on('error', err => { rec && (rec.writeError = err); if (rec && !rec.stopping) stopRecording('Writing to disk failed: ' + err.message); });

  recorderWin = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: webPrefs });
  recorderWin.loadFile(path.join(__dirname, 'src', 'recorder.html'));
  const started = await new Promise(resolve => {
    const t = setTimeout(() => { cleanup(); resolve({ error: 'The recorder took too long to start.' }); }, 20000);
    const cleanup = () => { clearTimeout(t); ipcMain.removeListener('recorder:ready', onReady); ipcMain.removeListener('recorder:started', onStarted); ipcMain.removeListener('recorder:error', onErr); };
    const onReady = () => recorderWin.webContents.send('recorder:start', { ...cfg, display: { id: display.id, width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor } });
    const onStarted = (ev, info) => { cleanup(); resolve(info); };
    const onErr = (ev, msg) => { cleanup(); resolve({ error: msg }); };
    ipcMain.on('recorder:ready', onReady); ipcMain.on('recorder:started', onStarted); ipcMain.on('recorder:error', onErr);
  });
  if (started.error) { await abortRecording(); return { error: started.error }; }

  rec.mime = started.mime; rec.startedAt = Date.now(); rec.resumedAt = rec.startedAt;
  createBar(display);
  if (mainWin) mainWin.minimize();
  rec.tickTimer = setInterval(() => {
    if (barWin && !barWin.isDestroyed()) barWin.webContents.send('bar:tick', { elapsed: elapsedMs(), paused: rec.paused, mic: cfg.mic, system: cfg.system, webcam: cfg.webcam });
  }, 500);
  rec.diskTimer = setInterval(() => {
    const free = freeBytes(cfg.folder);
    if (free < LOW_DISK_STOP) return stopRecording('Disk space is almost full, so the recording was stopped and saved safely.');
    if (free < LOW_DISK_WARN && !rec.warned) {
      rec.warned = true;
      const msg = `Low disk space: only ${(free / 1024 ** 3).toFixed(1)} GB left. Recording will stop automatically to protect your video if space runs out.`;
      if (barWin && !barWin.isDestroyed()) barWin.webContents.send('bar:warn', msg);
      sendMain('rec:warn', msg);
    }
  }, 5000);
  return { ok: true };
});

function elapsedMs() { if (!rec) return 0; return rec.elapsedBefore + (rec.paused ? 0 : Date.now() - rec.resumedAt); }

ipcMain.on('recorder:chunk', (e, buf) => {
  if (!rec || !rec.stream || rec.stream.destroyed) return;
  rec.stream.write(Buffer.from(buf));
});
ipcMain.on('bar:pause', () => togglePause(true));
ipcMain.on('bar:resume', () => togglePause(false));
ipcMain.on('bar:stop', () => stopRecording());
ipcMain.on('rec:stop', () => stopRecording());
ipcMain.on('rec:pause', () => togglePause(true));
ipcMain.on('rec:resume', () => togglePause(false));
ipcMain.on('recorder:fatal', (e, msg) => { if (rec && !rec.stopping) stopRecording('Recording problem: ' + msg); });

function togglePause(pause) {
  if (!rec || rec.stopping || rec.paused === pause) return;
  const now = Date.now();
  if (pause) { rec.elapsedBefore += now - rec.resumedAt; rec.paused = true; }
  else { rec.resumedAt = now; rec.paused = false; }
  recorderWin && recorderWin.webContents.send(pause ? 'recorder:pause' : 'recorder:resume');
}

async function abortRecording() {
  if (!rec) return;
  const r = rec; rec = null;
  clearInterval(r.tickTimer); clearInterval(r.diskTimer);
  try { r.stream.destroy(); } catch {}
  try { fs.unlinkSync(r.tmpPath); } catch {}
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy(); recorderWin = null;
  if (barWin && !barWin.isDestroyed()) barWin.destroy(); barWin = null;
  if (mainWin) { mainWin.show(); }
}

async function stopRecording(reason) {
  if (!rec || rec.stopping) return;
  const r = rec; r.stopping = true;
  clearInterval(r.tickTimer); clearInterval(r.diskTimer);
  if (!r.paused) r.elapsedBefore += Date.now() - r.resumedAt; r.paused = true;
  const totalMs = r.elapsedBefore;
  if (barWin && !barWin.isDestroyed()) barWin.destroy(); barWin = null;
  if (mainWin) { mainWin.show(); mainWin.focus(); }
  sendMain('rec:finalizing', { percent: 0, note: reason || '' });

  // ask the recorder to flush & stop
  await new Promise(resolve => {
    const t = setTimeout(() => { done(); }, 15000);
    const done = () => { clearTimeout(t); ipcMain.removeListener('recorder:stopped', onStop); resolve(); };
    const onStop = () => done();
    ipcMain.on('recorder:stopped', onStop);
    if (recorderWin && !recorderWin.isDestroyed()) recorderWin.webContents.send('recorder:stop'); else done();
  });
  await new Promise(res => r.stream.end(res));
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy(); recorderWin = null;

  let size = 0; try { size = fs.statSync(r.tmpPath).size; } catch {}
  if (size < 1024) {
    rec = null; try { fs.unlinkSync(r.tmpPath); } catch {}
    return sendMain('rec:failed', 'Nothing was recorded (the video file is empty).');
  }
  const out = uniquePath(r.cfg.folder, r.cfg.fileName.replace('{date}', stamp()));
  try {
    await finalize(r, out, totalMs);
    try { fs.unlinkSync(r.tmpPath); } catch {}
    rec = null;
    sendMain('rec:done', { path: out, size: fs.statSync(out).size, durationMs: totalMs, note: reason || '' });
  } catch (err) {
    rec = null;
    // keep the raw capture so nothing is lost
    sendMain('rec:failed', `Could not create the MP4 (${err.message}). Your raw recording was kept at: ${r.tmpPath}`);
  }
}

function finalize(r, out, totalMs) {
  return new Promise((resolve, reject) => {
    const isH264 = /avc1|h264/i.test(r.mime);
    const args = ['-hide_banner', '-y', '-fflags', '+genpts', '-i', r.tmpPath];
    if (isH264) args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', r.cfg.quality === 'high' ? '19' : r.cfg.quality === 'small' ? '27' : '23', '-pix_fmt', 'yuv420p', '-r', String(r.fps));
    if (r.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0'); else args.push('-an');
    args.push('-movflags', '+faststart', out);
    let proc;
    try { proc = spawn(ffmpegPath, args, { windowsHide: true }); } catch (err) { return reject(err); }
    let log = '';
    proc.stderr.on('data', d => {
      const s = d.toString(); log = (log + s).slice(-2000);
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
      if (m && totalMs > 0) {
        const t = (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 1000;
        sendMain('rec:finalizing', { percent: Math.min(99, Math.round((t / totalMs) * 100)) });
      }
    });
    proc.on('error', reject);
    proc.on('close', code => code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('ffmpeg exited with code ' + code + ': ' + log.split('\n').slice(-3).join(' ').trim())));
  });
}

// ---------- app lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
  app.whenReady().then(() => { setupSession(); createMain(); });
  app.on('window-all-closed', () => { if (!rec) app.quit(); });
  app.on('before-quit', () => { if (rec && !rec.stopping) { try { rec.stream.end(); } catch {} } });
}
