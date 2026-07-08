# ICAT Cricket Live

Ball-by-ball cricket scoring with broadcast-quality overlays for OBS and
YouTube Live. A Docker-only local stack runs on a laptop at the ground; the
scorer scores from a phone, OBS pulls transparent overlay pages, a director
toggles graphics, and spectators follow a live scorecard over the local
network.

| Surface | Who uses it | Where |
|---|---|---|
| **Scoring console** | the scorer, on a phone | `/console` |
| **Streamer camera** | a second phone: match camera + broadcast | `/stream` |
| **Broadcast overlays** | OBS Browser Sources (transparent, 1920×1080) | `/overlay/full` and friends |
| **Director panel** | whoever runs the stream | `/director` |
| **Public live scorecard** | players' families, the club group chat | `/live/<matchId>` |

**Streaming to YouTube?** The step-by-step OBS + YouTube guide, including the
match-day checklist, is in **[STREAMING.md](STREAMING.md)**. Read it a few
days before your first stream — YouTube's live-streaming switch takes ~24
hours to activate.

## Quick start

You need Docker Desktop. The app, Node dependencies, Postgres, ffmpeg, Nginx,
certificates, and optional Python tooling all stay inside Docker.

```sh
cd CricketOps
cp .env.docker.example .env
# Edit LAN_IP, PUBLIC_HTTP_ORIGIN, and PUBLIC_HTTPS_ORIGIN in .env.
docker compose up --build
```

Then open <http://localhost:3333>. Phones on the same Wi-Fi/hotspot open
`http://<laptop-ip>:3333`. For phone camera streaming, install the generated
local CA from `http://<laptop-ip>:3333/__ca.crt` once, then use
`https://<laptop-ip>:3443/stream/<matchId>`.

Want to poke around before a real match?

```sh
docker compose exec app npm run demo
docker compose exec app npm test
```

Run the demo command after the stack is up, then visit `/console/m-demo`,
`/overlay/full?match=m-demo`, or `/live/m-demo`.

## Match day in five steps

1. **Start the stack.** Laptop on the hotspot,
   `docker compose up --build`. Open the configured
   `PUBLIC_HTTP_ORIGIN`.
2. **Create the match** from the landing page: team names, players, overs —
   or tap **Import roster (Excel / CSV)** in the wizard and load the sheet the
   teams shared (team names in the first row with players below, or
   Team,Player columns; with more than two teams you pick the two playing).
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
| `/overlay/full` | Single OBS source: scorebug + stingers + ticker |
| `/overlay/scorebug` | Just the score bar |
| `/overlay/batting` `/overlay/bowling` `/overlay/summary` `/overlay/lineups` `/overlay/target` | Individual full-screen cards, if you prefer separate OBS sources |
| `/director` · `/director/<matchId>` | Director panel |
| `/live/<matchId>` | Public live scorecard (`/live` alone redirects to `/matches`) |
| `/matches` | All matches on this server |
| `/settings` | Branding: org name, logo, accent colour, sponsors |
| `/stream` · `/stream/<matchId>` | **Stream from a phone**: the phone becomes the match camera (and, with ffmpeg, the whole broadcast rig) |
| `/stream/program` | The phone camera as a clean feed — add it as an OBS Browser Source |

## Two-phone operation: scorer + streamer

Phone 1 scores at `/console`. Phone 2 opens `/stream/<matchId>`, enters the
**director PIN**, and becomes the match camera with a live program preview
(camera + the real scorebug, driven by live state — what the streamer sees is
what viewers see).

- **With a laptop (Tier 1, always available):** OBS adds
  `http://localhost:3333/stream/program?match=<id>` as a Browser Source — the
  phone's camera arrives over Wi-Fi/hotspot WebRTC, replacing DroidCam-style
  third-party apps. OBS still composites `/overlay/full` on top and encodes to
  YouTube as usual.
- **Direct to YouTube (Tier 2):** ffmpeg is bundled in the app container, and
  `/stream` exposes a "GO LIVE ON YOUTUBE" flow: paste the stream key once
  (stored privately in Postgres, never shown or exported again), and the phone
  composites the scorebug onto its camera and broadcasts 720p30 straight to
  YouTube through the server. The director panel shows a live health chip
  (bitrate, uptime, drops).

Both roles use the same takeover model: joining with "take over" cleanly
revokes the old device, which immediately becomes read-only.

Overlay pages accept `?match=<id>`; without it they attach to the server's
most recently active match and automatically re-attach when a new match starts.

**Card carousel.** Add all the card overlays as stacked OBS sources and leave
them off: at every over break the cards automatically take turns on screen
(batting → bowling → summary, or the chase panel during a run chase; the full
carousel also runs through the innings break, and lineups show before play).
The moment the next ball is bowled they all clear. The director panel has the
on/off tile and the seconds-per-card setting; manually switching a card on
always wins over the carousel.

## Architecture

Event-sourced, deliberately boring:

```
console sends events ─▶ server validates ─▶ append to Postgres event rows
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
| `server/` | Express + Socket.IO server, Postgres persistence, PINs, QR |
| `client/` | All UI surfaces — vanilla ES modules, no build step |
| `config/` | `branding.json` |
| `docs/` | `CONTRACT.md` — the server↔client contract |
| `scripts/` | `demo.js` (seed data), `acceptance.js` |
| Docker volumes | Postgres data, Node dependencies, generated certs, and tool venv |

## Resilience

Community matches happen on flaky hotspots. Accordingly:

- **Every event hits Postgres immediately** in an append-only event table.
  Undo/edit rewrite the event rows transactionally, so a crash cannot leave a
  half-written match log.
- **Restart and resume.** Restart the Docker stack and the match is exactly
  where it was. A failed write is not acknowledged to the scorer.
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

## Docker Operations

The full Docker-only setup and operations guide is in **[DOCKER.md](DOCKER.md)**.
The legacy hosting guide has been reduced to this local Docker path so the app
does not spill dependencies into the host OS.

## Configuration

- **Port:** Nginx exposes host ports `3333` for HTTP and `3443` for HTTPS.
- **Branding** (org name, footer line, logo, accent colour, up to 3 sponsor
  logos): edit it live at `/settings`. Applies to all overlays and the live page.
- **Data location:** match history lives in the `postgres_data` Docker volume.

## Design decisions

- **Postgres for persistence.** Matches are stored as durable event rows in the
  private Postgres container.
- **Event log + pure reduce, not mutable state.** Scoring mistakes are a fact
  of life; replaying an amended log is the only edit model that's always
  consistent.
- **Vanilla JS, no build step.** Docker runs the Node server directly with hot
  reload in development.
  Volunteers can read and tweak every file, and OBS's embedded Chromium is
  old enough that a small, boring dependency surface is a feature.
- **Socket.IO rather than raw WebSockets.** Auto-reconnect, per-message ack
  callbacks, and transport fallbacks matter more than elegance on pavilion
  Wi-Fi.

MIT licensed.
