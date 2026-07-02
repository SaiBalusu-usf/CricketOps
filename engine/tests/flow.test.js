import test from 'node:test';
import assert from 'node:assert/strict';
import { openMatch, firstInnings, Match } from './helpers.js';

const SIX_A_SIDE = {
  teams: [
    { name: 'ICAT Blue', short: 'BLU', players: ['Arun', 'Bala', 'Chetan', 'Dinesh', 'Emil', 'Farhan'] },
    { name: 'ICAT Gold', short: 'GLD', players: ['Naveen', 'Omar', 'Pranav', 'Qadir', 'Rohit', 'Sanjay'] },
  ],
};

test('strike rotation basics', () => {
  const m = openMatch();
  m.runs(1);
  assert.equal(m.inn().striker, 'A2');
  m.dot();
  assert.equal(m.inn().striker, 'A2');
  m.runs(2);
  assert.equal(m.inn().striker, 'A2');
  m.runs(3);
  assert.equal(m.inn().striker, 'A1');
});

test('over of six legal balls: ends swap, bowler must change', () => {
  const m = openMatch();
  for (let i = 0; i < 6; i++) m.dot();
  const inn = m.inn();
  assert.equal(inn.legalBalls, 6);
  assert.equal(inn.striker, 'A2'); // ends alternate at the over change
  assert.equal(inn.currentBowlerId, null);
  assert.equal(inn.lastOverBowlerId, 'B1');
  assert.equal(m.state.needs.bowler, true);
  assert.deepEqual(inn.overByOver[0], { over: 1, runs: 0, wickets: 0, bowlerId: 'B1', maiden: true });
  const ballWithoutBowler = m.check({ type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0 });
  assert.ok(ballWithoutBowler.errors.length, 'cannot bowl without picking a bowler');
});

test('odd single off the last ball of the over keeps the same batter on strike (§5.6)', () => {
  const m = openMatch();
  for (let i = 0; i < 5; i++) m.dot();
  m.runs(1); // A1 takes a single off ball 6
  assert.equal(m.inn().striker, 'A1'); // ...and keeps the strike for the new over
  assert.equal(m.inn().nonStriker, 'A2');
});

test('wides and no-balls do not advance the over', () => {
  const m = openMatch();
  for (let i = 0; i < 5; i++) m.dot();
  m.wide();
  m.nb(0);
  assert.equal(m.inn().legalBalls, 5);
  assert.equal(m.inn().currentBowlerId, 'B1'); // over still going
  m.dot();
  assert.equal(m.inn().legalBalls, 6);
  assert.equal(m.inn().currentBowlerId, null);
});

test('consecutive-over and over-cap warnings on bowler selection', () => {
  const m = new Match({ maxOversPerBowler: 1 }).startInnings('A', 'A1', 'A2').bowler('B1');
  for (let i = 0; i < 6; i++) m.dot();
  const again = m.check({ type: 'BOWLER_CHANGE', bowler: 'B1' });
  assert.ok(again.warnings.some((w) => /consecutive/.test(w)));
  m.bowler('B2');
  for (let i = 0; i < 6; i++) m.dot();
  const capped = m.check({ type: 'BOWLER_CHANGE', bowler: 'B1' });
  assert.ok(capped.warnings.some((w) => /maximum/.test(w)));
});

test('caught with batters crossed: survivor keeps the crossed position (§5.6)', () => {
  const m = openMatch();
  m.out('caught', { fielders: ['B5'], crossed: true });
  assert.equal(m.batter('A1').out.kind, 'caught');
  // scorer puts the incoming batter at the non-striker end because they crossed
  m.newBatter('A3', 'nonstriker');
  assert.equal(m.inn().striker, 'A2');
  assert.equal(m.inn().nonStriker, 'A3');
});

test('run out of the non-striker after a completed run', () => {
  const m = openMatch();
  m.ball({ batRuns: 1, wicket: { kind: 'runout', out: 'nonstriker', fielders: ['B5'] } });
  const inn = m.inn();
  assert.equal(inn.runs, 1);
  assert.equal(m.batter('A2').out.kind, 'runout');
  assert.equal(m.batter('A1').out, null);
  m.newBatter('A3', 'striker');
  assert.equal(inn.wickets, 1);
  assert.equal(m.inn().striker, 'A3');
  assert.equal(m.inn().nonStriker, 'A1');
});

test('retired hurt leaves, returns at a fall of wicket, and keeps their runs (§5.6)', () => {
  const m = openMatch();
  m.runs(4);
  m.retire('striker', 'hurt');
  assert.equal(m.batter('A1').retiredHurt, true);
  assert.equal(m.state.needs.newBatter, true);
  m.newBatter('A3', 'striker');
  m.runs(2);
  m.out('bowled');
  m.newBatter('A1', 'striker'); // the retired batter resumes
  const a1 = m.batter('A1');
  assert.equal(a1.retiredHurt, false);
  assert.equal(a1.resumed, true);
  m.runs(4);
  assert.equal(m.batter('A1').runs, 8); // 4 before retiring + 4 after resuming
  assert.equal(m.inn().batters.filter((b) => b.id === 'A1').length, 1);
});

test('retired out counts as a wicket and appears in FOW', () => {
  const m = openMatch();
  m.runs(1);
  m.retire('striker', 'out');
  const inn = m.inn();
  assert.equal(inn.wickets, 1);
  assert.equal(inn.fow.length, 1);
  assert.equal(m.batter('A2').out.kind, 'retired-out');
  assert.equal(m.batter('A2').howOut, 'retired out');
});

test('last man stands: innings continues solo at 9-equivalent wickets, ends on the last (§5.6)', () => {
  const m = new Match({ ...SIX_A_SIDE, rules: { lastManStands: true } })
    .startInnings('A', 'A1', 'A2').bowler('B1');
  // five wickets in five balls, each new batter taking strike
  m.out('bowled'); m.newBatter('A3');
  m.out('bowled'); m.newBatter('A4');
  m.out('bowled'); m.newBatter('A5');
  m.out('bowled'); m.newBatter('A6');
  m.out('bowled'); // fifth wicket — nobody left, A2 stands alone
  let inn = m.inn();
  assert.equal(inn.closed, false, 'last man stands keeps the innings alive');
  assert.equal(inn.wickets, 5);
  assert.equal(inn.striker, 'A2');
  assert.equal(inn.nonStriker, null);
  assert.equal(inn.solo, true);
  m.runs(1); // over complete (6th legal ball)
  assert.equal(m.inn().striker, 'A2', 'a solo batter is always on strike');
  m.bowler('B2');
  m.runs(3);
  assert.equal(m.inn().striker, 'A2');
  assert.equal(m.batter('A2').runs, 4);
  m.out('bowled');
  inn = m.inn();
  assert.equal(inn.closed, true);
  assert.equal(inn.closeReason, 'allout');
  assert.equal(inn.wickets, 6);
});

test('without last man stands the innings ends at squad-minus-one wickets', () => {
  const m = new Match(SIX_A_SIDE).startInnings('A', 'A1', 'A2').bowler('B1');
  m.out('bowled'); m.newBatter('A3');
  m.out('bowled'); m.newBatter('A4');
  m.out('bowled'); m.newBatter('A5');
  m.out('bowled'); m.newBatter('A6');
  m.out('bowled');
  const inn = m.inn();
  assert.equal(inn.closed, true);
  assert.equal(inn.closeReason, 'allout');
  assert.equal(inn.wickets, 5);
});

test('target reached mid-over ends the innings with the right result (§5.6)', () => {
  const m = firstInnings(new Match(), 20); // ICAT Blue 20, target 21
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  m.runs(4).runs(4).runs(4).runs(4);
  assert.equal(m.state.chase.need, 5);
  assert.equal(m.state.chase.ballsLeft, 26);
  m.runs(6);
  const inn = m.inn();
  assert.equal(inn.closed, true);
  assert.equal(inn.closeReason, 'target');
  assert.equal(inn.legalBalls, 5);
  const r = m.state.result;
  assert.equal(r.winner, 'B');
  assert.equal(r.text, 'ICAT Gold won by 10 wickets with 25 balls remaining');
  assert.equal(m.state.phase, 'complete');
});

test('defending side wins by runs', () => {
  const m = firstInnings(new Match(), 20);
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  // 30 dots = overs done at 0
  for (let over = 0; over < 5; over++) {
    if (over > 0) m.bowler(`A${over + 1}`);
    for (let i = 0; i < 6; i++) m.dot();
  }
  assert.equal(m.inn().closeReason, 'overs');
  assert.equal(m.state.result.text, 'ICAT Blue won by 20 runs');
});

test('overs-complete close and innings break phases', () => {
  const m = openMatch();
  for (let over = 0; over < 5; over++) {
    if (over > 0) m.bowler(`B${over + 1}`);
    for (let i = 0; i < 6; i++) m.dot();
  }
  assert.equal(m.inn().closed, true);
  assert.equal(m.inn().closeReason, 'overs');
  assert.equal(m.state.phase, 'break');
  assert.equal(m.state.needs.openers, true);
});

test('revised target and overs are honoured mid-chase (rain rule)', () => {
  const m = firstInnings(new Match(), 20);
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  m.runs(1).runs(1);
  m.push({ type: 'TARGET_REVISED', target: 15, oversLimit: 3, note: 'rain' });
  assert.equal(m.state.chase.target, 15);
  assert.equal(m.state.chase.need, 13);
  assert.equal(m.inn().oversLimit, 3);
  m.runs(4).runs(4).runs(4).runs(1);
  const inn = m.inn();
  assert.equal(inn.closed, true);
  assert.equal(inn.closeReason, 'target');
  assert.equal(m.state.result.winner, 'B');
  assert.match(m.state.result.text, /ICAT Gold won by 10 wickets with 12 balls remaining/);
});

test('tie, then a super over decides it', () => {
  const m = firstInnings(new Match({ superOver: true }), 10); // target 11
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  let balls = 0;
  for (let i = 0; i < 10; i++) { m.runs(1); balls++; if (balls % 6 === 0) m.bowler(`A${balls / 6 + 1}`); }
  while (balls < 30) { m.dot(); balls++; if (balls % 6 === 0 && balls < 30) m.bowler(`A${balls / 6 + 1}`); }
  assert.equal(m.inn().closed, true);
  assert.equal(m.state.result.text, 'Match tied');
  assert.equal(m.state.superOverAvailable, true);

  // super over: Gold bats first (batted second in the match)
  m.startInnings('B', 'B3', 'B4').bowler('A5');
  for (let i = 0; i < 6; i++) m.runs(1);
  assert.equal(m.inn().closed, true);
  assert.equal(m.inn().superOver, true);
  assert.equal(m.inn().oversLimit, 1);
  m.startInnings('A', 'A3', 'A4').bowler('B5');
  m.runs(4).runs(4);
  assert.equal(m.inn().closed, true);
  assert.equal(m.state.result.text, 'Match tied — ICAT Blue won the Super Over');
  assert.equal(m.state.phase, 'complete');
});

test('super over needs the toggle and a tie', () => {
  const m = firstInnings(new Match(), 10);
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  m.runs(4).runs(4).runs(4);
  assert.equal(m.state.result.winner, 'B');
  const v = m.check({ type: 'INNINGS_START', battingTeamId: 'B', striker: 'B3', nonStriker: 'B4' });
  assert.ok(v.errors.length, 'no super over without a tie + toggle');
});
