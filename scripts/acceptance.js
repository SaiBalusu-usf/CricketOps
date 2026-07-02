/**
 * §14 acceptance walkthrough (npm run acceptance).
 *
 * Drives the REAL server over the real socket protocol end-to-end:
 *   1. create a 5-over match, teams of 6, last-man-stands ON, free hit ON
 *   2. score innings 1 incl. wide+2, no-ball six, free-hit run out, byes,
 *      caught behind, retired hurt who returns, and a maiden — verifying the
 *      server state equals an independent local reduce() after every event,
 *      and that the state broadcast arrives fast
 *   3. undo a wicket; edit an earlier ball 1 → 4; verify re-derivation
 *   4. SIGKILL the server mid-innings, restart, verify exact resume
 *   5. score the chase to a last-over finish; verify chase panel + result
 *   6. export → wipe → import → identical scorecards
 *   7. open every /overlay/* route at 1920×1080 in headless Chromium:
 *      no JS errors, transparent background, screenshots
 *
 * Uses a throwaway DATA_DIR so real match data is never touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { reduce } from '../engine/index.js';

const PORT = process.env.ACCEPT_PORT || 3411;
const BASE = `http://localhost:${PORT}`;
const WORK = process.env.ACCEPT_DIR || path.join(process.cwd(), 'scratch', 'acceptance');
const DATA_DIR = path.join(WORK, 'data');
const SHOTS = path.join(WORK, 'shots');

const results = [];
const step = (name, fn) => stepImpl(name, fn);
async function stepImpl(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✘ ${name}\n    ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// server + socket plumbing
// ---------------------------------------------------------------------------

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['server/index.js'], {
    // STREAM_TEST_OUTPUT makes stream:start pipe into ffmpeg's null muxer
    // instead of RTMP, so the Tier-2 smoke test needs no YouTube account
    env: { ...process.env, PORT: String(PORT), DATA_DIR, STREAM_TEST_OUTPUT: 'null' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}
function killServer(signal = 'SIGKILL') {
  if (server) { server.kill(signal); server = null; }
  return new Promise((r) => setTimeout(r, 300));
}

let socket = null;
let latestState = null;
let latestVersion = 0;
let lastFx = [];
let stateArrivals = new Map(); // version -> arrival time

function connectSocket(matchId, pin) {
  return new Promise((resolve, reject) => {
    socket = io(BASE, { transports: ['websocket'] });
    socket.on('state', (msg) => {
      latestState = msg.state;
      latestVersion = msg.version;
      stateArrivals.set(msg.version, performance.now());
    });
    socket.on('fx', (msg) => { lastFx.push(...msg.fx); });
    socket.on('connect', () => {
      socket.emit('join', { matchId, role: 'scorer', pin, clientId: 'acceptance' }, (res) => {
        if (!res.ok) return reject(new Error(`join failed: ${res.error}`));
        latestState = res.state;
        latestVersion = res.version;
        resolve(res);
      });
    });
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}

const localEvents = []; // mirror of the server log, for independent verification

function send(event, { force = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    socket.emit('append', { matchId: MATCH.id, event, force }, (res) => {
      if (!res.ok) return reject(new Error(`append ${event.type} rejected: ${JSON.stringify(res.errors || res.warnings)}`));
      localEvents.push(event);
      // verify the broadcast reached us quickly (same client is in the room)
      const check = () => {
        const arrived = stateArrivals.get(res.version);
        if (arrived === undefined) return setTimeout(check, 10);
        const ms = arrived - t0;
        if (ms > 300) console.log(`    (slow broadcast: ${Math.round(ms)}ms)`);
        // independent engine check: server state must equal our own reduce
        const mine = reduce([FIRST_EVENT, ...localEvents]);
        assert.equal(latestState.innings.length, mine.innings.length, 'innings count mismatch');
        const a = latestState.innings[latestState.innings.length - 1];
        const b = mine.innings[mine.innings.length - 1];
        assert.deepEqual(
          { r: a.runs, w: a.wickets, b: a.legalBalls, s: a.striker, n: a.nonStriker },
          { r: b.runs, w: b.wickets, b: b.legalBalls, s: b.striker, n: b.nonStriker },
          `server/local divergence after ${event.type}`,
        );
        resolve(res);
      };
      check();
    });
    setTimeout(() => reject(new Error(`append ${event.type} ack timeout`)), 5000);
  });
}

const ball = (over = {}) => send({ type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0, ...over });
const emitAck = (name, payload) => new Promise((resolve) => socket.emit(name, payload, resolve));

// ---------------------------------------------------------------------------

let MATCH = null;
let FIRST_EVENT = null;

async function createMatch() {
  const res = await (await fetch(`${BASE}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        teams: [
          { name: 'ICAT Blue', short: 'BLU', color: '#1d4ed8', players: ['Arun', 'Bala', 'Chetan', 'Dinesh', 'Emil', 'Farhan'] },
          { name: 'ICAT Gold', short: 'GLD', color: '#b45309', players: ['Naveen', 'Omar', 'Pranav', 'Qadir', 'Rohit', 'Sanjay'] },
        ],
        oversPerInnings: 5,
        maxOversPerBowler: 2,
        toss: { winner: 'A', decision: 'bat' },
        rules: { lastManStands: true, freeHit: true },
      },
    }),
  })).json();
  assert.ok(res.id && res.scorerPin, 'match creation failed');
  MATCH = res;
  const evs = await (await fetch(`${BASE}/api/matches/${res.id}/events`)).json();
  FIRST_EVENT = evs.events[0];
}

const inn = () => latestState.innings[latestState.innings.length - 1];
const batter = (id) => inn().batters.find((b) => b.id === id);

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nICAT Cricket Live — §14 acceptance walkthrough\n');

  await step('1. server up, match created (5 ov, 6-a-side, LMS on, free hit on)', async () => {
    await startServer();
    await createMatch();
    assert.equal((await (await fetch(`${BASE}/api/info`)).json()).activeMatchId, MATCH.id);
    await connectSocket(MATCH.id, MATCH.scorerPin);
  });

  await step('2. innings 1: wide+2, no-ball six, free-hit run out, byes, caught behind, retired hurt returns, maiden', async () => {
    await send({ type: 'INNINGS_START', battingTeamId: 'A', striker: 'A1', nonStriker: 'A2' });
    await send({ type: 'BOWLER_CHANGE', bowler: 'B1' });
    // over 1
    await ball({ legality: 'wide', extraRuns: 2 });                    // wide + 2 → 3 wides
    assert.equal(inn().extras.wides, 3);
    await ball({ legality: 'noball', batRuns: 6 });                    // no-ball SIX
    assert.equal(latestState.freeHitPending, true, 'free hit should be pending');
    assert.equal(batter('A1').sixes, 1);
    // free hit: stumping must be rejected…
    await assert.rejects(
      ball({ wicket: { kind: 'stumped', out: 'striker', fielders: ['B6'] } }),
      /free hit/i, 'stumping on a free hit must be rejected',
    );
    // …but a run out on the free hit is out
    await ball({ batRuns: 1, wicket: { kind: 'runout', out: 'striker', fielders: ['B5'] } });
    assert.equal(inn().wickets, 1);
    assert.equal(latestState.needs.newBatter, true);
    await send({ type: 'NEW_BATTER', batter: 'A3', end: 'striker' });
    await ball({ extraType: 'bye', extraRuns: 2 });                    // byes
    assert.equal(inn().extras.byes, 2);
    await ball({ wicket: { kind: 'caught', out: 'striker', fielders: ['B6'] } }); // caught behind
    await send({ type: 'NEW_BATTER', batter: 'A4', end: 'striker' });
    await ball({ batRuns: 4 });
    await ball({ batRuns: 1 });
    await ball({});                                                    // over 1 complete (6 legal)
    assert.equal(inn().legalBalls, 6);
    assert.equal(latestState.needs.bowler, true);

    // over 2: retired hurt mid-over
    await send({ type: 'BOWLER_CHANGE', bowler: 'B2' });
    await ball({ batRuns: 2 });
    await send({ type: 'RETIREMENT', who: 'striker', kind: 'hurt' });
    const retiredId = inn().batters.find((b) => b.retiredHurt).id;
    await send({ type: 'NEW_BATTER', batter: 'A5', end: 'striker' });
    await ball({ batRuns: 4 });
    await ball({});
    await ball({ batRuns: 1 });
    await ball({});
    await ball({});                                                    // over 2 done

    // over 3: a maiden from B1
    await send({ type: 'BOWLER_CHANGE', bowler: 'B1' });
    for (let i = 0; i < 6; i++) await ball({});
    assert.equal(inn().bowlers.find((b) => b.id === 'B1').maidens, 1, 'over 3 must be a maiden');

    // over 4: wicket, and the retired-hurt batter RETURNS at the fall
    await send({ type: 'BOWLER_CHANGE', bowler: 'B3' });
    await ball({ batRuns: 6 });
    await ball({ wicket: { kind: 'bowled', out: 'striker' } });
    await send({ type: 'NEW_BATTER', batter: retiredId, end: 'striker' });
    assert.equal(batter(retiredId).resumed, true, 'retired-hurt batter resumes');
    await ball({ batRuns: 2 });
    await ball({ batRuns: 2 });
    await ball({});
    await ball({ batRuns: 1 });

    // over 5
    await send({ type: 'BOWLER_CHANGE', bowler: 'B4' });
    for (let i = 0; i < 6; i++) await ball({ batRuns: i % 2 ? 1 : 2 });
    assert.equal(inn().closed, true);
    assert.equal(inn().closeReason, 'overs');
    assert.equal(latestState.phase, 'break');
  });

  let scoreBeforeUndo = null;
  await step('3a. undo a wicket restores the batter (during innings 2)', async () => {
    await send({ type: 'INNINGS_START', battingTeamId: 'B', striker: 'B1', nonStriker: 'B2' });
    await send({ type: 'BOWLER_CHANGE', bowler: 'A1' });
    await ball({ batRuns: 4 });
    await ball({ batRuns: 1 });
    scoreBeforeUndo = JSON.stringify({ r: inn().runs, w: inn().wickets, s: inn().striker });
    await ball({ wicket: { kind: 'bowled', out: 'striker' } });
    await send({ type: 'NEW_BATTER', batter: 'B3', end: 'striker' });
    assert.equal(inn().wickets, 1);
    for (let i = 0; i < 2; i++) {
      const res = await emitAck('undo', { matchId: MATCH.id });
      assert.ok(res.ok, `undo failed: ${JSON.stringify(res)}`);
      localEvents.pop();
    }
    assert.equal(inn().wickets, 0, 'wicket must be gone');
    assert.equal(JSON.stringify({ r: inn().runs, w: inn().wickets, s: inn().striker }), scoreBeforeUndo);
  });

  await step('3b. edit an earlier ball from 1 to 4 re-derives downstream state', async () => {
    const evs = await (await fetch(`${BASE}/api/matches/${MATCH.id}/events`)).json();
    // the single scored in THIS innings (after the most recent INNINGS_START)
    const startIdx = evs.events.map((e) => e.type).lastIndexOf('INNINGS_START');
    const seq = evs.events.findIndex((e, i) => i > startIdx && e.type === 'BALL' && e.batRuns === 1 && !e.wicket);
    const target = evs.events[seq];
    const runsBefore = inn().runs;
    const res = await emitAck('edit', { matchId: MATCH.id, seq, event: { ...target, batRuns: 4 } });
    assert.ok(res.ok, `edit failed: ${JSON.stringify(res)}`);
    localEvents[seq - 1] = { ...target, batRuns: 4 };
    assert.equal(inn().runs, runsBefore + 3, 'total re-derived +3');
    assert.deepEqual(res.anomalies, [], 'no anomalies from the edit');
    // put it back so the chase numbers stay tidy
    const back = await emitAck('edit', { matchId: MATCH.id, seq, event: target });
    assert.ok(back.ok);
    localEvents[seq - 1] = target;
  });

  await step('4. SIGKILL the server mid-innings → restart → exact resume', async () => {
    const before = JSON.stringify({ v: latestVersion, s: latestState.innings.map((i) => [i.runs, i.wickets, i.legalBalls]) });
    socket.close();
    await killServer('SIGKILL');
    await startServer();
    await connectSocket(MATCH.id, MATCH.scorerPin);
    const after = JSON.stringify({ v: latestVersion, s: latestState.innings.map((i) => [i.runs, i.wickets, i.legalBalls]) });
    assert.equal(after, before, 'state must survive a hard kill');
  });

  await step('5. chase to a last-over finish: target/RRR live, result string, result fx', async () => {
    const target = latestState.target.runs;
    assert.equal(target, latestState.innings[0].runs + 1);
    // bowl overs 1–4 economically so the finish lands in over 5
    const perOver = [['A2'], ['A3'], ['A4'], ['A5']];
    // over 1 already has 2 balls (4 + 1). finish it with singles/dots:
    await ball({ batRuns: 1 }); await ball({}); await ball({ batRuns: 2 }); await ball({});
    for (const [bowler] of perOver.slice(0, 3)) {
      await send({ type: 'BOWLER_CHANGE', bowler });
      for (let i = 0; i < 6; i++) await ball({ batRuns: [1, 2, 1, 0, 1, 1][i] });
    }
    const chase = latestState.chase;
    assert.ok(chase && chase.ballsLeft === 6, `should be 6 balls left, got ${chase && chase.ballsLeft}`);
    assert.ok(chase.rrr > 0);
    // last over: get within a boundary of the target, then hit it
    await send({ type: 'BOWLER_CHANGE', bowler: 'A5' });
    lastFx = [];
    let guard = 0;
    while (!latestState.result && guard++ < 6) {
      const need = latestState.chase.need;
      await ball({ batRuns: need > 6 ? 6 : need });
    }
    assert.ok(latestState.result, 'match must end in the last over');
    assert.match(latestState.result.text, /ICAT Gold won by \d+ wickets? with [1-5] balls? remaining/);
    assert.ok(lastFx.some((f) => f.type === 'result'), 'result stinger must fire');
    assert.equal(latestState.phase, 'complete');
  });

  let exported = null;
  await step('6. export → wipe → import → identical scorecards', async () => {
    exported = await (await fetch(`${BASE}/api/matches/${MATCH.id}/export`)).json();
    assert.equal(exported.events.length, latestVersion);
    const stateBefore = reduce(exported.events);
    // wipe the entire data dir (server keeps a cache — kill it first, like a real wipe)
    socket.close();
    await killServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    await startServer();
    assert.deepEqual(await (await fetch(`${BASE}/api/matches`)).json(), [], 'DB wiped');
    const imp = await (await fetch(`${BASE}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exported),
    })).json();
    assert.ok(imp.id, 'import failed');
    const snap = await (await fetch(`${BASE}/api/matches/${imp.id}`)).json();
    assert.deepEqual(
      snap.state.innings.map((i) => ({ r: i.runs, w: i.wickets, o: i.oversText, bat: i.batters, bowl: i.bowlers })),
      stateBefore.innings.map((i) => ({ r: i.runs, w: i.wickets, o: i.oversText, bat: i.batters, bowl: i.bowlers })),
      'scorecards identical after import',
    );
    assert.equal(snap.state.result.text, stateBefore.result.text);
    MATCH.id = imp.id;
    MATCH.scorerPin = imp.scorerPin;
    MATCH.directorPin = imp.directorPin;
  });

  await step('7. every overlay route at 1920×1080: no JS errors, transparent, screenshots', async () => {
    const { chromium } = await import('playwright-core');
    const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const errors = [];
    try {
      for (const kind of ['scorebug', 'batting', 'bowling', 'summary', 'lineups', 'target', 'full']) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`${kind} console: ${m.text()}`); });
        await page.goto(`${BASE}/overlay/${kind}?match=${MATCH.id}`, { waitUntil: 'networkidle' }).catch((e) => errors.push(`${kind}: ${e.message}`));
        await page.waitForTimeout(1200);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) errors.push(`${kind}: body background not transparent (${bg})`);
        await page.screenshot({ path: path.join(SHOTS, `${kind}.png`), omitBackground: true });
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(errors, [], `overlay problems:\n${errors.join('\n')}`);
  });

  // ---- upgraded-scope steps (Parts A–D regressions) -----------------------

  const freshSocket = () => io(BASE, { transports: ['websocket'] });
  const joinAs = (sock, role, pin, extra = {}) => new Promise((resolve, reject) => {
    const doJoin = () => sock.emit('join', { matchId: MATCH.id, role, pin, ...extra }, resolve);
    if (sock.connected) doJoin(); else sock.once('connect', doJoin);
    setTimeout(() => reject(new Error('join timeout')), 5000);
  });
  const emitOn = (sock, name, payload) => new Promise((resolve, reject) => {
    sock.emit(name, payload, resolve);
    setTimeout(() => reject(new Error(`${name} ack timeout`)), 5000);
  });

  await step('8. URL matrix: every route answers with its required status', async () => {
    const checks = [
      ['/', 200], ['/console', 200], ['/console/', 200], [`/console/${MATCH.id}`, 200],
      ['/console/bogus-id', 200], ['/director', 200], [`/director/${MATCH.id}`, 200],
      [`/live/${MATCH.id}`, 200], [`/live/${MATCH.id}/`, 200], ['/matches', 200],
      ['/settings', 200], ['/stream', 200], [`/stream/${MATCH.id}`, 200],
      ['/stream/program', 200], [`/stream/program?match=${MATCH.id}`, 200],
      ['/overlay/scorebug', 200], ['/overlay/full', 200], ['/overlay/junk', 404],
      ['/manifest.webmanifest', 200], ['/sw.js', 200], ['/favicon.ico', 200],
      ['/api/nope', 404], ['/healthz', 200],
    ];
    const problems = [];
    for (const [p, want] of checks) {
      const r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
      if (r.status !== want) problems.push(`${p} → ${r.status} (wanted ${want})`);
    }
    const redir = await fetch(`${BASE}/live`, { redirect: 'manual' });
    if (redir.status !== 302 || !/\/matches$/.test(redir.headers.get('location') || '')) {
      problems.push(`/live → ${redir.status} ${redir.headers.get('location')} (wanted 302 → /matches)`);
    }
    const fav = await fetch(`${BASE}/favicon.ico`);
    if (!/svg|icon/.test(fav.headers.get('content-type') || '')) problems.push(`favicon content-type ${fav.headers.get('content-type')}`);
    const api404 = await fetch(`${BASE}/api/definitely-not-a-thing`);
    if (!/json/.test(api404.headers.get('content-type') || '')) problems.push('unknown /api/* is not JSON');

    // the server must shrug off junk without dying (B4)
    const badJson = await fetch(`${BASE}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    if (badJson.status >= 500) problems.push(`malformed JSON body → ${badJson.status} (should be 4xx)`);
    const junkSock = io(BASE, { transports: ['websocket'] });
    await new Promise((r) => junkSock.on('connect', r));
    junkSock.emit('append');                 // no payload, no ack
    junkSock.emit('stream:chunk', 12345);    // nonsense payload
    junkSock.emit('join', { role: { weird: true } }, () => {});
    junkSock.emit('edit', { matchId: MATCH.id, seq: -5 }, () => {});
    await new Promise((r) => setTimeout(r, 300));
    junkSock.close();
    const alive = await fetch(`${BASE}/healthz`);
    if (!alive.ok) problems.push('server died after junk payloads');
    assert.deepEqual(problems, []);
  });

  await step('9. A1 regression: a revoked scorer cannot append, undo, or edit', async () => {
    const a = freshSocket();
    const b = freshSocket();
    try {
      const ja = await joinAs(a, 'scorer', MATCH.scorerPin, { clientId: 'devA' });
      assert.ok(ja.ok, `A join: ${JSON.stringify(ja)}`);
      let revokedSeen = false;
      a.on('scorer-revoked', () => { revokedSeen = true; });
      const jb = await joinAs(b, 'scorer', MATCH.scorerPin, { clientId: 'devB', takeover: true });
      assert.ok(jb.ok, 'takeover join must succeed');
      const versionBefore = jb.version;

      const pen = { type: 'PENALTY', teamId: 'A', runs: 5, note: 'stale device', id: 'a1-stale' };
      const ra = await emitOn(a, 'append', { matchId: MATCH.id, event: pen });
      assert.equal(ra.ok, false, 'revoked append must fail');
      assert.equal(ra.revoked, true);
      const ru = await emitOn(a, 'undo', { matchId: MATCH.id });
      assert.equal(ru.ok, false);
      assert.equal(ru.revoked, true);
      const re = await emitOn(a, 'edit', { matchId: MATCH.id, seq: 3, event: { type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0 } });
      assert.equal(re.ok, false);
      assert.equal(re.revoked, true);

      const rb = await emitOn(b, 'append', { matchId: MATCH.id, event: { ...pen, id: 'b1-real', note: 'from the live device' } });
      assert.ok(rb.ok, `B append: ${JSON.stringify(rb)}`);
      assert.equal(rb.version, versionBefore + 1, "only B's append landed");
      assert.ok(revokedSeen, 'A received scorer-revoked');
      const ub = await emitOn(b, 'undo', { matchId: MATCH.id });
      assert.ok(ub.ok);
    } finally {
      a.close();
      b.close();
    }
  });

  await step('10. A2 regression: stale expectedVersion returns versionConflict', async () => {
    const s = freshSocket();
    try {
      const j = await joinAs(s, 'scorer', MATCH.scorerPin, { clientId: 'devC', takeover: true });
      assert.ok(j.ok);
      const pen = { type: 'PENALTY', teamId: 'A', runs: 5, note: 'queued offline', id: 'a2-q1' };
      const stale = await emitOn(s, 'append', { matchId: MATCH.id, event: pen, expectedVersion: j.version - 1 });
      assert.equal(stale.ok, false);
      assert.equal(stale.versionConflict, true);
      assert.equal(stale.needsForce, true);
      const fine = await emitOn(s, 'append', { matchId: MATCH.id, event: pen, expectedVersion: j.version });
      assert.ok(fine.ok, `matching expectedVersion must append: ${JSON.stringify(fine)}`);
      const undo = await emitOn(s, 'undo', { matchId: MATCH.id });
      assert.ok(undo.ok);
    } finally {
      s.close();
    }
  });

  let streamerSock = null;
  await step('11. streamer role: lock + takeover + status + key hygiene', async () => {
    const s1 = freshSocket();
    const s2 = freshSocket();
    const j1 = await joinAs(s1, 'streamer', MATCH.directorPin, { clientId: 'cam1' });
    assert.ok(j1.ok, `streamer join: ${JSON.stringify(j1)}`);
    assert.equal(j1.role, 'streamer');
    const st0 = await emitOn(s1, 'stream:status', { matchId: MATCH.id });
    assert.ok(st0.ok);
    assert.equal(st0.live, false);

    const j2a = await joinAs(s2, 'streamer', MATCH.directorPin, { clientId: 'cam2' });
    assert.equal(j2a.ok, false);
    assert.equal(j2a.error, 'streamer-active');
    let s1revoked = false;
    s1.on('streamer-revoked', () => { s1revoked = true; });
    const j2b = await emitOn(s2, 'join', { matchId: MATCH.id, role: 'streamer', pin: MATCH.directorPin, clientId: 'cam2', takeover: true });
    assert.ok(j2b.ok, 'streamer takeover must succeed');

    const kOld = await emitOn(s1, 'stream:set-key', { matchId: MATCH.id, key: 'SHOULD-NOT-WORK' });
    assert.equal(kOld.ok, false);
    assert.equal(kOld.revoked, true);
    const k = await emitOn(s2, 'stream:set-key', { matchId: MATCH.id, key: 'test-KEY-abcd' });
    assert.ok(k.ok);
    assert.equal(k.keyTail, '…abcd');
    assert.ok(s1revoked, 's1 received streamer-revoked');

    // the key must never leave the server: not in snapshots, exports,
    // status payloads, or any non-0600 file
    const snap = JSON.stringify(await (await fetch(`${BASE}/api/matches/${MATCH.id}`)).json());
    const exp2 = JSON.stringify(await (await fetch(`${BASE}/api/matches/${MATCH.id}/export`)).json());
    assert.ok(!snap.includes('test-KEY'), 'key leaked into the snapshot');
    assert.ok(!exp2.includes('test-KEY'), 'key leaked into the export');
    const st1 = await emitOn(s2, 'stream:status', { matchId: MATCH.id });
    assert.ok(!JSON.stringify(st1).includes('test-KEY'), 'key leaked into status');
    assert.equal(st1.hasKey, true);
    const streamFile = path.join(DATA_DIR, 'matches', MATCH.id, 'stream.json');
    assert.equal(fs.statSync(streamFile).mode & 0o777, 0o600, 'stream.json must be 0600');
    for (const f of ['events.ndjson', 'meta.json', 'presentation.json']) {
      assert.ok(!fs.readFileSync(path.join(DATA_DIR, 'matches', MATCH.id, f), 'utf8').includes('test-KEY'), `key leaked into ${f}`);
    }
    s1.close();
    streamerSock = s2;
  });

  await step('12. Tier-2 ffmpeg pipe smoke test (skips cleanly without ffmpeg)', async () => {
    const info = await (await fetch(`${BASE}/api/info`)).json();
    if (!info.streaming || !info.streaming.rtmp) {
      console.log('    skipped: no ffmpeg on this host');
      return;
    }
    const ff = process.env.FFMPEG_PATH || 'ffmpeg';
    const sample = path.join(WORK, 'sample.webm');
    // Preferred clip source: a REAL MediaRecorder in headless Chromium — the
    // exact encode path the streamer phone uses. Fallback: ffmpeg rawvideo.
    let haveClip = false;
    try {
      const { chromium } = await import('playwright-core');
      const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
      const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
      try {
        const page = await browser.newPage();
        const b64 = await page.evaluate(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 240;
          const ctx = canvas.getContext('2d');
          let hue = 0;
          const iv = setInterval(() => {
            ctx.fillStyle = `hsl(${hue = (hue + 7) % 360},80%,50%)`;
            ctx.fillRect(0, 0, 320, 240);
          }, 33);
          const stream = canvas.captureStream(15);
          const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
          const chunks = [];
          rec.ondataavailable = (e) => chunks.push(e.data);
          const stopped = new Promise((r) => { rec.onstop = r; });
          rec.start(500);
          await new Promise((r) => setTimeout(r, 2500));
          rec.stop();
          await stopped;
          clearInterval(iv);
          const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
          let s = '';
          const u8 = new Uint8Array(buf);
          for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
          return btoa(s);
        });
        fs.writeFileSync(sample, Buffer.from(b64, 'base64'));
        haveClip = fs.statSync(sample).size > 1000;
      } finally {
        await browser.close();
      }
    } catch { /* no chromium — try ffmpeg below */ }
    if (!haveClip) {
      const W = 320, H = 240, FRAMES = 30;
      const raw = Buffer.alloc(W * H * 3 * FRAMES);
      for (let f = 0; f < FRAMES; f++) raw.fill((f * 8) % 255, f * W * H * 3, (f + 1) * W * H * 3);
      const g = spawnSync(ff, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '15',
        '-i', 'pipe:0', '-c:v', 'libvpx', '-b:v', '200k', '-an', sample],
      { input: raw, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      haveClip = g.status === 0 && fs.existsSync(sample);
    }
    if (!haveClip) {
      console.log('    skipped: could not generate a test clip on this host');
      return;
    }
    const s2 = streamerSock;
    assert.ok(s2, 'streamer socket from step 11');
    const start = await emitOn(s2, 'stream:start', { matchId: MATCH.id, mimeType: 'video/webm;codecs=vp8' });
    assert.ok(start.ok, `stream:start: ${JSON.stringify(start)}`);
    assert.equal(start.test, true, 'test output must be active');
    const bytes = fs.readFileSync(sample);
    for (let o = 0; o < bytes.length; o += 65536) {
      s2.emit('stream:chunk', { matchId: MATCH.id, seq: o / 65536, data: bytes.subarray(o, o + 65536) });
    }
    await new Promise((r) => setTimeout(r, 1500));
    const st = await emitOn(s2, 'stream:status', { matchId: MATCH.id });
    assert.ok(st.ffmpegAlive, `ffmpeg pipe died: ${st.lastError}`);
    assert.ok(st.kbps > 0, 'no throughput measured');
    const stop = await emitOn(s2, 'stream:stop', { matchId: MATCH.id });
    assert.ok(stop.ok);
    const clear = await emitOn(s2, 'stream:clear-key', { matchId: MATCH.id });
    assert.ok(clear.ok);
  });

  streamerSock?.close();
  socket?.close();
  await killServer();

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} steps passed. Screenshots: ${SHOTS}\n`);
  if (fails.length) {
    for (const f of fails) console.log(`FAILED: ${f.name}\n${f.err.stack}\n`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  socket?.close();
  await killServer();
  process.exit(1);
});
