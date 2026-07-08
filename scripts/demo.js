/**
 * Seed a realistic half-played T20 (`npm run demo`) so every overlay and page
 * can be previewed instantly: ICAT Blue's full innings, ICAT Gold 7.4 overs
 * into the chase. Deterministic (seeded PRNG) and generated through the same
 * validation gate the console uses, so it is always a legal match.
 *
 * Demo PINs — scorer: 1234, director: 5678. Match id: m-demo.
 */
import {
  matchCreatedEvent, reduce, validateAppend, makeId,
} from '../engine/index.js';
import * as store from '../server/store.js';

const BLUE = ['Arun Kumar', 'Bala Iyer', 'Chetan Rao', 'Dinesh Patel', 'Emil Thomas', 'Farhan Ali',
  'Ganesh Nair', 'Hari Menon', 'Ishan Shah', 'Jai Reddy', 'Kiran Das'];
const GOLD = ['Naveen Raju', 'Omar Khan', 'Pranav Joshi', 'Qadir Shaikh', 'Rohit Verma', 'Sanjay Gupta',
  'Tarun Mehta', 'Uday Kulkarni', 'Vikram Singh', 'Wasim Akhtar', 'Yash Pillai'];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260702);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

const events = [matchCreatedEvent({
  name: 'ICAT Sunday League — Demo',
  venue: 'Tampa, FL',
  teams: [
    { name: 'ICAT Blue', short: 'BLU', color: '#1d4ed8', players: BLUE },
    { name: 'ICAT Gold', short: 'GLD', color: '#b45309', players: GOLD },
  ],
  oversPerInnings: 20,
  maxOversPerBowler: 4,
  toss: { winner: 'A', decision: 'bat' },
  superOver: true,
}, makeId('d'), Date.now())];

let state = reduce(events);

function send(ev) {
  const v = validateAppend(state, ev);
  if (v.errors.length) return false;
  events.push({ id: makeId('d'), ts: Date.now(), ...ev });
  state = reduce(events);
  return true;
}

function sampleBall(freeHit) {
  const r = rng();
  if (r < 0.30) return { batRuns: 0 };
  if (r < 0.60) return { batRuns: 1 };
  if (r < 0.70) return { batRuns: 2 };
  if (r < 0.715) return { batRuns: 3 };
  if (r < 0.835) return { batRuns: 4 };
  if (r < 0.885) return { batRuns: 6 };
  if (r < 0.915) return { legality: 'wide', extraRuns: rng() < 0.2 ? 1 : 0 };
  if (r < 0.93) return { legality: 'noball', batRuns: pick([0, 0, 1, 2, 4, 6]) };
  if (r < 0.945) return { extraType: pick(['bye', 'legbye']), extraRuns: pick([1, 1, 2]) };
  if (freeHit) return { batRuns: pick([1, 2, 4]) }; // most wickets impossible — just score
  const kind = pick(['bowled', 'bowled', 'caught', 'caught', 'caught', 'lbw', 'runout', 'stumped']);
  const fielding = state.innings[state.innings.length - 1].bowlingTeamId;
  const fielder = `${fielding}${1 + Math.floor(rng() * 7)}`;
  if (kind === 'runout') {
    return { batRuns: pick([0, 1]), wicket: { kind, out: pick(['striker', 'nonstriker']), fielders: [fielder] } };
  }
  const needsFielder = kind === 'caught' || kind === 'stumped';
  return { batRuns: 0, wicket: { kind, out: 'striker', fielders: needsFielder ? [fielder] : [] } };
}

function playInnings(battingTeamId, stopAtBalls = Infinity) {
  const bowlingTeamId = battingTeamId === 'A' ? 'B' : 'A';
  const bowlers = [7, 8, 9, 10, 11].map((n) => `${bowlingTeamId}${n}`);
  let nextBat = 3; // A1/A2 open
  send({ type: 'INNINGS_START', battingTeamId, striker: `${battingTeamId}1`, nonStriker: `${battingTeamId}2` });

  let guard = 0;
  while (guard++ < 600) {
    const inn = state.innings[state.innings.length - 1];
    if (inn.closed || inn.legalBalls >= stopAtBalls) break;
    if (state.needs.newBatter) {
      send({ type: 'NEW_BATTER', batter: `${battingTeamId}${nextBat++}`, end: 'striker' });
      continue;
    }
    if (state.needs.bowler) {
      const over = Math.floor(inn.legalBalls / 6);
      send({ type: 'BOWLER_CHANGE', bowler: bowlers[over % bowlers.length] });
      continue;
    }
    const ball = sampleBall(state.freeHitPending);
    if (!send({ type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0, ...ball })) {
      send({ type: 'BALL', legality: 'legal', batRuns: 1, extraRuns: 0 }); // sampled something illegal — take a single
    }
  }
}

playInnings('A');                 // full first innings
playInnings('B', 46);             // chase paused at 7.4 overs

// ---------------------------------------------------------------------------

async function main() {
  await store.ensureDirs();
  const id = 'm-demo';
  await store.deleteMatch(id);
  const meta = {
    id, createdAt: Date.now(), updatedAt: Date.now(),
    scorerPin: '1234', directorPin: '5678', demo: true,
  };
  await store.createMatch(id, meta, events[0]);
  await store.rewriteEvents(id, events);

  const inn1 = state.innings[0];
  const inn2 = state.innings[1];
  const port = process.env.PUBLIC_HTTP_ORIGIN || `http://localhost:${process.env.PORT || 3333}`;
  console.log('');
  console.log('Demo match seeded ✔');
  console.log(`  ICAT Blue ${inn1.runs}/${inn1.wickets} (${inn1.oversText} ov)`);
  console.log(`  ICAT Gold ${inn2.runs}/${inn2.wickets} (${inn2.oversText} ov) — chasing ${inn1.runs + 1}`);
  console.log('');
  console.log(`  Scorer PIN 1234 · Director PIN 5678 · match id ${id}`);
  console.log('  With the Docker stack running, visit:');
  console.log(`    console   ${port}/console/${id}`);
  console.log(`    scorebug  ${port}/overlay/scorebug?match=${id}`);
  console.log(`    live      ${port}/live/${id}`);
  console.log('');
  await store.close();
}

main().catch(async (err) => {
  console.error(err && err.stack ? err.stack : err);
  await store.close().catch(() => {});
  process.exit(1);
});
