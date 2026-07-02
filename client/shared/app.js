/**
 * Shared client runtime: socket lifecycle, offline queue, DOM + format helpers.
 * Vanilla ES module — every surface (console, overlays, director, live) uses this.
 */

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class:'x', onclick}, child, …) — null/false children are skipped. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const fmt = {
  overs: (balls) => `${Math.floor(balls / 6)}.${balls % 6}`,
  figures: (b) => `${Math.floor(b.balls / 6)}.${b.balls % 6}-${b.maidens}-${b.runs}-${b.wickets}`,
  batLine: (b) => `${b.runs}(${b.balls})`,
  num1: (x) => (x === null || x === undefined || Number.isNaN(x) ? '—' : (Math.round(x * 10) / 10).toFixed(1)),
  score: (inn) => `${inn.runs}/${inn.wickets}`,
};

/** Scale a fixed 1920×1080 #stage to fit the viewport (OBS is exactly 1:1). */
export function fitStage(stage = document.getElementById('stage')) {
  if (!stage) return;
  const fit = () => {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = `scale(${s})`;
  };
  fit();
  window.addEventListener('resize', fit);
}

// ---------------------------------------------------------------------------
// Socket runtime
// ---------------------------------------------------------------------------

function ensureIO() {
  if (window.io) return Promise.resolve(window.io);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = () => resolve(window.io);
    s.onerror = () => reject(new Error('socket.io client failed to load'));
    document.head.appendChild(s);
  });
}

function clientId() {
  let id = localStorage.getItem('icat-client-id');
  if (!id) {
    id = `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem('icat-client-id', id);
  }
  return id;
}

const rid = () => `e-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

async function fetchInfo() {
  try { return await (await fetch('/api/info')).json(); } catch { return {}; }
}

/**
 * Connect to a match. Resolves once the first join succeeds (or immediately
 * for view roles with no match yet — it keeps polling and joins when one
 * appears). See docs/CONTRACT.md §8.
 */
export async function connect(opts = {}) {
  const io = await ensureIO();
  const cid = clientId();
  const cb = (name, ...args) => { try { opts[name]?.(...args); } catch (e) { console.error(e); } };

  const app = {
    matchId: opts.matchId || null,
    role: 'view',
    state: null,
    presentation: null,
    branding: null,
    version: 0,
    online: false,
    queue: [],
  };

  const queueKey = () => `icat-queue-${app.matchId}`;
  const loadQueue = () => { try { app.queue = JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch { app.queue = []; } };
  const saveQueue = () => localStorage.setItem(queueKey(), JSON.stringify(app.queue));

  const socket = io({ reconnectionDelayMax: 3000 });
  app.socket = socket;

  const emitAck = (name, payload, timeoutMs = 8000) => new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, errors: ['timeout'], timeout: true }); } }, timeoutMs);
    socket.emit(name, payload, (res) => { if (!done) { done = true; clearTimeout(t); resolve(res || { ok: false, errors: ['no ack'] }); } });
  });

  let joinOpts = { role: opts.role || 'view', pin: opts.pin, takeover: opts.takeover };

  async function join() {
    if (!app.matchId) {
      const info = await fetchInfo();
      app.matchId = opts.matchId || info.activeMatchId || null;
      if (!app.matchId) {
        cb('onStatus', 'no-match');
        setTimeout(join, 3000); // a match will appear; overlays just wait
        return;
      }
    }
    const res = await emitAck('join', { matchId: app.matchId, clientId: cid, ...joinOpts });
    if (!res.ok) {
      cb('onStatus', res.error || 'join-failed');
      if (res.error === 'no-match') { app.matchId = null; setTimeout(join, 3000); }
      return;
    }
    app.role = res.role;
    app.version = res.version;
    app.state = res.state;
    app.presentation = res.presentation;
    app.branding = res.branding;
    app.pins = res.pins;
    app.online = true;
    cb('onStatus', 'online');
    cb('onBranding', app.branding);
    cb('onPresentation', app.presentation);
    cb('onState', app.state, app.version);
    loadQueue();
    flush();
  }

  let flushing = false;
  async function flush() {
    if (flushing || !app.online || app.role === 'view' || !app.queue.length) return;
    flushing = true;
    try {
      while (app.queue.length && app.online) {
        const item = app.queue[0];
        const res = await emitAck('append', { matchId: app.matchId, event: item.event, force: item.force });
        if (res.timeout) break; // still offline-ish; retry on next reconnect
        app.queue.shift();
        saveQueue();
        if (!res.ok && !res.duplicate) cb('onQueueDrop', item.event, res.errors || res.warnings || []);
      }
    } finally {
      flushing = false;
      cb('onQueue', app.queue.length);
    }
  }

  socket.on('connect', join);
  socket.on('disconnect', () => { app.online = false; cb('onStatus', 'offline'); });
  socket.on('state', (msg) => {
    if (msg.matchId !== app.matchId) return;
    app.state = msg.state;
    app.version = msg.version;
    cb('onState', app.state, app.version);
  });
  socket.on('fx', (msg) => { if (msg.matchId === app.matchId) cb('onFx', msg.fx, !!msg.manual); });
  socket.on('presentation', (msg) => {
    if (msg.matchId !== app.matchId) return;
    app.presentation = msg.presentation;
    cb('onPresentation', app.presentation);
  });
  socket.on('branding', (b) => { app.branding = b; cb('onBranding', b); });
  socket.on('scorer-revoked', (msg) => {
    if (msg.matchId !== app.matchId) return;
    app.role = 'view';
    cb('onStatus', 'revoked');
  });

  // overlays follow the server's active match: when this one is done,
  // quietly watch for the next one
  if (!opts.matchId && (opts.follow ?? true)) {
    setInterval(async () => {
      if (!app.state || app.state.phase !== 'complete') return;
      const info = await fetchInfo();
      if (info.activeMatchId && info.activeMatchId !== app.matchId) {
        app.matchId = info.activeMatchId;
        join();
      }
    }, 10000);
  }

  /** Append an event. Offline (or timeout): queued + optimistic ack. */
  app.send = async (event, { force = false } = {}) => {
    const ev = { id: rid(), ...event };
    if (!app.online) {
      app.queue.push({ event: ev, force });
      saveQueue();
      cb('onQueue', app.queue.length);
      return { ok: true, queued: true };
    }
    const res = await emitAck('append', { matchId: app.matchId, event: ev, force });
    if (res.timeout) {
      app.queue.push({ event: ev, force });
      saveQueue();
      cb('onQueue', app.queue.length);
      return { ok: true, queued: true };
    }
    return res;
  };

  app.undo = () => emitAck('undo', { matchId: app.matchId });
  app.edit = (seq, event) => emitAck('edit', { matchId: app.matchId, seq, event });
  app.setPresentation = (patch) => emitAck('presentation', { matchId: app.matchId, patch });
  app.fire = (fx) => emitAck('fire', { matchId: app.matchId, fx });
  app.rejoin = (extra = {}) => { joinOpts = { ...joinOpts, ...extra }; return join(); };
  app.fetchEvents = async () => (await (await fetch(`/api/matches/${app.matchId}/events`)).json());

  cb('onStatus', 'connecting');
  return app;
}

// ---------------------------------------------------------------------------
// Misc shared bits
// ---------------------------------------------------------------------------

export function teamOf(state, teamId) {
  return state.config.teams.find((t) => t.id === teamId);
}

export function playerName(state, pid) {
  if (!pid) return '';
  for (const t of ['A', 'B']) {
    const p = state.squads[t].find((x) => x.id === pid);
    if (p) return p.name;
  }
  return pid;
}

/** The innings the viewer cares about right now (live one, else latest). */
export function focusInnings(state) {
  if (!state || !state.innings.length) return null;
  return state.innings[state.innings.length - 1];
}

export function applyBranding(branding) {
  if (branding?.accent) document.documentElement.style.setProperty('--accent', branding.accent);
}
