/**
 * Regression tests for defects found in the adversarial review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMatch, firstInnings, Match } from './helpers.js';
import { reduce, undoLast, computeFx } from '../index.js';

const SIX_A_SIDE_LMS = {
  teams: [
    { name: 'ICAT Blue', short: 'BLU', players: ['Arun', 'Bala', 'Chetan', 'Dinesh', 'Emil', 'Farhan'] },
    { name: 'ICAT Gold', short: 'GLD', players: ['Naveen', 'Omar', 'Pranav', 'Qadir', 'Rohit', 'Sanjay'] },
  ],
  rules: { lastManStands: true },
};

test('CONFIG_UPDATED never mutates the event log, and undo restores it', () => {
  const m = openMatch();
  m.push({ type: 'CONFIG_UPDATED', patch: { teams: [{ name: 'Renamed FC' }], rules: { wideRuns: 2 } } });
  assert.equal(m.events[0].config.teams[0].name, 'ICAT Blue', 'the MATCH_CREATED event must stay immutable');
  assert.equal(m.events[0].config.rules.wideRuns, 1);
  assert.equal(m.state.config.teams[0].name, 'Renamed FC');
  assert.equal(m.state.config.rules.wideRuns, 2);
  const { events } = undoLast(m.events);
  const st = reduce(events);
  assert.equal(st.config.teams[0].name, 'ICAT Blue', 'undo must restore the old config');
  assert.equal(st.config.rules.wideRuns, 1);
});

test('a lone last-man-stands batter can retire hurt and resume without stranding the strike', () => {
  const m = new Match(SIX_A_SIDE_LMS).startInnings('A', 'A1', 'A2').bowler('B1');
  m.out('bowled'); m.newBatter('A3');
  m.out('bowled'); m.newBatter('A4');
  m.out('bowled'); m.newBatter('A5');
  m.out('bowled'); m.newBatter('A6');
  m.out('bowled'); // A2 stands alone
  assert.equal(m.inn().solo, true);
  m.runs(1); // 6th legal ball — over change while solo
  m.bowler('B2');
  m.retire('striker', 'hurt');
  assert.equal(m.state.needs.newBatter, true);
  m.newBatter('A2', 'striker'); // the lone batter resumes
  const inn = m.inn();
  assert.equal(inn.solo, true, 'still batting alone');
  assert.equal(inn.striker, 'A2');
  assert.equal(inn.nonStriker, null);
  m.runs(3); // odd runs must not strand the striker into the empty slot
  assert.equal(m.inn().striker, 'A2');
  m.runs(1);
  assert.equal(m.inn().striker, 'A2');
  assert.equal(m.state.anomalies.length, 0);
});

test('Law 16.9: a run out after the winning run is completed does not count', () => {
  const m = firstInnings(new Match(), 10); // target 11
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  m.runs(4).runs(4).runs(2); // 10/0
  // winning single completed, then run out coming back for a second
  m.ball({ batRuns: 1, wicket: { kind: 'runout', out: 'nonstriker', fielders: ['A5'] } });
  const inn = m.inn();
  assert.equal(inn.runs, 11);
  assert.equal(inn.wickets, 0, 'the dismissal must be void');
  assert.equal(inn.closeReason, 'target');
  assert.equal(m.batter('B1').out ?? m.batter('B2').out ?? null, null);
  assert.match(m.state.result.text, /ICAT Gold won by 10 wickets/);
  assert.ok(m.state.feed.some((f) => /Law 16\.9/.test(f.text)));
});

test('re-picking the bowler before the first ball of an over does not void a maiden', () => {
  const m = openMatch(); // B1 selected at over start
  m.bowler('B3'); // scorer corrects the pick before any delivery
  for (let i = 0; i < 6; i++) m.dot();
  assert.equal(m.bowlerRow('B3').maidens, 1);
  assert.equal(m.bowlerRow('B1').balls, 0);
  assert.deepEqual(m.inn().overByOver[0].bowlerId, 'B3');
});

test('state.target is available during the innings break, and a break-time overs revision applies', () => {
  const m = firstInnings(new Match(), 20); // Blue 20 in 5-over match
  assert.equal(m.state.phase, 'break');
  assert.deepEqual(m.state.target, { runs: 21, revised: false });
  m.push({ type: 'TARGET_REVISED', target: 15, oversLimit: 3, note: 'rain at the break' });
  assert.deepEqual(m.state.target, { runs: 15, revised: true });
  assert.equal(m.state.pendingOversLimit, 3);
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  assert.equal(m.inn().oversLimit, 3, 'the revised overs apply to the new innings');
  assert.equal(m.state.chase.target, 15);
  assert.equal(m.state.chase.ballsLeft, 18);
});

test('a tied super over can be replayed until decided', () => {
  const m = firstInnings(new Match({ superOver: true }), 4); // target 5
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  let balls = 0;
  for (let i = 0; i < 4; i++) { m.runs(1); balls++; }
  while (balls < 30) { m.dot(); balls++; if (balls % 6 === 0 && balls < 30) m.bowler(`A${balls / 6 + 1}`); }
  assert.equal(m.state.result.text, 'Match tied');

  // super over 1: both sides 5
  m.startInnings('B', 'B3', 'B4').bowler('A6');
  m.runs(1).runs(1).runs(1).runs(1).runs(1).dot();
  m.startInnings('A', 'A3', 'A4').bowler('B6');
  m.runs(4).runs(1).dot().dot().dot().dot();
  assert.equal(m.state.result.text, 'Match tied — Super Over tied');
  assert.equal(m.state.superOverAvailable, true);

  // super over 2 is allowed, and decides it
  const v = m.check({ type: 'INNINGS_START', battingTeamId: 'B', striker: 'B5', nonStriker: 'B7' });
  assert.equal(v.errors.length, 0, `second super over must be allowed: ${v.errors}`);
  m.startInnings('B', 'B5', 'B7').bowler('A7');
  m.runs(2).dot().dot().dot().dot().dot();
  m.startInnings('A', 'A5', 'A7').bowler('B8');
  m.runs(4);
  assert.equal(m.state.result.text, 'Match tied — ICAT Blue won the Super Over');
  assert.equal(m.state.phase, 'complete');
});

test('retired out fires a wicket stinger', () => {
  const m = openMatch();
  m.runs(2);
  const before = m.state;
  const ev = { type: 'RETIREMENT', who: 'striker', kind: 'out' };
  m.push(ev);
  const fx = computeFx(before, m.state, ev);
  assert.ok(fx.some((f) => f.type === 'wicket' && f.how === 'retired out' && f.batter === 'Arun'),
    `expected retired-out wicket fx in ${JSON.stringify(fx)}`);
});

test('adding a player with an existing id is rejected up front', () => {
  const m = openMatch();
  assert.ok(m.check({ type: 'PLAYER_ADDED', teamId: 'A', playerId: 'A3', name: 'Dup' })
    .errors.some((e) => /already exists/.test(e)));
  assert.equal(m.check({ type: 'PLAYER_ADDED', teamId: 'A', playerId: 'A12', name: 'Fresh' }).errors.length, 0);
});
