/**
 * ICAT Cricket Live server.
 *
 * One lightweight process serves all four surfaces (console, overlays,
 * director, public live page), persists every event to disk immediately,
 * and pushes state to every connected client over Socket.IO.
 *
 * No accounts, no API keys, no cloud calls. Run `npm start` and point
 * phones at the printed LAN URL.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIO } from 'socket.io';
import QRCode from 'qrcode';

import {
  normalizeConfig, matchCreatedEvent, reduce, validateAppend,
  undoLast, replaceEvent, computeFx, makeId,
} from '../engine/index.js';
import * as store from './store.js';
import { createStreamManager } from './stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3333', 10);

store.ensureDirs();

// ---------------------------------------------------------------------------
// In-memory cache of open matches (source of truth stays on disk)
// ---------------------------------------------------------------------------

const matches = new Map(); // id -> { meta, events, state, presentation }

function loadMatch(id) {
  if (matches.has(id)) return matches.get(id);
  if (!store.matchExists(id)) return null;
  const meta = store.readMeta(id);
  const events = store.readEvents(id);
  const m = {
    meta,
    events,
    state: reduce(events),
    presentation: store.readPresentation(id),
  };
  matches.set(id, m);
  return m;
}

function allMatches() {
  return store.listMatchIds().map((id) => loadMatch(id)).filter(Boolean);
}

/**
 * The match overlays attach to when no ?match= is given. Kept in memory
 * (B5): /api/info is polled every few seconds by every waiting client, so it
 * must not rescan the disk. Recomputed on boot, create, import, and every
 * touch() (append/undo/edit all touch).
 */
let cachedActiveMatchId = null;

function refreshActiveMatch() {
  const all = allMatches();
  if (!all.length) { cachedActiveMatchId = null; return; }
  const live = all.filter((m) => m.state.phase !== 'complete');
  const pool = live.length ? live : all;
  pool.sort((a, b) => (b.meta.updatedAt || b.meta.createdAt) - (a.meta.updatedAt || a.meta.createdAt));
  cachedActiveMatchId = pool[0].meta.id;
}

function activeMatchId() { return cachedActiveMatchId; }

function matchSummary(m) {
  const s = m.state;
  const teams = s.config ? s.config.teams.map((t) => ({ id: t.id, name: t.name, short: t.short, color: t.color })) : [];
  return {
    id: m.meta.id,
    createdAt: m.meta.createdAt,
    updatedAt: m.meta.updatedAt || m.meta.createdAt,
    phase: s.phase,
    teams,
    innings: s.innings.map((i) => ({
      battingTeamId: i.battingTeamId, runs: i.runs, wickets: i.wickets, overs: i.oversText, superOver: i.superOver,
    })),
    result: s.result ? s.result.text : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------

// B4: this process must limp, never die — state is durable on disk before
// every ack, so serving through a stray bug beats crashing mid-over.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

const app = express();
app.use(express.json({ limit: '4mb' })); // imports and logo data URLs
app.use((req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });

// B3: blunt create/import spam (kept unauthenticated by design)
const createHits = new Map(); // ip -> [timestamps]
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of createHits) {
    const live = arr.filter((t) => now - t < 60000);
    if (live.length) createHits.set(ip, live); else createHits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function rateLimited(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const arr = (createHits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 5) {
    res.status(429).json({ error: 'too many requests — try again in a minute' });
    return true;
  }
  arr.push(now);
  createHits.set(ip, arr);
  return false;
}

function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// static: the whole client, plus the engine itself (it runs in the browser too)
app.use('/client', express.static(path.join(ROOT, 'client')));
app.use('/engine', express.static(path.join(ROOT, 'engine')));

const page = (...p) => (req, res) => res.sendFile(path.join(ROOT, 'client', ...p));

app.get('/', page('index.html'));
app.get('/console', page('console', 'index.html'));
app.get('/console/:matchId', page('console', 'index.html'));
app.get('/director', page('director', 'index.html'));
app.get('/director/:matchId', page('director', 'index.html'));
app.get('/live', (req, res) => res.redirect('/matches'));
app.get('/live/:matchId', page('live', 'index.html'));
app.get('/matches', page('live', 'matches.html'));
app.get('/settings', page('settings', 'index.html'));
app.get('/stream', page('stream', 'index.html'));
app.get('/stream/program', page('stream', 'program.html')); // before :matchId!
app.get('/stream/:matchId', page('stream', 'index.html'));
app.get('/manifest.webmanifest', page('manifest.webmanifest'));
app.get('/sw.js', page('sw.js'));
app.get('/favicon.ico', page('icons', 'icon.svg'));

const OVERLAYS = ['scorebug', 'batting', 'bowling', 'summary', 'lineups', 'target', 'full'];
app.get('/overlay/:kind', (req, res) => {
  if (OVERLAYS.includes(req.params.kind)) {
    return res.sendFile(path.join(ROOT, 'client', 'overlay', `${req.params.kind}.html`));
  }
  res.status(404).type('html').send(
    `<body style="font-family:sans-serif;background:#111;color:#eee;padding:2em">
     <h2>No such overlay</h2><p>Valid overlay URLs:</p>
     <ul>${OVERLAYS.map((k) => `<li><a style="color:#f5b301" href="/overlay/${k}">/overlay/${k}</a></li>`).join('')}</ul>
     </body>`,
  );
});

// ---- REST ------------------------------------------------------------------

app.get('/api/info', (req, res) => {
  res.json({
    port: PORT,
    urls: lanUrls(),
    activeMatchId: activeMatchId(),
    streaming: { rtmp: !!streamManager.ffmpegPath },
  });
});

app.get('/api/matches', (req, res) => {
  res.json(allMatches().map(matchSummary).sort((a, b) => b.updatedAt - a.updatedAt));
});

app.post('/api/matches', (req, res) => {
  if (rateLimited(req, res)) return;
  const config = normalizeConfig(req.body?.config || {});
  // sanity cap (kept out of the engine — scoring rules are unaffected)
  for (const t of config.teams) t.players = t.players.slice(0, 16);
  if (!config.teams[0].players.length || !config.teams[1].players.length) {
    return res.status(400).json({ error: 'both teams need at least one player' });
  }
  const id = store.makeMatchId();
  const meta = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scorerPin: store.makePin(),
    directorPin: store.makePin(),
  };
  store.createMatch(id, meta, matchCreatedEvent(config, makeId('e'), meta.createdAt));
  matches.delete(id);
  const m = loadMatch(id);
  refreshActiveMatch();
  res.json({ id, scorerPin: meta.scorerPin, directorPin: meta.directorPin, summary: matchSummary(m) });
});

app.get('/api/matches/:id', (req, res) => {
  const m = loadMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such match' });
  res.json({
    matchId: m.meta.id,
    version: m.events.length,
    createdAt: m.meta.createdAt,
    updatedAt: m.meta.updatedAt || m.meta.createdAt,
    state: m.state,
    presentation: m.presentation,
  });
});

app.get('/api/matches/:id/events', (req, res) => {
  const m = loadMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such match' });
  res.json({ matchId: m.meta.id, version: m.events.length, events: m.events });
});

app.get('/api/matches/:id/export', (req, res) => {
  const m = loadMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such match' });
  const teams = m.state.config ? m.state.config.teams.map((t) => t.name).join(' v ') : m.meta.id;
  res.set('Content-Disposition', `attachment; filename="${m.meta.id}.icat-match.json"`);
  res.json({
    format: 'icat-cricket-live/match@1',
    exportedAt: new Date().toISOString(),
    id: m.meta.id,
    title: teams,
    events: m.events,
  });
});

app.post('/api/import', (req, res) => {
  if (rateLimited(req, res)) return;
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events || !events.length || events[0].type !== 'MATCH_CREATED') {
    return res.status(400).json({ error: 'not a match export (missing MATCH_CREATED event log)' });
  }
  const id = store.makeMatchId();
  const meta = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scorerPin: store.makePin(),
    directorPin: store.makePin(),
    importedFrom: body.id || null,
  };
  store.createMatch(id, meta, events[0]);
  store.rewriteEvents(id, events);
  matches.delete(id);
  const m = loadMatch(id);
  refreshActiveMatch();
  res.json({ id, scorerPin: meta.scorerPin, directorPin: meta.directorPin, summary: matchSummary(m) });
});

app.get('/api/branding', (req, res) => res.json(store.readBranding()));

// B2: branding writes deface the live broadcast, so non-localhost callers
// must present a scorer/director PIN of a current match via x-icat-pin.
app.put('/api/branding', (req, res) => {
  if (!isLocalRequest(req)) {
    const ip = req.socket.remoteAddress || 'unknown';
    const wait = pinLockout(ip, '*branding');
    if (wait !== null) return res.status(429).json({ error: 'locked-out', retryInMs: wait });
    const pin = req.get('x-icat-pin');
    const all = allMatches();
    const current = all.filter((m) => m.state.phase !== 'complete');
    const pool = current.length ? current : all;
    if (!pin || !pool.some((m) => anyPinMatches(m.meta, pin))) {
      pinFailed(ip, '*branding');
      return res.status(401).json({ error: 'pin-required' });
    }
    pinPassed(ip, '*branding');
  }
  const clean = store.writeBranding(req.body || {});
  io.emit('branding', clean);
  res.json(clean);
});

// B4: Express 4 does not catch async throws — guard explicitly
app.get('/qr.svg', async (req, res) => {
  try {
    const text = String(req.query.text || lanUrls()[0] || `http://localhost:${PORT}/`);
    const svg = await QRCode.toString(text.slice(0, 500), { type: 'svg', margin: 1, width: 480 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    console.error('[qr.svg]', err.message);
    res.status(500).type('text').send('QR generation failed');
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// unknown /api/* paths answer JSON, not an HTML 404 (B4/C)
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// last-resort error middleware: JSON for /api, minimal HTML elsewhere
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const code = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (code >= 500) console.error('[express]', err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) res.status(code).json({ error: code === 400 ? 'bad request body' : 'internal error' });
  else res.status(code).type('html').send('<body style="font-family:sans-serif;padding:2em"><h2>Something went wrong</h2><p>The scoreboard is still safe on disk. Check the server terminal.</p></body>');
});

// ---------------------------------------------------------------------------
// Socket.IO — real-time layer
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: true } });

const room = (id) => `match:${id}`;

/**
 * One exclusive holder per match per role (scorer, streamer). Takeover
 * revokes the old socket *authoritatively*: its role map is downgraded so a
 * stale/hostile client can never keep acting after losing the lock (A1).
 */
function lockRegistry(revokeEvent) {
  const locks = new Map(); // matchId -> { clientId, socketId }
  return {
    /** returns true when acquired, false when another live holder exists and no takeover */
    acquire(socket, id, msg) {
      const lock = locks.get(id);
      const holderAlive = lock && io.sockets.sockets.has(lock.socketId);
      if (holderAlive && lock.clientId !== msg.clientId) {
        if (!msg.takeover) return false;
        const old = io.sockets.sockets.get(lock.socketId);
        if (old) {
          old.data.roles.set(id, 'view');
          // remember WHY the role is gone, so the old device's next action
          // gets a revoked:true ack instead of a generic auth error
          (old.data.revokedFrom ||= new Set()).add(`${revokeEvent}:${id}`);
        }
        io.to(lock.socketId).emit(revokeEvent, { matchId: id });
      }
      locks.set(id, { clientId: msg.clientId || socket.id, socketId: socket.id });
      (socket.data.revokedFrom ||= new Set()).delete(`${revokeEvent}:${id}`);
      return true;
    },
    isHolder(id, socket) {
      const lock = locks.get(id);
      return !!lock && lock.socketId === socket.id;
    },
    dropSocket(socketId) {
      for (const [id, lock] of locks) if (lock.socketId === socketId) locks.delete(id);
    },
    get(id) { return locks.get(id); },
  };
}
const scorerLocks = lockRegistry('scorer-revoked');
const streamerLocks = lockRegistry('streamer-revoked');

// ---------------------------------------------------------------------------
// PIN checks — constant-time compare + per-(ip, match) lockout with backoff
// ---------------------------------------------------------------------------

const pinFailures = new Map(); // `${ip}|${scope}` -> { count, lockedUntil, last }
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of pinFailures) if (v.last < cutoff) pinFailures.delete(k);
}, 10 * 60 * 1000).unref();

function pinEquals(given, actual) {
  const a = Buffer.alloc(32);
  const b = Buffer.alloc(32);
  a.write(String(given ?? '').slice(0, 32));
  b.write(String(actual ?? '').slice(0, 32));
  return crypto.timingSafeEqual(a, b);
}

/** ms remaining in a lockout, or null when attempts are allowed */
function pinLockout(ip, scope) {
  const e = pinFailures.get(`${ip}|${scope}`);
  return e && e.lockedUntil > Date.now() ? e.lockedUntil - Date.now() : null;
}

function pinFailed(ip, scope) {
  const k = `${ip}|${scope}`;
  const e = pinFailures.get(k) || { count: 0, lockedUntil: 0, last: 0 };
  e.count += 1;
  e.last = Date.now();
  if (e.count >= 5) {
    e.lockedUntil = Date.now() + Math.min(30000 * 2 ** (e.count - 5), 600000);
  }
  pinFailures.set(k, e);
}

function pinPassed(ip, scope) { pinFailures.delete(`${ip}|${scope}`); }

/** true when the given pin matches the match's scorer or director PIN. */
function anyPinMatches(meta, pin) {
  // evaluate both to keep timing independent of which one matches
  const s = pinEquals(pin, meta.scorerPin);
  const d = pinEquals(pin, meta.directorPin);
  return s || d;
}

const streamManager = createStreamManager({ io, room, readKey: store.readStreamKey });

function broadcastState(m) {
  io.to(room(m.meta.id)).emit('state', {
    matchId: m.meta.id,
    version: m.events.length,
    rev: m.meta.rev || 0,
    state: m.state,
  });
}

/**
 * rev is a monotonic change counter (persisted in meta) — unlike `version`
 * (= events.length) it never goes backwards on undo, so clients use it to
 * discard out-of-order state broadcasts.
 */
function touch(m) {
  m.meta.updatedAt = Date.now();
  m.meta.rev = (m.meta.rev || 0) + 1;
  store.writeMeta(m.meta.id, m.meta);
  refreshActiveMatch();
}

/** Live audience counter for the public page (room size, all roles). */
function broadcastViewers(id) {
  const n = io.sockets.adapter.rooms.get(room(id))?.size || 0;
  io.to(room(id)).emit('viewers', { matchId: id, count: n });
}

io.on('connection', (socket) => {
  socket.data.roles = new Map(); // matchId -> 'view' | 'scorer' | 'director'

  socket.on('join', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId || activeMatchId());
    if (!m) return ack({ ok: false, error: 'no-match' });
    const id = m.meta.id;
    let role = 'view';

    if (['scorer', 'director', 'streamer'].includes(msg.role)) {
      const ip = socket.handshake.address || 'unknown';
      const wait = pinLockout(ip, id);
      if (wait !== null) return ack({ ok: false, error: 'locked-out', retryInMs: wait });
      const pinOk = msg.role === 'scorer'
        ? pinEquals(msg.pin, m.meta.scorerPin)
        : anyPinMatches(m.meta, msg.pin); // director & streamer accept either PIN
      if (!pinOk) {
        pinFailed(ip, id);
        const now = pinLockout(ip, id);
        return ack(now !== null
          ? { ok: false, error: 'locked-out', retryInMs: now }
          : { ok: false, error: 'bad-pin' });
      }
      pinPassed(ip, id);

      if (msg.role === 'scorer') {
        if (!scorerLocks.acquire(socket, id, msg)) return ack({ ok: false, error: 'scorer-active' });
      } else if (msg.role === 'streamer') {
        if (!streamerLocks.acquire(socket, id, msg)) return ack({ ok: false, error: 'streamer-active' });
        streamManager.adoptSession(id, socket.id); // resume a grace-held ffmpeg pipe
        io.to(room(id)).emit('stream:publisher-changed', { matchId: id });
      }
      role = msg.role;
    }

    socket.join(room(id));
    socket.data.roles.set(id, role);
    queueMicrotask(() => broadcastViewers(id)); // after the join completes
    ack({
      ok: true,
      role,
      matchId: id,
      version: m.events.length,
      rev: m.meta.rev || 0,
      state: m.state,
      presentation: m.presentation,
      branding: store.readBranding(),
      pins: role === 'scorer' ? { directorPin: m.meta.directorPin } : undefined,
      streaming: streamManager.publicStatus(id),
    });
  });

  const requireRole = (matchId, roles) => {
    const r = socket.data.roles.get(matchId);
    return r && roles.includes(r) ? r : null;
  };

  const wasRevokedFrom = (revokeEvent, matchId) => !!(socket.data.revokedFrom
    && socket.data.revokedFrom.has(`${revokeEvent}:${matchId}`));

  const revokedAck = (ack, revokeEvent, matchId) => {
    socket.emit(revokeEvent, { matchId }); // re-send: covers reconnect races
    ack({
      ok: false,
      errors: [`${revokeEvent === 'scorer-revoked' ? 'scoring' : 'streaming'} was taken over by another device`],
      revoked: true,
    });
  };

  // A1: belt and braces — a scorer-role socket must ALSO hold the live lock.
  const requireScorerLock = (m, ack) => {
    if (scorerLocks.isHolder(m.meta.id, socket)) return true;
    socket.data.roles.set(m.meta.id, 'view');
    revokedAck(ack, 'scorer-revoked', m.meta.id);
    return false;
  };

  socket.on('append', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    const role = requireRole(m.meta.id, ['scorer', 'director']);
    if (!role) {
      if (wasRevokedFrom('scorer-revoked', m.meta.id)) return revokedAck(ack, 'scorer-revoked', m.meta.id);
      return ack({ ok: false, errors: ['not authorised — join as scorer first'] });
    }

    const ev = msg.event || {};
    // directors may only adjust targets/penalties/ticker-ish events
    if (role === 'director' && !['TARGET_REVISED', 'PENALTY', 'CONFIG_UPDATED'].includes(ev.type)) {
      return ack({ ok: false, errors: ['directors cannot score balls'] });
    }
    if (role === 'scorer' && !requireScorerLock(m, ack)) return;

    // idempotent re-send after a reconnect
    if (ev.id && m.events.some((e) => e.id === ev.id)) {
      return ack({ ok: true, duplicate: true, version: m.events.length });
    }

    // A2: offline-queued events carry the version they were queued at; if the
    // log moved on (another device scored), surface it instead of appending
    // stale balls on top of the real ones.
    if (msg.expectedVersion !== undefined && msg.expectedVersion !== null
        && !msg.force && msg.expectedVersion !== m.events.length) {
      return ack({
        ok: false,
        needsForce: true,
        versionConflict: true,
        warnings: [`scoreboard moved on since this ball was queued (queued at version ${msg.expectedVersion}, now ${m.events.length})`],
      });
    }

    const v = validateAppend(m.state, ev);
    if (v.errors.length) return ack({ ok: false, errors: v.errors });
    if (v.warnings.length && !msg.force) {
      return ack({ ok: false, warnings: v.warnings, needsForce: true });
    }

    const stamped = { id: ev.id || makeId('e'), ts: Date.now(), ...ev };
    const before = m.state;
    m.events.push(stamped);
    m.state = reduce(m.events);
    store.appendEvent(m.meta.id, stamped);
    touch(m);
    broadcastState(m);
    const fx = computeFx(before, m.state, stamped);
    if (fx.length) io.to(room(m.meta.id)).emit('fx', { matchId: m.meta.id, fx });
    ack({ ok: true, version: m.events.length, warnings: v.warnings });
  });

  socket.on('undo', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireRole(m.meta.id, ['scorer'])) {
      if (wasRevokedFrom('scorer-revoked', m.meta.id)) return revokedAck(ack, 'scorer-revoked', m.meta.id);
      return ack({ ok: false, errors: ['not authorised'] });
    }
    if (!requireScorerLock(m, ack)) return;
    const { events, undone } = undoLast(m.events);
    if (!undone) return ack({ ok: false, errors: ['nothing to undo'] });
    m.events = events;
    m.state = reduce(m.events);
    store.rewriteEvents(m.meta.id, m.events);
    touch(m);
    broadcastState(m);
    ack({ ok: true, undone, version: m.events.length });
  });

  socket.on('edit', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireRole(m.meta.id, ['scorer'])) {
      if (wasRevokedFrom('scorer-revoked', m.meta.id)) return revokedAck(ack, 'scorer-revoked', m.meta.id);
      return ack({ ok: false, errors: ['not authorised'] });
    }
    if (!requireScorerLock(m, ack)) return;
    let events;
    try {
      events = replaceEvent(m.events, msg.seq, msg.event || {});
    } catch (e) {
      return ack({ ok: false, errors: [e.message] });
    }
    const nextState = reduce(events);
    m.events = events;
    m.state = nextState;
    store.rewriteEvents(m.meta.id, m.events);
    touch(m);
    broadcastState(m);
    ack({ ok: true, version: m.events.length, anomalies: nextState.anomalies });
  });

  socket.on('presentation', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireRole(m.meta.id, ['scorer', 'director'])) return ack({ ok: false, errors: ['not authorised'] });
    const patch = msg.patch || {};
    m.presentation = {
      ...m.presentation,
      ...patch,
      show: { ...m.presentation.show, ...(patch.show || {}) },
    };
    store.writePresentation(m.meta.id, m.presentation);
    io.to(room(m.meta.id)).emit('presentation', { matchId: m.meta.id, presentation: m.presentation });
    ack({ ok: true });
  });

  socket.on('fire', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireRole(m.meta.id, ['scorer', 'director'])) return ack({ ok: false, errors: ['not authorised'] });
    const fx = Array.isArray(msg.fx) ? msg.fx : [msg.fx];
    io.to(room(m.meta.id)).emit('fx', { matchId: m.meta.id, fx, manual: true });
    ack({ ok: true });
  });

  // ---- streaming (Part D) --------------------------------------------------

  const requireStreamer = (m, ack) => {
    if (requireRole(m.meta.id, ['streamer'])) return true;
    if (wasRevokedFrom('streamer-revoked', m.meta.id)) revokedAck(ack, 'streamer-revoked', m.meta.id);
    else ack({ ok: false, errors: ['not authorised — join as streamer first'] });
    return false;
  };

  const requireStreamerLock = (m, ack) => {
    if (streamerLocks.isHolder(m.meta.id, socket)) return true;
    socket.data.roles.set(m.meta.id, 'view');
    revokedAck(ack, 'streamer-revoked', m.meta.id);
    return false;
  };

  // Tier 1 WebRTC signaling relay. Viewers (the /stream/program page) request;
  // the lock-holding streamer offers; ICE flows both ways. Payloads are opaque.
  socket.on('stream:webrtc-request', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, error: 'no-match' });
    const lock = streamerLocks.get(m.meta.id);
    if (!lock || !io.sockets.sockets.has(lock.socketId)) return ack({ ok: false, error: 'no-streamer' });
    io.to(lock.socketId).emit('stream:webrtc-request', { matchId: m.meta.id, from: socket.id });
    ack({ ok: true });
  });

  socket.on('stream:webrtc-offer', (msg = {}) => {
    const m = loadMatch(msg.matchId);
    if (!m || !streamerLocks.isHolder(m.meta.id, socket) || !msg.to) return;
    io.to(msg.to).emit('stream:webrtc-offer', { matchId: m.meta.id, from: socket.id, payload: msg.payload });
  });

  socket.on('stream:webrtc-answer', (msg = {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return;
    const lock = streamerLocks.get(m.meta.id);
    if (lock) io.to(lock.socketId).emit('stream:webrtc-answer', { matchId: m.meta.id, from: socket.id, payload: msg.payload });
  });

  socket.on('stream:ice', (msg = {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return;
    const lock = streamerLocks.get(m.meta.id);
    const fromStreamer = lock && lock.socketId === socket.id;
    const to = fromStreamer ? msg.to : (lock && lock.socketId);
    if (to) io.to(to).emit('stream:ice', { matchId: m.meta.id, from: socket.id, payload: msg.payload });
  });

  // Tier 2 — stream key + broadcast lifecycle (lock-holding streamer only).
  // The key is write-only: acks/status expose hasKey + last 4 chars, nothing more.
  socket.on('stream:set-key', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireStreamer(m, ack)) return;
    if (!requireStreamerLock(m, ack)) return;
    const key = String(msg.key || '').trim();
    if (!key || key.length > 128) return ack({ ok: false, errors: ['that does not look like a stream key'] });
    store.writeStreamKey(m.meta.id, key);
    ack({ ok: true, hasKey: true, keyTail: `…${key.slice(-4)}` });
  });

  socket.on('stream:clear-key', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireStreamer(m, ack)) return;
    if (!requireStreamerLock(m, ack)) return;
    store.clearStreamKey(m.meta.id);
    ack({ ok: true, hasKey: false });
  });

  socket.on('stream:start', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireStreamer(m, ack)) return;
    if (!requireStreamerLock(m, ack)) return;
    streamManager.start(m.meta.id, socket.id, { mimeType: msg.mimeType }, ack);
  });

  socket.on('stream:chunk', (msg = {}) => {
    if (!msg.matchId || !streamerLocks.isHolder(msg.matchId, socket)) return;
    if (msg.data) streamManager.chunk(msg.matchId, socket.id, msg.data);
  });

  socket.on('stream:stop', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    if (!requireStreamer(m, ack)) return;
    streamManager.stop(m.meta.id, socket.id, ack);
  });

  socket.on('stream:status', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false });
    ack({ ok: true, matchId: m.meta.id, ...streamManager.publicStatus(m.meta.id) });
  });

  socket.on('disconnect', () => {
    scorerLocks.dropSocket(socket.id);
    streamerLocks.dropSocket(socket.id);
    streamManager.onPublisherDisconnect(socket.id);
    for (const matchId of socket.data.roles.keys()) {
      queueMicrotask(() => broadcastViewers(matchId));
    }
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function lanUrls() {
  // Wi-Fi adapters first: VPN/virtual adapters (Tailscale, WSL, corporate
  // VPNs) often win enumeration order but are unreachable from phones, and
  // the first URL feeds the QR codes.
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) found.push({ name, address: a.address });
    }
  }
  const rank = ({ name, address }) => {
    if (/wi-?fi|wlan|wireless/i.test(name)) return 0;
    if (address.startsWith('192.168.')) return 1;   // typical home/hotspot subnet
    if (/^eth|ethernet|^en/i.test(name)) return 2;
    return 3;                                        // VPNs, tunnels, vEthernet…
  };
  found.sort((x, y) => rank(x) - rank(y));
  return found.map((f) => `http://${f.address}:${PORT}`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — is another copy running?`);
    console.error(`  Try:  PORT=${PORT + 111} npm start\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  console.log(`\n  ${signal} — shutting down (all match data is already on disk)`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

refreshActiveMatch();

server.listen(PORT, '0.0.0.0', async () => {
  const urls = lanUrls();
  const main = urls[0] || `http://localhost:${PORT}`;
  console.log('');
  console.log('  ICAT Cricket Live');
  console.log('  ─────────────────');
  console.log(`  This laptop:   http://localhost:${PORT}`);
  for (const u of urls) console.log(`  Phones (LAN):  ${u}`);
  console.log(`  OBS overlay:   http://localhost:${PORT}/overlay/scorebug   (1920×1080 Browser Source)`);
  console.log('');
  if (urls.length) {
    try {
      console.log(await QRCode.toString(main, { type: 'terminal', small: true }));
      console.log(`  Scan with a phone on the same hotspot/Wi-Fi → ${main}`);
    } catch { /* terminal may not like it — the /qr.svg endpoint still works */ }
  }
  const active = activeMatchId();
  if (active) console.log(`  Resuming match: ${active} (${matchSummary(loadMatch(active)).phase})`);
  console.log(`  Phone streaming: Tier 1 (camera to OBS) always on · Tier 2 (direct to YouTube) ${streamManager.ffmpegPath ? `ready (ffmpeg: ${streamManager.ffmpegPath})` : 'needs ffmpeg installed'}`);
  console.log('');
});
