# Client contract — ICAT Cricket Live

This is the authoritative contract between the server/engine and every UI
surface. If a UI needs something not listed here, it derives it from `state`
— it never invents new server calls.

Everything is vanilla ES modules. **No frameworks, no CDNs, no build step.**
The engine itself runs in the browser: `import { ... } from '/engine/index.js'`.

## 1. URLs

| Route | Page |
|---|---|
| `/` | Landing: new match, resume, links, QR |
| `/console` · `/console/:matchId` | Scoring console (PWA) |
| `/overlay/scorebug` `/overlay/batting` `/overlay/bowling` `/overlay/summary` `/overlay/lineups` `/overlay/target` `/overlay/full` | OBS browser sources, 1920×1080 |
| `/director` · `/director/:matchId` | Director panel |
| `/live/:matchId` | Public live scorecard (`/live` redirects to `/matches`) |
| `/matches` | All matches on this server |
| `/settings` | Branding settings |
| `/stream` · `/stream/:matchId` | Streamer phone: match camera + program preview + YouTube broadcast |
| `/stream/program` (`?match=`) | Clean camera feed for OBS (Tier 1 WebRTC consumer) |

Overlay pages take `?match=<id>`; without it they attach to the server's
**active match** (`GET /api/info → activeMatchId`) and re-attach when a new
match becomes active. All static assets live under `/client/...`;
`/socket.io/socket.io.js` is served by Socket.IO.

## 2. REST

- `GET /api/info` → `{ port, urls: ["http://192.168.x.x:3333", …], activeMatchId,
  streaming: { rtmp: bool } }` (`rtmp` = ffmpeg found → phone-only YouTube broadcast available)
- `GET /api/matches` → `[{ id, phase, teams:[{id,name,short,color}], innings:[{battingTeamId,runs,wickets,overs,superOver}], result, createdAt, updatedAt }]`
- `POST /api/matches` body `{ config }` (shape: engine `normalizeConfig` input, §5) → `{ id, scorerPin, directorPin, summary }`
- `GET /api/matches/:id` → `{ matchId, version, createdAt, updatedAt, state, presentation }`
- `GET /api/matches/:id/events` → `{ matchId, version, events }` (for the edit log)
- `GET /api/matches/:id/export` → downloadable match JSON `{ format, id, title, events }`
- `POST /api/import` body = an export file → `{ id, scorerPin, directorPin, summary }`
- `GET /api/branding` / `PUT /api/branding` → branding object (§7).
  PUT from anywhere but localhost needs an `x-icat-pin` header carrying a scorer
  or director PIN of a current (non-complete, else any) match; otherwise `401`.
  Repeated wrong PINs → `429 { error:'locked-out', retryInMs }`.
- `POST /api/matches` and `POST /api/import` are rate-limited to 5/min per IP (`429`).
  Squads are capped at 16 players per team at creation.
- `GET /qr.svg?text=<url>` → QR code SVG

## 3. Socket protocol (Socket.IO, all messages use ack callbacks)

Client → server:

- `join { matchId?, role: 'view'|'scorer'|'director'|'streamer', pin?, clientId?, takeover? }`
  → ack `{ ok, role, matchId, version, rev, state, presentation, branding, pins?, streaming }`
  - scorer authenticates with the scorer PIN; director and **streamer** accept
    the director *or* scorer PIN (deliberately no third PIN — the streamer is
    the director-trust tier).
  - wrong PIN → `{ ok:false, error:'bad-pin' }`. Five consecutive failures per
    (IP, match) → `{ ok:false, error:'locked-out', retryInMs }` with exponential
    backoff (30 s doubling, capped at 10 min).
  - another holder active → `{ ok:false, error:'scorer-active'|'streamer-active' }`;
    re-join with `takeover:true` to seize the lock (old device gets
    `scorer-revoked` / `streamer-revoked` **and** its server-side role is
    downgraded to view — its later actions are rejected with `revoked:true`).
  - `clientId` is a random id kept in localStorage so a page refresh keeps the lock.
- `append { matchId, event, force?, expectedVersion? }` → ack `{ ok, version }` |
  `{ ok:false, errors:[…] }` | `{ ok:false, warnings:[…], needsForce:true }` |
  `{ ok:false, warnings:[…], needsForce:true, versionConflict:true }` when
  `expectedVersion` (set by the offline queue) no longer matches the log length |
  `{ ok:false, errors:[…], revoked:true }` when this device lost the scorer lock.
  Give each event an `id` (random string) — appends are idempotent by `id`.
  `force:true` overrides both warning types after explicit user confirmation.
- `undo { matchId }` → ack `{ ok, undone, version }` (lock-holding scorer only)
- `edit { matchId, seq, event }` → ack `{ ok, version, anomalies }` (lock-holding scorer only)
- `presentation { matchId, patch }` → merged + persisted + broadcast (scorer/director/streamer)
- `fire { matchId, fx: {type, …} }` → broadcast a manual stinger (scorer/director)
- `stream:*` — see §11.

Server → client (broadcast to the match room):

- `state { matchId, version, rev, state }` — after every change. Full snapshot;
  replace, don't merge. `rev` is a **monotonic change counter** (persisted in
  match meta): unlike `version` it never decreases on undo, so clients drop any
  broadcast whose `rev` is lower than one they have already applied. (The
  original B6 idea — guard on `version` — would wedge the UI after an undo,
  which legitimately lowers `version`; `rev` keeps the ordering guard sound.)
- `fx { matchId, fx: [FxItem, …], manual? }` — stinger triggers (§6)
- `presentation { matchId, presentation }`
- `branding <branding object>` — deliberately **global** (`io.emit`), not
  room-scoped: branding is server-wide and overlays for other matches must
  update too. Do not scope it to a room.
- `scorer-revoked { matchId }` / `streamer-revoked { matchId }` — this device
  lost that lock; go read-only. Also re-sent whenever a stale device tries to act.
- `stream:status` / `stream:publisher-changed` — see §11.
- `viewers { matchId, count }` — live audience size for the match room,
  broadcast on every join/disconnect (the public page's LIVE VIEWERS counter).

## 4. `state` shape (produced by `engine reduce()`)

```jsonc
{
  "config": {
    "name": "", "venue": "",
    "teams": [
      { "id": "A", "name": "ICAT Blue", "short": "BLU", "color": "#1d4ed8",
        "players": [{ "id": "A1", "name": "Arun" }, …] },
      { "id": "B", … }
    ],
    "oversPerInnings": 20, "maxOversPerBowler": 4, "superOver": false,
    "toss": { "winner": "A", "decision": "bat" } /* or null */,
    "rules": { "lastManStands": false, "noLbw": false, "freeHit": true,
               "wideRuns": 1, "noBallRuns": 1, "jokerAllowed": false }
  },
  "squads": { "A": [{ "id", "name" }, …], "B": […] },   // config squads + mid-match additions
  "phase": "setup" | "live" | "break" | "complete",
  "innings": [ /* Innings, in order; index 2+ = super overs (a tied super over
                  may be followed by another pair, per ICC) */ ],
  "needs": { "openers": bool, "bowler": bool, "newBatter": bool },
  "freeHitPending": bool,
  "target": { "runs": 171, "revised": false } /* set from the moment the innings that
       sets it closes — i.e. during the break AND the chase; null before that */,
  "pendingOversLimit": null /* overs revision made during a break; applies to the next innings */,
  "chase": { "target", "need", "ballsLeft", "rrr" } /* only while a chase is live */,
  "result": { "winner": "A"|"B"|null, "text": "ICAT Blue won by 23 runs", "method": … } /* or null */,
  "superOverAvailable": bool,
  "feed": [ { "seq", "inning", "ov": "14.3", "text": "Kumar to Patel, FOUR!", "kind":
              "ball"|"four"|"six"|"wicket"|"extra"|"info"|"innings"|"result" }, … ],
  "anomalies": [ "…" ],          // non-empty only after a weird edit — surface to scorer
  "currentInnings": 1,           // index of latest innings, or null
  "battingTeamId": "B"           // batting side of the LIVE innings, else null
}
```

**Innings:**

```jsonc
{
  "index": 0, "battingTeamId": "A", "bowlingTeamId": "B", "superOver": false,
  "oversLimit": 20, "maxWickets": 10,
  "runs": 142, "wickets": 4, "legalBalls": 87, "oversText": "14.3", "crr": 9.79,
  "extras": { "wides": 5, "noballs": 1, "byes": 2, "legbyes": 4, "penalties": 0, "total": 12 },
  "batters": [ { "id", "name", "order", "runs", "balls", "fours", "sixes", "sr",
                 "out": null | { "kind", "fielders": [], "bowlerId" },
                 "howOut": "c Smith b Kumar" | "not out" | "retired hurt",
                 "retiredHurt": bool, "resumed": bool, "atCrease": bool } ],
  "bowlers": [ { "id", "name", "balls", "oversText": "2.3", "maidens", "runs",
                 "wickets", "dots", "wides", "noballs", "econ" } ],
  "fow": [ { "wicket": 1, "runs": 34, "overs": "4.2", "batterId", "batterName" } ],
  "partnerships": [ { "batterIds": [], "runs", "balls", "unbroken" } ],   // completed stands
  "currentPartnership": { … } | null,
  "allPartnerships": [ …completed, current ],
  "overByOver": [ { "over": 1, "runs": 9, "wickets": 0, "bowlerId", "maiden": false } ],
  "thisOver": [ "•", "1", "4", "W", "nb+2" ],   // tokens for the current over
  "lastOver": [ … ],                             // previous over's tokens
  "striker": "A4" | null, "nonStriker": "A7" | null,   // null slot = waiting for batter
  "solo": false,                                 // last-man-stands: batting alone
  "currentBowlerId": "B3" | null, "lastOverBowlerId": "B5" | null,
  "closed": false, "closeReason": null | "allout"|"overs"|"target"|"declared"
}
```

Display conventions: striker marked `*`; batter line `Name* 38(22)`; bowler
figures `O.B-M-R-W` (e.g. `2.3-0-24-1`); scorebug shows `thisOver` if
non-empty else `lastOver`.

## 5. Events the console constructs

Every event gets `id` (random string) client-side. Server adds `ts`.

- `INNINGS_START { battingTeamId, striker, nonStriker }` — nonStriker may be null
  only for a 1-player team or last-man-stands edge.
- `BOWLER_CHANGE { bowler }` — required at the start of every over (and allowed
  mid-over for injury replacement).
- `BALL { legality: 'legal'|'wide'|'noball', batRuns, extraType: null|'bye'|'legbye',
  extraRuns, short?: bool, wicket?: { kind, out: 'striker'|'nonstriker',
  fielders: [playerId], crossed?: bool }, note? }`
  - Wide: `batRuns` must be 0; completed runs go in `extraRuns` (no extraType).
  - No-ball: bat runs in `batRuns`; runs **not** off the bat in `extraRuns`
    (with `extraType` recording bye/legbye provenance, scored as no-ball extras).
  - `wicket.out` is positional **at the moment the ball was bowled**.
  - Dismissal kinds: `bowled caught lbw runout stumped hitwicket timedout obstructing hittwice`.
    Legality rules are enforced by the engine (wide → runout/stumped/hitwicket/obstructing;
    no-ball & free hit → runout/obstructing/hittwice; lbw blocked when noLbw).
  - Law 16.9: if the ball's completed runs already reach the target, an attached
    wicket is silently voided (a feed info line records it).
- `NEW_BATTER { batter, end: 'striker'|'nonstriker' }` — **end = where they stand
  for the NEXT delivery** (the survivor takes the other end). After `caught` with
  `crossed:true`, default the end to `nonstriker` so the survivor keeps strike.
- `RETIREMENT { who: 'striker'|'nonstriker', kind: 'hurt'|'out', note? }` —
  retired hurt may return later via `NEW_BATTER` (engine allows it; show
  retired-hurt players in the incoming-batter picker).
- `PENALTY { teamId, runs: 5, note }`
- `TARGET_REVISED { target?, oversLimit?, clear?, note }`
- `INNINGS_DECLARED { note? }` — manual end of innings.
- `PLAYER_ADDED { teamId, playerId, name }` — `playerId` = next free `A#`/`B#`.
- `CONFIG_UPDATED { patch }` — names/shorts/colors/rules/maxOversPerBowler.

Console flow requirements: watch `state.needs` — `openers` → innings-start
sheet; `newBatter` → incoming-batter sheet (list `squads` minus out/at-crease,
including retired-hurt); `bowler` → next-bowler sheet showing overs
used/remaining per bowler (warnings arrive via append ack `needsForce`).

## 6. `fx` items (stingers)

`{ type: 'four'|'six', batter }` · `{ type:'wicket', batter, score:"23(18)", how, teamScore }`
· `{ type:'duck', batter }` · `{ type:'fifty'|'hundred', batter, score }`
· `{ type:'hattrick', bowler }` · `{ type:'over', over, runs, wickets, tokens, bowler, score }`
· `{ type:'innings-end', team, score }` · `{ type:'result', text }`

Overlays play stingers automatically when `presentation.auto` is true (default)
and always for `manual:true` fires. Stingers auto-dismiss after ~5s. The
director's manual fire sends the same shapes (it may omit details — degrade
gracefully).

## 7. `presentation` and `branding`

```jsonc
presentation = {
  "theme": "broadcast" | "chroma",   // chroma = solid #00b140 page background
  "ticker": "",                       // free text; empty = hidden
  "videoUrl": "",                     // YouTube link, set from the director panel;
                                      // the public /live page embeds it in its video card
  "auto": true,                       // auto stingers / auto cards
  "show": { "scorebug": true, "batting": false, "bowling": false,
            "summary": false, "lineups": false, "target": false }
}
branding = { "orgName": "ICAT", "footer": "ICAT — Tampa, FL",
             "logo": null | "data:image/…", "accent": "#f5b301",
             "sponsors": [ { "name", "logo": "data:…" } ] /* ≤3 */ }
```

Every overlay honours: its own `show.<name>` flag (fade in/out, 240 ms),
`theme`, `ticker` (scorebug + full render it), `branding`.

## 8. `client/shared/app.js` (already written — use it)

```js
import { connect, fmt, $, h } from '/client/shared/app.js';

const app = await connect({
  matchId,            // or null → active match
  role: 'view',       // 'scorer' | 'director' need pin
  pin, takeover,
  onState(state, version) {},   // fires immediately after join, then on every change
  onFx(fxList, manual) {},
  onPresentation(p) {},
  onBranding(b) {},
  onStatus(s) {},     // 'connecting'|'online'|'offline'|'revoked'|'scorer-active'|'bad-pin'|'no-match'
});
app.send(event, {force}) → Promise<ack>   // queues offline, flushes on reconnect (scorer)
app.undo() / app.edit(seq, event) / app.setPresentation(patch) / app.fire(fx)
app.state, app.presentation, app.branding, app.matchId, app.role, app.rev
```

Offline-queue semantics (A2): every queued item is stamped with
`baseVersion = version + itemsAheadInQueue` at queue time; `flush()` sends it
as `expectedVersion`. On a `versionConflict` ack the queue **freezes**
(`app.queueFrozen`) and `onQueueConflict(items)` fires — the console shows a
review sheet built on `app.queuedEvents() / app.resendQueued(i) /
app.discardQueued(i) / app.unfreezeQueue()`. The queue also freezes the moment
the app is revoked, so stale balls never auto-apply after a later re-takeover.
Any ack carrying `revoked:true` behaves exactly like the revoke event
(role→view, `onStatus('revoked')`). Extra callbacks: `onQueueConflict`,
`onStreamStatus`, `onPublisherChanged`; `onStatus` gets `(status, res)` so
`locked-out` can show `res.retryInMs` as a countdown.

`fmt`: `overs(balls)`, `figures(bowler)` → "2.3-0-24-1", `srr(x)` 1-dp string,
`batLine(batter)` → "38(22)". `$`/`h` are querySelector / element helpers.

## 9. Design language

Tokens in `client/shared/base.css` (`--bg --fg --accent --panel --ok --warn
--danger` etc.) and overlay tokens in `client/overlay/base.css`. System font
stack, `font-variant-numeric: tabular-nums` for all numbers.

- **Overlays** (`base.css` gives you: transparent body, a 1920×1080 `#stage`
  with safe margins var `--safe`, team-color chip classes, glassy panel
  mixins, `.hidden` fade transitions, chroma theme via `body.chroma`):
  broadcast-dark glass panels `rgba(10,14,22,.92)`, white text, accent from
  branding (`--accent`), team colors as 6px left chips, radius 8px,
  transitions 240ms cubic-bezier(.2,.9,.3,1), transform+opacity only.
- **Console**: outdoor high-contrast default (near-white bg, near-black text,
  48px+ tap targets, bottom-anchored pad), `body.dark` alternative theme.
- OBS runs Chromium ~103-era CEF: no `:has()`, no CSS nesting, no
  `text-wrap`. Flexbox/grid/custom properties/animations are all fine.

## 10. File ownership (for parallel work — do not touch files you don't own)

| Owner | Files |
|---|---|
| shared (done) | `client/shared/*`, `client/overlay/base.css`, `client/manifest.webmanifest`, `client/sw.js`, `client/icons/*` |
| console | `client/console/*` |
| overlay-scorebug | `client/overlay/scorebug.{html,js}`, `client/overlay/full.{html,js}`, `client/overlay/stingers.{js,css}` |
| overlay-cards | `client/overlay/{batting,bowling,summary,lineups,target}.html`, `client/overlay/cards.{js,css}` |
| director | `client/director/*` |
| public | `client/live/*`, `client/index.html`, `client/settings/*` |
| docs | `README.md`, `STREAMING.md` |

Stinger markup/animation belongs to `stingers.js` (exports
`mountStingers(container)` returning `{ play(fxItem) }`); `full.html` and
`scorebug.html` both use it. Card overlays do not play stingers.

## 11. Streaming (Part D — two-phone operation)

Phone 1 scores at `/console`; phone 2 opens `/stream/<matchId>`, joins as the
**streamer role** (director or scorer PIN — no third PIN exists by design) and
becomes the match camera. One active streamer per match (`streamerLocks`,
same takeover semantics as the scorer lock). The streamer surface consumes the
same `state`/`presentation`/`fx`/`branding` bus as every other surface — there
is no parallel data path.

**Tier 1 (always available)** — phone camera → laptop OBS over LAN WebRTC:

- `stream:webrtc-request { matchId }` (viewer → server) → relayed to the
  lock-holding streamer as `{ matchId, from }`; ack `{ ok }` or
  `{ ok:false, error:'no-streamer' }`.
- `stream:webrtc-offer { matchId, to, payload }` (streamer → viewer, relayed;
  only accepted from the lock holder).
- `stream:webrtc-answer { matchId, payload }` (viewer → streamer, relayed).
- `stream:ice { matchId, to?, payload }` (both directions; viewer→streamer
  needs no `to`).
- `stream:publisher-changed { matchId }` (broadcast) — a new streamer took
  over; program pages tear down and re-request automatically.
- `/stream/program` renders the clean camera feed only (OBS composites the
  overlay separately). Signaling payloads are opaque to the server.

**Tier 2 (when `/api/info → streaming.rtmp` is true)** — phone → YouTube via
the server's ffmpeg (`FFMPEG_PATH` env or `ffmpeg` on PATH):

- `stream:set-key { matchId, key }` / `stream:clear-key { matchId }`
  (lock-holding streamer only). The key is **write-only**: stored in Postgres
  separately from events and presentation, never in `state`, exports,
  `/api/matches/:id`, status payloads, or logs. Acks/status expose only
  `{ hasKey, keyTail:'…abcd' }`.
- `stream:start { matchId, mimeType }` → spawns ffmpeg (H.264 input → copy,
  else transcode to 720p30 x264 2.5 Mbps, keyframe 2 s) pushing
  `rtmp://a.rtmp.youtube.com/live2/<key>`. `STREAM_TEST_OUTPUT=null` (env, for
  tests) pipes into ffmpeg's null muxer instead; ack carries `test:true`.
- `stream:chunk { matchId, seq, data }` — binary MediaRecorder chunks (1 s),
  written to ffmpeg stdin in order; the server buffers at most ~12 s and
  drops oldest beyond that (counted in `drops`).
- `stream:stop { matchId }`; a dropped streamer socket keeps ffmpeg alive for
  a 60 s grace window, and a rejoin adopts the session (a resume respawns
  ffmpeg cleanly rather than splicing mid-GOP).
- `stream:status { matchId }` ack, plus a 2 s broadcast while a session runs:
  `{ matchId, rtmp, live, uptimeSec, kbps, queuedSec, drops, ffmpegAlive,
  hasKey, keyTail, lastError }`. The director panel renders this as a
  read-only health chip.

The Tier-2 composite is drawn client-side (`client/stream/canvas-scorebug.js`)
from the same `onState`/`onPresentation` callbacks as the DOM scorebug.
`presentation.theme:'chroma'` is meaningless on a composited frame and is
ignored there; `fx` renders as a simple 2 s banner for four/six/wicket.
