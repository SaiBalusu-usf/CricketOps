/**
 * Director panel — presentation control for the broadcast. Routes:
 *   /director            → match picker
 *   /director/:matchId   → join as director (director or scorer PIN both work)
 *
 * The page builds a static skeleton once and patches it on state /
 * presentation broadcasts, so controls never jump under a thumb. Overlay
 * toggles flip locally first (optimistic) and revert if the server refuses.
 */

import { connect, $, h, teamOf } from '/client/shared/app.js';

const hdr = $('#hdr');
const main = $('#main');

// ---------------------------------------------------------------------------
// Theme (dark control-room default)
// ---------------------------------------------------------------------------

const THEME_KEY = 'icat-director-theme';

function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0d1117' : '#f4f6f8');
}
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

function themeToggle() {
  const btn = h('button', {
    class: 'icon-btn', 'aria-label': 'Toggle dark theme', title: 'Light / dark',
    onclick: () => {
      const next = document.body.classList.contains('dark') ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    },
  });
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
    + '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>';
  return btn;
}

// ---------------------------------------------------------------------------
// Toasts, copy, confirm dialog
// ---------------------------------------------------------------------------

function toast(msg, tone = 'ok') {
  const root = $('#toasts');
  if (!root) return;
  const el = h('div', { class: `toast ${tone}` }, String(msg));
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 280); }, 2800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed', 'warn'); }
    ta.remove();
  }
}

/** Modal yes/no. Resolves false on dismiss / Escape / backdrop tap. */
function confirmDialog({ title = 'Are you sure?', lines = [], confirmLabel = 'Confirm', tone = 'primary' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('show');
      setTimeout(() => backdrop.remove(), 260);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    const backdrop = h('div', {
      class: 'sheet-backdrop',
      onclick: (e) => { if (e.target === backdrop) finish(false); },
    },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'sheet-title' }, title),
        lines.map((l) => h('p', { class: 'confirm-line' }, l)),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', { class: 'btn grow', onclick: () => finish(false) }, 'Cancel'),
          h('button', { class: `btn ${tone} grow`, onclick: () => finish(true) }, confirmLabel))));
    $('#sheets').append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
    document.addEventListener('keydown', onKey, true);
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const path = location.pathname.replace(/\/+$/, '');
const matchRoute = path.match(/^\/director\/([^/]+)$/);
if (matchRoute) startDirector(decodeURIComponent(matchRoute[1]));
else renderPicker();

// ---------------------------------------------------------------------------
// Match picker (/director with no id)
// ---------------------------------------------------------------------------

function chrome(brand) {
  hdr.textContent = '';
  hdr.append(h('div', { class: 'hdr-top' },
    h('span', { class: 'hdr-brand' }, brand),
    h('span', { class: 'hdr-right' }, themeToggle())));
  main.textContent = '';
}

const PHASE_LABEL = { setup: 'Not started', live: 'LIVE', break: 'Innings break', complete: 'Finished' };

function matchScoreLine(m) {
  if (!m.innings || !m.innings.length) return PHASE_LABEL[m.phase] || m.phase;
  return m.innings.map((i) => {
    const t = m.teams.find((x) => x.id === i.battingTeamId);
    return `${t ? t.short : i.battingTeamId} ${i.runs}/${i.wickets} (${i.overs})`;
  }).join(' · ');
}

async function renderPicker() {
  chrome('ICAT Cricket Live');
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-title' }, 'Director panel'),
    h('div', { class: 'page-sub' }, 'Overlay switching, stingers and match control — pick a match.'));
  main.append(page);

  let info = {};
  let matches = [];
  try {
    [info, matches] = await Promise.all([
      fetch('/api/info').then((r) => r.json()),
      fetch('/api/matches').then((r) => r.json()),
    ]);
  } catch { /* server unreachable — fall through to the empty note */ }

  matches.sort((a, b) => (b.id === info.activeMatchId) - (a.id === info.activeMatchId) || b.updatedAt - a.updatedAt);
  for (const m of matches) {
    page.append(h('a', { class: 'match-row', href: `/director/${m.id}` },
      h('span', {}, `${m.teams[0].short} v ${m.teams[1].short}`),
      m.id === info.activeMatchId && m.phase !== 'complete'
        ? h('span', { class: 'pill live' }, PHASE_LABEL[m.phase] || m.phase)
        : h('span', { class: 'tag' }, PHASE_LABEL[m.phase] || m.phase),
      h('span', { class: 'mr-score' }, matchScoreLine(m))));
  }
  if (!matches.length) page.append(h('p', { class: 'center-note' }, 'No matches on this server yet — create one from the scoring console.'));
}

// ---------------------------------------------------------------------------
// Director session
// ---------------------------------------------------------------------------

const OVERLAYS = [
  ['scorebug', 'Scorebug', 'Lower-third score strip'],
  ['batting', 'Batting card', 'Current batters'],
  ['bowling', 'Bowling card', 'Bowler figures'],
  ['summary', 'Summary', 'Innings summary card'],
  ['lineups', 'Line-ups', 'Both squads'],
  ['target', 'Target', 'Chase equation'],
];

const STINGERS = [
  { type: 'four', label: 'FOUR', cls: 'gold' },
  { type: 'six', label: 'SIX', cls: 'gold' },
  { type: 'wicket', label: 'WICKET', cls: 'red' },
  { type: 'fifty', label: 'FIFTY', cls: 'blue' },
  { type: 'hundred', label: 'HUNDRED', cls: 'blue' },
  { type: 'hattrick', label: 'HAT-TRICK', cls: 'red' },
  { type: 'duck', label: 'DUCK', cls: 'red' },
  { type: 'over', label: 'OVER', cls: 'grey' },
  { type: 'innings-end', label: 'INNINGS END', cls: 'grey' },
  { type: 'result', label: 'RESULT', cls: 'gold' },
];

const TICKER_PRESETS = ['Drinks break', 'Rain delay', 'Innings break'];

async function startDirector(matchId) {
  const pinKey = `icat-director-pin-${matchId}`;
  let app = null;
  let state = null;
  let pres = null;       // local copy — flipped optimistically before the ack
  let status = 'connecting';
  let built = false;
  let streamStatus = null; // read-only broadcast health (Part D)
  const ui = { penaltyTeam: null };
  const refs = {};

  // --- join ------------------------------------------------------------------
  let pin = localStorage.getItem(pinKey);
  if (!pin) pin = await promptPin(matchId, null);
  localStorage.setItem(pinKey, pin);
  renderConnecting();

  app = await connect({
    matchId, role: 'director', pin, follow: false,
    onState(st) { state = st; updateContext(); updateMatchControl(); },
    onPresentation(p) { pres = p; updatePresentation(); },
    onStatus(s, res) { handleStatus(s, res); },
    onStreamStatus(s) { streamStatus = s; updateContext(); },
  });

  async function handleStatus(s, res = {}) {
    status = s;
    if (s === 'bad-pin' || s === 'locked-out') {
      localStorage.removeItem(pinKey);
      built = false;
      const msg = s === 'locked-out'
        ? `Too many wrong PINs — this device is locked for ${Math.ceil((res.retryInMs || 30000) / 1000)}s. Wait, then try again.`
        : 'That PIN is not right — try again.';
      pin = await promptPin(matchId, msg);
      localStorage.setItem(pinKey, pin);
      renderConnecting();
      app.rejoin({ pin });
      return;
    }
    if (s === 'no-match') { built = false; renderNoMatch(matchId); return; }
    if (s === 'online' && !built) { buildUI(); built = true; buildLinks(); }
    updateContext();
  }

  // --- entry screens ----------------------------------------------------------
  function renderConnecting() {
    chrome('Director');
    main.append(h('p', { class: 'center-note' }, 'Connecting…'));
  }

  function renderNoMatch(id) {
    chrome('Director');
    main.append(h('div', { class: 'page pin-screen' },
      h('div', { class: 'page-title' }, 'Match not found'),
      h('p', { class: 'page-sub' }, `No match “${id}” on this server.`),
      h('a', { class: 'btn primary', href: '/director' }, 'All matches')));
  }

  function promptPin(id, errMsg) {
    return new Promise((resolve) => {
      chrome('Director');
      const input = h('input', {
        class: 'pin-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
        autocomplete: 'one-time-code', maxlength: '8', placeholder: '····',
      });
      const go = () => { const v = input.value.trim(); if (v) resolve(v); else input.focus(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      const title = h('div', { class: 'page-sub', style: { textAlign: 'center' } }, `Match ${id}`);
      main.append(h('div', { class: 'page pin-screen' },
        h('div', { class: 'page-title' }, 'Enter the director PIN'),
        title,
        h('div', { class: 'card pin-card' },
          h('span', { class: 'pin-label' }, 'Director PIN'),
          input,
          errMsg ? h('span', { class: 'confirm-line', style: { fontSize: '13.5px' } }, errMsg) : null,
          h('button', { class: 'btn primary', style: { width: '100%' }, onclick: go }, 'Join as director'),
          h('span', { class: 'muted small' }, 'The scorer PIN works here too.'))));
      fetch(`/api/matches/${id}`).then((r) => r.json()).then((d) => {
        if (d.state && d.state.config) title.textContent = d.state.config.teams.map((t) => t.name).join(' v ');
      }).catch(() => {});
      setTimeout(() => input.focus(), 100);
    });
  }

  // --- presentation actions (optimistic) --------------------------------------
  async function patchPresentation(patch, revert) {
    updatePresentation();
    const res = await app.setPresentation(patch);
    if (!res.ok) {
      revert();
      updatePresentation();
      toast(res.timeout ? 'Offline — change not applied' : (res.errors || ['change failed']).join(' · '), 'danger');
    }
  }

  function toggleShow(k) {
    if (!pres || !app) return;
    const v = !pres.show[k];
    pres.show[k] = v;
    patchPresentation({ show: { [k]: v } }, () => { pres.show[k] = !v; });
  }

  function toggleAuto() {
    if (!pres || !app) return;
    const v = !pres.auto;
    pres.auto = v;
    patchPresentation({ auto: v }, () => { pres.auto = !v; });
  }

  function setTheme(t) {
    if (!pres || !app || pres.theme === t) return;
    const prev = pres.theme;
    pres.theme = t;
    patchPresentation({ theme: t }, () => { pres.theme = prev; });
  }

  function setTicker(text) {
    if (!pres || !app) return;
    const prev = pres.ticker;
    pres.ticker = text;
    refs.ticker.value = text;
    patchPresentation({ ticker: text }, () => { pres.ticker = prev; });
  }

  // --- stingers ----------------------------------------------------------------
  async function fireStinger(item, btn) {
    if (!app) return;
    btn.classList.remove('fired');
    void btn.offsetWidth; // restart the flash animation
    btn.classList.add('fired');
    const fx = { type: item.type };
    if (item.type === 'result') {
      fx.text = (state && state.result && state.result.text) || (pres && pres.ticker) || 'Match result';
    }
    const res = await app.fire(fx);
    if (!res.ok) toast((res.errors || ['stinger failed']).join(' · '), 'danger');
  }

  // --- match control (real events → confirm first) ------------------------------
  async function sendChecked(ev, confirmOpts) {
    if (!app) return { ok: false };
    const go = await confirmDialog(confirmOpts);
    if (!go) return { ok: false };
    let res = await app.send(ev);
    if (!res.ok && res.needsForce) {
      const over = await confirmDialog({
        title: 'Scoring warning', lines: res.warnings || [],
        confirmLabel: 'Apply anyway', tone: 'danger',
      });
      if (!over) return { ok: false };
      res = await app.send(ev, { force: true });
    }
    if (res.ok) toast(res.queued ? 'Offline — queued for sync' : 'Applied', res.queued ? 'warn' : 'ok');
    else if (res.errors) toast(res.errors.join(' · '), 'danger');
    return res;
  }

  async function applyRevision() {
    const t = parseInt(refs.target.value, 10);
    const o = parseInt(refs.overs.value, 10);
    const ev = { type: 'TARGET_REVISED', note: refs.revNote.value.trim() };
    if (!Number.isNaN(t)) ev.target = t;
    if (!Number.isNaN(o)) ev.oversLimit = o;
    if (ev.target === undefined && ev.oversLimit === undefined) {
      toast('Enter a new target or an overs limit', 'warn');
      return;
    }
    const lines = [];
    if (ev.target !== undefined) lines.push(`New target: ${ev.target}`);
    if (ev.oversLimit !== undefined) lines.push(`Overs limit: ${ev.oversLimit} per innings`);
    if (ev.note) lines.push(`Note: ${ev.note}`);
    lines.push('This writes a TARGET_REVISED event into the match record.');
    const res = await sendChecked(ev, { title: 'Revise the match?', lines, confirmLabel: 'Apply revision' });
    if (res.ok) { refs.target.value = ''; refs.overs.value = ''; refs.revNote.value = ''; }
  }

  async function clearRevision() {
    await sendChecked(
      { type: 'TARGET_REVISED', clear: true, note: 'revision cleared' },
      { title: 'Clear the revision?', lines: ['The original target and overs come back into force.'], confirmLabel: 'Clear revision', tone: 'danger' });
  }

  async function awardPenalty() {
    if (!state) return;
    const team = teamOf(state, ui.penaltyTeam);
    const note = refs.penNote.value.trim();
    const res = await sendChecked(
      { type: 'PENALTY', teamId: ui.penaltyTeam, runs: 5, note },
      {
        title: 'Award penalty runs?',
        lines: [`+5 runs to ${team ? team.name : ui.penaltyTeam}`, note ? `Note: ${note}` : 'No note recorded.'],
        confirmLabel: 'Award +5', tone: 'danger',
      });
    if (res.ok) refs.penNote.value = '';
  }

  // -----------------------------------------------------------------------------
  // Skeleton — built once, patched by the update fns below
  // -----------------------------------------------------------------------------

  const section = (title, ...kids) => h('section', { class: 'sec' }, h('div', { class: 'sec-title' }, title), ...kids);
  const fieldEl = (label, control) => h('div', { class: 'field' }, h('label', {}, label), control);

  function buildUI() {
    hdr.textContent = '';
    refs.conn = h('span', { class: 'conn', title: 'connecting' });
    refs.scoreLine = h('div', { class: 'score-line' });
    refs.sub = h('div', { class: 'score-sub' });
    refs.streamChip = h('span', { class: 'stream-chip', hidden: true });
    hdr.append(h('div', { class: 'hdr-top' },
      refs.conn,
      h('div', { class: 'hdr-score' }, refs.scoreLine, refs.sub),
      refs.streamChip,
      h('span', { class: 'hdr-right' }, themeToggle())));

    main.textContent = '';
    const colA = h('div', { class: 'colwrap' });
    const colB = h('div', { class: 'colwrap' });
    main.append(h('div', { class: 'columns' }, colA, colB));

    // overlays
    refs.tiles = {};
    const grid = h('div', { class: 'tile-grid' });
    for (const [k, name, hint] of OVERLAYS) {
      const btn = h('button', { class: 'tile', type: 'button', 'data-k': k, title: hint, onclick: () => toggleShow(k) },
        h('span', { class: 't-name' }, name),
        h('span', { class: 't-state' }, 'OFF'));
      refs.tiles[k] = btn;
      grid.append(btn);
    }
    colA.append(section('Overlays', grid));

    // presentation
    refs.autoTile = h('button', { class: 'tile wide', type: 'button', 'data-k': 'auto', onclick: toggleAuto },
      h('span', { class: 't-name' }, 'Auto stingers & cards'),
      h('span', { class: 't-state' }, 'OFF'));
    refs.themeBtns = {};
    const seg = h('div', { class: 'seg' });
    for (const [v, label] of [['broadcast', 'Broadcast'], ['chroma', 'Chroma green']]) {
      const b = h('button', { class: 'seg-btn', type: 'button', 'data-v': v, onclick: () => setTheme(v) }, label);
      refs.themeBtns[v] = b;
      seg.append(b);
    }
    colA.append(section('Presentation', refs.autoTile, fieldEl('Overlay theme', seg)));

    // ticker
    refs.ticker = h('input', { type: 'text', placeholder: 'Ticker text — empty hides it', autocomplete: 'off' });
    refs.ticker.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTicker(refs.ticker.value.trim()); });
    refs.chips = TICKER_PRESETS.map((t) => h('button', { class: 'chip', type: 'button', 'data-text': t, onclick: () => setTicker(t) }, t));
    colA.append(section('Ticker',
      h('div', { class: 'ticker-row' },
        refs.ticker,
        h('button', { class: 'btn primary', onclick: () => setTicker(refs.ticker.value.trim()) }, 'Set'),
        h('button', { class: 'btn', onclick: () => setTicker('') }, 'Clear')),
      h('div', { class: 'chip-row' }, refs.chips)));

    // stingers
    const sg = h('div', { class: 'sting-grid' });
    for (const item of STINGERS) {
      const b = h('button', { class: `sting ${item.cls}`, type: 'button', 'data-fx': item.type }, item.label);
      b.addEventListener('click', () => fireStinger(item, b));
      sg.append(b);
    }
    colB.append(section('Fire a stinger', sg,
      h('p', { class: 'sec-note' }, 'Manual stingers play on every overlay, even with Auto off.')));

    // match control
    refs.target = h('input', { class: 'num-input', type: 'number', inputmode: 'numeric', min: '1', placeholder: '—' });
    refs.overs = h('input', { class: 'num-input', type: 'number', inputmode: 'numeric', min: '1', placeholder: '—' });
    refs.revNote = h('input', { type: 'text', placeholder: 'e.g. DLS after rain', autocomplete: 'off' });
    refs.revStatus = h('div', { class: 'mc-status' });
    refs.clearRev = h('button', { class: 'btn', style: { display: 'none' }, onclick: clearRevision }, 'Clear revision');
    refs.penaltySeg = h('div', { class: 'seg' });
    refs.penNote = h('input', { type: 'text', placeholder: 'Reason (optional)', autocomplete: 'off' });
    colB.append(section('Match control',
      h('div', { class: 'card mc-card' },
        h('div', { class: 'card-title' }, 'Revise target / overs'),
        refs.revStatus,
        h('div', { class: 'mc-row' }, fieldEl('New target', refs.target), fieldEl('Overs limit', refs.overs)),
        fieldEl('Note', refs.revNote),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary grow', onclick: applyRevision }, 'Apply revision'),
          refs.clearRev)),
      h('div', { class: 'card mc-card' },
        h('div', { class: 'card-title' }, 'Penalty runs'),
        fieldEl('Awarded to', refs.penaltySeg),
        fieldEl('Note', refs.penNote),
        h('button', { class: 'btn danger', onclick: awardPenalty }, 'Award +5 penalty'))));

    // links + pin
    refs.links = h('div', { class: 'links' });
    let shown = false;
    const pinVal = h('span', { class: 'pv' }, '••••');
    const pinHint = h('span', { class: 'ph' }, 'tap to reveal');
    const pinRow = h('button', {
      class: 'pin-peek', type: 'button',
      onclick: () => {
        shown = !shown;
        pinVal.textContent = shown ? pin : '••••';
        pinHint.textContent = shown ? 'tap to hide' : 'tap to reveal';
      },
    }, h('span', { class: 'pl' }, 'PIN'), pinVal, pinHint);
    const linksSec = section('Links & access', refs.links, pinRow);
    linksSec.classList.add('sec-links'); // phone: last; desktop: fills column A
    colA.append(linksSec);
  }

  async function buildLinks() {
    let base = location.origin;
    try {
      const info = await (await fetch('/api/info')).json();
      if (info.urls && info.urls[0]) base = info.urls[0];
    } catch { /* offline — origin is fine */ }
    const id = (app && app.matchId) || matchId;
    const rows = [
      ['Scorebug', `${base}/overlay/scorebug?match=${id}`],
      ['Full frame', `${base}/overlay/full?match=${id}`],
      ['Batting', `${base}/overlay/batting?match=${id}`],
      ['Bowling', `${base}/overlay/bowling?match=${id}`],
      ['Summary', `${base}/overlay/summary?match=${id}`],
      ['Line-ups', `${base}/overlay/lineups?match=${id}`],
      ['Target', `${base}/overlay/target?match=${id}`],
      ['Live score', `${base}/live/${id}`],
    ];
    refs.links.textContent = '';
    refs.links.append(h('p', { class: 'sec-note', style: { margin: '0 0 8px' } },
      'Overlay URLs go into OBS as 1920×1080 Browser Sources.'));
    for (const [name, url] of rows) {
      refs.links.append(h('div', { class: 'link-row' },
        h('span', { class: 'link-name' }, name),
        h('span', { class: 'link-url' }, url),
        h('button', { class: 'btn', onclick: () => copyText(url) }, 'Copy')));
    }
  }

  // -----------------------------------------------------------------------------
  // Patch fns
  // -----------------------------------------------------------------------------

  function scoreLine() {
    if (!state || !state.config) return 'Waiting for the match…';
    if (!state.innings.length) return `${state.config.teams.map((t) => t.short).join(' v ')} — not started`;
    const bits = state.innings.map((i) => {
      const t = teamOf(state, i.battingTeamId);
      return `${t ? t.short : i.battingTeamId} ${i.runs}/${i.wickets} (${i.oversText})`;
    });
    if (state.chase && state.phase === 'live') bits.push(`need ${state.chase.need} off ${state.chase.ballsLeft}`);
    return bits.join(' · ');
  }

  function subLine() {
    if (!state || !state.config) return status;
    if (state.phase === 'complete' && state.result) return state.result.text;
    if (state.phase === 'break') return 'Innings break';
    const c = state.config;
    const label = [c.name, c.venue].filter(Boolean).join(' · ');
    if (state.phase === 'setup') return label ? `Not started · ${label}` : 'Not started';
    return label || `${c.oversPerInnings}-over match`;
  }

  function updateContext() {
    if (!built) return;
    const cls = status === 'online' ? ' online' : status === 'offline' ? ' offline' : '';
    refs.conn.className = `conn${cls}`;
    refs.conn.title = status;
    refs.scoreLine.textContent = scoreLine();
    refs.sub.textContent = subLine();
    // read-only broadcast health chip (Part D): the graphics person sees
    // stream state without holding the phone
    const ss = streamStatus;
    const show = !!(ss && (ss.live || ss.hasKey));
    refs.streamChip.hidden = !show;
    if (show) {
      const up = Math.max(0, ss.uptimeSec | 0);
      const hh = String(Math.floor(up / 3600)).padStart(2, '0');
      const mm = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
      const sec = String(up % 60).padStart(2, '0');
      refs.streamChip.textContent = ss.live
        ? `Stream: LIVE · ${((ss.kbps || 0) / 1000).toFixed(1)} Mbps · ${hh}:${mm}:${sec}`
        : `Stream: ready (${ss.keyTail || 'key set'})`;
      refs.streamChip.classList.toggle('live', !!ss.live);
    }
  }

  function updatePresentation() {
    if (!built || !pres) return;
    for (const [k, btn] of Object.entries(refs.tiles)) {
      const on = !!pres.show[k];
      btn.classList.toggle('on', on);
      btn.querySelector('.t-state').textContent = on ? 'ON AIR' : 'OFF';
    }
    refs.autoTile.classList.toggle('on', !!pres.auto);
    refs.autoTile.querySelector('.t-state').textContent = pres.auto ? 'ON' : 'OFF';
    const theme = pres.theme === 'chroma' ? 'chroma' : 'broadcast';
    for (const [v, btn] of Object.entries(refs.themeBtns)) btn.classList.toggle('on', theme === v);
    if (document.activeElement !== refs.ticker) refs.ticker.value = pres.ticker || '';
    for (const c of refs.chips) c.classList.toggle('on', (pres.ticker || '') === c.dataset.text);
  }

  function updateMatchControl() {
    if (!built || !state || !state.config) return;
    refs.revStatus.textContent = state.target
      ? `Current target ${state.target.runs}${state.target.revised ? ' (revised)' : ''} · ${state.config.oversPerInnings} overs`
      : `No target yet · ${state.config.oversPerInnings} overs a side`;
    refs.clearRev.style.display = state.target && state.target.revised ? '' : 'none';

    if (!ui.penaltyTeam) ui.penaltyTeam = state.battingTeamId || 'A';
    refs.penaltySeg.textContent = '';
    for (const t of state.config.teams) {
      refs.penaltySeg.append(h('button', {
        class: `seg-btn${ui.penaltyTeam === t.id ? ' on' : ''}`, type: 'button',
        onclick: () => { ui.penaltyTeam = t.id; updateMatchControl(); },
      }, t.name));
    }
  }
}
