const $ = id => document.getElementById(id);
let S = {}, displays = [], camPreviewStream = null, meterStream = null, meterCtx = null, meterRaf = 0, lastResult = null;

const FIELDS = ['camId', 'camCorner', 'camSize', 'micId', 'resolution', 'fps', 'quality', 'fileName', 'displayId'];
const CHECKS = ['webcam', 'mic', 'system'];

function showError(msg) { const e = $('errorBar'); e.textContent = msg; e.classList.remove('hidden'); clearTimeout(showError.t); showError.t = setTimeout(() => e.classList.add('hidden'), 12000); }
function persist() {
  FIELDS.forEach(k => { const v = $(k).value; S[k] = k === 'fps' ? +v : k === 'displayId' ? (v ? +v : null) : v; });
  CHECKS.forEach(k => S[k] = $(k).checked);
  window.asr.invoke('settings:set', S);
  renderChips(); toggleSections();
}
function renderChips() {
  $('chips').innerHTML = '';
  [['Screen', true], ['Webcam', S.webcam], ['Microphone', S.mic], ['Computer sound', S.system]].forEach(([n, on]) => {
    const c = document.createElement('span'); c.className = 'chip' + (on ? ' on' : ''); c.textContent = (on ? '● ' : '○ ') + n; $('chips').appendChild(c);
  });
}
function toggleSections() {
  $('areaRow').classList.toggle('hidden', S.mode !== 'area');
  $('camOpts').classList.toggle('hidden', !S.webcam);
  $('micOpts').classList.toggle('hidden', !S.mic);
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('areaInfo').textContent = S.area ? `${S.area.width} × ${S.area.height} px selected` : 'No area selected yet';
}

async function fillDevices() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (sel, kind, saved, fallback) => {
    const list = devs.filter(d => d.kind === kind);
    sel.innerHTML = list.length ? '' : `<option value="">${fallback}</option>`;
    list.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`; sel.appendChild(o); });
    if (saved && list.some(d => d.deviceId === saved)) sel.value = saved;
  };
  fill($('camId'), 'videoinput', S.camId, 'No camera found');
  fill($('micId'), 'audioinput', S.micId, 'No microphone found');
}

async function stopPreviews() {
  if (camPreviewStream) { camPreviewStream.getTracks().forEach(t => t.stop()); camPreviewStream = null; $('camPreview').srcObject = null; }
  if (meterStream) { meterStream.getTracks().forEach(t => t.stop()); meterStream = null; }
  cancelAnimationFrame(meterRaf); try { meterCtx && meterCtx.close(); } catch {} meterCtx = null; $('meterFill').style.width = '0';
}
async function startCamPreview() {
  if (camPreviewStream) { camPreviewStream.getTracks().forEach(t => t.stop()); camPreviewStream = null; }
  if (!S.webcam) return;
  try {
    camPreviewStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: $('camId').value ? { exact: $('camId').value } : undefined }, audio: false });
    $('camPreview').srcObject = camPreviewStream; await fillDevices(); // labels appear after permission
  } catch (e) {
    showError(e.name === 'NotAllowedError' ? 'Camera access was denied. Turn on camera access for desktop apps in Windows Settings > Privacy & security > Camera.' : 'No usable camera was found, or it is being used by another app.');
    $('webcam').checked = false; persist();
  }
}
async function startMeter() {
  if (meterStream) { meterStream.getTracks().forEach(t => t.stop()); meterStream = null; } cancelAnimationFrame(meterRaf);
  if (!S.mic) return;
  try {
    meterStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('micId').value ? { exact: $('micId').value } : undefined }, video: false });
    await fillDevices();
    meterCtx = new AudioContext(); const an = meterCtx.createAnalyser(); an.fftSize = 512;
    meterCtx.createMediaStreamSource(meterStream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => { an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); $('meterFill').style.width = Math.min(100, peak / 128 * 140) + '%'; meterRaf = requestAnimationFrame(loop); };
    loop();
  } catch (e) {
    showError(e.name === 'NotAllowedError' ? 'Microphone access was denied. Turn on microphone access for desktop apps in Windows Settings > Privacy & security > Microphone.' : 'No usable microphone was found.');
    $('mic').checked = false; persist();
  }
}

async function init() {
  S = await window.asr.invoke('settings:get');
  displays = await window.asr.invoke('displays:list');
  $('displayId').innerHTML = displays.map(d => `<option value="${d.id}">${d.label}</option>`).join('');
  if (S.displayId && displays.some(d => d.id === S.displayId)) $('displayId').value = S.displayId; else S.displayId = displays[0] && displays[0].id;
  FIELDS.forEach(k => { if (k !== 'displayId' && S[k] !== undefined && $(k)) $(k).value = S[k]; });
  CHECKS.forEach(k => $(k).checked = !!S[k]);
  $('folder').value = S.folder;
  await fillDevices();
  renderChips(); toggleSections();
  if (S.webcam) startCamPreview();
  if (S.mic) startMeter();

  FIELDS.forEach(k => $(k).addEventListener('change', () => { if (k === 'displayId') S.area = null; persist(); if (k === 'camId') startCamPreview(); if (k === 'micId') startMeter(); }));
  CHECKS.forEach(k => $(k).addEventListener('change', () => { persist(); if (k === 'webcam') { S.webcam ? startCamPreview() : stopPreviews().then(() => S.mic && startMeter()); } if (k === 'mic') { S.mic ? startMeter() : (meterStream && meterStream.getTracks().forEach(t => t.stop())); $('meterFill').style.width = '0'; } }));
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; persist(); });
  $('pickArea').onclick = async () => {
    const r = await window.asr.invoke('area:select', S.displayId, S.area && { x: S.area.x, y: S.area.y, width: S.area.width, height: S.area.height });
    if (r) { S.area = r; window.asr.invoke('settings:set', S); toggleSections(); }
  };
  $('browse').onclick = async () => { const f = await window.asr.invoke('folder:choose', S.folder); if (f) { S.folder = f; $('folder').value = f; persist(); } };
  $('start').onclick = startRecording;
  $('openVideo').onclick = async () => { const err = await window.asr.invoke('shell:open', lastResult.path); if (err) showError('Could not open the video: ' + err); };
  $('openFolder').onclick = () => window.asr.invoke('shell:show', lastResult.path);
  $('saveCopy').onclick = async () => { const r = await window.asr.invoke('file:saveCopy', lastResult.path); if (r && r.error) showError('Could not save the copy: ' + r.error); else if (r) $('resText').textContent = 'Saved a copy to: ' + r; };
  $('again').onclick = () => { $('result').classList.add('hidden'); $('setup').classList.remove('hidden'); $('start').disabled = false; if (S.webcam) startCamPreview(); if (S.mic) startMeter(); };
}

async function startRecording() {
  persist();
  if (S.mode === 'area' && !S.area) { showError('Please select the area you want to record first.'); return; }
  if (!S.fileName.trim()) { showError('Please enter a file name.'); return; }
  $('start').disabled = true;
  await stopPreviews(); // release camera & mic so the recorder can use them
  const r = await window.asr.invoke('rec:start', { ...S });
  if (r && r.error) { showError(r.error); $('start').disabled = false; if (S.webcam) startCamPreview(); if (S.mic) startMeter(); }
}

window.asr.on('rec:finalizing', d => {
  $('setup').classList.add('hidden'); $('result').classList.remove('hidden'); $('resActions').classList.add('hidden');
  $('resTitle').textContent = 'Finishing your video…'; $('progFill').style.width = (d.percent || 3) + '%';
  $('resText').textContent = d.note || 'Saving and finalizing the MP4 file. Please keep the app open.';
});
window.asr.on('rec:done', d => {
  lastResult = d; $('progFill').style.width = '100%';
  const mb = (d.size / 1048576).toFixed(1), s = Math.round(d.durationMs / 1000);
  $('resTitle').textContent = '✅ Recording saved';
  $('resText').textContent = `${d.path}  ·  ${Math.floor(s / 60)}m ${s % 60}s  ·  ${mb} MB${d.note ? '  ·  ' + d.note : ''}`;
  ['openVideo', 'openFolder', 'saveCopy'].forEach(id => $(id).classList.remove('hidden'));
  $('resActions').classList.remove('hidden');
});
window.asr.on('rec:failed', msg => {
  $('setup').classList.add('hidden'); $('result').classList.remove('hidden');
  $('resTitle').textContent = '⚠️ Recording problem'; $('progFill').style.width = '0';
  $('resText').textContent = msg; $('resActions').classList.add('hidden'); $('again').parentElement.classList.remove('hidden');
  $('openVideo').classList.add('hidden'); $('openFolder').classList.add('hidden'); $('saveCopy').classList.add('hidden');
});
window.asr.on('rec:warn', showError);
init();
