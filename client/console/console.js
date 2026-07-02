/**
 * Scoring console — the scorer's surface. Routes:
 *   /console            → home (resume / new match)
 *   /console?new=1      → setup wizard
 *   /console/:matchId   → join as scorer and score
 *
 * Everything re-renders from app.state on every onState (never merged).
 */

import { connect, fmt, $, h, teamOf, playerName } from '/client/shared/app.js';
import {
  initTheme, themeToggle, toast, openSheet, closeSheet, sheetKind, confirmSheet,
  liveInn, openOpenersSheet, openBowlerSheet, openNewBatterSheet, openWicketSheet,
  openMoreSheet, openAnomaliesSheet, openEditBallSheet,
} from '/client/console/ui.js';
import { renderHome, renderWizard } from '/client/console/wizard.js';

initTheme();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const hdr = $('#hdr');
const main = $('#main');
const dock = $('#dock');

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const path = location.pathname.replace(/\/+$/, '');
const matchRoute = path.match(/^\/console\/([^/]+)$/);
if (matchRoute) startMatch(decodeURIComponent(matchRoute[1]));
else if (new URLSearchParams(location.search).get('new') === '1') renderWizard();
else renderHome();

// ---------------------------------------------------------------------------
// Scorer session
// ---------------------------------------------------------------------------

async function startMatch(matchId) {
  const pinKey = `icat-pin-${matchId}`;
  const ui = { padMode: 'main', staged: null, shortNext: false, pendingEnd: null, logOpen: false, status: 'connecting', queued: 0, revoked: false };
  let app = null;
  let state = null;

  const readOnly = () => !app || app.role !== 'scorer';

  // --- send with error toasts + warning→force confirmation -----------------
  async function send(event) {
    if (readOnly()) { toast('Read-only — take scoring back first', 'warn'); return { ok: false, readOnly: true }; }
    let res = await app.send(event);
    if (!res.ok && res.needsForce) {
      const go = await confirmSheet({ title: 'Scoring warning', lines: res.warnings || [], confirmLabel: 'Override', tone: 'danger' });
      if (!go) return { ok: false, cancelled: true };
      res = await app.send(event, { force: true });
    }
    if (res.ok && res.queued) toast('Offline — saved to the queue', 'warn');
    else if (!res.ok && res.errors) toast(res.errors.join(' · '), 'danger');
    return res;
  }

  async function sendBall(ball) {
    const ev = { type: 'BALL', ...ball };
    if (ui.shortNext && ((ev.batRuns | 0) > 0 || (ev.extraRuns | 0) > 0)) {
      ev.short = true;
      ui.shortNext = false;
    }
    const res = await send(ev);
    if (res.ok) { ui.padMode = 'main'; ui.staged = null; renderDock(); }
    return res;
  }

  async function doUndo() {
    if (readOnly() || !app.online) return;
    const res = await app.undo();
    if (res.ok) toast(`Undid: ${res.undone ? res.undone.type.replace(/_/g, ' ').toLowerCase() : 'last event'}`);
    else toast((res.errors || ['nothing to undo']).join(' · '), 'warn');
  }

  const ctx = {
    matchId, ui,
    get app() { return app; },
    get state() { return state; },
    send, sendBall,
    render, watchNeeds,
  };

  // --- needs-driven sheets --------------------------------------------------
  function watchNeeds() {
    if (!state || readOnly()) return;
    const kind = sheetKind();
    const needKinds = ['newBatter', 'bowler', 'openers'];
    if (state.phase === 'complete') { if (needKinds.includes(kind)) closeSheet(); return; }
    if (state.needs.newBatter) { if (!kind) openNewBatterSheet(ctx); return; }
    if (state.needs.bowler) { if (!kind) openBowlerSheet(ctx); return; }
    if (state.needs.openers) { if (!kind) openOpenersSheet(ctx); return; }
    if (needKinds.includes(kind)) closeSheet(); // satisfied elsewhere (e.g. another device)
  }

  // --- join -----------------------------------------------------------------
  let pin = localStorage.getItem(pinKey);
  if (!pin) pin = await promptPin(matchId, null);
  localStorage.setItem(pinKey, pin);
  renderConnecting();

  app = await connect({
    matchId, role: 'scorer', pin, follow: false,
    onState(st) { state = st; render(); watchNeeds(); },
    onStatus(s) { handleStatus(s); },
    onQueue(n) { ui.queued = n; renderHeader(); renderDock(); },
    onQueueDrop(ev, errs) { toast(`Dropped queued ${ev.type}: ${(errs || []).join(', ')}`, 'danger'); },
  });

  async function handleStatus(s) {
    const prev = ui.status;
    ui.status = s;
    if (s === 'bad-pin') {
      localStorage.removeItem(pinKey);
      const fresh = await promptPin(matchId, 'That PIN is not right — try again.');
      localStorage.setItem(pinKey, fresh);
      renderConnecting();
      app.rejoin({ pin: fresh });
      return;
    }
    if (s === 'scorer-active') { renderTakeover(); return; }
    if (s === 'no-match') { renderNoMatch(); return; }
    if (s === 'revoked') { ui.revoked = true; render(); return; }
    if (s === 'online' && !readOnly()) ui.revoked = false;
    if (s === 'online' || prev === 'online') render();
    else { renderHeader(); renderDock(); }
  }

  function renderConnecting() {
    hdr.textContent = '';
    dock.textContent = '';
    main.textContent = '';
    main.append(h('p', { class: 'center-note' }, 'Connecting…'));
  }

  function promptPin(id, errMsg) {
    return new Promise((resolve) => {
      hdr.textContent = '';
      hdr.append(h('div', { class: 'hdr-top' }, h('span', { class: 'hdr-brand' }, 'ICAT Cricket Live'), h('span', { class: 'hdr-right' }, themeToggle())));
      dock.textContent = '';
      main.textContent = '';
      const input = h('input', { class: 'pin-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'one-time-code', maxlength: '8', placeholder: '····' });
      const go = () => { const v = input.value.trim(); if (v) resolve(v); else input.focus(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      const card = h('div', { class: 'card pin-card', style: { maxWidth: '360px', margin: '0 auto' } },
        h('span', { class: 'pin-label' }, 'Scorer PIN'),
        input,
        errMsg ? h('span', { class: 'warn-line', style: { fontSize: '13.5px' } }, errMsg) : null,
        h('button', { class: 'btn primary', style: { width: '100%' }, onclick: go }, 'Join as scorer'));
      const title = h('div', { class: 'page-sub', style: { textAlign: 'center' } }, `Match ${id}`);
      main.append(h('div', { class: 'page pin-screen' }, h('div', { class: 'page-title' }, 'Enter the scorer PIN'), title, card));
      // best effort: show who is playing
      fetch(`/api/matches/${id}`).then((r) => r.json()).then((d) => {
        if (d.state && d.state.config) title.textContent = d.state.config.teams.map((t) => t.name).join(' v ');
      }).catch(() => {});
      setTimeout(() => input.focus(), 100);
    });
  }

  function renderTakeover() {
    dock.textContent = '';
    main.textContent = '';
    main.append(h('div', { class: 'page pin-screen' },
      h('div', { class: 'page-title' }, 'Someone is already scoring'),
      h('p', { class: 'page-sub' }, 'Another device holds the scorer lock for this match.'),
      h('div', { class: 'result-actions' },
        h('button', { class: 'btn danger', onclick: () => { renderConnecting(); app.rejoin({ takeover: true }); } }, 'Take over scoring'),
        h('a', { class: 'btn ghost', href: '/console' }, 'Back'))));
  }

  function renderNoMatch() {
    dock.textContent = '';
    main.textContent = '';
    main.append(h('div', { class: 'page pin-screen' },
      h('div', { class: 'page-title' }, 'Match not found'),
      h('p', { class: 'page-sub' }, `No match “${matchId}” on this server.`),
      h('div', { class: 'result-actions' }, h('a', { class: 'btn primary', href: '/console' }, 'Back to matches'))));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() { renderHeader(); renderMain(); renderDock(); }

  function connDot() {
    const cls = ui.status === 'online' || ui.status === 'revoked' ? 'online'
      : ui.status === 'offline' ? 'offline' : '';
    return h('span', { class: `conn ${cls}`, title: ui.status });
  }

  function renderHeader() {
    if (!state || !state.config) return;
    hdr.textContent = '';
    const inn = state.innings.length ? state.innings[state.innings.length - 1] : null;
    const top = h('div', { class: 'hdr-top' }, connDot());

    if (inn) {
      const bat = teamOf(state, inn.battingTeamId);
      top.append(h('div', { class: 'hdr-score' },
        h('span', { class: 'score-big' }, `${bat.short} ${inn.runs}/${inn.wickets}`),
        h('span', { class: 'score-ovr' }, `${inn.oversText} / ${inn.oversLimit} ov`),
        state.phase === 'live' ? h('span', { class: 'score-crr' }, `CRR ${fmt.num1(inn.crr)}`) : null));
    } else {
      top.append(h('div', { class: 'hdr-score' },
        h('span', { class: 'score-big', style: { fontSize: '20px' } }, state.config.teams.map((t) => t.short).join(' v '))));
    }

    const right = h('span', { class: 'hdr-right' });
    if (ui.queued > 0) right.append(h('span', { class: 'queue-badge', title: 'events queued offline' }, String(ui.queued)));
    if (state.freeHitPending) right.append(h('span', { class: 'fh-badge' }, 'FREE HIT'));
    right.append(themeToggle());
    top.append(right);
    hdr.append(top);

    const sub = [];
    if (state.chase && state.phase === 'live') {
      sub.push(`Target ${state.chase.target} · Need ${state.chase.need} off ${state.chase.ballsLeft} · RRR ${fmt.num1(state.chase.rrr)}`);
    } else if (state.phase === 'break') sub.push('Innings break');
    else if (state.phase === 'setup') sub.push(matchLabel());
    else if (state.phase === 'complete' && state.result) sub.push(state.result.text);
    else if (inn && state.innings.length === 1) sub.push(`1st innings · ${matchLabel()}`);
    if (sub.length) hdr.append(h('div', { class: 'hdr-sub' }, sub.join(' · ')));
  }

  function matchLabel() {
    const c = state.config;
    return [c.name, `${c.oversPerInnings} overs`, c.venue].filter(Boolean).join(' · ');
  }

  function renderMain() {
    if (!state || !state.config) return;
    main.textContent = '';
    const wrap = h('div', {});
    main.append(wrap);

    if (ui.revoked || (ui.status === 'online' && readOnly())) {
      wrap.append(h('button', { class: 'banner danger', onclick: () => { renderConnecting(); app.rejoin({ takeover: true }); } },
        'Another device took over scoring — you are read-only.', h('span', { class: 'b-act' }, 'Take back')));
    }
    if (state.anomalies.length) {
      wrap.append(h('button', { class: 'banner warn', onclick: () => openAnomaliesSheet(ctx) },
        `${state.anomalies.length} scoring anomal${state.anomalies.length === 1 ? 'y' : 'ies'} flagged`, h('span', { class: 'b-act' }, 'View')));
    }

    if (state.phase === 'complete') { renderResult(wrap); return; }
    if (state.phase === 'setup') { renderSetup(wrap); return; }
    if (state.phase === 'break') { renderBreak(wrap); return; }

    // live
    const inn = liveInn(state);
    if (!inn) return;
    if (!readOnly()) {
      if (state.needs.newBatter) wrap.append(needBanner('New batter needed', 'Choose', () => openNewBatterSheet(ctx)));
      else if (state.needs.bowler) wrap.append(needBanner('Next bowler needed', 'Choose', () => openBowlerSheet(ctx)));
    }
    wrap.append(battersCard(inn), bowlerCard(inn), logSection());
  }

  function needBanner(text, act, onclick) {
    return h('button', { class: 'banner info', onclick }, text, h('span', { class: 'b-act' }, act));
  }

  function batRow(inn, pid, onStrike) {
    if (!pid) {
      return h('div', { class: 'bat-row' },
        h('span', { class: 'strike-dot off' }),
        h('span', { class: 'bat-name waiting' }, 'waiting for batter…'));
    }
    const b = inn.batters.find((x) => x.id === pid) || { name: playerName(state, pid), runs: 0, balls: 0, sr: 0 };
    return h('div', { class: 'bat-row' },
      h('span', { class: `strike-dot${onStrike ? '' : ' off'}` }),
      h('span', { class: 'bat-name' }, b.name),
      onStrike && inn.solo ? h('span', { class: 'tag warn' }, 'last man stands') : null,
      h('span', { class: 'bat-sr' }, `SR ${fmt.num1(b.sr)}`),
      h('span', { class: 'bat-score' }, fmt.batLine(b)));
  }

  function battersCard(inn) {
    const stand = inn.currentPartnership;
    return h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Batting',
        h('span', { class: 'right muted' }, `Extras ${inn.extras.total}`)),
      batRow(inn, inn.striker, true),
      inn.solo ? null : batRow(inn, inn.nonStriker, false),
      stand && (stand.balls > 0 || stand.runs > 0)
        ? h('div', { class: 'pship' }, `Partnership ${stand.runs}(${stand.balls})`) : null);
  }

  function tokenChip(t) {
    const cls = t.indexOf('W') >= 0 ? ' wkt' : (t === '4' || t === '6' ? ' bdry' : '');
    return h('span', { class: `tok${cls}` }, t);
  }

  function bowlerCard(inn) {
    const b = inn.bowlers.find((x) => x.id === inn.currentBowlerId);
    const tokens = inn.thisOver.length ? inn.thisOver : inn.lastOver;
    const label = inn.thisOver.length ? 'This over' : 'Last over';
    const rules = (state && state.config && state.config.rules) || { wideRuns: 1, noBallRuns: 1 };
    const runs = tokens.reduce((s, t) => {
      const m = t.match(/\d+/); // runs shown inside the token (wd+2, nb+4, b2, plain digits)
      return s + (t === '4' || t === '6' ? parseInt(t, 10) : m ? parseInt(m[0], 10) : 0)
        + ((t === 'wd' || t.indexOf('wd+') === 0) ? rules.wideRuns : 0)
        + ((t === 'nb' || t.indexOf('nb+') === 0) ? rules.noBallRuns : 0);
    }, 0);
    return h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Bowling'),
      b ? h('div', { class: 'bowl-row' },
        h('span', { class: 'bat-name' }, b.name),
        h('span', { class: 'bowl-econ' }, `econ ${fmt.num1(b.econ)}`),
        h('span', { class: 'bowl-figs' }, fmt.figures(b)))
        : h('div', { class: 'bat-name waiting' }, 'waiting for bowler…'),
      tokens.length ? h('div', { class: 'ov-strip' },
        h('span', { class: 'ov-label' }, label),
        tokens.map(tokenChip),
        h('span', { class: 'tok sum' }, `= ${runs}`)) : null);
  }

  // --- ball log + edit ------------------------------------------------------
  function logSection() {
    const all = state.feed.filter((f) => f.seq !== null && f.seq !== undefined);
    const items = all.slice(-60).reverse();
    const head = h('button', { class: `log-head${ui.logOpen ? ' open' : ''}`, onclick: () => { ui.logOpen = !ui.logOpen; renderMain(); } },
      `Ball log (${all.length})`, h('span', { class: 'chev' }, '▾'));
    const box = h('div', { class: 'card', style: { padding: '0 12px' } }, head);
    if (ui.logOpen) {
      const list = h('div', { class: 'log-list', style: { margin: '0 -12px' } });
      for (const f of items) {
        list.append(h('button', {
          class: `log-row k-${f.kind}`,
          onclick: () => { if (readOnly()) toast('Read-only', 'warn'); else openEditBallSheet(ctx, f.seq); },
        },
          h('span', { class: 'log-ov' }, f.ov || '—'),
          h('span', { class: 'log-text' }, f.text)));
      }
      if (!items.length) list.append(h('p', { class: 'center-note' }, 'No deliveries yet.'));
      box.append(list);
    }
    return box;
  }

  // --- setup / break / result ----------------------------------------------
  function renderSetup(wrap) {
    const c = state.config;
    const toss = c.toss ? `${teamOf(state, c.toss.winner).name} won the toss and chose to ${c.toss.decision}` : 'No toss recorded';
    wrap.append(h('div', { class: 'card home-card' },
      h('div', { class: 'card-title' }, 'Ready to start'),
      h('div', { class: 'home-vs' },
        h('span', { class: 'team-dot', style: { background: c.teams[0].color } }), c.teams[0].name,
        h('span', { class: 'muted' }, 'v'),
        h('span', { class: 'team-dot', style: { background: c.teams[1].color } }), c.teams[1].name),
      h('div', { class: 'home-score' }, `${c.oversPerInnings} overs a side · max ${c.maxOversPerBowler} per bowler`),
      h('div', { class: 'home-score' }, toss),
      readOnly() ? null : h('button', { class: 'btn primary', onclick: () => openOpenersSheet(ctx) }, 'Start innings')));
  }

  function inningsSummaryCard(inn, title) {
    const t = teamOf(state, inn.battingTeamId);
    const topBats = [...inn.batters].sort((a, b2) => b2.runs - a.runs).slice(0, 2).filter((b2) => b2.balls > 0 || b2.runs > 0);
    const topBowls = [...inn.bowlers].sort((a, b2) => b2.wickets - a.wickets || a.runs - b2.runs).slice(0, 2);
    return h('div', { class: 'card' },
      h('div', { class: 'card-title' }, title,
        h('span', { class: 'right' }, `Extras ${inn.extras.total}`)),
      h('div', { class: 'summary-line' },
        h('span', { class: 'team-dot', style: { background: t.color } }),
        h('span', { class: 'sl-name', style: { fontSize: '18px' } }, t.name),
        h('span', { class: 'sl-val', style: { fontSize: '20px' } }, `${inn.runs}/${inn.wickets}`),
        h('span', { class: 'sl-sub' }, `${inn.oversText} ov`)),
      ...topBats.map((b) => h('div', { class: 'summary-line' },
        h('span', { class: 'sl-name' }, b.name), h('span', { class: 'sl-sub' }, b.howOut), h('span', { class: 'sl-val' }, fmt.batLine(b)))),
      ...topBowls.map((b) => h('div', { class: 'summary-line' },
        h('span', { class: 'sl-name' }, b.name), h('span', { class: 'sl-val' }, fmt.figures(b)))));
  }

  function renderBreak(wrap) {
    const last = state.innings[state.innings.length - 1];
    if (last) {
      const label = last.superOver ? 'Super over' : `${['1st', '2nd'][Math.min(last.index, 1)]} innings`;
      wrap.append(inningsSummaryCard(last, label));
    }
    if (state.target) {
      wrap.append(h('div', { class: 'banner info static' },
        `Target ${state.target.runs}${state.target.revised ? ' (revised)' : ''} to win`));
    }
    if (!readOnly()) {
      wrap.append(h('button', { class: 'btn primary', style: { width: '100%' }, onclick: () => openOpenersSheet(ctx) },
        state.innings.length >= 2 ? 'Start super over innings' : 'Start second innings'));
    }
  }

  function renderResult(wrap) {
    const r = state.result;
    wrap.append(h('div', { class: 'card result-card' },
      h('div', { class: 'result-kicker' }, 'Result'),
      h('div', { class: 'result-text' }, r ? r.text : 'Match complete'),
      h('div', { class: 'result-lines' }, state.innings.map((i) => {
        const t = teamOf(state, i.battingTeamId);
        return `${t.short} ${i.runs}/${i.wickets} (${i.oversText})${i.superOver ? ' SO' : ''}`;
      }).join(' · ')),
      h('div', { class: 'result-actions' },
        state.superOverAvailable && !readOnly()
          ? h('button', { class: 'btn accent', onclick: () => openOpenersSheet(ctx) }, 'Start super over') : null,
        h('a', { class: 'btn primary', href: `/live/${matchId}` }, 'View scorecard'),
        h('a', { class: 'btn', href: '/console?new=1' }, 'New match'),
        h('a', { class: 'btn ghost', href: `/api/matches/${matchId}/export`, download: true }, 'Export match JSON'))));
    wrap.append(...state.innings.map((i) => inningsSummaryCard(i, i.superOver ? 'Super over' : `${['1st', '2nd'][Math.min(i.index, 1)]} innings`)));
    wrap.append(logSection());
  }

  // -------------------------------------------------------------------------
  // Dock — undo + primary pad / inline choosers
  // -------------------------------------------------------------------------

  function padBtn(label, cls, onclick, { staged = false, disabled = false } = {}) {
    return h('button', {
      class: `pad-btn${cls ? ` ${cls}` : ''}${staged ? ' staged' : ''}`,
      disabled, onclick,
    }, label);
  }

  function renderDock() {
    if (!state || !state.config) return;
    dock.textContent = '';
    if (state.phase === 'complete') return;

    const inn = liveInn(state);
    const canBall = !readOnly() && state.phase === 'live' && inn
      && !state.needs.newBatter && inn.striker && inn.currentBowlerId;

    if (ui.shortNext) {
      dock.append(h('div', { class: 'dock-note' }, 'Next runs will be scored “one short”',
        h('button', { class: 'btn ghost', style: { minHeight: '36px' }, onclick: () => { ui.shortNext = false; renderDock(); } }, 'Cancel')));
    }

    dock.append(h('div', { class: 'undo-row' },
      h('button', {
        class: 'undo-btn', disabled: readOnly() || !app || !app.online, onclick: doUndo,
      }, 'UNDO LAST')));

    if (ui.padMode !== 'main') { dock.append(chooser(canBall)); return; }

    const off = { disabled: !canBall }; // More stays live in every phase
    const pad = h('div', { class: 'pad' },
      padBtn('0', '', () => sendBall({ legality: 'legal', batRuns: 0 }), off),
      padBtn('1', '', () => sendBall({ legality: 'legal', batRuns: 1 }), off),
      padBtn('2', '', () => sendBall({ legality: 'legal', batRuns: 2 }), off),
      padBtn('3', '', () => sendBall({ legality: 'legal', batRuns: 3 }), off),
      padBtn('4', 'bdry', () => sendBall({ legality: 'legal', batRuns: 4 }), off),
      padBtn('6', 'bdry', () => sendBall({ legality: 'legal', batRuns: 6 }), off),
      padBtn('Wd', 'extra', () => { ui.padMode = 'wd'; ui.staged = null; renderDock(); }, off),
      padBtn('Nb', 'extra', () => { ui.padMode = 'nb'; ui.staged = null; renderDock(); }, off),
      padBtn('Bye', 'extra', () => { ui.padMode = 'bye'; ui.staged = null; renderDock(); }, off),
      padBtn('Lb', 'extra', () => { ui.padMode = 'lb'; ui.staged = null; renderDock(); }, off),
      padBtn('WICKET', 'wicket', () => openWicketSheet(ctx, 'legal'), off),
      padBtn('More', 'more', () => openMoreSheet(ctx), { disabled: readOnly() }));
    dock.append(pad);
    dock.append(h('div', { class: 'kbd-hint' },
      h('kbd', {}, '0–6'), ' runs · ', h('kbd', {}, 'W'), ' wide · ', h('kbd', {}, 'N'), ' no-ball · ',
      h('kbd', {}, 'B'), ' bye · ', h('kbd', {}, 'L'), ' leg-bye · ', h('kbd', {}, 'X'), ' wicket · ',
      h('kbd', {}, 'Ctrl+Z'), ' undo'));
  }

  const CHOOSERS = {
    wd: { title: 'Wide', sub: (st) => `penalty +${st.config.rules.wideRuns} · pick runs completed as well` },
    nb: { title: 'No-ball', sub: (st) => `penalty +${st.config.rules.noBallRuns} · pick runs off the bat, or byes` },
    bye: { title: 'Byes', sub: () => 'runs past the keeper, no bat involved' },
    lb: { title: 'Leg byes', sub: () => 'runs off the body' },
  };

  function chooser(canBall) {
    const mode = ui.padMode;
    const meta = CHOOSERS[mode];
    const back = () => { ui.padMode = 'main'; ui.staged = null; renderDock(); };
    const wrap = h('div', { class: 'chooser' },
      h('div', { class: 'chooser-head' },
        h('span', { class: 'chooser-title' }, meta.title),
        h('span', { class: 'chooser-sub' }, meta.sub(state)),
        h('button', { class: 'sheet-x x', 'aria-label': 'Cancel', onclick: back }, '×')));
    const pad = h('div', { class: `pad${canBall ? '' : ' dim'}` });

    if (mode === 'wd') {
      for (const n of [0, 1, 2, 3, 4]) {
        pad.append(padBtn(n === 0 ? 'Wd' : `+${n}`, 'extra', () => sendBall({ legality: 'wide', batRuns: 0, extraRuns: n }), { staged: ui.staged === n }));
      }
      pad.append(padBtn('Wicket on wide', 'wicket full', () => { ui.padMode = 'main'; openWicketSheet(ctx, 'wide'); }));
    } else if (mode === 'nb') {
      for (const n of [0, 1, 2, 4, 6]) {
        pad.append(padBtn(n === 0 ? 'Nb' : `+${n}`, n === 4 || n === 6 ? 'bdry' : 'extra',
          () => sendBall({ legality: 'noball', batRuns: n, extraRuns: 0 }), { staged: ui.staged === n }));
      }
      pad.append(
        padBtn('Bye 1', 'extra', () => sendBall({ legality: 'noball', batRuns: 0, extraType: 'bye', extraRuns: 1 })),
        padBtn('Bye 2', 'extra', () => sendBall({ legality: 'noball', batRuns: 0, extraType: 'bye', extraRuns: 2 })),
        padBtn('Wicket', 'wicket span3', () => { ui.padMode = 'main'; openWicketSheet(ctx, 'noball'); }));
    } else {
      const type = mode === 'bye' ? 'bye' : 'legbye';
      for (const n of [1, 2, 3, 4]) {
        pad.append(padBtn(String(n), 'extra', () => sendBall({ legality: 'legal', batRuns: 0, extraType: type, extraRuns: n }), { staged: ui.staged === n }));
      }
    }
    wrap.append(pad);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Keyboard (desktop)
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (!state || state.phase !== 'live' || readOnly()) return;
    if (sheetKind()) return; // sheets own the keyboard while open
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const digits = { wd: [0, 1, 2, 3, 4], nb: [0, 1, 2, 4, 6], bye: [1, 2, 3, 4], lb: [1, 2, 3, 4] };

    if (ui.padMode === 'main') {
      if (/^[0-6]$/.test(k)) { sendBall({ legality: 'legal', batRuns: +k }); return; }
      if (k === 'w') { ui.padMode = 'wd'; ui.staged = null; renderDock(); return; }
      if (k === 'n') { ui.padMode = 'nb'; ui.staged = null; renderDock(); return; }
      if (k === 'b') { ui.padMode = 'bye'; ui.staged = null; renderDock(); return; }
      if (k === 'l') { ui.padMode = 'lb'; ui.staged = null; renderDock(); return; }
      if (k === 'x') { openWicketSheet(ctx, 'legal'); return; }
      return;
    }
    // chooser modes: digits stage, Enter sends, Escape cancels
    if (e.key === 'Escape') { ui.padMode = 'main'; ui.staged = null; renderDock(); return; }
    if (/^[0-9]$/.test(k) && digits[ui.padMode].indexOf(+k) >= 0) { ui.staged = +k; renderDock(); return; }
    if (e.key === 'Enter') {
      const n = ui.staged;
      if (ui.padMode === 'wd') sendBall({ legality: 'wide', batRuns: 0, extraRuns: n || 0 });
      else if (ui.padMode === 'nb') sendBall({ legality: 'noball', batRuns: n || 0, extraRuns: 0 });
      else if (n) sendBall({ legality: 'legal', batRuns: 0, extraType: ui.padMode === 'bye' ? 'bye' : 'legbye', extraRuns: n });
    }
  });
}
