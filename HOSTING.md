# Hosting ICAT Cricket Live — free, real-time, minimal dependencies

The app is one small Node process with its own on-disk storage — no database,
no build step, no API keys. Anything that can run Node 18+ can host it. Pick
the tier that matches your ambition; every tier below is free.

> **The HTTPS rule (read this first).** Phone browsers only allow the camera
> (`/stream`), wake-lock, and one-tap link sharing on **HTTPS** pages (or
> `localhost`). Scoring at `/console` works fine over plain LAN HTTP — but the
> moment you want the **streamer phone camera** or **spectators outside your
> Wi-Fi**, you want the tunnel from Tier 1. It gives you a real `https://` URL
> with zero configuration.

---

## Tier 1 — Match-day hosting from the laptop (no account, no cost, 2 minutes)

What you already do, plus one command. The laptop at the ground runs the
server; a **Cloudflare Quick Tunnel** gives it a temporary public HTTPS URL.

1. Install the tunnel client once:
   - **Windows:** `winget install Cloudflare.cloudflared`
   - **macOS:** `brew install cloudflared`
   - **Linux/Pi:** download from developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Start the app: `npm start`
3. In a second terminal: `cloudflared tunnel --url http://localhost:3333`
4. It prints something like `https://random-words.trycloudflare.com` — that URL
   is your live site: `…/live/<matchId>` for spectators anywhere,
   `…/console/<matchId>` for the scorer, `…/stream/<matchId>` for the camera
   phone (HTTPS → the camera works).

Facts to know: **no account is needed**, WebSockets work, the URL changes
every run (share it in the group chat each match), and OBS on the laptop keeps
using `http://localhost:3333` — zero latency, tunnel outages can't touch your
overlay. This is the recommended way to run an actual match.

---

## Tier 2 — Permanent self-host on hardware you own (no third party at all)

An old laptop, mini-PC, or Raspberry Pi at home becomes the club server —
matches, history, and the public site stay up 24/7 on your own metal.

1. Install Node 18+ (and optionally ffmpeg for phone-only broadcasting).
2. Clone the repo, `npm install`, confirm `npm start` works.
3. Keep it alive across reboots:
   - **Linux / Raspberry Pi (systemd)** — create `/etc/systemd/system/cricketops.service`:
     ```ini
     [Unit]
     Description=ICAT Cricket Live
     After=network.target

     [Service]
     WorkingDirectory=/home/pi/CricketOps
     ExecStart=/usr/bin/node server/index.js
     Restart=always
     Environment=PORT=3333

     [Install]
     WantedBy=multi-user.target
     ```
     then `sudo systemctl enable --now cricketops`.
   - **Windows:** Task Scheduler → new task → run `node server\index.js` in the
     repo folder, trigger "At startup", enable restart-on-failure.
4. Reachability, choose one:
   - **Zero-config again:** run `cloudflared tunnel --url http://localhost:3333`
     under the same supervisor. Same caveat — the URL rotates on restart.
   - **Stable free URL:** make a free Cloudflare account, create a **named
     tunnel** (`cloudflared tunnel create cricket`), and map it to a free
     `*.cfargotunnel.com` hostname or your own domain. Survives restarts with
     the same address, still no port-forwarding, HTTPS included.
   - **Old-school:** router port-forward 3333 + a free dynamic-DNS name
     (e.g. DuckDNS). Plain HTTP only — fine for `/live` and `/console`, but
     the camera page will refuse to run without HTTPS; add a named tunnel or a
     reverse proxy with a certificate if you need `/stream` remotely.

Your data lives in `data/` — back it up by copying the folder, or use the
in-app export (every match is one JSON file).

---

## Tier 3 — Always-free cloud VM (public 24/7 site, survives your house Wi-Fi)

If you want a CricHeroes-style permanent site without keeping hardware on,
the only genuinely free-forever compute with **persistent disk + WebSockets**
is a free-tier VM (e.g. Oracle Cloud "Always Free" ARM shapes; requires
creating an account). Once you have any Ubuntu VM:

```sh
sudo apt update && sudo apt install -y nodejs npm ffmpeg
git clone https://github.com/SaiBalusu-usf/CricketOps.git && cd CricketOps
npm install
# systemd unit exactly as in Tier 2, then open port 3333 in the VM firewall
```

For HTTPS + a clean domain on a VM, the lightest path is **Caddy** (a single
binary): `caddy reverse-proxy --from yourname.duckdns.org --to localhost:3333`
gets you an auto-renewing certificate with one command.

**Why not the popular free PaaS options?** Render/Railway/Fly free tiers have
**ephemeral disks** (your `data/` — the match history — vanishes on every
redeploy or sleep) and idle your process so the first visitor waits ~30 s and
live sockets drop. GitHub Pages/Netlify are static-only and cannot run the
server at all. The app deliberately stores everything in plain files so a
real disk — laptop, Pi, or VM — is all it needs.

---

## Which tier should ICAT use?

- **Every match:** Tier 1. The laptop is already at the ground for OBS; the
  quick tunnel adds worldwide `/live` access and HTTPS for the camera phone.
- **Between matches:** Tier 2 on any spare machine keeps `/matches` (the
  archive) permanently browsable — import finished matches into it with the
  export/import buttons.
- **Only if the club outgrows that:** Tier 3.
