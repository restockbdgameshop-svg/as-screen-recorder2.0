// Hidden recorder engine: captures screen (+crop), composites webcam, mixes audio,
// encodes with MediaRecorder and streams chunks to disk through the main process.
let mr = null, screenStream = null, camStream = null, micStream = null, audioCtx = null, canvasStream = null, ticker = null;

const MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.640028,opus', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4',
  'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
];
const QUALITY_BPS = { small: 2.5e6, balanced: 6e6, high: 12e6 }; // at 1080p30
const CAM_SIZE = { small: 0.14, medium: 0.2, large: 0.28 };       // fraction of output width

const even = n => Math.max(2, Math.round(n / 2) * 2);
const fail = msg => window.asr.send('recorder:error', msg);

function stopAll() {
  try { if (ticker) ticker.terminate(); } catch {}
  [screenStream, camStream, micStream, canvasStream].forEach(s => s && s.getTracks().forEach(t => t.stop()));
  try { audioCtx && audioCtx.close(); } catch {}
}

async function start(cfg) {
  try {
    // 1) screen (+ optional system audio loopback)
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: !!cfg.system });
    } catch (e) { return fail('Screen capture was blocked or failed: ' + (e.message || e.name)); }
    const sv = document.createElement('video'); sv.srcObject = screenStream; sv.muted = true; await sv.play();
    await new Promise(r => { if (sv.videoWidth) r(); else sv.onloadedmetadata = r; });
    const vw = sv.videoWidth, vh = sv.videoHeight;

    // 2) crop rectangle in video pixels
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (cfg.mode === 'area' && cfg.area) {
      const k = vw / cfg.display.width;
      sx = Math.max(0, Math.round(cfg.area.x * k)); sy = Math.max(0, Math.round(cfg.area.y * k));
      sw = Math.min(vw - sx, Math.round(cfg.area.width * k)); sh = Math.min(vh - sy, Math.round(cfg.area.height * k));
      sw = Math.max(2, sw); sh = Math.max(2, sh);
    }

    // 3) output size (never upscale)
    let H = sh;
    if (cfg.resolution === '720p') H = Math.min(sh, 720);
    else if (cfg.resolution === '1080p') H = Math.min(sh, 1080);
    let W = even(sw * (H / sh)); H = even(H);

    // 4) webcam
    let camVideo = null;
    if (cfg.webcam) {
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: cfg.camId ? { exact: cfg.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) { return fail(e.name === 'NotAllowedError' ? 'Camera access was denied. Allow camera access in Windows Settings > Privacy > Camera.' : 'The selected camera is unavailable or in use by another app.'); }
      camVideo = document.createElement('video'); camVideo.srcObject = camStream; camVideo.muted = true; await camVideo.play();
    }

    // 5) audio mixing
    const audioTracks = [];
    if (cfg.mic || cfg.system) {
      audioCtx = new AudioContext({ sampleRate: 48000 });
      const dest = audioCtx.createMediaStreamDestination();
      if (cfg.mic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: cfg.micId ? { exact: cfg.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        } catch (e) { return fail(e.name === 'NotAllowedError' ? 'Microphone access was denied. Allow microphone access in Windows Settings > Privacy > Microphone.' : 'The selected microphone is unavailable.'); }
        audioCtx.createMediaStreamSource(micStream).connect(dest);
      }
      if (cfg.system) {
        const sysTracks = screenStream.getAudioTracks();
        if (sysTracks.length) audioCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
        else if (!cfg.mic) return fail('System audio could not be captured on this PC.');
      }
      audioTracks.push(...dest.stream.getAudioTracks());
    }

    // 6) compositing canvas (ticks from a Worker so a hidden window is never throttled)
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    const camW = even(W * (CAM_SIZE[cfg.camSize] || 0.2)), margin = Math.round(W * 0.02);
    const draw = () => {
      ctx.drawImage(sv, sx, sy, sw, sh, 0, 0, W, H);
      if (camVideo && camVideo.videoWidth) {
        const camH = even(camW * camVideo.videoHeight / camVideo.videoWidth);
        const x = cfg.camCorner.includes('left') ? margin : W - camW - margin;
        const y = cfg.camCorner.includes('top') ? margin : H - camH - margin;
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, camW, camH, Math.round(camW * 0.06)); ctx.clip();
        ctx.drawImage(camVideo, x, y, camW, camH); ctx.restore();
      }
    };
    draw();
    const blob = new Blob([`let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`], { type: 'text/javascript' });
    ticker = new Worker(URL.createObjectURL(blob));
    ticker.onmessage = draw; ticker.postMessage(Math.round(1000 / cfg.fps));
    canvasStream = canvas.captureStream(cfg.fps);

    // 7) recorder
    const out = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || '';
    const bps = Math.max(1e6, Math.round((QUALITY_BPS[cfg.quality] || 6e6) * (W * H) / (1920 * 1080) * Math.pow(cfg.fps / 30, 0.7)));
    mr = new MediaRecorder(out, { mimeType: mime || undefined, videoBitsPerSecond: bps, audioBitsPerSecond: 192000 });
    let pending = 0, stopping = false;
    mr.ondataavailable = async e => {
      if (!e.data || !e.data.size) return;
      pending++;
      try { window.asr.send('recorder:chunk', await e.data.arrayBuffer()); } finally { pending--; }
    };
    mr.onerror = e => window.asr.send('recorder:fatal', (e.error && e.error.message) || 'encoder error');
    mr.onstop = async () => {
      while (pending > 0) await new Promise(r => setTimeout(r, 20));
      stopAll(); window.asr.send('recorder:stopped');
    };
    screenStream.getVideoTracks()[0].onended = () => window.asr.send('recorder:fatal', 'The screen being recorded went away (display disconnected or locked).');
    mr.start(1000); // 1 s chunks written straight to disk: RAM stays flat for any duration
    window.asr.send('recorder:started', { mime: mr.mimeType || mime, width: W, height: H });
  } catch (e) {
    stopAll(); fail('Could not start recording: ' + (e.message || e.name));
  }
}

window.asr.on('recorder:start', start);
window.asr.on('recorder:pause', () => { if (mr && mr.state === 'recording') mr.pause(); });
window.asr.on('recorder:resume', () => { if (mr && mr.state === 'paused') mr.resume(); });
window.asr.on('recorder:stop', () => {
  if (mr && mr.state !== 'inactive') { try { mr.requestData(); } catch {} mr.stop(); } else { stopAll(); window.asr.send('recorder:stopped'); }
});
window.asr.send('recorder:ready');
