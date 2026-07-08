/**
 * Card overlays — centred full-frame panels for OBS: batting, bowling,
 * summary, lineups, target. Each page calls bootCard('<name>'); the shared
 * frame (team strip, brand head, branded foot) and all renderers live here.
 */
import { connect, fitStage, fmt, h, focusInnings, teamOf, applyBranding } from '/client/shared/app.js';

const FALLBACK = '#8a93a3';
const ORD = ['1st', '2nd', '3rd', '4th'];

const surname = (n) => String(n || '').trim().split(' ').pop();
const scoreText = (inn) => (inn.wickets >= inn.maxWickets ? String(inn.runs) : `${inn.runs}/${inn.wickets}`);
const inningsLabel = (inn) => (inn.superOver ? 'Super over' : `${ORD[inn.index] || `${inn.index + 1}th`} innings`);
const fowText = (inn) => inn.fow
  .map((f) => `${f.runs}-${f.wicket} (${surname(f.batterName)}, ${f.overs})`).join(',  ');

function extrasParts(x) {
  return [['wd', x.wides], ['nb', x.noballs], ['b', x.byes], ['lb', x.legbyes], ['pen', x.penalties]]
    .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Shared frame
// ---------------------------------------------------------------------------

function mountFrame(stage, name) {
  const r = {};
  r.strip = h('div', { class: 'ocard-strip' });
  r.brandLogo = h('img', { class: 'ocard-brand-logo', alt: '' });
  r.brandName = h('span', { class: 'ocard-brand-name' }, 'ICAT');
  r.brand = h('div', { class: 'ocard-brand' }, r.brandLogo, r.brandName);
  r.kicker = h('div', { class: 'ocard-kicker up' });
  r.title = h('div', { class: 'ocard-title up' });
  r.headright = h('div', { class: 'ocard-headright num' });
  r.body = h('div', { class: 'ocard-body' });
  r.footText = h('div', { class: 'ocard-foot-text' });
  r.sponsors = h('div', { class: 'ocard-sponsors' });
  r.card = h('div', { class: `ocard panel ${name}-card` },
    r.strip,
    h('div', { class: 'ocard-head' }, r.brand, h('div', { class: 'ocard-titles' }, r.kicker, r.title), r.headright),
    r.body,
    h('div', { class: 'ocard-foot' }, r.footText, r.sponsors));
  r.wrap = h('div', { class: 'cwrap fade hidden' }, r.card);
  stage.appendChild(r.wrap);
  return r;
}

function setBranding(r, b) {
  if (!b) return;
  applyBranding(b);
  if (b.logo) {
    r.brandLogo.src = b.logo;
    r.brand.classList.add('has-logo');
  } else {
    r.brand.classList.remove('has-logo');
    r.brandName.textContent = b.orgName || 'ICAT';
  }
  r.footText.textContent = b.footer || '';
  r.sponsors.textContent = '';
  for (const s of (b.sponsors || []).filter((x) => x && x.logo).slice(0, 3)) {
    r.sponsors.appendChild(h('span', { class: 'ocard-sponsor' }, h('img', { src: s.logo, alt: s.name || '' })));
  }
}

function headScore(r, big, sub) {
  r.headright.textContent = '';
  if (big) r.headright.appendChild(h('div', { class: 'big' }, big));
  if (sub) r.headright.appendChild(h('div', { class: 'sub up' }, sub));
}

const cols = (widths) => h('colgroup', {}, widths.map((w) => h('col', w ? { style: { width: `${w}px` } } : {})));
const th = (label, right) => h('th', { class: right ? 'r' : null }, label);
const td = (cls, ...kids) => h('td', { class: cls }, ...kids);

// ---------------------------------------------------------------------------
// Renderers — each fills the frame from `state` and returns true when the
// card has something worth showing.
// ---------------------------------------------------------------------------

function renderBatting(r, state) {
  const inn = focusInnings(state);
  if (!inn) return false;
  const team = teamOf(state, inn.battingTeamId) || {};
  const opp = teamOf(state, inn.bowlingTeamId) || {};
  r.card.style.setProperty('--team', team.color || FALLBACK);
  r.kicker.textContent = `Batting · ${inningsLabel(inn)} · v ${opp.name || ''}`;
  r.title.textContent = team.name || '';
  headScore(r, scoreText(inn), `${inn.oversText} ov`);

  const live = state.phase === 'live' && !inn.closed;
  const table = h('table', { class: 'otable num' },
    cols([52, 380, 0, 92, 92, 84, 84, 120]),
    h('tr', {}, th(''), th('Batter'), th(''), th('R', 1), th('B', 1), th('4s', 1), th('6s', 1), th('SR', 1)),
    [...inn.batters].sort((a, b) => a.order - b.order).map((b) => h('tr', {},
      td('bt-ord', String(b.order)),
      td('bt-name', live && b.id === inn.striker ? h('span', { class: 'odot' }) : null, b.name),
      td('bt-out', b.howOut || ''),
      td('r bt-runs', String(b.runs)),
      td('r', String(b.balls)),
      td('r', String(b.fours)),
      td('r', String(b.sixes)),
      td('r', b.balls > 0 && b.sr != null ? b.sr.toFixed(1) : '—'))));
  r.body.appendChild(table);

  const ytb = (state.squads[inn.battingTeamId] || []).filter((p) => !inn.batters.some((b) => b.id === p.id));
  if (ytb.length) {
    r.body.appendChild(h('div', { class: 'bat-ytb' },
      h('span', { class: 'lab up' }, 'Yet to bat'), ytb.map((p) => p.name).join(', ')));
  }

  const ex = extrasParts(inn.extras);
  r.body.appendChild(h('div', { class: 'bat-extras num' },
    'Extras ', h('b', {}, String(inn.extras.total)), ex ? ` (${ex})` : ''));

  r.body.appendChild(h('div', { class: 'bat-total num' },
    h('span', { class: 'bat-total-label up' }, 'Total'),
    h('span', { class: 'bat-total-score' }, scoreText(inn)),
    h('span', { class: 'bat-total-overs' }, `(${inn.oversText} ov)`),
    h('span', { class: 'bat-total-crr up' }, 'CRR ', h('b', {}, fmt.num1(inn.crr)))));
  return true;
}

function renderBowling(r, state) {
  const inn = focusInnings(state);
  if (!inn || !inn.bowlers.length) return false;
  const team = teamOf(state, inn.bowlingTeamId) || {};
  const bat = teamOf(state, inn.battingTeamId) || {};
  r.card.style.setProperty('--team', team.color || FALLBACK);
  r.kicker.textContent = `Bowling · ${inningsLabel(inn)}`;
  r.title.textContent = team.name || '';
  headScore(r, scoreText(inn), `${bat.short || bat.name || ''} · ${inn.oversText} ov`);

  const live = state.phase === 'live' && !inn.closed;
  const table = h('table', { class: 'otable num' },
    cols([0, 96, 80, 96, 80, 116, 100, 84, 84]),
    h('tr', {}, th('Bowler'), th('O', 1), th('M', 1), th('R', 1), th('W', 1),
      th('Econ', 1), th('Dots', 1), th('Wd', 1), th('Nb', 1)),
    inn.bowlers.map((b) => h('tr', {},
      td('bw-name', live && b.id === inn.currentBowlerId ? h('span', { class: 'odot' }) : null, b.name),
      td('r', b.oversText),
      td('r', String(b.maidens)),
      td('r', String(b.runs)),
      td('r bw-w', String(b.wickets)),
      td('r', fmt.num1(b.econ)),
      td('r bw-dim', String(b.dots)),
      td('r bw-dim', String(b.wides)),
      td('r bw-dim', String(b.noballs)))));
  r.body.appendChild(table);

  if (inn.fow.length) {
    r.body.appendChild(h('div', { class: 'bowl-fow num' },
      h('span', { class: 'lab up' }, 'Fall of wickets'), fowText(inn)));
  }
  return true;
}

/** Axis-free runs-per-over manhattan: white bars, dim maidens, red wicket dots. */
function overChartSvg(inn) {
  const overs = inn.overByOver;
  const slots = Math.max(inn.oversLimit || overs.length, overs.length, 1);
  const W = 1492;
  const H = 200;
  const TOP = 30; // headroom for wicket dots
  const BARW = 24;
  const slotW = W / slots;
  const maxR = Math.max(10, ...overs.map((o) => o.runs));
  const parts = [];
  for (let i = 0; i < overs.length; i++) {
    const o = overs[i];
    const x = i * slotW + (slotW - BARW) / 2;
    const bh = Math.max(4, ((o.runs || 0) / maxR) * (H - TOP));
    const y = H - bh;
    const fill = o.maiden || !o.runs ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.85)';
    // rounded data-end, square at the baseline
    parts.push(`<path d="M${x} ${H} V${y + 4} Q${x} ${y} ${x + 4} ${y} H${x + BARW - 4} Q${x + BARW} ${y} ${x + BARW} ${y + 4} V${H} Z" fill="${fill}"/>`);
    for (let k = 0; k < Math.min(o.wickets || 0, 3); k++) {
      const cy = Math.max(9, y - 13 - k * 19);
      parts.push(`<circle cx="${x + BARW / 2}" cy="${cy}" r="7" fill="#e01e37" stroke="rgba(8,12,20,0.9)" stroke-width="2"/>`);
    }
  }
  parts.push(`<line x1="0" y1="${H + 0.5}" x2="${W}" y2="${H + 0.5}" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>`);
  return `<svg viewBox="0 0 ${W} ${H + 1}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Runs per over">${parts.join('')}</svg>`;
}

function renderSummary(r, state) {
  const inn = focusInnings(state);
  if (!inn) return false;
  const team = teamOf(state, inn.battingTeamId) || {};
  r.card.style.setProperty('--team', team.color || FALLBACK);
  r.kicker.textContent = `Innings summary · ${inningsLabel(inn)}`;
  r.title.textContent = team.name || '';
  headScore(r, scoreText(inn), `${inn.oversText} ov`);

  if (state.phase === 'complete' && state.result) {
    r.body.appendChild(h('div', { class: 'sum-result up' }, state.result.text));
  }

  const bats = [...inn.batters].sort((a, b) => b.runs - a.runs || a.balls - b.balls).slice(0, 3);
  const bowls = [...inn.bowlers].sort((a, b) => b.wickets - a.wickets || a.runs - b.runs).slice(0, 3);
  const batRow = (b) => h('div', { class: 'sum-row num' },
    h('span', { class: 'nm' }, b.name),
    h('span', { class: 'fig' }, `${b.runs}${!b.out && !b.retiredHurt ? '*' : ''} `, h('span', {}, `(${b.balls})`)));
  const bowlRow = (b) => h('div', { class: 'sum-row num' },
    h('span', { class: 'nm' }, b.name),
    h('span', { class: 'fig' }, `${b.wickets}-${b.runs} `, h('span', {}, `(${b.oversText})`)));
  r.body.appendChild(h('div', { class: 'sum-cols' },
    h('div', {}, h('div', { class: 'sum-col-h up' }, 'Top batters'), bats.map(batRow)),
    h('div', {}, h('div', { class: 'sum-col-h up' }, 'Top bowlers'), bowls.map(bowlRow))));

  const ex = extrasParts(inn.extras);
  const meta = h('div', { class: 'sum-meta num' },
    h('div', {}, h('span', { class: 'lab up' }, 'Extras'), `${inn.extras.total}${ex ? ` (${ex})` : ''}`));
  if (inn.fow.length) meta.appendChild(h('div', {}, h('span', { class: 'lab up' }, 'Fall of wickets'), fowText(inn)));
  r.body.appendChild(meta);

  if (inn.overByOver.length) {
    const chart = h('div', { class: 'sum-chart' },
      h('div', { class: 'sum-chart-head up' }, 'Runs per over',
        h('span', { class: 'sum-chart-key' }, h('span', { class: 'kdot' }), 'Wicket')));
    const holder = h('div');
    holder.innerHTML = overChartSvg(inn);
    chart.appendChild(holder.firstChild);
    r.body.appendChild(chart);
  }
  return true;
}

function renderLineups(r, state) {
  const teams = state.config.teams || [];
  if (teams.length < 2) return false;
  const [a, b] = teams;
  r.card.style.setProperty('--team', a.color || FALLBACK);
  r.card.style.setProperty('--team2', b.color || FALLBACK);
  r.strip.classList.add('duo');
  r.kicker.textContent = `Line-ups${state.config.venue ? ` · ${state.config.venue}` : ''}`;
  r.title.textContent = state.config.name || `${a.name} v ${b.name}`;
  const opi = state.config.oversPerInnings;
  const mob = state.config.maxOversPerBowler;
  headScore(r, opi ? `${opi} overs` : 'Unlimited', mob ? `max ${mob} per bowler` : null);

  const column = (t) => {
    const squad = state.squads[t.id] || t.players || [];
    return h('div', { style: { '--team': t.color || FALLBACK } },
      h('div', { class: 'lu-team' },
        h('span', { class: 'lu-chip' }),
        h('span', { class: 'lu-short up' }, t.short || ''),
        h('span', { class: 'lu-full' }, t.name || '')),
      squad.map((p, i) => h('div', { class: 'lu-p' },
        h('span', { class: 'lu-n num' }, String(i + 1)),
        h('span', { class: 'lu-nm' }, p.name))));
  };
  r.body.appendChild(h('div', { class: 'lu-cols' }, column(a), column(b)));

  const toss = state.config.toss;
  if (toss && toss.winner) {
    const w = teamOf(state, toss.winner) || {};
    r.body.appendChild(h('div', { class: 'lu-toss' },
      h('span', { class: 'lab' }, 'Toss'),
      `${w.name || toss.winner} won the toss and chose to ${toss.decision || 'bat'}`));
  }
  return true;
}

function renderTarget(r, state) {
  const inns = state.innings || [];
  const last = inns[inns.length - 1];
  const chase = state.chase;
  const atBreak = state.phase === 'break' && last && last.closed;
  if (!chase && !atBreak) return false; // no chase yet — stay off air

  const stat = (lab, val) => h('div', { class: 'tg-stat' },
    h('div', { class: 'lab up' }, lab), h('div', { class: 'val num' }, val));

  if (chase) {
    const inn = focusInnings(state);
    const team = teamOf(state, inn.battingTeamId) || {};
    r.card.style.setProperty('--team', team.color || FALLBACK);
    r.kicker.textContent = `Run chase · ${inningsLabel(inn)}`;
    r.title.textContent = team.name || '';
    headScore(r, null, null);
    r.body.appendChild(h('div', { class: 'tg-label up' }, 'Target'));
    r.body.appendChild(h('div', { class: 'tg-num' }, String(chase.target)));
    r.body.appendChild(h('div', { class: 'tg-stats' },
      stat('Need', String(chase.need)),
      stat('Balls', String(chase.ballsLeft)),
      stat('RRR', fmt.num1(chase.rrr))));
    r.body.appendChild(h('div', { class: 'tg-score num' },
      h('b', {}, `${team.short || team.name || ''} ${scoreText(inn)}`),
      ` (${inn.oversText} ov) · CRR ${fmt.num1(inn.crr)}`));
    const pct = Math.max(0, Math.min(100, (inn.runs / chase.target) * 100));
    r.body.appendChild(h('div', { class: 'tg-bar' },
      h('div', { class: 'tg-bar-fill', style: { width: `${pct}%` } })));
    return true;
  }

  // innings break: the chase is set but not under way yet
  const target = state.target ? state.target.runs : last.runs + 1;
  const chaser = teamOf(state, last.bowlingTeamId) || {};
  const limit = inns.length >= 2 ? 1 : (state.config.oversPerInnings || last.oversLimit);
  r.card.style.setProperty('--team', chaser.color || FALLBACK);
  r.kicker.textContent = 'Run chase · innings break';
  r.title.textContent = chaser.name || '';
  headScore(r, null, null);
  r.body.appendChild(h('div', { class: 'tg-label up' }, 'Target'));
  r.body.appendChild(h('div', { class: 'tg-num' }, String(target)));
  if (limit) {
    r.body.appendChild(h('div', { class: 'tg-chaseline up num' },
      `${chaser.short || chaser.name || ''} need ${target} from ${limit} over${limit === 1 ? '' : 's'}`));
    r.body.appendChild(h('div', { class: 'tg-stats duo' },
      stat('Balls', String(limit * 6)),
      stat('Req. rate', fmt.num1(target / limit))));
  }
  return true;
}

const RENDERERS = {
  batting: renderBatting,
  bowling: renderBowling,
  summary: renderSummary,
  lineups: renderLineups,
  target: renderTarget,
};

// ---------------------------------------------------------------------------
// Page boot
// ---------------------------------------------------------------------------

const ROTATABLE = ['batting', 'bowling', 'summary', 'lineups', 'target'];

/**
 * Card carousel (auto-rotation). During natural pauses the info cards take
 * turns on screen, cycling every `rotate.seconds` until play resumes:
 *   over break    -> batting -> bowling -> summary (target instead, in a chase)
 *   innings break -> summary -> batting -> bowling -> target/lineups
 *   pre-match     -> lineups
 * Every card page computes the same schedule from the shared wall clock, so
 * separate OBS browser sources stay in lockstep with no extra coordination.
 * A manually switched-on card pauses the carousel (the director wins), and
 * the moment the next ball is bowled every rotated card hides itself.
 */
function rotationTurn(state, pres) {
  const rot = pres && pres.rotate;
  if (!rot || !rot.enabled || !pres.auto || !state || !state.config) return null;
  if (ROTATABLE.some((k) => pres.show && pres.show[k])) return null; // manual override
  const inn = state.innings.length ? state.innings[state.innings.length - 1] : null;

  let list = null;
  if (state.phase === 'setup') list = ['lineups'];
  else if (state.phase === 'break') list = ['summary', 'batting', 'bowling', state.target ? 'target' : 'lineups'];
  else if (state.phase === 'live' && inn && inn.legalBalls > 0 && inn.thisOver.length === 0) {
    // between overs: from the 6th legal ball until the first ball of the next over
    list = state.chase ? ['batting', 'bowling', 'target'] : ['batting', 'bowling', 'summary'];
  }
  if (!list) return null;
  const ms = Math.max(4, rot.seconds || 8) * 1000;
  return list[Math.floor(Date.now() / ms) % list.length];
}

export async function bootCard(name) {
  fitStage();
  const render = RENDERERS[name];
  const ui = mountFrame(document.getElementById('stage'), name);
  let state = null;
  let pres = null;

  function update() {
    let has = false;
    if (state) {
      ui.body.textContent = '';
      has = !!render(ui, state);
    }
    let show = !!(pres && pres.show && pres.show[name]);
    // sensible-auto: the summary surfaces itself at full time
    if (name === 'summary' && pres && pres.auto && state && state.phase === 'complete') show = true;
    // carousel turn (over/innings breaks, pre-match)
    if (!show && rotationTurn(state, pres) === name) show = true;
    ui.wrap.classList.toggle('hidden', !(has && show));
  }

  // the carousel advances on the wall clock, not on state changes
  setInterval(() => { if (pres && pres.rotate && pres.rotate.enabled) update(); }, 300);

  return connect({
    matchId: new URLSearchParams(location.search).get('match'),
    role: 'view',
    onState(s) { state = s; update(); },
    onPresentation(p) {
      pres = p;
      document.body.classList.toggle('chroma', p.theme === 'chroma');
      update();
    },
    onBranding(b) { setBranding(ui, b); },
  });
}
