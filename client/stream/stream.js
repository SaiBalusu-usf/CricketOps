/**
 * Streamer phone surface (/stream, /stream/:matchId) — Part D.
 *
 * Tier 1 (always): this phone is the wireless match camera. The laptop adds
 * /stream/program as an OBS Browser Source and receives the camera over
 * WebRTC on the LAN. The phone shows a live program preview: camera +
 * the real DOM scorebug driven by live state.
 *
 * Tier 2 (when the server reports ffmpeg): the phone composites the
 * scorebug onto a canvas and broadcasts straight to YouTube through the
 * server's ffmpeg relay — no laptop needed.
 */
import { connect, h, $, fmt, teamOf, focusInnings } from '/client/shared/app.js';
import { mountScorebug } from '/client/overlay/scorebug.js';
import { createCanvasScorebug } from '/client/stream/canvas-scorebug.js';

const pathParts = location.pathname.split('/').filter(Boolean); // ['stream', maybe id]
const urlMatchId = pathParts[1] && pathParts[1] !== 'program' ? pathParts[1] : null;

const gate = $('#gate');
const main = $('#main');
const cam = $('#cam');
const banner = $('#banner');

let app = null;
let camera = null;          // MediaStream
let facing = 'environment';
let resolution = 720;
let torchOn = false;
const viewers = new Map();  // viewerSocketId -> RTCPeerConnection
let bug = null;             // DOM scorebug for the preview
const canvasBug = createCanvasScorebug();

// Tier 2 recording state
let recording = false;
let wantRecording = false;  // survives reconnects — respawn on rejoin
let recorder = null;
let chunkSeq = 0;
let compositeStop = null;
let lastStatus = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function showBanner(text, cls = '', ms = 0) {
  banner.textContent = text;
  banner.className = `banner ${cls}`;
  if (ms) setTimeout(() => banner.classList.add('hidden'), ms);
}
function hideBanner() { banner.classList.add('hidden'); }

const pinKey = (id) => `icat-streamer-pin-${id}`;

// ---------------------------------------------------------------------------
// join gate
// ---------------------------------------------------------------------------

async function resolveMatchId() {
  if (urlMatchId) return urlMatchId;
  try {
    const info = await (await fetch('/api/info')).json();
    return info.activeMatchId;
  } catch { return null; }
}

function renderGate(matchId, { error, retryInMs, takeover } = {}) {
  gate.classList.remove('hidden');
  main.classList.add('hidden');
  gate.textContent = '';
  const pin = h('input', {
    type: 'password', inputmode: 'numeric', maxlength: '4',
    placeholder: '••••', autocomplete: 'off', style: { textAlign: 'center', fontSize: '24px', letterSpacing: '8px' },
  });
  const msg = error === 'locked-out'
    ? `Too many wrong PINs — try again in ${Math.ceil((retryInMs || 30000) / 1000)}s`
    : error === 'bad-pin' ? 'Wrong PIN — use the director (or scorer) PIN'
    : error === 'streamer-active' ? 'Another phone is already streaming this match'
    : error === 'no-match' ? 'No match on this server yet — create one from the console first'
    : null;
  gate.append(
    h('h2', {}, 'Stream this match'),
    h('p', { class: 'muted' }, 'This phone becomes the match camera. Enter the director PIN (the scorer PIN also works).'),
    h('div', { class: 'card col' },
      h('label', {}, 'PIN'),
      pin,
      msg ? h('p', { class: 'small', style: { color: 'var(--danger)' } }, msg) : null,
      h('button', {
        class: 'btn primary', onclick: () => start(matchId, pin.value.trim(), false),
      }, 'Join as streamer'),
      error === 'streamer-active'
        ? h('button', { class: 'btn danger', onclick: () => start(matchId, pin.value.trim() || localStorage.getItem(pinKey(matchId)) || '', true) }, 'Take over streaming')
        : null,
    ),
    h('a', { class: 'small muted', href: '/matches' }, 'All matches'),
  );
  const saved = localStorage.getItem(pinKey(matchId));
  if (saved) pin.value = saved;
  setTimeout(() => pin.focus(), 200);
}

async function start(matchId, pin, takeover) {
  if (!pin) return;
  localStorage.setItem(pinKey(matchId), pin);
  if (app) { app.rejoin({ role: 'streamer', pin, takeover }); return; }

  app = await connect({
    matchId,
    role: 'streamer',
    pin,
    takeover,
    onStatus(status, res = {}) {
      $('#conn').className = `conn ${status === 'online' ? 'online' : 'offline'}`;
      if (status === 'online' && app.role === 'streamer') {
        onJoined();
      } else if (['bad-pin', 'locked-out', 'streamer-active', 'no-match'].includes(status)) {
        if (status === 'bad-pin') localStorage.removeItem(pinKey(matchId));
        renderGate(matchId, { error: status, retryInMs: res.retryInMs });
      } else if (status === 'revoked') {
        stopEverything();
        showBanner('Another phone took over streaming.', '');
        renderGate(matchId, { error: 'streamer-active' });
      } else if (status === 'offline') {
        if (recording) pauseRecordingForReconnect();
        showBanner('Connection lost — reconnecting…', 'info');
      }
    },
    onState(state) {
      if (bug) bug.setState(state);
      canvasBug.setState(state);
      renderScoreline(state);
    },
    onPresentation(p) { if (bug) bug.setPresentation({ ...p, theme: 'broadcast', show: { ...p.show, scorebug: true } }); canvasBug.setPresentation(p); },
    onBranding(b) { if (bug) bug.setBranding(b); canvasBug.setBranding(b); },
    onFx(fx) { for (const f of fx) canvasBug.flash(f); },
    onStreamStatus(s) { lastStatus = s; renderBroadcastPanel(); },
  });
}

function renderScoreline(state) {
  const inn = focusInnings(state);
  if (!inn) { $('#scoreline').textContent = 'Waiting for the match…'; return; }
  const team = teamOf(state, inn.battingTeamId) || {};
  let line = `${team.short || ''} ${inn.runs}/${inn.wickets} (${inn.oversText})`;
  if (state.chase) line += ` · need ${state.chase.need} off ${state.chase.ballsLeft}`;
  if (state.result) line = state.result.text;
  $('#scoreline').textContent = line;
}

// ---------------------------------------------------------------------------
// camera + preview
// ---------------------------------------------------------------------------

async function onJoined() {
  gate.classList.add('hidden');
  main.classList.remove('hidden');
  hideBanner();
  if (!bug) {
    bug = mountScorebug($('#stage'));
    fitPreviewStage();
    window.addEventListener('resize', fitPreviewStage);
    if (app.state) { bug.setState(app.state); canvasBug.setState(app.state); renderScoreline(app.state); }
    if (app.presentation) { bug.setPresentation({ ...app.presentation, theme: 'broadcast', show: { ...app.presentation.show, scorebug: true } }); canvasBug.setPresentation(app.presentation); }
    if (app.branding) { bug.setBranding(app.branding); canvasBug.setBranding(app.branding); }
  }
  if (!camera) await openCamera();
  requestWakeLock();
  watchBattery();
  renderBroadcastPanel();
  // was recording before a reconnect? resume with a clean pipe
  if (wantRecording && !recording) startRecording();
}

function fitPreviewStage() {
  const scale = window.innerWidth / 1920;
  const stage = $('#stage');
  stage.style.transformOrigin = 'bottom left';
  stage.style.transform = `scale(${scale})`;
  $('#bugWrap').style.height = `${1080 * scale}px`;
}

async function openCamera() {
  stopTracks();
  const wants = {
    video: {
      facingMode: facing,
      width: { ideal: resolution === 1080 ? 1920 : 1280 },
      height: { ideal: resolution === 1080 ? 1080 : 720 },
    },
    audio: { echoCancellation: false, noiseSuppression: false },
  };
  try {
    camera = await navigator.mediaDevices.getUserMedia(wants);
  } catch (err) {
    showBanner(`Camera blocked: ${err.message}. Allow camera + microphone for this site.`);
    return;
  }
  cam.srcObject = camera;
  // swap the outgoing track for every connected viewer
  const vTrack = camera.getVideoTracks()[0];
  for (const pc of viewers.values()) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && vTrack) sender.replaceTrack(vTrack);
    const aSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    const aTrack = camera.getAudioTracks()[0];
    if (aSender && aTrack) aSender.replaceTrack(aTrack);
  }
}

function stopTracks() {
  if (camera) for (const t of camera.getTracks()) t.stop();
  camera = null;
}

$('#flipBtn').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  await openCamera();
});
$('#resSel').addEventListener('change', async (e) => {
  resolution = parseInt(e.target.value, 10);
  await openCamera();
});
$('#torchBtn').addEventListener('click', async () => {
  const track = camera && camera.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) { showBanner('Torch is not available on this camera', 'info', 2000); return; }
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { /* unsupported */ }
});

// ---------------------------------------------------------------------------
// wake lock + battery + backgrounding
// ---------------------------------------------------------------------------

let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not fatal */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    hideBanner();
  } else if (recording) {
    // rAF throttling in background starves the composite — warn loudly
    showBanner('KEEP THIS APP IN THE FOREGROUND — the broadcast pauses in the background');
  }
});

async function watchBattery() {
  try {
    const b = await navigator.getBattery?.();
    if (!b) return;
    const paint = () => { $('#battery').textContent = `${Math.round(b.level * 100)}%${b.charging ? '⚡' : ''}`; };
    b.addEventListener('levelchange', paint);
    b.addEventListener('chargingchange', paint);
    paint();
  } catch { /* no battery API */ }
}

// ---------------------------------------------------------------------------
// Tier 1 — WebRTC publisher (program page viewers)
// ---------------------------------------------------------------------------

function wireSignaling() {
  const sock = app.socket;
  sock.on('stream:webrtc-request', async (msg) => {
    if (msg.matchId !== app.matchId || !camera) return;
    const old = viewers.get(msg.from);
    if (old) { old.close(); viewers.delete(msg.from); }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    viewers.set(msg.from, pc);
    for (const track of camera.getTracks()) pc.addTrack(track, camera);
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.emit('stream:ice', { matchId: app.matchId, to: msg.from, payload: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        pc.close();
        if (viewers.get(msg.from) === pc) viewers.delete(msg.from);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sock.emit('stream:webrtc-offer', { matchId: app.matchId, to: msg.from, payload: offer });
  });
  sock.on('stream:webrtc-answer', async (msg) => {
    const pc = viewers.get(msg.from);
    if (pc) { try { await pc.setRemoteDescription(msg.payload); } catch { /* stale */ } }
  });
  sock.on('stream:ice', async (msg) => {
    const pc = viewers.get(msg.from);
    if (pc && msg.payload) { try { await pc.addIceCandidate(msg.payload); } catch { /* stale */ } }
  });
}

// ---------------------------------------------------------------------------
// Tier 2 — composite + MediaRecorder → server ffmpeg → YouTube
// ---------------------------------------------------------------------------

const MIME_LADDER = [
  'video/webm;codecs=h264,opus',
  'video/mp4',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_LADDER.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

function buildComposite() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let raf = 0;
  const paint = () => {
    // cover-fit the camera frame
    const vw = cam.videoWidth || 1280;
    const vh = cam.videoHeight || 720;
    const s = Math.max(canvas.width / vw, canvas.height / vh);
    const dw = vw * s;
    const dh = vh * s;
    ctx.drawImage(cam, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    canvasBug.draw(ctx, canvas.width, canvas.height);
    raf = requestAnimationFrame(paint);
  };
  raf = requestAnimationFrame(paint);
  const stream = canvas.captureStream(30);
  const mic = camera && camera.getAudioTracks()[0];
  if (mic) stream.addTrack(mic.clone());
  return { stream, stop: () => { cancelAnimationFrame(raf); for (const t of stream.getTracks()) t.stop(); } };
}

async function startRecording() {
  const mime = pickMime();
  if (!mime) {
    showBanner('This browser cannot record video (no MediaRecorder). Use Chrome on Android or Safari 14.5+ on iOS.');
    return;
  }
  const res = await new Promise((r) => app.socket.emit('stream:start', { matchId: app.matchId, mimeType: mime }, r));
  if (!res || !res.ok) {
    showBanner((res && res.errors && res.errors[0]) || 'Could not start the broadcast');
    return;
  }
  const composite = buildComposite();
  compositeStop = composite.stop;
  recorder = new MediaRecorder(composite.stream, { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
  chunkSeq = 0;
  recorder.ondataavailable = async (e) => {
    if (!e.data || !e.data.size) return;
    const buf = await e.data.arrayBuffer();
    app.socket.emit('stream:chunk', { matchId: app.matchId, seq: chunkSeq++, data: buf });
  };
  recorder.start(1000);
  recording = true;
  wantRecording = true;
  renderBroadcastPanel();
}

function stopRecorderOnly() {
  try { recorder?.stop(); } catch { /* already stopped */ }
  recorder = null;
  compositeStop?.();
  compositeStop = null;
  recording = false;
}

function pauseRecordingForReconnect() {
  // decoder-safe resume = fresh recorder + respawned ffmpeg on rejoin
  stopRecorderOnly();
  renderBroadcastPanel();
}

async function stopRecording() {
  wantRecording = false;
  stopRecorderOnly();
  await new Promise((r) => app.socket.emit('stream:stop', { matchId: app.matchId }, r));
  renderBroadcastPanel();
}

function stopEverything() {
  wantRecording = false;
  stopRecorderOnly();
  for (const pc of viewers.values()) pc.close();
  viewers.clear();
}

// ---------------------------------------------------------------------------
// broadcast panel UI
// ---------------------------------------------------------------------------

let panelOpen = false;
$('#bcastBtn').addEventListener('click', () => { panelOpen = !panelOpen; renderBroadcastPanel(); });

function renderBroadcastPanel() {
  const box = $('#bcast');
  $('#bcastBtn').classList.toggle('live', recording);
  $('#bcastBtn').textContent = recording ? '● LIVE' : 'Broadcast…';
  if (!panelOpen) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.textContent = '';

  const rtmp = (lastStatus && lastStatus.rtmp) ?? (app.streaming && app.streaming.rtmp);
  const s = lastStatus || {};

  box.append(h('h3', {}, 'Broadcast'));
  box.append(h('p', { class: 'small muted' },
    'Tier 1 (always on): this phone is the camera. On the laptop, add ',
    h('code', {}, `${location.origin}/stream/program?match=${app.matchId}`),
    ' as an OBS Browser Source.'));

  if (!rtmp) {
    box.append(h('p', {}, 'Direct phone → YouTube needs ffmpeg on the server host. Install ffmpeg and restart the server to unlock it — no laptop needed after that.'));
  } else {
    const keyIn = h('input', { type: 'password', placeholder: s.hasKey ? `key saved (${s.keyTail})` : 'paste the YouTube stream key', style: { width: '100%' } });
    box.append(
      h('div', { class: 'col' },
        h('label', {}, 'YouTube stream key'),
        keyIn,
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary grow', onclick: async () => {
              const key = keyIn.value.trim();
              if (!key) return;
              const r = await new Promise((rr) => app.socket.emit('stream:set-key', { matchId: app.matchId, key }, rr));
              keyIn.value = '';
              keyIn.placeholder = r.ok ? `key saved (${r.keyTail})` : (r.errors && r.errors[0]) || 'failed';
            },
          }, 'Save key'),
          h('button', {
            class: 'btn ghost', onclick: async () => {
              await new Promise((rr) => app.socket.emit('stream:clear-key', { matchId: app.matchId }, rr));
              keyIn.placeholder = 'paste the YouTube stream key';
            },
          }, 'Clear'),
        ),
        h('div', { class: 'stat-row' },
          h('span', {}, 'state ', h('b', {}, recording ? 'LIVE' : s.live ? 'relay up' : 'idle')),
          h('span', {}, 'bitrate ', h('b', {}, `${s.kbps || 0} kbps`)),
          h('span', {}, 'uptime ', h('b', {}, fmtUptime(s.uptimeSec))),
          h('span', {}, 'buffered ', h('b', {}, `${s.queuedSec || 0}s`)),
          s.drops ? h('span', { style: { color: 'var(--warn)' } }, 'dropped ', h('b', {}, `${s.drops}`)) : null,
        ),
        s.lastError ? h('p', { class: 'small', style: { color: 'var(--danger)' } }, s.lastError) : null,
        h('p', { class: 'small muted' }, `recorder: ${pickMime() || 'not supported in this browser'}`),
        h('button', {
          class: `btn recbtn ${recording ? 'danger' : 'accent'}`,
          onclick: () => (recording ? stopRecording() : startRecording()),
        }, recording ? 'STOP BROADCAST' : 'GO LIVE ON YOUTUBE'),
      ),
    );
  }
  box.append(h('button', { class: 'btn ghost recbtn', onclick: () => { panelOpen = false; renderBroadcastPanel(); } }, 'Close'));
}

function fmtUptime(sec = 0) {
  const s = Math.max(0, sec | 0);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async () => {
  const matchId = await resolveMatchId();
  if (!matchId) { renderGate('', { error: 'no-match' }); return; }
  const saved = localStorage.getItem(pinKey(matchId));
  renderGate(matchId);
  if (saved) start(matchId, saved, false);
  // wire signaling once the app exists — poll briefly
  const t = setInterval(() => { if (app && app.socket) { wireSignaling(); clearInterval(t); } }, 300);
})();
