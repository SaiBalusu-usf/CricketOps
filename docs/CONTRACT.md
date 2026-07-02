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
| `/live/:matchId` | Public live scorecard |
| `/matches` | All matches on this server |
| `/settings` | Branding settings |

Overlay pages take `?match=<id>`; without it they attach to the server's
**active match** (`GET /api/info → activeMatchId`) and re-attach when a new
match becomes active. All static assets live under `/client/...`;
`/socket.io/socket.io.js` is served by Socket.IO.

## 2. REST

- `GET /api/info` → `{ port, urls: ["http://192.168.x.x:3333", …], activeMatchId }`
- `GET /api/matches` → `[{ id, phase, teams:[{id,name,short,color}], innings:[{battingTeamId,runs,wickets,overs,superOver}], result, createdAt, updatedAt }]`
- `POST /api/matches` body `{ config }` (shape: engine `normalizeConfig` input, §5) → `{ id, scorerPin, directorPin, summary }`
- `GET /api/matches/:id` → `{ matchId, version, state, presentation }`
- `GET /api/matches/:id/events` → `{ matchId, version, events }` (for the edit log)
- `GET /api/matches/:id/export` → downloadable match JSON `{ format, id, title, events }`
- `POST /api/import` body = an export file → `{ id, scorerPin, directorPin, summary }`
- `GET /api/branding` / `PUT /api/branding` → branding object (§7)
- `GET /qr.svg?text=<url>` → QR code SVG

## 3. Socket protocol (Socket.IO, all messages use ack callbacks)

Client → server:

- `join { matchId?, role: 'view'|'scorer'|'director', pin?, clientId?, takeover? }`
  → ack `{ ok, role, matchId, version, state, presentation, branding, pins? }`
  - scorer with wrong PIN → `{ ok:false, error:'bad-pin' }`
  - another scorer active → `{ ok:false, error:'scorer-active' }`; re-join with
    `takeover:true` to seize the lock (old scorer gets `scorer-revoked`).
  - `clientId` is a random id kept in localStorage so a page refresh keeps the lock.
- `append { matchId, event, force? }` → ack `{ ok, version }` |
  `{ ok:false, errors:[…] }` | `{ ok:false, warnings:[…], needsForce:true }`
  (re-send with `force:true` after the user confirms). Give each event an
  `id` (random string) before sending — appends are idempotent by `id`, safe
  to re-send after a reconnect.
- `undo { matchId }` → ack `{ ok, undone, version }` (scorer only; removes the
  **last event** — a wicket + incoming batter is two undos)
- `edit { matchId, seq, event }` → ack `{ ok, version, anomalies }` (scorer only;
  `seq` = index in the events array; only sensible for BALL events)
- `presentation { matchId, patch }` → merged + persisted + broadcast (scorer/director)
- `fire { matchId, fx: {type, …} }` → broadcast a manual stinger (scorer/director)

Server → client (broadcast to the match room):

- `state { matchId, version, state }` — after every change. Full snapshot; replace, don't merge.
- `fx { matchId, fx: [FxItem, …], manual? }` — stinger triggers (§6)
- `presentation { matchId, presentation }`
- `branding <branding object>`
- `scorer-revoked { matchId }` — this device lost the scorer lock; go read-only.

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
app.state, app.presentation, app.branding, app.matchId, app.role
```

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
