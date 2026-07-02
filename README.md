# ICAT Cricket Live

Ball-by-ball cricket scoring with broadcast-quality overlays for OBS and
YouTube Live. One small Node server runs on a laptop at the ground; the scorer
scores from a phone, OBS pulls transparent overlay pages, a director toggles
graphics, and spectators follow a live scorecard — all over a phone hotspot,
completely offline if you want. No accounts, no API keys, no database, nothing
to pay for.

| Surface | Who uses it | Where |
|---|---|---|
| **Scoring console** | the scorer, on a phone | `/console` |
| **Broadcast overlays** | OBS Browser Sources (transparent, 1920×1080) | `/overlay/full` and friends |
| **Director panel** | whoever runs the stream | `/director` |
| **Public live scorecard** | players' families, the club group chat | `/live/<matchId>` |

**Streaming to YouTube?** The step-by-step OBS + YouTube guide, including the
match-day checklist, is in **[STREAMING.md](STREAMING.md)**. Read it a few
days before your first stream — YouTube's live-streaming switch takes ~24
hours to activate.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer (the current LTS is fine).

```sh
git clone https://github.com/SaiBalusu-usf/CricketOps.git
cd CricketOps
npm install
npm start
```

Then open <http://localhost:3333>. The terminal also prints a LAN URL and a QR
code for phones on the same Wi-Fi/hotspot.

Want to poke around before a real match?

```sh
npm run demo    # seeds a half-played T20: match id m-demo, scorer PIN 1234, director PIN 5678
npm test        # runs the engine's test suite
```

Run `npm run demo` before starting the server (or restart it afterwards), then
visit `/console/m-demo`, `/overlay/full`, or `/live/m-demo`.

## Match day in five steps

1. **Start the server.** Laptop on the hotspot, `npm start`. Note the
   `Phones (LAN):` URL it prints.
2. **Create the match** from the landing page: team names, players, overs.
   You get two 4-digit PINs — **scorer** and **director** — shown **once** at
   creation. Screenshot them.
3. **Scorer joins.** The scorer's phone scans the QR from the landing page (or
   the terminal), opens the console, enters the scorer PIN. Only one scorer
   can be active at a time; a replacement device can take over the lock.
4. **OBS + director.** OBS adds `http://localhost:3333/overlay/full` as a
   Browser Source (details in [STREAMING.md](STREAMING.md)); the director
   opens `/director` with the director PIN to toggle cards, fire stingers, and
   set the ticker. Overlays and `/live` need no PIN — they're read-only.
5. **Score.** Every ball updates every screen instantly. Share the
   `http://<laptop-LAN-address>:3333/live/<matchId>` link with spectators.

## URL map

| URL | What it is |
|---|---|
| `/` | Landing page: new match, resume, links, QR code |
| `/console` · `/console/<matchId>` | Scoring console (installable as a PWA) |
| `/overlay/full` | Single OBS source: scorebug + cards + stingers + ticker |
| `/overlay/scorebug` | Just the score bar |
| `/overlay/batting` `/overlay/bowling` `/overlay/summary` `/overlay/lineups` `/overlay/target` | Individual full-screen cards, if you prefer separate OBS sources |
| `/director` · `/director/<matchId>` | Director panel |
| `/live/<matchId>` | Public live scorecard |
| `/matches` | All matches on this server |
| `/settings` | Branding: org name, logo, accent colour, sponsors |

Overlay pages accept `?match=<id>`; without it they attach to the server's
most recently active match and automatically re-attach when a new match starts.

## Architecture

Event-sourced, deliberately boring:

```
console sends events ─▶ server validates ─▶ append to events.ndjson on disk
                                        └─▶ state = reduce(events)  (pure function)
                                        └─▶ broadcast snapshot to every client (Socket.IO)
```

Every ball is an immutable event. Match state is always recomputed by a pure
`reduce()` over the log, so undo, edit-a-past-ball, replay, and export are all
trivially correct. The engine has no server dependencies and also runs in the
browser (`import ... from '/engine/index.js'`).

| Directory | Contents |
|---|---|
| `engine/` | Rules engine: events → state, validation, stinger detection, tests |
| `server/` | Express + Socket.IO server, disk persistence, PINs, QR |
| `client/` | All UI surfaces — vanilla ES modules, no build step |
| `config/` | `branding.json` |
| `docs/` | `CONTRACT.md` — the server↔client contract |
| `scripts/` | `demo.js` (seed data), `acceptance.js` |
| `data/` | Match storage, created at first run — **back this folder up** |

## Resilience

Community matches happen on flaky hotspots. Accordingly:

- **Every event hits the disk immediately** — one JSON line appended to
  `data/matches/<id>/events.ndjson`. Undo/edit rewrite the log atomically
  (temp file + rename), so a crash can't corrupt a match.
- **Restart and resume.** Kill the laptop mid-over, run `npm start`, and the
  match is exactly where it was. A torn final line from a crash is dropped —
  that event was never acknowledged to the scorer anyway.
- **Scorer offline queue.** If the scorer's phone drops off the network, the
  console keeps accepting balls, queues them in localStorage, and flushes on
  reconnect. Appends are idempotent, so a re-send after a flaky ack never
  double-scores a ball.
- **Export / import.** Download any match as a single JSON file from
  `/api/matches/<id>/export` and restore it on any other server via
  `POST /api/import` — for backups, or moving a match between laptops:

  ```sh
  curl -X POST -H 'Content-Type: application/json' \
       --data @m-demo.icat-match.json http://localhost:3333/api/import
  ```

## Letting people watch from anywhere (free)

Local is the primary mode: OBS, scorer, and director all talk to the laptop.
But if family across town wants the `/live` page, or your scorer is at the
boundary on mobile data, put a free tunnel in front — no account, no key:

1. Install `cloudflared` (Cloudflare's tunnel client):
   - **Windows:** `winget install Cloudflare.cloudflared`
   - **macOS:** `brew install cloudflared`
   - **Linux:** grab the package from the
     [official downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. With the server running, open a second terminal:

   ```sh
   cloudflared tunnel --url http://localhost:3333
   ```

3. It prints a URL like `https://random-words-here.trycloudflare.com`. Share
   `https://…trycloudflare.com/live/<matchId>` with spectators; a remote
   scorer or director can use their pages through it too. **OBS keeps using
   `localhost`** — the overlay never depends on the internet.

Caveats, honestly: the URL is different every run (share it fresh each match),
and quick tunnels are rate-limited for heavy traffic — fine for a club match,
not for a thousand viewers hammering refresh.

Alternative: any free Node host (e.g. Render's free tier) can run the server
in the cloud, but free-tier disks are **ephemeral** — a redeploy or sleep can
wipe `data/`. If you go that route, export your matches after every game and
import them where you need them. Local mode remains the recommended setup.

## Configuration

- **Port:** defaults to `3333`; override with `PORT=8080 npm start`.
- **Branding** (org name, footer line, logo, accent colour, up to 3 sponsor
  logos): edit it live at `/settings`, or edit `config/branding.json` directly
  and refresh your pages. Applies to all overlays and the live page.
- **Data location:** `DATA_DIR=/path/to/storage npm start` if you don't want
  match data under the repo's `data/`.

## Design decisions

- **No database.** A club's season is a few hundred small files. NDJSON on
  disk means zero setup, zero native dependencies, backups by copying a
  folder, and nothing that can fail to start at the ground.
- **Event log + pure reduce, not mutable state.** Scoring mistakes are a fact
  of life; replaying an amended log is the only edit model that's always
  consistent.
- **Vanilla JS, no build step.** `git clone` → `npm install` → run, forever.
  Volunteers can read and tweak every file, and OBS's embedded Chromium is
  old enough that a small, boring dependency surface is a feature.
- **Socket.IO rather than raw WebSockets.** Auto-reconnect, per-message ack
  callbacks, and transport fallbacks matter more than elegance on pavilion
  Wi-Fi.

MIT licensed.
