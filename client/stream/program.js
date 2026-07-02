/**
 * /stream/program — the Tier-1 camera consumer. OBS (or any browser on the
 * laptop) adds this page as a source; it receives the streamer phone's
 * camera over LAN WebRTC. It never renders score graphics: the overlay
 * stays a separate OBS source, so this behaves exactly like a camera.
 */
import { connect } from '/client/shared/app.js';

const feed = document.getElementById('feed');
const slate = document.getElementById('slate');
const slateText = document.getElementById('slateText');

let app = null;
let pc = null;
let connected = false;
let lastFrameCheck = 0;

function showSlate(text) {
  slateText.textContent = text;
  slate.classList.remove('hidden');
}
function hideSlate() { slate.classList.add('hidden'); }

function teardown() {
  if (pc) { try { pc.close(); } catch { /* gone */ } }
  pc = null;
  connected = false;
}

async function request() {
  if (!app || !app.online || connected || pc) return;
  const res = await new Promise((r) => app.socket.emit('stream:webrtc-request', { matchId: app.matchId }, r));
  if (!res || !res.ok) {
    showSlate(res && res.error === 'no-streamer'
      ? 'Waiting for the camera phone… open /stream on it'
      : 'Waiting for the match…');
  }
}

function wire() {
  const sock = app.socket;
  sock.on('stream:webrtc-offer', async (msg) => {
    if (msg.matchId !== app.matchId) return;
    teardown();
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.ontrack = (e) => {
      feed.srcObject = e.streams[0];
      hideSlate();
      connected = true;
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.emit('stream:ice', { matchId: app.matchId, payload: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        showSlate('Reconnecting…');
        teardown();
        setTimeout(request, 800); // renegotiate automatically
      }
    };
    await pc.setRemoteDescription(msg.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sock.emit('stream:webrtc-answer', { matchId: app.matchId, payload: answer });
  });
  sock.on('stream:ice', async (msg) => {
    if (pc && msg.payload) { try { await pc.addIceCandidate(msg.payload); } catch { /* stale */ } }
  });
}

(async () => {
  app = await connect({
    matchId: new URLSearchParams(location.search).get('match'),
    role: 'view',
    onStatus(s) { if (s === 'offline') { showSlate('Reconnecting…'); teardown(); } },
    onPublisherChanged() { teardown(); showSlate('Camera changed — reconnecting…'); setTimeout(request, 500); },
  });
  const t = setInterval(() => { if (app.socket) { wire(); clearInterval(t); } }, 200);

  // keep asking until a streamer shows up; keep an eye on frozen frames
  setInterval(() => {
    if (!connected) request();
    // frozen-frame watchdog: paint the slate rather than a stale frame
    if (connected && feed.readyState >= 2) {
      const now = feed.getVideoPlaybackQuality ? feed.getVideoPlaybackQuality().totalVideoFrames : 0;
      if (now > 0 && now === lastFrameCheck) {
        showSlate('Reconnecting…');
      } else if (now > 0) {
        hideSlate();
      }
      lastFrameCheck = now;
    }
  }, 2000);
})();
