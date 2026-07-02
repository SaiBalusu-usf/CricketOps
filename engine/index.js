/**
 * ICAT Cricket Live — scoring engine.
 *
 * Pure, framework-free, dependency-free, isomorphic (Node + browser).
 *
 * The entire match is an append-only event log. events[0] is MATCH_CREATED
 * (which carries the match config); every later event describes one scorer
 * or director action. Match state is reduce(events) — a pure fold — so undo
 * is "drop the last event" and edit is "replace an event and re-fold".
 *
 * Laws references (MCC 2017 code / ICC playing conditions) are noted where
 * behaviour is subtle.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'MATCH_CREATED',   // { config }
  'CONFIG_UPDATED',  // { patch } shallow patch of names/shorts/colors/rules/maxOversPerBowler
  'PLAYER_ADDED',    // { teamId, playerId, name }
  'INNINGS_START',   // { battingTeamId, striker, nonStriker }
  'BOWLER_CHANGE',   // { bowler }
  'BALL',            // see applyBall()
  'NEW_BATTER',      // { batter, end: 'striker'|'nonstriker' } end = position for the NEXT delivery
  'RETIREMENT',      // { who: 'striker'|'nonstriker', kind: 'hurt'|'out', note? }
  'PENALTY',         // { teamId, runs, note }
  'TARGET_REVISED',  // { oversLimit?, target?, note }
  'INNINGS_DECLARED',// { note? } manually close the current innings
];

export const DISMISSAL_KINDS = [
  'bowled', 'caught', 'lbw', 'runout', 'stumped', 'hitwicket',
  'timedout', 'obstructing', 'hittwice',
];

// Dismissals credited to the bowler (Law 30–39; run out / obstructing /
// timed out / hit twice are not credited).
export const BOWLER_CREDITED = new Set(['bowled', 'caught', 'lbw', 'stumped', 'hitwicket']);

// ICC 21.19.4: on a free hit — even one called wide — only these apply.
const ALLOWED_ON_FREE_HIT = new Set(['runout', 'obstructing', 'hittwice']);
// Law 21 / 25: dismissals possible off a no-ball.
const ALLOWED_ON_NO_BALL = ALLOWED_ON_FREE_HIT;
// Law 22: dismissals possible off a wide (no free hit in force).
const ALLOWED_ON_WIDE = new Set(['runout', 'stumped', 'hitwicket', 'obstructing']);

const FIELDER_KINDS = new Set(['caught', 'runout', 'stumped', 'obstructing']);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let uidCounter = 0;
/** Collision-safe id for events created in one process. Callers may supply their own. */
export function makeId(prefix = 'e') {
  uidCounter += 1;
  return `${prefix}${uidCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize raw setup-form input into the canonical config object.
 * Teams get stable ids 'A' and 'B'; players get ids 'A1'.. / 'B1'..
 */
export function normalizeConfig(input = {}) {
  const mkTeam = (raw = {}, id) => {
    const names = Array.isArray(raw.players)
      ? raw.players.map((p) => (typeof p === 'string' ? p : p.name)).filter((n) => n && n.trim())
      : [];
    return {
      id,
      name: (raw.name || (id === 'A' ? 'Team A' : 'Team B')).trim(),
      short: (raw.short || (raw.name || id).replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || id).toUpperCase().slice(0, 4),
      color: raw.color || (id === 'A' ? '#1d4ed8' : '#b91c1c'),
      players: names.map((name, i) => ({ id: `${id}${i + 1}`, name: name.trim() })),
    };
  };
  const overs = clampInt(input.oversPerInnings, 1, 100, 20);
  return {
    name: (input.name || '').trim(),
    venue: (input.venue || '').trim(),
    teams: [mkTeam(input.teams?.[0], 'A'), mkTeam(input.teams?.[1], 'B')],
    oversPerInnings: overs,
    maxOversPerBowler: clampInt(input.maxOversPerBowler, 1, 100, Math.ceil(overs / 5)),
    superOver: !!input.superOver,
    toss: input.toss && input.toss.winner
      ? { winner: input.toss.winner === 'B' ? 'B' : 'A', decision: input.toss.decision === 'bowl' ? 'bowl' : 'bat' }
      : null,
    rules: {
      lastManStands: !!input.rules?.lastManStands,
      noLbw: !!input.rules?.noLbw,
      freeHit: input.rules?.freeHit !== false, // default ON
      wideRuns: clampInt(input.rules?.wideRuns, 1, 2, 1),
      noBallRuns: clampInt(input.rules?.noBallRuns, 1, 2, 1),
      jokerAllowed: !!input.rules?.jokerAllowed, // cosmetic only
    },
  };
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export function matchCreatedEvent(config, id = makeId(), ts = 0) {
  return { id, ts, type: 'MATCH_CREATED', config: normalizeConfig(config) };
}

// ---------------------------------------------------------------------------
// Small formatting helpers (shared by all UIs)
// ---------------------------------------------------------------------------

export function oversText(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

export function strikeRate(runs, balls) {
  return balls > 0 ? Math.round((runs / balls) * 1000) / 10 : 0;
}

export function economy(runs, balls) {
  return balls > 0 ? Math.round((runs / (balls / 6)) * 100) / 100 : 0;
}

/** Compact token for the this-over strip, e.g. '•', '4', 'wd+2', 'nb+6', 'b2', '1W'. */
export function ballToken(ev) {
  const runs = (ev.batRuns || 0) + (ev.extraRuns || 0);
  let base;
  if (ev.legality === 'wide') base = runs > 0 ? `wd+${runs}` : 'wd';
  else if (ev.legality === 'noball') base = runs > 0 ? `nb+${runs}` : 'nb';
  else if (ev.extraType === 'bye') base = `b${ev.extraRuns || 0}`;
  else if (ev.extraType === 'legbye') base = `lb${ev.extraRuns || 0}`;
  else base = ev.batRuns > 0 ? String(ev.batRuns) : '•';
  if (ev.wicket) return ev.legality === 'legal' && !ev.extraType && !(ev.batRuns > 0) ? 'W' : `${base}W`;
  return base;
}

/** Scorecard dismissal text, e.g. 'c Smith b Kumar', 'run out (Smith)'. */
export function dismissalText(out, nameOf) {
  if (!out) return 'not out';
  const f = (i) => nameOf(out.fielders?.[i]) || '?';
  const b = () => nameOf(out.bowlerId) || '?';
  switch (out.kind) {
    case 'bowled': return `b ${b()}`;
    case 'caught':
      return out.fielders?.[0] && out.fielders[0] === out.bowlerId
        ? `c & b ${b()}`
        : `c ${f(0)} b ${b()}`;
    case 'lbw': return `lbw b ${b()}`;
    case 'runout': return out.fielders?.length ? `run out (${out.fielders.map((x) => nameOf(x)).join('/')})` : 'run out';
    case 'stumped': return `st ${f(0)} b ${b()}`;
    case 'hitwicket': return `hit wicket b ${b()}`;
    case 'retired-out': return 'retired out';
    case 'retired-hurt': return 'retired hurt';
    case 'timedout': return 'timed out';
    case 'obstructing': return 'obstructing the field';
    case 'hittwice': return 'hit the ball twice';
    default: return out.kind;
  }
}

// ---------------------------------------------------------------------------
// Reduce — the fold
// ---------------------------------------------------------------------------

function newInnings(index, battingTeamId, bowlingTeamId, oversLimit, maxWickets, superOver) {
  return {
    index,
    battingTeamId,
    bowlingTeamId,
    superOver,
    oversLimit,
    maxWickets,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    extras: { wides: 0, noballs: 0, byes: 0, legbyes: 0, penalties: 0, total: 0 },
    batters: [],       // stat rows in batting order
    bowlers: [],       // stat rows in bowling order
    fow: [],
    partnerships: [],  // completed stands; current stand is `currentStand`
    overByOver: [],    // completed overs {over, runs, wickets, bowlerId, maiden}
    thisOver: [],      // tokens of the in-progress over
    lastOver: [],      // tokens of the most recrecently completed over
    striker: null,
    nonStriker: null,
    solo: false,       // last-man-stands: single batter remaining
    currentBowlerId: null,
    lastOverBowlerId: null,
    closed: false,
    closeReason: null,
    // fold-internal (kept on the object; harmless in JSON)
    currentStand: null,
    curOver: null,
  };
}

function batterRow(inn, playerId, nameOf) {
  let row = inn.batters.find((b) => b.id === playerId);
  if (!row) {
    row = {
      id: playerId, name: nameOf(playerId), order: inn.batters.length + 1,
      runs: 0, balls: 0, fours: 0, sixes: 0,
      out: null, retiredHurt: false, resumed: false, atCrease: false,
    };
    inn.batters.push(row);
  }
  return row;
}

function bowlerRow(inn, playerId, nameOf) {
  let row = inn.bowlers.find((b) => b.id === playerId);
  if (!row) {
    row = {
      id: playerId, name: nameOf(playerId),
      balls: 0, runs: 0, wickets: 0, maidens: 0, dots: 0, wides: 0, noballs: 0,
      hatChain: 0, // consecutive deliveries with a credited wicket
    };
    inn.bowlers.push(row);
  }
  return row;
}

function startOver(inn, bowlerId) {
  inn.curOver = {
    number: Math.floor(inn.legalBalls / 6) + 1,
    bowlers: [bowlerId],
    conceded: 0,   // runs charged to the bowler this over (maiden test)
    teamRuns: 0,
    wickets: 0,
    legal: 0,
  };
  inn.thisOver = [];
}

function startStand(inn) {
  inn.currentStand = {
    batterIds: [inn.striker, inn.nonStriker].filter(Boolean),
    runs: 0,
    balls: 0,
  };
}

function closeStand(inn) {
  if (inn.currentStand && (inn.currentStand.runs > 0 || inn.currentStand.balls > 0
      || inn.partnerships.length < Math.max(0, inn.wickets))) {
    inn.partnerships.push({ ...inn.currentStand, unbroken: false });
  }
  inn.currentStand = null;
}

/**
 * Fold the event log into full match state. Never throws on bad events —
 * collects human-readable notes in state.anomalies instead, so an edit of an
 * earlier ball can never brick the match.
 */
export function reduce(events) {
  const st = {
    config: null,
    squads: { A: [], B: [] },
    innings: [],
    phase: 'setup',
    needs: { openers: false, bowler: false, newBatter: false },
    freeHitPending: false,
    revisedTarget: null,
    pendingOversLimit: null, // overs revision made during a break, for the next innings
    pendingPenalties: { A: 0, B: 0 }, // penalties awarded before the team has an innings
    feed: [],
    anomalies: [],
    lastBallSeq: null,
    result: null,
    superOverAvailable: false,
  };

  const nameOf = (pid) => {
    if (!pid) return null;
    for (const t of ['A', 'B']) {
      const p = st.squads[t].find((x) => x.id === pid);
      if (p) return p.name;
    }
    return pid;
  };
  st._nameOf = nameOf; // used by finalize; stripped before returning

  const curInn = () => st.innings.length ? st.innings[st.innings.length - 1] : null;
  const liveInn = () => {
    const inn = curInn();
    return inn && !inn.closed ? inn : null;
  };

  events.forEach((ev, idx) => {
    const seq = idx;
    try {
      applyEvent(st, ev, seq, nameOf, curInn, liveInn);
    } catch (err) {
      st.anomalies.push(`event ${seq} (${ev.type}): ${err.message}`);
    }
  });

  finalize(st, nameOf);
  delete st._nameOf;
  return st;
}

function applyEvent(st, ev, seq, nameOf, curInn, liveInn) {
  switch (ev.type) {
    case 'MATCH_CREATED': {
      // deep-clone: st.config gets patched by CONFIG_UPDATED and must never
      // alias the immutable event in the log
      st.config = JSON.parse(JSON.stringify(ev.config));
      st.squads.A = [...st.config.teams[0].players];
      st.squads.B = [...st.config.teams[1].players];
      return;
    }
    case 'CONFIG_UPDATED': {
      if (!st.config) { st.anomalies.push(`event ${seq}: CONFIG_UPDATED before MATCH_CREATED`); return; }
      const patch = ev.patch || {};
      if (patch.teams) {
        patch.teams.forEach((tp, i) => {
          if (!tp) return;
          const t = st.config.teams[i];
          if (tp.name) t.name = tp.name;
          if (tp.short) t.short = tp.short.toUpperCase().slice(0, 4);
          if (tp.color) t.color = tp.color;
        });
      }
      if (patch.rules) st.config.rules = { ...st.config.rules, ...patch.rules };
      if (patch.maxOversPerBowler) st.config.maxOversPerBowler = patch.maxOversPerBowler;
      if (patch.name !== undefined) st.config.name = patch.name;
      if (patch.venue !== undefined) st.config.venue = patch.venue;
      return;
    }
    case 'PLAYER_ADDED': {
      const teamId = ev.teamId === 'B' ? 'B' : 'A';
      const pid = ev.playerId || `${teamId}${st.squads[teamId].length + 1}`;
      if (st.squads[teamId].some((p) => p.id === pid)) { st.anomalies.push(`event ${seq}: duplicate player id ${pid}`); return; }
      st.squads[teamId].push({ id: pid, name: ev.name || pid });
      return;
    }
    case 'INNINGS_START': {
      const prev = curInn();
      if (prev && !prev.closed) { st.anomalies.push(`event ${seq}: INNINGS_START while an innings is live`); return; }
      const index = st.innings.length;
      const superOver = index >= 2;
      const battingTeamId = ev.battingTeamId === 'B' ? 'B' : 'A';
      const bowlingTeamId = battingTeamId === 'A' ? 'B' : 'A';
      const squadSize = st.squads[battingTeamId].length;
      const lms = st.config.rules.lastManStands;
      const maxWickets = superOver
        ? Math.min(2, Math.max(1, squadSize - (lms ? 0 : 1)))
        : Math.max(1, squadSize - (lms ? 0 : 1));
      const oversLimit = superOver ? 1 : (st.pendingOversLimit || st.config.oversPerInnings);
      st.pendingOversLimit = null;
      const inn = newInnings(index, battingTeamId, bowlingTeamId, oversLimit, maxWickets, superOver);
      st.innings.push(inn);
      if (superOver) st.revisedTarget = null; // revisions never apply across to a super over
      inn.striker = ev.striker || null;
      inn.nonStriker = ev.nonStriker || null;
      if (inn.striker) batterRow(inn, inn.striker, nameOf).atCrease = true;
      if (inn.nonStriker) batterRow(inn, inn.nonStriker, nameOf).atCrease = true;
      if (!inn.nonStriker && st.config.rules.lastManStands) inn.solo = true;
      // penalties awarded to this team before they batted land on this innings
      const pend = st.pendingPenalties[battingTeamId] || 0;
      if (pend) {
        inn.extras.penalties += pend;
        inn.runs += pend;
        st.pendingPenalties[battingTeamId] = 0;
      }
      startStand(inn);
      st.freeHitPending = false;
      pushFeed(st, seq, null, `${teamName(st, battingTeamId)} innings begins`, 'info');
      return;
    }
    case 'BOWLER_CHANGE': {
      const inn = liveInn();
      if (!inn) { st.anomalies.push(`event ${seq}: BOWLER_CHANGE with no live innings`); return; }
      inn.currentBowlerId = ev.bowler;
      bowlerRow(inn, ev.bowler, nameOf);
      if (!inn.curOver) startOver(inn, ev.bowler);
      else if (inn.curOver.legal === 0) inn.curOver.bowlers = [ev.bowler]; // re-pick before a ball: not shared
      else if (!inn.curOver.bowlers.includes(ev.bowler)) inn.curOver.bowlers.push(ev.bowler);
      return;
    }
    case 'BALL': {
      applyBall(st, ev, seq, nameOf, liveInn);
      return;
    }
    case 'NEW_BATTER': {
      const inn = liveInn();
      if (!inn) { st.anomalies.push(`event ${seq}: NEW_BATTER with no live innings`); return; }
      if (inn.striker && inn.nonStriker) { st.anomalies.push(`event ${seq}: NEW_BATTER with no vacancy`); return; }
      const row = batterRow(inn, ev.batter, nameOf);
      if (row.out) { st.anomalies.push(`event ${seq}: NEW_BATTER ${ev.batter} is already out`); return; }
      if (row.atCrease) { st.anomalies.push(`event ${seq}: NEW_BATTER ${ev.batter} is already at the crease`); return; }
      if (row.retiredHurt) { row.retiredHurt = false; row.resumed = true; }
      row.atCrease = true;
      const survivor = inn.striker || inn.nonStriker;
      const end = ev.end === 'nonstriker' ? 'nonstriker' : 'striker';
      if (end === 'striker') { inn.striker = ev.batter; inn.nonStriker = survivor; }
      else { inn.nonStriker = ev.batter; inn.striker = survivor; }
      // still solo if there was no survivor (a lone last-man-stands batter
      // retired hurt and is now resuming alone)
      inn.solo = !(inn.striker && inn.nonStriker);
      if (inn.solo && !inn.striker) { inn.striker = inn.nonStriker; inn.nonStriker = null; }
      st.needs.newBatter = false;
      startStand(inn);
      pushFeed(st, seq, inn, `${row.name} comes to the crease`, 'info');
      return;
    }
    case 'RETIREMENT': {
      const inn = liveInn();
      if (!inn) { st.anomalies.push(`event ${seq}: RETIREMENT with no live innings`); return; }
      const slot = ev.who === 'nonstriker' ? 'nonStriker' : 'striker';
      const pid = inn[slot];
      if (!pid) { st.anomalies.push(`event ${seq}: RETIREMENT of empty ${slot} slot`); return; }
      const row = batterRow(inn, pid, nameOf);
      row.atCrease = false;
      closeStand(inn);
      if (ev.kind === 'out') {
        // Retired out — a dismissal (Law 25.4), recorded in FOW, no bowler credit.
        row.out = { kind: 'retired-out', fielders: [], bowlerId: null };
        inn.wickets += 1;
        inn.fow.push({ wicket: inn.wickets, runs: inn.runs, overs: oversText(inn.legalBalls), batterId: pid, batterName: row.name });
        pushFeed(st, seq, inn, `${row.name} retired out ${row.runs}(${row.balls})`, 'wicket');
      } else {
        row.retiredHurt = true;
        pushFeed(st, seq, inn, `${row.name} retired hurt ${row.runs}(${row.balls})`, 'info');
      }
      inn[slot] = null;
      resolveVacancy(st, inn);
      return;
    }
    case 'PENALTY': {
      const teamId = ev.teamId === 'B' ? 'B' : 'A';
      const runs = clampInt(ev.runs, 1, 25, 5);
      // Award to the team's innings if it exists (live or completed —
      // Law 41 penalties can adjust a completed total); otherwise hold.
      const inn = [...st.innings].reverse().find((i) => i.battingTeamId === teamId);
      if (inn) {
        inn.extras.penalties += runs;
        inn.runs += runs;
      } else {
        st.pendingPenalties[teamId] += runs;
      }
      pushFeed(st, seq, null, `${runs} penalty runs to ${teamName(st, teamId)}${ev.note ? ` — ${ev.note}` : ''}`, 'info');
      checkClose(st, liveInn());
      return;
    }
    case 'TARGET_REVISED': {
      const inn = liveInn() || curInn();
      if (ev.oversLimit) {
        if (inn && !inn.closed) {
          const already = Math.ceil(inn.legalBalls / 6);
          inn.oversLimit = Math.max(already, clampInt(ev.oversLimit, 1, 100, inn.oversLimit));
        } else {
          // revised during the break (the usual rain case): applies to the
          // innings about to start
          st.pendingOversLimit = clampInt(ev.oversLimit, 1, 100, null);
        }
      }
      if (ev.clear) st.pendingOversLimit = null;
      if (ev.target !== undefined && ev.target !== null) {
        st.revisedTarget = clampInt(ev.target, 1, 10000, null);
      } else if (ev.clear) {
        st.revisedTarget = null;
      }
      pushFeed(st, seq, null,
        `Revised: ${ev.target ? `target ${ev.target}` : ''}${ev.target && ev.oversLimit ? ', ' : ''}${ev.oversLimit ? `${ev.oversLimit} overs` : ''}${ev.note ? ` — ${ev.note}` : ''}`,
        'info');
      checkClose(st, liveInn());
      return;
    }
    case 'INNINGS_DECLARED': {
      const inn = liveInn();
      if (!inn) { st.anomalies.push(`event ${seq}: INNINGS_DECLARED with no live innings`); return; }
      closeInnings(st, inn, 'declared');
      return;
    }
    default:
      st.anomalies.push(`event ${seq}: unknown type ${ev.type}`);
  }
}

/** Current chase target while folding (revisions + live view of earlier innings totals). */
function currentTarget(st, inn) {
  if (!inn || inn.index % 2 === 0) return null; // even innings set the target, odd ones chase
  if (inn.index === 1 && st.revisedTarget) return st.revisedTarget;
  const setBy = st.innings[inn.index - 1];
  return setBy ? setBy.runs + 1 : null;
}

// ---------------------------------------------------------------------------
// The ball — the heart of the engine
// ---------------------------------------------------------------------------

function applyBall(st, ev, seq, nameOf, liveInn) {
  const inn = liveInn();
  if (!inn) { st.anomalies.push(`event ${seq}: BALL with no live innings`); return; }
  if (st.needs.newBatter) { st.anomalies.push(`event ${seq}: BALL while waiting for a new batter`); return; }
  if (!inn.striker) { st.anomalies.push(`event ${seq}: BALL with no striker`); return; }
  if (!inn.currentBowlerId) { st.anomalies.push(`event ${seq}: BALL with no bowler`); return; }

  const rules = st.config.rules;
  const legality = ev.legality === 'wide' || ev.legality === 'noball' ? ev.legality : 'legal';
  const batRuns = Math.max(0, ev.batRuns | 0);
  const extraRuns = Math.max(0, ev.extraRuns | 0);
  const short = ev.short ? 1 : 0;

  const wasFreeHit = st.freeHitPending;
  const striker = batterRow(inn, inn.striker, nameOf);
  const bw = bowlerRow(inn, inn.currentBowlerId, nameOf);
  if (!inn.curOver) startOver(inn, inn.currentBowlerId);
  const over = inn.curOver;
  const ovLabel = `${Math.floor(inn.legalBalls / 6)}.${(inn.legalBalls % 6) + 1}`;

  // ---- score allocation --------------------------------------------------
  const wideVal = legality === 'wide' ? rules.wideRuns : 0;
  const nbVal = legality === 'noball' ? rules.noBallRuns : 0;
  // A declared short run removes one completed run from the score, but the
  // batters still finished where their running left them (Law 18.3), so
  // crossing parity uses the runs as run, not as scored.
  let batScored = batRuns;
  let extraScored = extraRuns;
  if (short) {
    if (batScored > 0) batScored -= 1;
    else if (extraScored > 0) extraScored -= 1;
  }
  const teamRuns = wideVal + nbVal + batScored + extraScored;
  inn.runs += teamRuns;
  over.teamRuns += teamRuns;

  // ---- striker -------------------------------------------------------------
  if (legality !== 'wide') striker.balls += 1; // a wide never counts as a ball faced (Law 22.7)
  if (legality !== 'wide' && batScored > 0) {
    striker.runs += batScored;
    if (batRuns === 4) striker.fours += 1;
    if (batRuns === 6) striker.sixes += 1;
  }

  // ---- extras --------------------------------------------------------------
  if (legality === 'wide') {
    inn.extras.wides += wideVal + extraScored; // runs completed on a wide are all wides (Law 22.6)
  } else if (legality === 'noball') {
    // Runs not off the bat on a no-ball are no-ball extras (per house style —
    // spec §5.2), and the bowler is charged with them.
    inn.extras.noballs += nbVal + extraScored;
  } else if (ev.extraType === 'bye') {
    inn.extras.byes += extraScored;
  } else if (ev.extraType === 'legbye') {
    inn.extras.legbyes += extraScored;
  }

  // ---- bowler ----------------------------------------------------------------
  // Byes/leg-byes off a legal ball are not the bowler's; wides & no-balls
  // (including runs run on them) are.
  let charged = batScored;
  if (legality === 'wide') charged += wideVal + extraScored;
  if (legality === 'noball') charged += nbVal + extraScored;
  bw.runs += charged;
  over.conceded += charged;
  if (legality === 'legal') {
    bw.balls += 1;
    if (batRuns === 0) bw.dots += 1;
  } else if (legality === 'wide') bw.wides += 1;
  else bw.noballs += 1;

  // ---- legal-ball count ------------------------------------------------------
  if (legality === 'legal') {
    inn.legalBalls += 1;
    over.legal += 1;
    if (inn.currentStand) inn.currentStand.balls += 1;
  }
  if (inn.currentStand) inn.currentStand.runs += teamRuns;

  // Law 16.9: once the winning run is completed the match is over — a
  // dismissal on the same ball (e.g. run out going back for an extra run)
  // does not count.
  let wicket = ev.wicket || null;
  const targetNow = currentTarget(st, inn);
  if (wicket && targetNow !== null && inn.runs >= targetNow) {
    wicket = null;
    pushFeed(st, seq, inn, 'Dismissal not counted — the winning run had already been scored (Law 16.9)', 'info');
  }

  inn.thisOver.push(ballToken({ ...ev, wicket, legality, batRuns, extraRuns }));
  st.lastBallSeq = seq;

  // ---- wicket -----------------------------------------------------------------
  let outRow = null;
  if (wicket) {
    const outSlot = wicket.out === 'nonstriker' ? 'nonStriker' : 'striker';
    const outId = inn[outSlot];
    if (!outId) {
      st.anomalies.push(`event ${seq}: wicket of empty ${outSlot} slot ignored`);
    } else {
      outRow = batterRow(inn, outId, nameOf);
      const credited = BOWLER_CREDITED.has(wicket.kind);
      outRow.out = {
        kind: wicket.kind,
        fielders: wicket.fielders || [],
        bowlerId: credited ? inn.currentBowlerId : null,
      };
      outRow.atCrease = false;
      inn.wickets += 1;
      over.wickets += 1;
      if (credited) {
        bw.wickets += 1;
        bw.hatChain += 1;
      }
      inn.fow.push({
        wicket: inn.wickets, runs: inn.runs, overs: oversText(inn.legalBalls),
        batterId: outId, batterName: outRow.name,
      });
      closeStand(inn);
      inn[outSlot] = null;
    }
  }
  // a delivery by this bowler without a credited wicket breaks a hat-trick chain
  if (!(wicket && outRow && BOWLER_CREDITED.has(wicket.kind))) bw.hatChain = 0;

  // ---- positions -----------------------------------------------------------------
  if (wicket && outRow) {
    // Survivor placement is decided by the incoming batter's declared end
    // (NEW_BATTER.end = position for the next delivery), so nothing to do here.
    // Exception: caught with batters crossed and the innings continuing solo, or
    // no incoming batter — handled by resolveVacancy below.
    st.needs.newBatter = true;
    resolveVacancy(st, inn, wicket);
  } else if (!inn.solo) {
    // Law 18: batters change ends on each completed run — odd runs swap them.
    const crossings = batRuns + extraRuns;
    if (crossings % 2 === 1) swapEnds(inn);
  }

  // ---- over completion --------------------------------------------------------------
  let overCompleted = false;
  if (legality === 'legal' && inn.legalBalls % 6 === 0) {
    overCompleted = true;
    const maiden = over.legal === 6 && over.conceded === 0 && over.bowlers.length === 1;
    if (maiden) bw.maidens += 1;
    inn.overByOver.push({
      over: over.number, runs: over.teamRuns, wickets: over.wickets,
      bowlerId: over.bowlers[over.bowlers.length - 1], maiden,
    });
    inn.lastOver = [...inn.thisOver];
    inn.lastOverBowlerId = inn.currentBowlerId;
    inn.currentBowlerId = null;
    inn.curOver = null;
    inn.thisOver = [];
    if (!inn.solo) swapEnds(inn); // Law 17: ends alternate each over
  }

  // ---- free hit ----------------------------------------------------------------------
  if (legality === 'noball' && rules.freeHit) st.freeHitPending = true;
  else if (legality === 'legal') st.freeHitPending = false;
  // a wide leaves a pending free hit in force (ICC 21.19.2)

  // ---- commentary ----------------------------------------------------------------------
  pushBallFeed(st, seq, inn, ev, { ovLabel, striker, bw, outRow, wasFreeHit, teamRuns, batRuns, extraRuns, legality, nameOf });

  // ---- innings close checks ---------------------------------------------------------------
  checkClose(st, inn, overCompleted);
}

function swapEnds(inn) {
  const s = inn.striker;
  inn.striker = inn.nonStriker;
  inn.nonStriker = s;
}

/**
 * After a slot is vacated (wicket or retirement): if nobody can come in,
 * either continue solo (last man stands) or close the innings.
 */
function resolveVacancy(st, inn) {
  const pool = eligiblePool(st, inn);
  const atCrease = [inn.striker, inn.nonStriker].filter(Boolean).length;
  if (pool.length > 0) {
    st.needs.newBatter = true;
    return;
  }
  st.needs.newBatter = false;
  if (atCrease === 1 && st.config.rules.lastManStands) {
    // Last man stands: the remaining batter bats alone, always on strike.
    inn.striker = inn.striker || inn.nonStriker;
    inn.nonStriker = null;
    inn.solo = true;
    startStand(inn);
    return;
  }
  closeInnings(st, inn, 'allout');
}

/** Batters who could still come in (includes retired-hurt, who may resume). */
export function eligiblePool(st, inn) {
  return st.squads[inn.battingTeamId].filter((p) => {
    if (p.id === inn.striker || p.id === inn.nonStriker) return false;
    const row = inn.batters.find((b) => b.id === p.id);
    return !row || (!row.out && !row.atCrease);
  });
}

function closeInnings(st, inn, reason) {
  if (inn.closed) return;
  inn.closed = true;
  inn.closeReason = reason;
  if (inn.currentStand && (inn.currentStand.balls > 0 || inn.currentStand.runs > 0)) {
    inn.partnerships.push({ ...inn.currentStand, unbroken: true });
  }
  inn.currentStand = null;
  st.needs.newBatter = false;
  st.freeHitPending = false;
  pushFeed(st, null, inn,
    `End of innings: ${teamName(st, inn.battingTeamId)} ${inn.runs}/${inn.wickets} (${oversText(inn.legalBalls)} ov)`,
    'innings');
}

function checkClose(st, inn, justCompletedOver = false) {
  if (!inn || inn.closed) return;
  const target = currentTarget(st, inn);
  if (target !== null && inn.runs >= target) return closeInnings(st, inn, 'target');
  if (inn.wickets >= inn.maxWickets) return closeInnings(st, inn, 'allout');
  if (inn.legalBalls >= inn.oversLimit * 6) return closeInnings(st, inn, 'overs');
}

// ---------------------------------------------------------------------------
// Commentary feed
// ---------------------------------------------------------------------------

function teamName(st, teamId) {
  const t = st.config?.teams.find((x) => x.id === teamId);
  return t ? t.name : teamId;
}

function pushFeed(st, seq, inn, text, kind) {
  st.feed.push({
    seq, inning: inn ? inn.index : null,
    ov: inn ? oversText(inn.legalBalls) : null,
    text, kind,
  });
}

const FOUR_LINES = ['FOUR!', 'FOUR — races to the rope', 'FOUR, sweetly struck', 'FOUR through the field'];
const SIX_LINES = ['SIX!', 'SIX — that is huge!', 'SIX, clean over the rope', 'SIX! Into the crowd'];
const DOT_LINES = ['no run', 'dot ball', 'defended, no run', 'no run, well fielded'];

function pick(lines, seq) { return lines[seq % lines.length]; }

function pushBallFeed(st, seq, inn, ev, ctx) {
  const { ovLabel, striker, bw, outRow, wasFreeHit, batRuns, extraRuns, legality, nameOf } = ctx;
  const parts = [];
  const bits = [];
  if (wasFreeHit && legality !== 'wide') bits.push('free hit');
  if (legality === 'wide') bits.push(extraRuns > 0 ? `wide, ${extraRuns} more run${extraRuns > 1 ? 's' : ''}` : 'wide');
  else if (legality === 'noball') {
    bits.push('NO BALL');
    if (batRuns === 6) bits.push(pick(SIX_LINES, seq));
    else if (batRuns === 4) bits.push(pick(FOUR_LINES, seq));
    else if (batRuns > 0) bits.push(`${batRuns} run${batRuns > 1 ? 's' : ''}`);
    else if (extraRuns > 0) bits.push(`${extraRuns} more`);
  } else if (ev.extraType === 'bye') bits.push(`${extraRuns} bye${extraRuns > 1 ? 's' : ''}`);
  else if (ev.extraType === 'legbye') bits.push(`${extraRuns} leg bye${extraRuns > 1 ? 's' : ''}`);
  else if (batRuns === 6) bits.push(pick(SIX_LINES, seq));
  else if (batRuns === 4) bits.push(pick(FOUR_LINES, seq));
  else if (batRuns === 1) bits.push('single');
  else if (batRuns > 0) bits.push(`${batRuns} runs`);
  else if (!ev.wicket) bits.push(pick(DOT_LINES, seq));

  if (ev.wicket && outRow) {
    bits.push(`OUT! ${outRow.name} ${dismissalText(outRow.out, nameOf)} ${outRow.runs}(${outRow.balls})`);
  }
  if (ev.short) bits.push('one short');
  parts.push(`${bw.name} to ${striker.name}, ${bits.join(', ')}`);

  const kind = ev.wicket && outRow ? 'wicket'
    : legality !== 'legal' ? 'extra'
    : batRuns === 6 ? 'six'
    : batRuns === 4 ? 'four' : 'ball';
  st.feed.push({ seq, inning: inn.index, ov: ovLabel, text: parts.join(' '), kind });
}

// ---------------------------------------------------------------------------
// Finalize — derived views computed once, after the fold
// ---------------------------------------------------------------------------

function finalize(st, nameOf) {
  if (!st.config) { st.phase = 'setup'; return; }

  for (const inn of st.innings) {
    inn.oversText = oversText(inn.legalBalls);
    inn.extras.total = inn.extras.wides + inn.extras.noballs + inn.extras.byes + inn.extras.legbyes + inn.extras.penalties;
    inn.crr = inn.legalBalls > 0 ? Math.round((inn.runs / (inn.legalBalls / 6)) * 100) / 100 : 0;
    for (const b of inn.batters) {
      b.sr = strikeRate(b.runs, b.balls);
      b.howOut = b.out ? dismissalText(b.out, nameOf)
        : b.retiredHurt ? 'retired hurt'
        : 'not out';
    }
    for (const b of inn.bowlers) {
      b.oversText = oversText(b.balls);
      b.econ = economy(b.runs, b.balls);
    }
    // live partnership view
    inn.currentPartnership = inn.currentStand ? { ...inn.currentStand, unbroken: true } : null;
    inn.allPartnerships = [...inn.partnerships, ...(inn.currentPartnership ? [inn.currentPartnership] : [])];
  }

  const n = st.innings.length;
  const last = n ? st.innings[n - 1] : null;

  // phase (odd count + closed = between innings, incl. between super overs)
  if (!n) st.phase = 'setup';
  else if (!last.closed) st.phase = 'live';
  else if (n % 2 === 1) st.phase = 'break';
  else st.phase = 'complete';

  // needs
  const live = last && !last.closed ? last : null;
  st.needs.bowler = !!(live && !live.currentBowlerId && !st.needs.newBatter);
  st.needs.openers = st.phase === 'setup' || st.phase === 'break';

  // chase / target
  st.target = null;
  st.chase = null;
  if (n >= 2 && st.innings[n - 1].index % 2 === 1) {
    // a chase innings exists (live or finished)
    const chaseInn = st.innings[n - 1];
    const target = chaseInn.index === 1 && st.revisedTarget
      ? st.revisedTarget
      : st.innings[chaseInn.index - 1].runs + 1;
    st.target = { runs: target, revised: chaseInn.index === 1 && !!st.revisedTarget };
    if (!chaseInn.closed) {
      const need = Math.max(0, target - chaseInn.runs);
      const ballsLeft = Math.max(0, chaseInn.oversLimit * 6 - chaseInn.legalBalls);
      st.chase = {
        target, need, ballsLeft,
        rrr: ballsLeft > 0 ? Math.round((need / ballsLeft) * 600) / 100 : null,
      };
    }
  } else if (n % 2 === 1 && last.closed) {
    // between innings: the target the NEXT innings will chase
    const target = n === 1 && st.revisedTarget ? st.revisedTarget : last.runs + 1;
    st.target = { runs: target, revised: n === 1 && !!st.revisedTarget };
  }

  // result (the feed is fully re-derived on every fold, so appending here is safe)
  st.result = computeResult(st);
  if (st.result) {
    st.feed.push({ seq: null, inning: null, ov: null, text: st.result.text, kind: 'result' });
  }

  // convenience top-level pointers
  st.currentInnings = last ? last.index : null;
  st.battingTeamId = live ? live.battingTeamId : null;
}

function computeResult(st) {
  const main = st.innings.slice(0, 2);
  if (main.length < 2 || !main[0].closed || !main[1].closed) return null;

  const t1 = main[0].battingTeamId, t2 = main[1].battingTeamId;
  const target = st.revisedTarget || main[0].runs + 1;
  const r2 = main[1].runs;

  if (r2 >= target) {
    const wktsInHand = main[1].maxWickets - main[1].wickets;
    const ballsLeft = main[1].oversLimit * 6 - main[1].legalBalls;
    return {
      winner: t2,
      method: 'runs-or-wickets',
      text: `${teamName(st, t2)} won by ${wktsInHand} wicket${wktsInHand === 1 ? '' : 's'}`
        + (ballsLeft > 0 ? ` with ${ballsLeft} ball${ballsLeft === 1 ? '' : 's'} remaining` : ''),
    };
  }
  if (r2 < target - 1) {
    const margin = target - 1 - r2;
    return { winner: t1, method: 'runs-or-wickets', text: `${teamName(st, t1)} won by ${margin} run${margin === 1 ? '' : 's'}` };
  }

  // Tied — walk super-over pairs (2,3), (4,5), … ICC rules allow repeating
  // the super over until there is a winner.
  for (let i = 2; ; i += 2) {
    const a = st.innings[i], b = st.innings[i + 1];
    if (!a) {
      st.superOverAvailable = st.config.superOver;
      return i === 2
        ? { winner: null, method: 'tie', text: 'Match tied' }
        : { winner: null, method: 'super-over-tied', text: 'Match tied — Super Over tied' };
    }
    if (!a.closed || !b || !b.closed) return null; // super over in progress
    const t = a.runs + 1;
    if (b.runs >= t) {
      return { winner: b.battingTeamId, method: 'super-over', text: `Match tied — ${teamName(st, b.battingTeamId)} won the Super Over` };
    }
    if (b.runs < t - 1) {
      return { winner: a.battingTeamId, method: 'super-over', text: `Match tied — ${teamName(st, a.battingTeamId)} won the Super Over` };
    }
    // super over tied as well — another pair may follow
  }
}

// ---------------------------------------------------------------------------
// Validation — server rejects errors; warnings are override-able
// ---------------------------------------------------------------------------

export function validateAppend(state, ev) {
  const errors = [];
  const warnings = [];
  const st = state;
  const inn = st.innings.length ? st.innings[st.innings.length - 1] : null;
  const live = inn && !inn.closed ? inn : null;

  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  switch (ev.type) {
    case 'MATCH_CREATED':
      if (st.config) err('match already created');
      break;

    case 'INNINGS_START': {
      if (!st.config) { err('no match'); break; }
      if (live) err('an innings is already in progress');
      const index = st.innings.length;
      if (index >= 2) {
        if (!st.config.superOver) err('super over is not enabled for this match');
        else if (index % 2 === 0 && !(st.result && st.result.winner === null)) {
          err('a super over only follows a tie');
        }
      }
      if (index === 1 && st.innings[0] && ev.battingTeamId === st.innings[0].battingTeamId) {
        err('this team already batted');
      }
      if (!ev.striker) err('an opening striker is required');
      if (!ev.nonStriker && !st.config.rules.lastManStands) {
        const squad = st.squads[ev.battingTeamId === 'B' ? 'B' : 'A'];
        if (squad.length > 1) err('an opening non-striker is required');
      }
      if (ev.striker && ev.striker === ev.nonStriker) err('openers must be two different players');
      break;
    }

    case 'BOWLER_CHANGE': {
      if (!live) { err('no innings in progress'); break; }
      if (!ev.bowler) { err('a bowler is required'); break; }
      if (st.squads[live.bowlingTeamId].every((p) => p.id !== ev.bowler)) err('bowler is not in the fielding squad');
      const atOverStart = !live.curOver || live.curOver.legal === 0 || live.legalBalls % 6 === 0;
      if (atOverStart && ev.bowler === live.lastOverBowlerId) {
        warn(`${playerName(st, ev.bowler)} bowled the previous over — bowlers may not bowl consecutive overs`);
      }
      const row = live.bowlers.find((b) => b.id === ev.bowler);
      if (row && st.config.maxOversPerBowler && Math.floor(row.balls / 6) >= st.config.maxOversPerBowler && !live.superOver) {
        warn(`${playerName(st, ev.bowler)} has already bowled the maximum ${st.config.maxOversPerBowler} overs`);
      }
      break;
    }

    case 'BALL': {
      if (!live) { err('no innings in progress'); break; }
      if (st.needs.newBatter) { err('waiting for the incoming batter'); break; }
      if (!live.striker) { err('no striker at the crease'); break; }
      if (!live.currentBowlerId) { err('select a bowler for this over first'); break; }
      const legality = ev.legality || 'legal';
      const batRuns = ev.batRuns | 0;
      const extraRuns = ev.extraRuns | 0;
      if (batRuns < 0 || extraRuns < 0) err('runs cannot be negative');
      if (batRuns > 9 || extraRuns > 9) err('that is too many runs for one delivery');
      if (legality === 'wide' && batRuns > 0) err('runs off the bat are impossible on a wide — it would not be a wide');
      if (legality === 'wide' && ev.extraType) err('runs on a wide are scored as wides, not byes');
      if (legality === 'legal' && ev.extraType && batRuns > 0) err('a ball is either runs off the bat or byes/leg-byes, not both');
      const w = ev.wicket;
      if (w) {
        if (!DISMISSAL_KINDS.includes(w.kind)) err(`unknown dismissal: ${w.kind}`);
        if (w.kind === 'lbw' && st.config.rules.noLbw) err('LBW is disabled for this match');
        if (st.freeHitPending && !ALLOWED_ON_FREE_HIT.has(w.kind)) {
          err(`not out — on a free hit the batter can only be run out, out obstructing the field, or out hitting the ball twice`);
        } else if (legality === 'noball' && !ALLOWED_ON_NO_BALL.has(w.kind)) {
          err(`not out — ${w.kind} is not possible off a no-ball`);
        } else if (legality === 'wide' && !ALLOWED_ON_WIDE.has(w.kind)) {
          err(`not out — ${w.kind} is not possible off a wide`);
        }
        if (['bowled', 'caught', 'lbw', 'stumped'].includes(w.kind) && (batRuns > 0 || extraRuns > 0)) {
          err(`no runs can be scored when the batter is out ${w.kind}`);
        }
        if (w.kind === 'caught' && !(w.fielders && w.fielders.length)) warn('no catcher recorded');
        if (w.kind === 'stumped' && !(w.fielders && w.fielders.length)) warn('no keeper recorded for the stumping');
        if (w.out === 'nonstriker' && !['runout', 'obstructing', 'timedout'].includes(w.kind)) {
          err(`the non-striker cannot be out ${w.kind}`);
        }
        if (w.out === 'nonstriker' && !live.nonStriker) err('there is no non-striker');
      }
      break;
    }

    case 'NEW_BATTER': {
      if (!live) { err('no innings in progress'); break; }
      if (!ev.batter) { err('a batter is required'); break; }
      const row = live.batters.find((b) => b.id === ev.batter);
      if (row && row.out) err(`${playerName(st, ev.batter)} is already out`);
      if (row && row.atCrease) err(`${playerName(st, ev.batter)} is already batting`);
      if (st.squads[live.battingTeamId].every((p) => p.id !== ev.batter)) err('batter is not in the batting squad');
      if (!st.needs.newBatter) warn('no vacancy at the crease');
      break;
    }

    case 'RETIREMENT': {
      if (!live) { err('no innings in progress'); break; }
      const slot = ev.who === 'nonstriker' ? 'nonStriker' : 'striker';
      if (!live[slot]) err('that end is empty');
      if (!['hurt', 'out'].includes(ev.kind)) err('retirement must be hurt or out');
      break;
    }

    case 'PENALTY':
      if (!st.config) err('no match');
      break;

    case 'TARGET_REVISED':
      if (!st.config) err('no match');
      if (ev.target !== undefined && ev.target !== null && st.innings.length < 1) err('no first innings yet — nothing to revise');
      break;

    case 'INNINGS_DECLARED':
      if (!live) err('no innings in progress');
      break;

    case 'PLAYER_ADDED': {
      if (!ev.name || !ev.name.trim()) err('player name required');
      const t = ev.teamId === 'B' ? 'B' : 'A';
      if (ev.playerId && st.squads[t].some((p) => p.id === ev.playerId)) {
        err(`player id ${ev.playerId} already exists`);
      }
      break;
    }

    case 'CONFIG_UPDATED':
      break;

    default:
      err(`unknown event type: ${ev.type}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function playerName(st, pid) {
  for (const t of ['A', 'B']) {
    const p = st.squads[t].find((x) => x.id === pid);
    if (p) return p.name;
  }
  return pid || '?';
}

// ---------------------------------------------------------------------------
// Undo / edit
// ---------------------------------------------------------------------------

/** Undo the most recent event (never the MATCH_CREATED). */
export function undoLast(events) {
  if (events.length <= 1) return { events, undone: null };
  return { events: events.slice(0, -1), undone: events[events.length - 1] };
}

/** Replace the event at index `seq` (array index). MATCH_CREATED is immutable. */
export function replaceEvent(events, seq, replacement) {
  if (seq <= 0 || seq >= events.length) throw new Error('bad event index');
  const next = events.slice();
  next[seq] = { ...replacement, id: events[seq].id, ts: events[seq].ts, edited: true };
  return next;
}

// ---------------------------------------------------------------------------
// FX — stinger triggers, computed by diffing state around one event
// ---------------------------------------------------------------------------

export function computeFx(before, after, ev) {
  const fx = [];
  if (ev.type === 'BALL') {
    const innB = before.innings[before.innings.length - 1];
    const innA = after.innings[innB ? innB.index : 0] || after.innings[after.innings.length - 1];
    const strikerId = innB ? innB.striker : null;
    const batRuns = ev.batRuns | 0;

    if (!ev.wicket && batRuns === 4) fx.push({ type: 'four', batter: pname(after, strikerId) });
    if (!ev.wicket && batRuns === 6) fx.push({ type: 'six', batter: pname(after, strikerId) });

    if (ev.wicket && innA) {
      const fowEntry = innA.fow[innA.fow.length - 1];
      const outRow = fowEntry ? innA.batters.find((b) => b.id === fowEntry.batterId) : null;
      if (outRow) {
        fx.push({
          type: 'wicket',
          batter: outRow.name,
          score: `${outRow.runs}(${outRow.balls})`,
          how: outRow.howOut,
          teamScore: `${innA.runs}/${innA.wickets}`,
        });
        if (outRow.runs === 0) fx.push({ type: 'duck', batter: outRow.name });
        const bwA = innA.bowlers.find((b) => b.id === innB.currentBowlerId);
        if (bwA && bwA.hatChain >= 3) fx.push({ type: 'hattrick', bowler: bwA.name });
      }
    }

    // milestones
    if (strikerId && innA) {
      const rb = innB.batters.find((b) => b.id === strikerId);
      const ra = innA.batters.find((b) => b.id === strikerId);
      if (rb && ra) {
        if (rb.runs < 50 && ra.runs >= 50 && ra.runs < 100) fx.push({ type: 'fifty', batter: ra.name, score: `${ra.runs}(${ra.balls})` });
        if (rb.runs < 100 && ra.runs >= 100) fx.push({ type: 'hundred', batter: ra.name, score: `${ra.runs}(${ra.balls})` });
      }
    }

    // over completed
    if (innB && innA && innA.overByOver.length > innB.overByOver.length) {
      const o = innA.overByOver[innA.overByOver.length - 1];
      const bw = innA.bowlers.find((b) => b.id === o.bowlerId);
      fx.push({
        type: 'over',
        over: o.over,
        runs: o.runs,
        wickets: o.wickets,
        tokens: innA.lastOver,
        bowler: bw ? `${bw.name} ${bw.oversText}-${bw.maidens}-${bw.runs}-${bw.wickets}` : '',
        score: `${innA.runs}/${innA.wickets}`,
      });
    }
  }

  // retired out is a wicket the overlays should announce too
  if (ev.type === 'RETIREMENT' && ev.kind === 'out') {
    const innA = after.innings[after.innings.length - 1];
    const fowEntry = innA && innA.fow[innA.fow.length - 1];
    const outRow = fowEntry ? innA.batters.find((b) => b.id === fowEntry.batterId) : null;
    if (outRow) {
      fx.push({
        type: 'wicket', batter: outRow.name, score: `${outRow.runs}(${outRow.balls})`,
        how: 'retired out', teamScore: `${innA.runs}/${innA.wickets}`,
      });
    }
  }

  // innings end / result
  const closedBefore = before.innings.filter((i) => i.closed).length;
  const closedAfter = after.innings.filter((i) => i.closed).length;
  if (closedAfter > closedBefore) {
    const inn = after.innings.filter((i) => i.closed).pop();
    fx.push({
      type: 'innings-end',
      team: tname(after, inn.battingTeamId),
      score: `${inn.runs}/${inn.wickets} (${inn.oversText} ov)`,
    });
  }
  if (!before.result && after.result) fx.push({ type: 'result', text: after.result.text });
  return fx;
}

function pname(st, pid) {
  for (const t of ['A', 'B']) {
    const p = st.squads[t].find((x) => x.id === pid);
    if (p) return p.name;
  }
  return pid;
}
function tname(st, tid) {
  const t = st.config?.teams.find((x) => x.id === tid);
  return t ? t.name : tid;
}
