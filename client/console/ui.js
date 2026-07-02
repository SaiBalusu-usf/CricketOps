/**
 * Console UI toolkit: theme, toasts, bottom-sheet plumbing, small controls,
 * and every scorer flow that lives in a sheet. Domain sheets take the console
 * `ctx` built in console.js: { matchId, ui, state, app, send, render, watchNeeds }.
 */

import { $, h, fmt, teamOf, playerName } from '/client/shared/app.js';

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_KEY = 'icat-theme';

export function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0d1117' : '#f4f6f8');
}

export function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
}

export function themeToggle() {
  const btn = h('button', {
    class: 'icon-btn', 'aria-label': 'Toggle dark theme', title: 'Light / dark',
    onclick: () => {
      const next = document.body.classList.contains('dark') ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    },
  });
  // half-moon glyph as inline svg (emoji-free, renders everywhere)
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
    + '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>';
  return btn;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(msg, tone = 'ok') {
  const root = $('#toasts');
  if (!root) return;
  const el = h('div', { class: `toast ${tone}` }, String(msg));
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 280); }, 2800);
}

export async function copyText(text) {
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

// ---------------------------------------------------------------------------
// Sheet plumbing — one sheet at a time, slide-up, Escape/backdrop dismiss
// ---------------------------------------------------------------------------

let current = null;

export function sheetKind() { return current ? current.kind : null; }

function onSheetKey(e) {
  if (e.key === 'Escape' && current && current.dismissable) { e.stopPropagation(); closeSheet(); }
}

export function closeSheet() {
  if (!current) return;
  const { backdrop, onClose } = current;
  current = null;
  document.removeEventListener('keydown', onSheetKey, true);
  backdrop.classList.remove('show');
  setTimeout(() => backdrop.remove(), 260);
  if (onClose) { try { onClose(); } catch (e) { console.error(e); } }
}

export function openSheet(kind, { title = '', dismissable = true, onClose = null } = {}) {
  closeSheet();
  const titleEl = h('div', { class: 'sheet-title' }, title);
  const body = h('div', { class: 'sheet-body' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet-head' },
      titleEl,
      dismissable ? h('button', { class: 'sheet-x', 'aria-label': 'Close', onclick: () => closeSheet() }, '×') : null),
    body);
  const backdrop = h('div', {
    class: 'sheet-backdrop',
    onclick: (e) => { if (e.target === backdrop && dismissable) closeSheet(); },
  }, sheet);
  $('#sheets').append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));
  document.addEventListener('keydown', onSheetKey, true);
  current = { kind, backdrop, dismissable, onClose };
  return { body, close: closeSheet, setTitle: (t) => { titleEl.textContent = t; } };
}

/** Modal yes/no. Resolves false on dismiss. */
export function confirmSheet({ title = 'Are you sure?', lines = [], confirmLabel = 'Confirm', tone = 'danger' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const s = openSheet('confirm', { title, onClose: () => finish(false) });
    s.body.append(
      ...lines.map((l) => h('p', { class: 'warn-line' }, l)),
      h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: () => closeSheet() }, 'Cancel'),
        h('button', { class: `btn ${tone} grow`, onclick: () => { finish(true); closeSheet(); } }, confirmLabel)));
  });
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

/** Null-safe append — native Element.append stringifies null. */
function add(el, ...kids) {
  for (const k of kids.flat(Infinity)) {
    if (k !== null && k !== undefined && k !== false) el.append(k);
  }
}

/** Segmented control. options: [{value,label}] */
export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  const draw = () => {
    wrap.textContent = '';
    for (const o of options) {
      wrap.append(h('button', {
        class: `seg-btn${o.value === value ? ' on' : ''}`, type: 'button',
        onclick: () => { value = o.value; draw(); onChange(value); },
      }, o.label));
    }
  };
  draw();
  return wrap;
}

export function field(label, control) {
  return h('div', { class: 'field' }, h('label', {}, label), control);
}

export function toggleRow(label, sub, value, onChange) {
  const sw = h('span', { class: `switch${value ? ' on' : ''}` });
  return h('div', {
    class: 'toggle-row', role: 'switch', 'aria-checked': String(!!value), tabindex: '0',
    onclick: () => { value = !value; sw.classList.toggle('on', value); onChange(value); },
  },
    h('div', {}, h('div', { class: 't-label' }, label), sub ? h('div', { class: 't-sub' }, sub) : null),
    sw);
}

function playerGrid(players, onPick, { badge = null, role = null } = {}) {
  return h('div', { class: 'pick-grid' }, players.map((p) => {
    const b = badge ? badge(p) : null;
    const r = role ? role(p) : null;
    return h('button', { class: 'btn pick', type: 'button', onclick: () => onPick(p) },
      r ? h('span', { class: 'pick-role' }, r) : null,
      h('span', { class: 'pick-name' }, p.name),
      b ? h('span', { class: 'pick-badge' }, b) : null);
  }));
}

export function liveInn(state) {
  const inn = state && state.innings.length ? state.innings[state.innings.length - 1] : null;
  return inn && !inn.closed ? inn : null;
}

// ---------------------------------------------------------------------------
// Openers sheet — INNINGS_START (setup, break, super over)
// ---------------------------------------------------------------------------

export function openOpenersSheet(ctx) {
  const state = ctx.state;
  if (!state || !state.config) return;
  const idx = state.innings.length;
  const batted = state.innings.map((i) => i.battingTeamId);
  const other = (t) => (t === 'A' ? 'B' : 'A');

  let teamId;
  if (idx === 0) {
    const t = state.config.toss;
    teamId = t ? (t.decision === 'bat' ? t.winner : other(t.winner)) : 'A';
  } else if (idx === 1) teamId = other(batted[0]);
  else if (idx === 2) teamId = batted[1] || 'A'; // super over: chasing side bats first
  else teamId = other(batted[2]);

  let striker = null;
  let nonStriker = null;
  const title = idx >= 2 ? 'Super over — openers' : idx === 1 ? 'Second innings — openers' : 'Start the innings';
  const s = openSheet('openers', { title });

  const draw = () => {
    const squad = ctx.state.squads[teamId];
    const lms = ctx.state.config.rules.lastManStands;
    const soloOk = squad.length < 2 || lms;
    const ready = striker && (nonStriker || soloOk);
    s.body.textContent = '';
    s.body.append(
      field('Batting side', h('div', { class: 'team-choice' }, ['A', 'B'].map((id) => {
        const t = teamOf(ctx.state, id);
        return h('button', {
          class: `team-btn${id === teamId ? ' on' : ''}`, type: 'button',
          onclick: () => { if (id !== teamId) { teamId = id; striker = null; nonStriker = null; draw(); } },
        }, h('span', { class: 'team-dot', style: { background: t.color } }), t.name);
      }))),
      field('Tap the striker, then the non-striker', h('div', { class: 'pick-grid' }, squad.map((p) => {
        const isS = p.id === striker;
        const isN = p.id === nonStriker;
        return h('button', {
          class: `btn pick${isS || isN ? ' on' : ''}`, type: 'button',
          onclick: () => {
            if (isS) striker = null;
            else if (isN) nonStriker = null;
            else if (!striker) striker = p.id;
            else if (!nonStriker && p.id !== striker) nonStriker = p.id;
            draw();
          },
        },
          (isS || isN) ? h('span', { class: 'pick-role' }, isS ? 'Striker' : 'Non-striker') : null,
          h('span', { class: 'pick-name' }, p.name));
      }))),
      h('button', {
        class: 'btn primary', disabled: !ready,
        onclick: async () => {
          const res = await ctx.send({ type: 'INNINGS_START', battingTeamId: teamId, striker, nonStriker });
          if (res.ok) { closeSheet(); ctx.watchNeeds(); }
        },
      }, striker && !nonStriker && soloOk ? 'Start innings (batting solo)' : 'Start innings'));
  };
  draw();
}

// ---------------------------------------------------------------------------
// Bowler sheet — BOWLER_CHANGE with override-on-warning
// ---------------------------------------------------------------------------

export function openBowlerSheet(ctx) {
  const state = ctx.state;
  const inn = liveInn(state);
  if (!inn) return;
  const max = state.config.maxOversPerBowler;
  const squad = state.squads[inn.bowlingTeamId];
  const overNo = Math.floor(inn.legalBalls / 6) + 1;
  const midOver = inn.legalBalls % 6 !== 0 && inn.thisOver.length > 0;
  const s = openSheet('bowler', { title: midOver ? 'Change bowler (mid-over)' : `Bowler — over ${overNo}` });

  const list = h('div', { class: 'col bowler-list' });
  for (const p of squad) {
    const row = inn.bowlers.find((b) => b.id === p.id);
    const done = row ? Math.floor(row.balls / 6) : 0;
    const isLast = p.id === inn.lastOverBowlerId;
    const maxed = !inn.superOver && max && done >= max;
    list.append(h('button', {
      class: 'bowler-row', type: 'button',
      onclick: async () => {
        const res = await ctx.send({ type: 'BOWLER_CHANGE', bowler: p.id });
        if (res.ok) { closeSheet(); ctx.watchNeeds(); }
        else if (res.cancelled) openBowlerSheet(ctx); // force declined — pick again
      },
    },
      h('span', { class: 'bowler-name' },
        h('span', {}, p.name),
        isLast ? h('span', { class: 'tag warn' }, 'bowled last over')
          : maxed ? h('span', { class: 'tag warn' }, 'max overs used') : null),
      h('span', { class: 'bowler-figs' },
        row ? `${fmt.figures(row)} ${done}/${max} ov` : `— 0/${max} ov`)));
  }
  s.body.append(list);
}

// ---------------------------------------------------------------------------
// Wicket flow — BALL with wicket (or RETIREMENT), ≤3 taps for the common outs
// ---------------------------------------------------------------------------

const KIND_LABELS = {
  bowled: 'Bowled', caught: 'Caught', lbw: 'LBW', runout: 'Run out',
  stumped: 'Stumped', hitwicket: 'Hit wicket', timedout: 'Timed out',
  obstructing: 'Obstructing field', hittwice: 'Hit ball twice',
};

export function openWicketSheet(ctx, legality = 'legal') {
  const state = ctx.state;
  const inn = liveInn(state);
  if (!inn || !inn.striker) return;

  let kinds;
  if (state.freeHitPending || legality === 'noball') kinds = ['runout', 'obstructing', 'hittwice'];
  else if (legality === 'wide') kinds = ['runout', 'stumped', 'hitwicket', 'obstructing'];
  else kinds = ['bowled', 'caught', 'lbw', 'runout', 'stumped', 'hitwicket', 'timedout', 'obstructing', 'hittwice'];
  if (state.config.rules.noLbw) kinds = kinds.filter((k) => k !== 'lbw');

  const suffix = state.freeHitPending ? ' · free hit' : legality === 'wide' ? ' · wide' : legality === 'noball' ? ' · no-ball' : '';
  const s = openSheet('wicket', { title: `Wicket — how out?${suffix}` });
  const fieldSquad = state.squads[inn.bowlingTeamId];
  const strikerName = playerName(state, inn.striker);
  const nsName = inn.nonStriker ? playerName(state, inn.nonStriker) : null;

  const sendWicket = async (wicket, runsCompleted = 0) => {
    const ball = { type: 'BALL', legality, batRuns: 0, extraRuns: 0, wicket };
    if (runsCompleted) {
      if (legality === 'wide') ball.extraRuns = runsCompleted;
      else ball.batRuns = runsCompleted;
    }
    const res = await ctx.send(ball);
    if (res.ok) {
      // caught + crossed → survivor keeps strike, new batter defaults to non-striker
      ctx.ui.pendingEnd = wicket.kind === 'caught' && wicket.crossed ? 'nonstriker' : 'striker';
      ctx.ui.padMode = 'main';
      closeSheet();
      ctx.render();
      ctx.watchNeeds(); // the state broadcast can land while this sheet is still open
    }
  };

  const whoSeg = (onChange) => segmented(
    nsName
      ? [{ value: 'striker', label: `${strikerName} (striker)` }, { value: 'nonstriker', label: `${nsName} (non-striker)` }]
      : [{ value: 'striker', label: `${strikerName} (striker)` }],
    'striker', onChange);

  const step2 = (kind) => {
    s.body.textContent = '';
    if (kind === 'caught') {
      s.setTitle('Caught — who took the catch?');
      let crossed = false;
      s.body.append(
        toggleRow('Batters crossed?', 'New batter starts at the non-striker end', false, (v) => { crossed = v; }),
        playerGrid(fieldSquad, (p) => sendWicket({ kind, out: 'striker', fielders: [p.id], crossed })));
    } else if (kind === 'stumped') {
      s.setTitle('Stumped — by which keeper?');
      s.body.append(playerGrid(fieldSquad, (p) => sendWicket({ kind, out: 'striker', fielders: [p.id] })));
    } else if (kind === 'runout') {
      s.setTitle('Run out');
      let who = 'striker';
      let runs = 0;
      s.body.append(
        field('Who is out?', whoSeg((v) => { who = v; })),
        field('Runs completed before the wicket', segmented(
          [0, 1, 2, 3].map((n) => ({ value: n, label: String(n) })), 0, (v) => { runs = v; })),
        field('Fielder (tap to record the wicket)', playerGrid(fieldSquad, (p) => sendWicket({ kind, out: who, fielders: [p.id] }, runs))),
        h('button', { class: 'btn ghost', onclick: () => sendWicket({ kind, out: who, fielders: [] }, runs) }, 'No fielder recorded'));
    } else if (kind === 'obstructing' || kind === 'timedout') {
      s.setTitle(KIND_LABELS[kind]);
      let who = 'striker';
      s.body.append(
        field('Who is out?', whoSeg((v) => { who = v; })),
        h('button', { class: 'btn danger', onclick: () => sendWicket({ kind, out: who, fielders: [] }) }, `Confirm ${KIND_LABELS[kind].toLowerCase()}`));
    } else {
      sendWicket({ kind, out: 'striker', fielders: [] }); // bowled / lbw / hitwicket / hittwice — done
    }
  };

  const retireStep = (kind) => {
    s.body.textContent = '';
    s.setTitle(kind === 'hurt' ? 'Retired hurt' : 'Retired out');
    let who = 'striker';
    add(s.body,
      field('Who retires?', whoSeg((v) => { who = v; })),
      kind === 'hurt' ? h('p', { class: 'muted small', style: { margin: '0' } }, 'A retired-hurt batter may resume later from the new-batter list.') : null,
      h('button', { class: 'btn danger', onclick: async () => {
        const res = await ctx.send({ type: 'RETIREMENT', who, kind });
        if (res.ok) { closeSheet(); ctx.render(); ctx.watchNeeds(); }
      } }, kind === 'hurt' ? 'Retire hurt' : 'Retire out'));
  };

  s.body.append(
    h('div', { class: 'pick-grid' }, kinds.map((k) => h('button', { class: 'btn pick', onclick: () => step2(k) }, h('span', { class: 'pick-name' }, KIND_LABELS[k])))),
    h('div', { class: 'row' },
      h('button', { class: 'btn grow', onclick: () => retireStep('out') }, 'Retired out'),
      h('button', { class: 'btn grow', onclick: () => retireStep('hurt') }, 'Retired hurt')));
}

// ---------------------------------------------------------------------------
// New batter sheet — NEW_BATTER
// ---------------------------------------------------------------------------

export function openNewBatterSheet(ctx) {
  const state = ctx.state;
  const inn = liveInn(state);
  if (!inn) return;
  let end = ctx.ui.pendingEnd || 'striker';
  const eligible = state.squads[inn.battingTeamId].filter((p) => {
    if (p.id === inn.striker || p.id === inn.nonStriker) return false;
    const row = inn.batters.find((b) => b.id === p.id);
    return !row || (!row.out && !row.atCrease);
  });

  const s = openSheet('newBatter', { title: 'New batter' });
  s.body.append(
    field('Comes in at', segmented(
      [{ value: 'striker', label: 'Facing' }, { value: 'nonstriker', label: 'Non-striker' }],
      end, (v) => { end = v; })),
    eligible.length
      ? playerGrid(eligible, async (p) => {
        const res = await ctx.send({ type: 'NEW_BATTER', batter: p.id, end });
        if (res.ok) { ctx.ui.pendingEnd = null; closeSheet(); ctx.watchNeeds(); }
      }, {
        badge: (p) => {
          const r = inn.batters.find((b) => b.id === p.id);
          return r && r.retiredHurt ? 'retired hurt — can resume' : null;
        },
      })
      : h('p', { class: 'center-note' }, 'No eligible batters left.'),
    h('button', { class: 'btn ghost', onclick: () => openAddPlayerSheet(ctx, inn.battingTeamId) }, 'Add a player…'));
}

// ---------------------------------------------------------------------------
// More menu + its sub-sheets
// ---------------------------------------------------------------------------

export function openMoreSheet(ctx) {
  const state = ctx.state;
  const inn = liveInn(state);
  const s = openSheet('more', { title: 'More' });
  const item = (label, sub, onclick, state2 = null) => h('button', { class: 'more-item', type: 'button', onclick },
    h('span', {}, label, sub ? h('span', { class: 'mi-sub' }, sub) : null),
    state2 ? h('span', { class: `mi-state${state2.on ? ' on' : ''}` }, state2.text) : null);

  const scoring = state && state.phase === 'live' && inn;
  add(s.body,
    scoring ? h('div', { class: 'more-grid' },
      h('button', { class: 'more-item', onclick: () => { ctx.sendBall({ legality: 'legal', batRuns: 5 }); closeSheet(); } }, '5 runs'),
      h('button', { class: 'more-item', onclick: () => { ctx.sendBall({ legality: 'legal', batRuns: 7 }); closeSheet(); } }, '7 runs')) : null,
    scoring ? item('1 short', 'Apply “one short” to the next runs entered',
      () => { ctx.ui.shortNext = !ctx.ui.shortNext; closeSheet(); ctx.render(); },
      { on: ctx.ui.shortNext, text: ctx.ui.shortNext ? 'ARMED' : 'OFF' }) : null,
    item('Penalty runs (+5)', 'Award penalty runs to either side', () => openPenaltySheet(ctx)),
    scoring ? item('Retire batter', 'Retired hurt or retired out', () => openRetireSheet(ctx)) : null,
    item('Revise target / overs', 'Rain rule, shortened match', () => openReviseSheet(ctx)),
    scoring ? item('Declare / end innings', 'Close this innings now', async () => {
      closeSheet();
      const ok = await confirmSheet({ title: 'End this innings?', lines: ['The innings will be closed as declared.'], confirmLabel: 'End innings' });
      if (ok) { const res = await ctx.send({ type: 'INNINGS_DECLARED' }); if (res.ok) ctx.watchNeeds(); }
    }) : null,
    item('Add player', 'Late arrival joins a squad', () => openAddPlayerSheet(ctx)),
    item('Edit teams', 'Names, short codes, colors', () => openEditTeamsSheet(ctx)),
    h('a', { class: 'more-item', href: `/api/matches/${ctx.matchId}/export`, download: true },
      h('span', {}, 'Export match JSON', h('span', { class: 'mi-sub' }, 'Full event log — can be re-imported'))),
    item('Overlay & director links', 'URLs for OBS and the director', () => openLinksSheet(ctx)));
}

function openPenaltySheet(ctx) {
  const state = ctx.state;
  let teamId = state.battingTeamId || 'A';
  const note = h('input', { type: 'text', placeholder: 'Reason (optional)' });
  const s = openSheet('penalty', { title: 'Penalty runs (+5)' });
  s.body.append(
    field('Awarded to', segmented(state.config.teams.map((t) => ({ value: t.id, label: t.name })), teamId, (v) => { teamId = v; })),
    field('Note', note),
    h('button', { class: 'btn primary', onclick: async () => {
      const res = await ctx.send({ type: 'PENALTY', teamId, runs: 5, note: note.value.trim() });
      if (res.ok) { toast('+5 penalty runs'); closeSheet(); }
    } }, 'Award +5'));
}

function openRetireSheet(ctx) {
  const state = ctx.state;
  const inn = liveInn(state);
  if (!inn) return;
  let who = 'striker';
  let kind = 'hurt';
  const opts = [];
  if (inn.striker) opts.push({ value: 'striker', label: playerName(state, inn.striker) });
  if (inn.nonStriker) opts.push({ value: 'nonstriker', label: playerName(state, inn.nonStriker) });
  who = opts.length ? opts[0].value : 'striker';
  const s = openSheet('retire', { title: 'Retire batter' });
  s.body.append(
    field('Batter', segmented(opts, who, (v) => { who = v; })),
    field('How', segmented([{ value: 'hurt', label: 'Retired hurt' }, { value: 'out', label: 'Retired out' }], kind, (v) => { kind = v; })),
    h('button', { class: 'btn danger', onclick: async () => {
      const res = await ctx.send({ type: 'RETIREMENT', who, kind });
      if (res.ok) { closeSheet(); ctx.render(); ctx.watchNeeds(); }
    } }, 'Retire'));
}

function openReviseSheet(ctx) {
  const state = ctx.state;
  const target = h('input', { type: 'number', inputmode: 'numeric', min: '1', class: 'num-input', placeholder: '—', value: state.target ? state.target.runs : '' });
  const overs = h('input', { type: 'number', inputmode: 'numeric', min: '1', class: 'num-input', placeholder: '—' });
  const note = h('input', { type: 'text', placeholder: 'e.g. DLS after rain' });
  const s = openSheet('revise', { title: 'Revise target / overs' });
  add(s.body,
    h('div', { class: 'row' },
      field('New target', target),
      field('Overs limit', overs)),
    field('Note', note),
    h('button', { class: 'btn primary', onclick: async () => {
      const ev = { type: 'TARGET_REVISED', note: note.value.trim() };
      if (target.value) ev.target = parseInt(target.value, 10);
      if (overs.value) ev.oversLimit = parseInt(overs.value, 10);
      if (ev.target === undefined && ev.oversLimit === undefined) { toast('Enter a target or an overs limit', 'warn'); return; }
      const res = await ctx.send(ev);
      if (res.ok) { toast('Revision applied'); closeSheet(); }
    } }, 'Apply revision'),
    state.target && state.target.revised
      ? h('button', { class: 'btn ghost', onclick: async () => {
        const res = await ctx.send({ type: 'TARGET_REVISED', clear: true, note: 'revision cleared' });
        if (res.ok) { toast('Revised target cleared'); closeSheet(); }
      } }, 'Clear revised target') : null);
}

export function openAddPlayerSheet(ctx, presetTeam = null) {
  const state = ctx.state;
  let teamId = presetTeam || 'A';
  const name = h('input', { type: 'text', placeholder: 'Player name', autocapitalize: 'words' });
  const s = openSheet('addPlayer', { title: 'Add player' });
  s.body.append(
    field('Team', segmented(state.config.teams.map((t) => ({ value: t.id, label: t.name })), teamId, (v) => { teamId = v; })),
    field('Name', name),
    h('button', { class: 'btn primary', onclick: async () => {
      const n = name.value.trim();
      if (!n) { toast('Enter a name', 'warn'); return; }
      // next free id: max numeric suffix + 1 (length+1 can collide after
      // offline-queued adds or edits removed a player event)
      const maxN = ctx.state.squads[teamId]
        .reduce((m, p) => Math.max(m, parseInt(String(p.id).slice(1), 10) || 0), 0);
      const playerId = `${teamId}${maxN + 1}`;
      const res = await ctx.send({ type: 'PLAYER_ADDED', teamId, playerId, name: n });
      if (res.ok) { toast(`${n} added`); closeSheet(); ctx.watchNeeds(); }
    } }, 'Add player'));
  setTimeout(() => name.focus(), 260);
}

function openEditTeamsSheet(ctx) {
  const state = ctx.state;
  const rows = state.config.teams.map((t) => ({
    name: h('input', { type: 'text', value: t.name }),
    short: h('input', { type: 'text', value: t.short, maxlength: '4', class: 'short-input' }),
    color: h('input', { type: 'color', value: t.color, class: 'color-input' }),
  }));
  const s = openSheet('editTeams', { title: 'Edit teams' });
  s.body.append(
    ...state.config.teams.map((t, i) => h('div', { class: 'card team-card' },
      h('div', { class: 'card-title' }, `Team ${t.id}`),
      field('Name', rows[i].name),
      h('div', { class: 'row' }, field('Short', rows[i].short), field('Color', rows[i].color)))),
    h('button', { class: 'btn primary', onclick: async () => {
      const patch = { teams: rows.map((r) => ({ name: r.name.value.trim(), short: r.short.value.trim(), color: r.color.value })) };
      const res = await ctx.send({ type: 'CONFIG_UPDATED', patch });
      if (res.ok) { toast('Teams updated'); closeSheet(); }
    } }, 'Save'));
}

async function openLinksSheet(ctx) {
  let base = location.origin;
  try {
    const info = await (await fetch('/api/info')).json();
    if (info.urls && info.urls[0]) base = info.urls[0];
  } catch { /* offline — origin is fine */ }
  const id = ctx.matchId;
  const links = [
    ['Console', `${base}/console/${id}`],
    ['Director', `${base}/director/${id}`],
    ['Live score', `${base}/live/${id}`],
    ['Scorebug', `${base}/overlay/scorebug?match=${id}`],
    ['Full frame', `${base}/overlay/full?match=${id}`],
    ['Batting', `${base}/overlay/batting?match=${id}`],
    ['Bowling', `${base}/overlay/bowling?match=${id}`],
    ['Summary', `${base}/overlay/summary?match=${id}`],
    ['Line-ups', `${base}/overlay/lineups?match=${id}`],
    ['Target', `${base}/overlay/target?match=${id}`],
  ];
  const s = openSheet('links', { title: 'Links' });
  s.body.append(
    h('p', { class: 'muted small', style: { margin: '0' } }, 'Overlay URLs go into OBS as 1920×1080 Browser Sources.'),
    ...links.map(([name, url]) => h('div', { class: 'link-row' },
      h('span', { class: 'link-name' }, name),
      h('span', { class: 'link-url num' }, url),
      h('button', { class: 'btn', onclick: () => copyText(url) }, 'Copy'))));
}

export function openAnomaliesSheet(ctx) {
  const s = openSheet('anomalies', { title: 'Scoring anomalies' });
  s.body.append(
    h('p', { class: 'muted small', style: { margin: '0' } }, 'These usually follow an edit of an earlier ball. Review the ball log and fix the odd delivery.'),
    ...ctx.state.anomalies.map((a) => h('p', { class: 'warn-line' }, a)));
}

// ---------------------------------------------------------------------------
// Edit a past ball — mini-pad prefilled from the event log
// ---------------------------------------------------------------------------

export async function openEditBallSheet(ctx, seq) {
  let events;
  try { ({ events } = await ctx.app.fetchEvents()); } catch { toast('Could not load the event log', 'danger'); return; }
  const ev = events[seq];
  if (!ev || ev.type !== 'BALL') { toast('Only deliveries can be edited', 'warn'); return; }

  let legality = ev.legality || 'legal';
  let batRuns = ev.batRuns || 0;
  let extraType = ev.extraType || null;
  let extraRuns = ev.extraRuns || 0;
  let keepWicket = !!ev.wicket;
  const s = openSheet('editBall', { title: `Edit delivery · event ${seq}` });

  const draw = () => {
    s.body.textContent = '';
    add(s.body,
      field('Delivery', segmented(
        [{ value: 'legal', label: 'Legal' }, { value: 'wide', label: 'Wide' }, { value: 'noball', label: 'No-ball' }],
        legality, (v) => {
          legality = v;
          if (legality === 'wide') { batRuns = 0; extraType = null; }
          draw();
        })),
      legality !== 'wide' ? field('Runs off the bat', segmented(
        [0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })),
        batRuns, (v) => { batRuns = v; if (v > 0 && legality === 'legal') { extraType = null; extraRuns = 0; } draw(); })) : null,
      legality !== 'wide' ? field('Extras type', segmented(
        [{ value: null, label: 'None' }, { value: 'bye', label: 'Byes' }, { value: 'legbye', label: 'Leg byes' }],
        extraType, (v) => { extraType = v; if (v && legality === 'legal') batRuns = 0; if (!v && legality !== 'noball') extraRuns = 0; draw(); })) : null,
      (legality === 'wide' || legality === 'noball' || extraType) ? field(
        legality === 'wide' ? 'Runs completed (besides the wide penalty)' : 'Extra runs',
        segmented([0, 1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })), extraRuns, (v) => { extraRuns = v; })) : null,
      ev.wicket ? toggleRow(`Keep wicket (${KIND_LABELS[ev.wicket.kind] || ev.wicket.kind})`,
        'Turn off to make this delivery not-out', keepWicket, (v) => { keepWicket = v; }) : null,
      h('button', { class: 'btn primary', onclick: async () => {
        const next = { ...ev, legality, batRuns, extraRuns };
        if (extraType && legality !== 'wide') next.extraType = extraType; else delete next.extraType;
        if (!keepWicket) delete next.wicket;
        const res = await ctx.app.edit(seq, next);
        if (!res.ok) { toast((res.errors || ['edit failed']).join(' · '), 'danger'); return; }
        closeSheet();
        if (res.anomalies && res.anomalies.length) {
          toast(`Edited — ${res.anomalies.length} anomal${res.anomalies.length === 1 ? 'y' : 'ies'} flagged`, 'warn');
        } else toast('Delivery updated');
      } }, 'Save changes'));
  };
  draw();
}
