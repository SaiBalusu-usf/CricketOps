/**
 * Tier-2 streaming (Part D): pipe MediaRecorder chunks from the streamer
 * phone into ffmpeg and push RTMP to YouTube. Everything here is optional —
 * when ffmpeg is absent the manager still answers status questions
 * (rtmp:false) and the client shows Tier 1 only.
 *
 * Secrets: the stream key is read from store.readStreamKey at spawn time,
 * lives only in the ffmpeg argv of this process, and is redacted from any
 * stderr we keep. It never appears in logs, acks, or status payloads
 * (only hasKey + last 4 chars).
 */
import { spawn, spawnSync } from 'node:child_process';

const GRACE_MS = 60 * 1000;      // keep ffmpeg alive after a socket drop
const MAX_QUEUE_CHUNKS = 12;     // ~12 s of 1 s chunks, then drop-oldest
const STDERR_TAIL = 20;

export function detectFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'pipe', timeout: 4000 });
      if (r.status === 0) return c;
    } catch { /* not this one */ }
  }
  return null;
}

export function createStreamManager({ io, room, readKey }) {
  const ffmpegPath = detectFfmpeg();
  const sessions = new Map(); // matchId -> session

  function redact(text, key) {
    return key ? String(text).split(key).join('•••') : String(text);
  }

    async function publicStatus(matchId) {
      const s = sessions.get(matchId);
      const key = await readKey(matchId);
    const base = {
      rtmp: !!ffmpegPath,
      hasKey: !!key,
      keyTail: key ? `…${key.slice(-4)}` : null,
      live: false,
      uptimeSec: 0,
      kbps: 0,
      queuedSec: 0,
      drops: 0,
      ffmpegAlive: false,
      lastError: s ? s.lastError : null,
    };
    if (!s) return base;
    const now = Date.now();
    const windowBytes = s.byteLog.filter((e) => now - e.t < 5000).reduce((a, e) => a + e.bytes, 0);
    return {
      ...base,
      live: s.alive,
      uptimeSec: s.alive ? Math.round((now - s.startedAt) / 1000) : 0,
      kbps: Math.round((windowBytes * 8) / 5 / 1000),
      queuedSec: s.queue.length,
      drops: s.drops,
      ffmpegAlive: s.alive,
    };
  }

  async function broadcast(matchId) {
    io.to(room(matchId)).emit('stream:status', { matchId, ...(await publicStatus(matchId)) });
  }

  function buildArgs(mimeType, output) {
    const isH264 = /h264|avc1|mp4/i.test(mimeType || '');
    const video = isH264
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k', '-maxrate', '2500k',
        '-bufsize', '5000k', '-g', '60', '-pix_fmt', 'yuv420p'];
    return [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0',
      ...video,
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      ...output,
    ];
  }

  function stopSession(matchId, reason) {
    const s = sessions.get(matchId);
    if (!s) return;
    clearInterval(s.statusTimer);
    clearTimeout(s.graceTimer);
    if (s.proc && s.alive) {
      try { s.proc.stdin.end(); } catch { /* already gone */ }
      const proc = s.proc;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
    }
    s.alive = false;
    if (reason) s.lastError = s.lastError || reason;
    sessions.delete(matchId);
    broadcast(matchId);
  }

  return {
    ffmpegPath,
    publicStatus,

    /** Spawn ffmpeg for this match. Only the lock-holding streamer socket calls this. */
    async start(matchId, socketId, { mimeType } = {}, ack = () => {}) {
      if (!ffmpegPath) return ack({ ok: false, errors: ['ffmpeg is not installed on the server host'] });
      const testOutput = process.env.STREAM_TEST_OUTPUT === 'null';
      const key = await readKey(matchId);
      if (!key && !testOutput) return ack({ ok: false, errors: ['no stream key set — paste it from YouTube Studio first'] });

      // a restart from the same (or a new) streamer replaces the old pipe —
      // respawning cleanly is the decoder-safe way to resume after a gap
      if (sessions.has(matchId)) stopSession(matchId);

      // test mode (acceptance): decode-only into the null muxer, so the pipe
      // works with any ffmpeg build (no libx264/aac needed)
      const args = testOutput
        ? ['-hide_banner', '-loglevel', 'warning', '-i', 'pipe:0', '-f', 'null', '-']
        : buildArgs(mimeType, ['-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${key}`]);
      let proc;
      try {
        proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (err) {
        return ack({ ok: false, errors: [`ffmpeg failed to start: ${err.message}`] });
      }

      const s = {
        proc,
        socketId,
        alive: true,
        startedAt: Date.now(),
        mimeType: mimeType || 'unknown',
        queue: [],
        writing: false,
        drops: 0,
        byteLog: [],
        stderr: [],
        lastError: null,
        graceTimer: null,
        statusTimer: setInterval(() => broadcast(matchId), 2000),
      };
      s.statusTimer.unref?.();
      sessions.set(matchId, s);

      proc.stderr.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const clean = redact(line.trim(), key);
          if (clean) { s.stderr.push(clean); if (s.stderr.length > STDERR_TAIL) s.stderr.shift(); }
        }
      });
      proc.on('exit', (code) => {
        s.alive = false;
        if (code !== 0 && code !== null) {
          s.lastError = `ffmpeg exited (${code}): ${s.stderr.slice(-3).join(' | ')}`;
          console.error(`[stream] ${matchId}: ${s.lastError}`);
        }
        broadcast(matchId);
      });
      proc.stdin.on('error', () => { /* EPIPE after exit — exit handler reports */ });

      broadcast(matchId);
      ack({ ok: true, mimeType: s.mimeType, test: testOutput });
    },

    /** Ordered chunk sink with a bounded queue (drop-oldest beyond ~12 s). */
    chunk(matchId, socketId, data) {
      const s = sessions.get(matchId);
      if (!s || !s.alive || s.socketId !== socketId) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      s.byteLog.push({ t: Date.now(), bytes: buf.length });
      if (s.byteLog.length > 40) s.byteLog.shift();
      s.queue.push(buf);
      while (s.queue.length > MAX_QUEUE_CHUNKS) { s.queue.shift(); s.drops += 1; }
      if (!s.writing) drain(s);

      function drain(sess) {
        sess.writing = true;
        while (sess.queue.length && sess.alive) {
          const chunk = sess.queue.shift();
          if (!sess.proc.stdin.write(chunk)) {
            sess.proc.stdin.once('drain', () => drain(sess));
            return;
          }
        }
        sess.writing = false;
      }
    },

    stop(matchId, socketId, ack = () => {}) {
      const s = sessions.get(matchId);
      if (s && socketId && s.socketId !== socketId) return ack({ ok: false, errors: ['not the active streamer'] });
      stopSession(matchId);
      ack({ ok: true });
    },

    /** Socket dropped: keep ffmpeg alive for a grace window, then stop. */
    onPublisherDisconnect(socketId) {
      for (const [matchId, s] of sessions) {
        if (s.socketId !== socketId) continue;
        clearTimeout(s.graceTimer);
        s.graceTimer = setTimeout(() => stopSession(matchId, 'streamer disconnected'), GRACE_MS);
        s.graceTimer.unref?.();
      }
    },

    /** A reconnected streamer resumes ownership of the grace-held session. */
    adoptSession(matchId, socketId) {
      const s = sessions.get(matchId);
      if (!s) return;
      clearTimeout(s.graceTimer);
      s.socketId = socketId;
    },
  };
}
