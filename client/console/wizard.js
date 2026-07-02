/**
 * Console entry screens: home (resume / new match), the setup wizard, and the
 * one-time PINs screen after match creation.
 */

import { $, h } from '/client/shared/app.js';
import { themeToggle, toast, copyText, segmented, field, toggleRow } from '/client/console/ui.js';

const getJson = (url) => fetch(url).then((r) => r.json());

function chrome(title) {
  const hdr = $('#hdr');
  hdr.textContent = '';
  hdr.append(h('div', { class: 'hdr-top' },
    h('span', { class: 'hdr-brand' }, title),
    h('span', { class: 'hdr-right' }, themeToggle())));
  $('#dock').textContent = '';
  const main = $('#main');
  main.textContent = '';
  return main;
}

const phaseLabel = { setup: 'Not started', live: 'LIVE', break: 'Innings break', complete: 'Finished' };

function scoreLine(m) {
  if (!m.innings || !m.innings.length) return phaseLabel[m.phase] || m.phase;
  const bits = m.innings.map((i) => {
    const t = m.teams.find((x) => x.id === i.battingTeamId);
    return `${t ? t.short : i.battingTeamId} ${i.runs}/${i.wickets} (${i.overs})`;
  });
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export async function renderHome() {
  const main = chrome('ICAT Cricket Live');
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-title' }, 'Scoring console'),
    h('div', { class: 'page-sub' }, 'Run the match from your phone — overlays follow live.'));
  main.append(page);

  let info = {};
  let matches = [];
  try { [info, matches] = await Promise.all([getJson('/api/info'), getJson('/api/matches')]); }
  catch { /* server unreachable — still offer New match */ }

  const active = matches.find((m) => m.id === info.activeMatchId && m.phase !== 'complete');
  if (active) {
    page.append(h('div', { class: 'card home-card' },
      h('div', { class: 'card-title' }, 'Active match', h('span', { class: 'pill live right' }, phaseLabel[active.phase] || active.phase)),
      h('div', { class: 'home-vs' },
        h('span', { class: 'team-dot', style: { background: active.teams[0].color } }), active.teams[0].name,
        h('span', { class: 'muted' }, 'v'),
        h('span', { class: 'team-dot', style: { background: active.teams[1].color } }), active.teams[1].name),
      h('div', { class: 'home-score' }, scoreLine(active)),
      h('a', { class: 'btn primary', href: `/console/${active.id}` }, 'Resume scoring')));
  }

  page.append(h('button', {
    class: `btn ${active ? '' : 'primary'}`, style: { width: '100%', marginBottom: '16px' },
    onclick: () => { history.pushState({}, '', '/console?new=1'); renderWizard(); },
  }, 'New match'));

  const others = matches.filter((m) => !active || m.id !== active.id).slice(0, 6);
  if (others.length) {
    page.append(h('div', { class: 'card-title' }, 'Recent matches'));
    for (const m of others) {
      page.append(h('a', { class: 'match-row', href: `/console/${m.id}` },
        h('span', {}, `${m.teams[0].short} v ${m.teams[1].short}`),
        h('span', { class: 'tag' }, phaseLabel[m.phase] || m.phase),
        h('span', { class: 'mr-score' }, scoreLine(m))));
    }
  }
  if (!active && !others.length) {
    page.append(h('p', { class: 'center-note' }, 'No matches on this server yet — set one up above.'));
  }
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

const autoShort = (name) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
const lines = (text) => text.split('\n').map((x) => x.trim()).filter(Boolean);

export function renderWizard() {
  const cfg = {
    name: '', venue: '',
    teams: [
      { name: '', short: '', color: '#1d4ed8', playersText: '', shortTouched: false },
      { name: '', short: '', color: '#b91c1c', playersText: '', shortTouched: false },
    ],
    overs: 20, maxOvers: 4, maxTouched: false,
    toss: { winner: 'A', decision: 'bat' },
    rules: { freeHit: true, lastManStands: false, noLbw: false, wideRuns: 1, noBallRuns: 1, superOver: false, jokerAllowed: false },
  };
  let step = 0;

  const draw = () => {
    const main = chrome('New match');
    const page = h('div', { class: 'page' });
    main.append(page);
    page.append(h('div', { class: 'wiz-steps' },
      [0, 1, 2].map((i) => h('span', { class: `wiz-step${i <= step ? ' done' : ''}` }))));
    if (step === 0) stepTeams(page);
    else if (step === 1) stepFormat(page);
    else stepRules(page);
    main.scrollTop = 0;
  };

  const nav = (backFn, nextLabel, nextFn) => h('div', { class: 'wiz-nav' },
    h('button', { class: 'btn', onclick: backFn }, 'Back'),
    h('button', { class: 'btn primary', onclick: nextFn }, nextLabel));

  // Step 1 — teams, squads, colors
  const stepTeams = (page) => {
    page.append(h('div', { class: 'wiz-title' }, 'Teams & squads'));
    cfg.teams.forEach((t, i) => {
      const nameIn = h('input', { type: 'text', class: 'grow', placeholder: i === 0 ? 'e.g. ICAT Blue' : 'e.g. ICAT Gold', value: t.name, autocapitalize: 'words' });
      const shortIn = h('input', { type: 'text', class: 'short-input', maxlength: '4', placeholder: i === 0 ? 'BLU' : 'GLD', value: t.short });
      const colorIn = h('input', { type: 'color', class: 'color-input', value: t.color });
      const squadIn = h('textarea', { placeholder: 'One player per line (at least 2)' }, t.playersText);
      nameIn.addEventListener('input', () => {
        t.name = nameIn.value;
        if (!t.shortTouched) { t.short = autoShort(t.name); shortIn.value = t.short; }
      });
      shortIn.addEventListener('input', () => { t.shortTouched = true; t.short = shortIn.value.toUpperCase(); shortIn.value = t.short; });
      colorIn.addEventListener('input', () => { t.color = colorIn.value; });
      squadIn.addEventListener('input', () => { t.playersText = squadIn.value; });
      page.append(h('div', { class: 'card team-card' },
        h('div', { class: 'card-title' }, `Team ${'AB'[i]}`),
        h('div', { class: 'tc-head' }, field('Name', nameIn), field('Short', shortIn), field('Color', colorIn)),
        field('Squad', squadIn)));
    });
    page.append(nav(() => { location.href = '/console'; }, 'Next: format', () => {
      for (const [i, t] of cfg.teams.entries()) {
        if (!t.name.trim()) { toast(`Team ${'AB'[i]} needs a name`, 'warn'); return; }
        if (lines(t.playersText).length < 2) { toast(`${t.name.trim() || `Team ${'AB'[i]}`} needs at least 2 players`, 'warn'); return; }
      }
      step = 1; draw();
    }));
  };

  // Step 2 — format
  const stepFormat = (page) => {
    page.append(h('div', { class: 'wiz-title' }, 'Format'));
    const maxIn = h('input', { type: 'number', class: 'num-input', inputmode: 'numeric', min: '1', value: cfg.maxOvers });
    const oversIn = h('input', { type: 'number', class: 'num-input', inputmode: 'numeric', min: '1', max: '100', value: cfg.overs });
    const setOvers = (n) => {
      cfg.overs = n;
      oversIn.value = n;
      if (!cfg.maxTouched) { cfg.maxOvers = Math.ceil(n / 5); maxIn.value = cfg.maxOvers; }
      drawChips();
    };
    const chips = h('div', { class: 'chip-row' });
    const presets = [['T20', 20], ['T10', 10], ['8 overs', 8], ['6 overs', 6]];
    const drawChips = () => {
      chips.textContent = '';
      for (const [label, n] of presets) {
        chips.append(h('button', { class: `chip${cfg.overs === n ? ' on' : ''}`, onclick: () => setOvers(n) }, label));
      }
    };
    drawChips();
    oversIn.addEventListener('input', () => { const n = parseInt(oversIn.value, 10); if (n >= 1) setOvers(n); });
    maxIn.addEventListener('input', () => { cfg.maxTouched = true; cfg.maxOvers = parseInt(maxIn.value, 10) || cfg.maxOvers; });
    page.append(h('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      field('Overs per innings', h('div', { class: 'col' }, chips, h('div', { class: 'row' }, oversIn, h('span', { class: 'muted small' }, 'custom overs')))),
      field('Max overs per bowler', h('div', { class: 'row' }, maxIn, h('span', { class: 'muted small' }, 'auto = overs ÷ 5, rounded up')))));
    page.append(nav(() => { step = 0; draw(); }, 'Next: toss & rules', () => { step = 2; draw(); }));
  };

  // Step 3 — toss + rules → create
  const stepRules = (page) => {
    page.append(h('div', { class: 'wiz-title' }, 'Toss & rules'));
    const tName = (id) => cfg.teams[id === 'A' ? 0 : 1].name.trim() || `Team ${id}`;
    const nameIn = h('input', { type: 'text', placeholder: 'e.g. Sunday League — Round 3', value: cfg.name });
    const venueIn = h('input', { type: 'text', placeholder: 'e.g. USF Riverfront Park', value: cfg.venue });
    nameIn.addEventListener('input', () => { cfg.name = nameIn.value; });
    venueIn.addEventListener('input', () => { cfg.venue = venueIn.value; });
    page.append(
      h('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '12px' } },
        field('Toss won by', segmented([{ value: 'A', label: tName('A') }, { value: 'B', label: tName('B') }], cfg.toss.winner, (v) => { cfg.toss.winner = v; })),
        field('Elected to', segmented([{ value: 'bat', label: 'Bat' }, { value: 'bowl', label: 'Bowl' }], cfg.toss.decision, (v) => { cfg.toss.decision = v; }))),
      h('div', { class: 'card', style: { marginBottom: '12px' } },
        toggleRow('Free hit after no-ball', 'ICC-style free hit delivery', cfg.rules.freeHit, (v) => { cfg.rules.freeHit = v; }),
        toggleRow('Last man stands', 'Final batter bats on alone', cfg.rules.lastManStands, (v) => { cfg.rules.lastManStands = v; }),
        toggleRow('No LBW', 'LBW dismissals disabled', cfg.rules.noLbw, (v) => { cfg.rules.noLbw = v; }),
        toggleRow('Super over on tie', 'One-over eliminator if scores level', cfg.rules.superOver, (v) => { cfg.rules.superOver = v; }),
        toggleRow('Joker allowed', 'Cosmetic — shown on line-ups only', cfg.rules.jokerAllowed, (v) => { cfg.rules.jokerAllowed = v; }),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          field('Wide value', segmented([{ value: 1, label: '1' }, { value: 2, label: '2' }], cfg.rules.wideRuns, (v) => { cfg.rules.wideRuns = v; })),
          field('No-ball value', segmented([{ value: 1, label: '1' }, { value: 2, label: '2' }], cfg.rules.noBallRuns, (v) => { cfg.rules.noBallRuns = v; })))),
      h('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        field('Match name (optional)', nameIn),
        field('Venue (optional)', venueIn)));
    const createBtn = h('button', { class: 'btn primary', onclick: () => create(createBtn) }, 'Create match');
    page.append(h('div', { class: 'wiz-nav' }, h('button', { class: 'btn', onclick: () => { step = 1; draw(); } }, 'Back'), createBtn));
  };

  const create = async (btn) => {
    btn.disabled = true;
    const config = {
      name: cfg.name.trim(), venue: cfg.venue.trim(),
      teams: cfg.teams.map((t) => ({ name: t.name.trim(), short: t.short.trim(), color: t.color, players: lines(t.playersText) })),
      oversPerInnings: cfg.overs,
      maxOversPerBowler: cfg.maxOvers,
      superOver: cfg.rules.superOver,
      toss: { winner: cfg.toss.winner, decision: cfg.toss.decision },
      rules: cfg.rules,
    };
    try {
      const res = await fetch('/api/matches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
      });
      const out = await res.json();
      if (!res.ok || !out.id) throw new Error(out.error || 'server rejected the match');
      localStorage.setItem(`icat-pin-${out.id}`, out.scorerPin);
      renderPins(out);
    } catch (e) {
      toast(`Could not create the match: ${e.message}`, 'danger');
      btn.disabled = false;
    }
  };

  draw();
}

// ---------------------------------------------------------------------------
// PINs screen — shown exactly once after creation
// ---------------------------------------------------------------------------

async function renderPins({ id, scorerPin, directorPin }) {
  const main = chrome('Match created');
  let base = location.origin;
  try {
    const info = await getJson('/api/info');
    if (info.urls && info.urls[0]) base = info.urls[0];
  } catch { /* keep origin */ }
  const consoleUrl = `${base}/console/${id}`;

  main.append(h('div', { class: 'page pin-screen' },
    h('div', { class: 'page-title' }, 'Match created'),
    h('div', { class: 'pin-note' }, 'Write these PINs down — they are shown only once.'),
    h('div', { class: 'pin-grid' },
      h('div', { class: 'card pin-card' },
        h('span', { class: 'pin-label' }, 'Scorer PIN'),
        h('span', { class: 'pin-value' }, scorerPin),
        h('button', { class: 'btn', onclick: () => copyText(scorerPin) }, 'Copy')),
      h('div', { class: 'card pin-card' },
        h('span', { class: 'pin-label' }, 'Director PIN'),
        h('span', { class: 'pin-value' }, directorPin),
        h('button', { class: 'btn', onclick: () => copyText(directorPin) }, 'Copy'))),
    h('div', { class: 'qr-card' },
      h('img', { src: `/qr.svg?text=${encodeURIComponent(consoleUrl)}`, alt: 'QR code for the scoring console' })),
    h('p', { class: 'muted small' }, 'Scan on the scoring phone — it opens this console.'),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn ghost', onclick: () => copyText(consoleUrl) }, 'Copy console link'),
      h('a', { class: 'btn primary', href: `/console/${id}` }, 'Start scoring'))));
}
