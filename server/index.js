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
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIO } from 'socket.io';
import QRCode from 'qrcode';

import {
  normalizeConfig, matchCreatedEvent, reduce, validateAppend,
  undoLast, replaceEvent, computeFx, makeId,
} from '../engine/index.js';
import * as store from './store.js';

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

/** The match overlays attach to when no ?match= is given. */
function activeMatchId() {
  const all = allMatches();
  if (!all.length) return null;
  const live = all.filter((m) => m.state.phase !== 'complete');
  const pool = live.length ? live : all;
  pool.sort((a, b) => (b.meta.updatedAt || b.meta.createdAt) - (a.meta.updatedAt || a.meta.createdAt));
  return pool[0].meta.id;
}

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

const app = express();
app.use(express.json({ limit: '4mb' })); // imports and logo data URLs
app.use((req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });

// static: the whole client, plus the engine itself (it runs in the browser too)
app.use('/client', express.static(path.join(ROOT, 'client')));
app.use('/engine', express.static(path.join(ROOT, 'engine')));

const page = (...p) => (req, res) => res.sendFile(path.join(ROOT, 'client', ...p));

app.get('/', page('index.html'));
app.get('/console', page('console', 'index.html'));
app.get('/console/:matchId', page('console', 'index.html'));
app.get('/director', page('director', 'index.html'));
app.get('/director/:matchId', page('director', 'index.html'));
app.get('/live/:matchId', page('live', 'index.html'));
app.get('/matches', page('live', 'matches.html'));
app.get('/settings', page('settings', 'index.html'));
app.get('/manifest.webmanifest', page('manifest.webmanifest'));
app.get('/sw.js', page('sw.js'));

const OVERLAYS = ['scorebug', 'batting', 'bowling', 'summary', 'lineups', 'target', 'full'];
app.get('/overlay/:kind', (req, res, next) => {
  if (!OVERLAYS.includes(req.params.kind)) return next();
  res.sendFile(path.join(ROOT, 'client', 'overlay', `${req.params.kind}.html`));
});

// ---- REST ------------------------------------------------------------------

app.get('/api/info', (req, res) => {
  res.json({ port: PORT, urls: lanUrls(), activeMatchId: activeMatchId() });
});

app.get('/api/matches', (req, res) => {
  res.json(allMatches().map(matchSummary).sort((a, b) => b.updatedAt - a.updatedAt));
});

app.post('/api/matches', (req, res) => {
  const config = normalizeConfig(req.body?.config || {});
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
  res.json({ id, scorerPin: meta.scorerPin, directorPin: meta.directorPin, summary: matchSummary(m) });
});

app.get('/api/matches/:id', (req, res) => {
  const m = loadMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such match' });
  res.json({ matchId: m.meta.id, version: m.events.length, state: m.state, presentation: m.presentation });
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
  res.json({ id, scorerPin: meta.scorerPin, directorPin: meta.directorPin, summary: matchSummary(m) });
});

app.get('/api/branding', (req, res) => res.json(store.readBranding()));
app.put('/api/branding', (req, res) => {
  const clean = store.writeBranding(req.body || {});
  io.emit('branding', clean);
  res.json(clean);
});

app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || lanUrls()[0] || `http://localhost:${PORT}/`);
  const svg = await QRCode.toString(text.slice(0, 500), { type: 'svg', margin: 1, width: 480 });
  res.type('image/svg+xml').send(svg);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Socket.IO — real-time layer
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: true } });

const scorerLocks = new Map(); // matchId -> { clientId, socketId }
const room = (id) => `match:${id}`;

function broadcastState(m) {
  io.to(room(m.meta.id)).emit('state', {
    matchId: m.meta.id,
    version: m.events.length,
    state: m.state,
  });
}

function touch(m) {
  m.meta.updatedAt = Date.now();
  store.writeMeta(m.meta.id, m.meta);
}

io.on('connection', (socket) => {
  socket.data.roles = new Map(); // matchId -> 'view' | 'scorer' | 'director'

  socket.on('join', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId || activeMatchId());
    if (!m) return ack({ ok: false, error: 'no-match' });
    const id = m.meta.id;
    let role = 'view';

    if (msg.role === 'scorer') {
      if (msg.pin !== m.meta.scorerPin) return ack({ ok: false, error: 'bad-pin' });
      const lock = scorerLocks.get(id);
      const lockHolderConnected = lock && io.sockets.sockets.has(lock.socketId);
      if (lockHolderConnected && lock.clientId !== msg.clientId && !msg.takeover) {
        return ack({ ok: false, error: 'scorer-active' });
      }
      if (lockHolderConnected && lock.clientId !== msg.clientId && msg.takeover) {
        io.to(lock.socketId).emit('scorer-revoked', { matchId: id });
      }
      scorerLocks.set(id, { clientId: msg.clientId || socket.id, socketId: socket.id });
      role = 'scorer';
    } else if (msg.role === 'director') {
      if (msg.pin !== m.meta.directorPin && msg.pin !== m.meta.scorerPin) {
        return ack({ ok: false, error: 'bad-pin' });
      }
      role = 'director';
    }

    socket.join(room(id));
    socket.data.roles.set(id, role);
    ack({
      ok: true,
      role,
      matchId: id,
      version: m.events.length,
      state: m.state,
      presentation: m.presentation,
      branding: store.readBranding(),
      pins: role === 'scorer' ? { directorPin: m.meta.directorPin } : undefined,
    });
  });

  const requireRole = (matchId, roles) => {
    const r = socket.data.roles.get(matchId);
    return r && roles.includes(r) ? r : null;
  };

  socket.on('append', (msg = {}, ack = () => {}) => {
    const m = loadMatch(msg.matchId);
    if (!m) return ack({ ok: false, errors: ['no such match'] });
    const role = requireRole(m.meta.id, ['scorer', 'director']);
    if (!role) return ack({ ok: false, errors: ['not authorised — join as scorer first'] });

    const ev = msg.event || {};
    // directors may only adjust targets/penalties/ticker-ish events
    if (role === 'director' && !['TARGET_REVISED', 'PENALTY', 'CONFIG_UPDATED'].includes(ev.type)) {
      return ack({ ok: false, errors: ['directors cannot score balls'] });
    }

    // idempotent re-send after a reconnect
    if (ev.id && m.events.some((e) => e.id === ev.id)) {
      return ack({ ok: true, duplicate: true, version: m.events.length });
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
    if (!requireRole(m.meta.id, ['scorer'])) return ack({ ok: false, errors: ['not authorised'] });
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
    if (!requireRole(m.meta.id, ['scorer'])) return ack({ ok: false, errors: ['not authorised'] });
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

  socket.on('disconnect', () => {
    for (const [matchId, lock] of scorerLocks) {
      if (lock.socketId === socket.id) scorerLocks.delete(matchId);
    }
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function lanUrls() {
  const urls = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

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
  console.log('');
});
