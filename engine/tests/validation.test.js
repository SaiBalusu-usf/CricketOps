import test from 'node:test';
import assert from 'node:assert/strict';
import { openMatch, firstInnings, Match } from './helpers.js';
import { normalizeConfig } from '../index.js';

test('normalizeConfig applies sensible defaults', () => {
  const c = normalizeConfig({});
  assert.equal(c.oversPerInnings, 20);
  assert.equal(c.maxOversPerBowler, 4); // ceil(20/5)
  assert.equal(c.rules.freeHit, true);
  assert.equal(c.rules.wideRuns, 1);
  assert.equal(c.rules.lastManStands, false);
  assert.equal(c.teams[0].id, 'A');
  assert.equal(c.teams[1].id, 'B');

  const c8 = normalizeConfig({ oversPerInnings: 8 });
  assert.equal(c8.maxOversPerBowler, 2); // ceil(8/5)

  const named = normalizeConfig({ teams: [{ name: 'ICAT Blue', players: ['X', 'Y'] }, {}] });
  assert.equal(named.teams[0].short, 'ICAT');
  assert.deepEqual(named.teams[0].players.map((p) => p.id), ['A1', 'A2']);
});

test('cannot start an innings while one is live, or bat twice', () => {
  const m = openMatch();
  assert.ok(m.check({ type: 'INNINGS_START', battingTeamId: 'B', striker: 'B1', nonStriker: 'B2' }).errors.length);
  m.declare();
  assert.ok(m.check({ type: 'INNINGS_START', battingTeamId: 'A', striker: 'A1', nonStriker: 'A2' })
    .errors.some((e) => /already batted/.test(e)));
  assert.equal(m.check({ type: 'INNINGS_START', battingTeamId: 'B', striker: 'B1', nonStriker: 'B2' }).errors.length, 0);
});

test('openers must be two distinct players', () => {
  const m = new Match();
  assert.ok(m.check({ type: 'INNINGS_START', battingTeamId: 'A', striker: 'A1', nonStriker: 'A1' }).errors.length);
  assert.ok(m.check({ type: 'INNINGS_START', battingTeamId: 'A', striker: 'A1' }).errors.length);
});

test('balls are blocked while a new batter is due', () => {
  const m = openMatch();
  m.out('bowled');
  const v = m.check({ type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0 });
  assert.ok(v.errors.some((e) => /incoming batter/.test(e)));
});

test('a dismissed batter cannot return; an at-crease batter cannot come in', () => {
  const m = openMatch();
  m.out('bowled');
  assert.ok(m.check({ type: 'NEW_BATTER', batter: 'A1', end: 'striker' }).errors.length);
  assert.ok(m.check({ type: 'NEW_BATTER', batter: 'A2', end: 'striker' }).errors.length);
  assert.ok(m.check({ type: 'NEW_BATTER', batter: 'B1', end: 'striker' }).errors.length); // wrong squad
  assert.equal(m.check({ type: 'NEW_BATTER', batter: 'A3', end: 'striker' }).errors.length, 0);
});

test('the non-striker can only be out in non-striker ways', () => {
  const m = openMatch();
  assert.ok(m.check({
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'bowled', out: 'nonstriker' },
  }).errors.length);
  assert.equal(m.check({
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'runout', out: 'nonstriker', fielders: ['B2'] },
  }).errors.length, 0);
});

test('bowler must belong to the fielding side; absurd run counts rejected', () => {
  const m = openMatch();
  assert.ok(m.check({ type: 'BOWLER_CHANGE', bowler: 'A4' }).errors.length);
  assert.ok(m.check({ type: 'BALL', legality: 'legal', batRuns: 22, extraRuns: 0 }).errors.length);
  assert.ok(m.check({ type: 'BALL', legality: 'legal', batRuns: -1, extraRuns: 0 }).errors.length);
  // 7 off one ball (overthrows) is legitimate
  assert.equal(m.check({ type: 'BALL', legality: 'legal', batRuns: 7, extraRuns: 0 }).errors.length, 0);
});

test('stumping without a keeper and caught without a catcher warn but pass', () => {
  const m = openMatch();
  const v = m.check({
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'caught', out: 'striker', fielders: [] },
  });
  assert.equal(v.errors.length, 0);
  assert.ok(v.warnings.length > 0);
});

test('a revised target requires a first innings', () => {
  const m = new Match();
  assert.ok(m.check({ type: 'TARGET_REVISED', target: 50 }).errors.length);
  const m2 = firstInnings(new Match(), 12);
  assert.equal(m2.check({ type: 'TARGET_REVISED', target: 10, oversLimit: 3 }).errors.length, 0);
});

test('bye ball cannot also carry bat runs', () => {
  const m = openMatch();
  assert.ok(m.check({
    type: 'BALL', legality: 'legal', batRuns: 2, extraRuns: 2, extraType: 'bye',
  }).errors.length);
});
