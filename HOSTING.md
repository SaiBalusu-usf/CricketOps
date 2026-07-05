# Hosting & Operations Guide — ICAT Cricket Live

Every way to host the app, with exact steps, and how to run it **without
downtime**. Written for volunteers: copy-paste the commands for your option.

The app is one small Node process. Matches live as plain files in `data/` —
no database. Anything that runs Node 18+ can host it: your laptop, an old PC,
a Raspberry Pi, a Docker host, or a free cloud VM.

---

## 0. Choosing your setup

| You want | Use | Accounts needed | Cost |
|---|---|---|---|
| Score + stream a match at the ground | **A** (LAN) | none | free |
| …plus viewers/scorer from anywhere, and the camera phone | **A + B** (quick tunnel) | none | free |
| A permanent club site with a stable URL | **C or D** (named tunnel / home server) | free Cloudflare | free |
| Containers because you already run Docker | **E** | none | free |
| 24/7 site independent of your home | **F** (free cloud VM) | Oracle Cloud | free |

**Two rules that shape everything:**
1. **`data/` is the club's history.** Whatever you host on, that folder must
   persist and be backed up. (This is why "free web hosting" like
   Render/Railway/Fly free tiers are a bad fit — their disks are wiped on every
   redeploy/sleep — and GitHub Pages/Netlify can't run a server at all.)
2. **Phone cameras need HTTPS.** `/console`, `/live`, overlays — all fine on
   plain LAN HTTP. But phone browsers only unlock the **camera** (`/stream`)
   on `https://` pages or localhost. Options B/C/F give you HTTPS for free.

---

## A. Match-day baseline — laptop on the hotspot (LAN only)

1. Install [Node.js LTS](https://nodejs.org). Clone/unzip the repo, then:
   ```sh
   npm install     # once
   npm start
   ```
2. The terminal prints `Phones (LAN): http://<address>:3333` and a QR code.
   Wi-Fi adapters are listed first; ignore VPN-looking addresses (`10.x` from
   Tailscale or work VPNs is usually unreachable from phones).
3. **Open the firewall once** (phones time out without this):
   - **Windows** (admin PowerShell):
     ```powershell
     New-NetFirewallRule -DisplayName "ICAT Cricket Live 3333" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3333
     ```
     …and set your Wi-Fi network profile to **Private** (Settings → Network &
     Internet → Wi-Fi → your network).
   - **macOS:** System Settings → Network → Firewall → allow node, or turn the
     firewall off for the match.
   - **Linux:** `sudo ufw allow 3333/tcp` (if ufw is active).
4. Phones scan the QR from the landing page. Done — everything except the
   camera phone and remote spectators works at this tier.

**Anti-downtime at the ground:** plug the laptop in; disable sleep
(Windows: Settings → Power → "When plugged in, put my device to sleep: Never";
macOS: `caffeinate -s npm start`). If the server ever dies, `npm start` again —
**every ball is already on disk, the match resumes exactly, and every phone
reconnects by itself.** Recovery is ~5 seconds; nobody re-enters anything.

---

## B. Public HTTPS in one command — Cloudflare Quick Tunnel (no account)

Adds a temporary worldwide `https://` URL to whatever machine runs the app.

1. Install once:
   - **Windows:** `winget install Cloudflare.cloudflared`
   - **macOS:** `brew install cloudflared`
   - **Linux/Pi:** `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared` (pick your arch)
2. With the app running, in a second terminal:
   ```sh
   cloudflared tunnel --url http://localhost:3333
   ```
3. It prints `https://<random-words>.trycloudflare.com`. Share:
   - spectators → `https://…/live/<matchId>`
   - scorer anywhere → `https://…/console/<matchId>`
   - camera phone → `https://…/stream/<matchId>`  ← HTTPS makes the camera work
4. OBS on the same laptop keeps using `http://localhost:3333` — a tunnel
   hiccup can never freeze your overlay.

Limits, honestly: the URL changes every time the command restarts; it's
best-effort capacity (fine for a club match); WebSockets work.

**Keep it alive:** run it in a loop so a blip self-heals —
```powershell
while ($true) { cloudflared tunnel --url http://localhost:3333; Start-Sleep 2 }
```
(Linux/mac: `while true; do cloudflared tunnel --url http://localhost:3333; sleep 2; done`)
Note the URL changes if it does restart — for a stable URL, use option C.

---

## C. Stable public URL — Cloudflare Named Tunnel (free account, survives restarts)

Same tunnel, but with a fixed hostname and installed as a service.

1. Make a free Cloudflare account. A custom domain is optional — a free
   subdomain works if you add any domain later; otherwise use B for one-offs.
2. ```sh
   cloudflared tunnel login              # opens a browser to authorise
   cloudflared tunnel create cricket
   cloudflared tunnel route dns cricket score.yourdomain.org
   ```
3. Create the config (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: cricket
   credentials-file: /home/YOU/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: score.yourdomain.org
       service: http://localhost:3333
     - service: http_status:404
   ```
4. Install as an always-on service:
   - **Linux/Pi:** `sudo cloudflared service install && sudo systemctl enable --now cloudflared`
   - **Windows:** `cloudflared service install` (runs as a Windows service)

Now `https://score.yourdomain.org` is permanent: same URL every match, HTTPS
for the camera, no ports opened on your router.

---

## D. Permanent home server — Raspberry Pi / old PC / old laptop

The club archive stays up 24/7 on hardware you own.

1. **Install:** Node 18+ (`sudo apt install nodejs npm` on Pi OS/Ubuntu, or
   nodejs.org installers), optionally `sudo apt install ffmpeg` for phone-only
   broadcasting. Clone the repo, `npm install`, verify `npm start`.
2. **Supervise it** so it starts on boot and restarts on any crash:
   - **Linux/Pi — systemd.** `/etc/systemd/system/cricketops.service`:
     ```ini
     [Unit]
     Description=ICAT Cricket Live
     After=network.target

     [Service]
     WorkingDirectory=/home/pi/CricketOps
     ExecStart=/usr/bin/node server/index.js
     Restart=always
     RestartSec=2
     Environment=PORT=3333

     [Install]
     WantedBy=multi-user.target
     ```
     ```sh
     sudo systemctl daemon-reload
     sudo systemctl enable --now cricketops
     journalctl -u cricketops -f        # live logs
     ```
   - **Windows.** Two options:
     - *Task Scheduler:* Create Task → Run whether user is logged on or not →
       Trigger "At startup" → Action `node.exe` with argument
       `server\index.js`, "Start in" = the repo folder → Settings tab: restart
       every 1 minute up to 3 times.
     - *NSSM* (nicer — real service): `winget install NSSM`, then
       `nssm install CricketOps "C:\Program Files\nodejs\node.exe" server\index.js`
       and set AppDirectory to the repo folder. `nssm start CricketOps`.
3. **Stop the box sleeping:** Pi never sleeps; Windows → power settings →
   never sleep on AC; laptop-as-server → also "do nothing on lid close".
4. **Reach it:** LAN address for home use, plus option **B or C** for public
   access (run cloudflared under the same supervisor).
5. **Move matches in:** score at the ground on the laptop, then use the
   export button (or `/api/matches/<id>/export`) and import on the home
   server from `/matches` → Import.

---

## E. Docker / Docker Compose

A `Dockerfile` and `compose.yaml` ship in the repo (ffmpeg included in the
image, so Tier-2 phone broadcasting works out of the box).

```sh
docker compose up -d          # builds and starts; http://localhost:3333
docker compose logs -f        # watch
```

The compose file maps `./data` and `./config` from the host — **match history
survives image rebuilds and updates** — and sets `restart: unless-stopped`, so
Docker restarts the app after crashes and reboots. Update procedure:

```sh
git pull
docker compose up -d --build   # ~seconds of restart; clients auto-reconnect
```

---

## F. Free 24/7 cloud VM (Oracle Cloud "Always Free")

The one genuinely free-forever cloud option with a persistent disk,
WebSockets, and root access for ffmpeg.

1. Create an Oracle Cloud account → Compute → Create instance → shape
   **VM.Standard.A1.Flex** (Always Free ARM), Ubuntu image, add your SSH key.
2. Open the port, **twice** (Oracle needs both layers):
   - Console → your instance's subnet → Security List → add Ingress rule:
     TCP, source `0.0.0.0/0`, destination port `3333` (or 80/443 if using Caddy).
   - On the VM: `sudo iptables -I INPUT -p tcp --dport 3333 -j ACCEPT` (and
     persist with `sudo netfilter-persistent save`, or use ufw).
3. Install and run:
   ```sh
   sudo apt update && sudo apt install -y nodejs npm ffmpeg git
   git clone https://github.com/SaiBalusu-usf/CricketOps.git && cd CricketOps
   npm install
   ```
   …then the exact systemd unit from option D (adjust paths).
4. **HTTPS + a name** (needed for the camera page, nicer for everyone):
   - Free hostname: create one at DuckDNS (`yourclub.duckdns.org` → VM IP).
   - One-command TLS with Caddy (single binary, auto-renews certificates):
     ```sh
     sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
     curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
     curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
     sudo apt update && sudo apt install caddy
     ```
     `/etc/caddy/Caddyfile`:
     ```
     yourclub.duckdns.org {
         reverse_proxy localhost:3333
     }
     ```
     `sudo systemctl reload caddy` → `https://yourclub.duckdns.org` is live.

---

## G. Running without downtime — the operations playbook

The app was designed so that *restarts are cheap*: every ball is written to
disk **before** the scorer's phone gets its confirmation, state is rebuilt
from the log on boot, and every client (console, overlays, director, live
pages) reconnects and re-syncs automatically. "No downtime" therefore means:
restart fast, restart automatically, and never lose `data/`.

**1. Automatic restarts** — covered per option above (systemd `Restart=always`,
Docker `restart: unless-stopped`, Task Scheduler/NSSM retry, hotspot loop for
cloudflared). This is the single highest-value setting.

**2. Health monitoring.** The server exposes `GET /healthz` → `{"ok":true}`.
   - Free external monitor: UptimeRobot (free plan) pinging
     `https://your-url/healthz` every 5 minutes, emailing you on failure.
   - Local watchdog (belt and braces, cron every minute):
     ```sh
     * * * * * curl -fsS -m 5 http://localhost:3333/healthz >/dev/null || systemctl restart cricketops
     ```

**3. Backups.** Everything is in `data/` (plus `config/branding.json`).
   - Nightly copy (Linux): `0 3 * * * rsync -a /home/pi/CricketOps/data/ /home/pi/backup/cricket-data/`
   - Or per-match: the export button downloads one self-contained JSON that
     re-imports anywhere. Do this after every match as the off-site backup.

**4. Updates without visible downtime.** There is no long build step:
   ```sh
   git pull && npm install --omit=dev && sudo systemctl restart cricketops
   ```
   The restart takes ~2 seconds; phones show a brief "reconnecting" dot and
   resume. During a match, do updates at an innings break — or simply don't:
   nothing requires updating mid-match.

**5. Match-day redundancy** (the failure that actually matters is at the ground):
   - Laptop plugged in; hotspot phone plugged in; power bank for both.
   - The scorer's console **keeps scoring even if the server is unreachable**
     — balls queue on the phone and flush on reconnect, with a review sheet if
     anything conflicts. A server blip never loses balls.
   - If the laptop dies entirely: install Node on a second laptop beforehand,
     keep a copy of the repo on a USB stick, restore the latest match export —
     back live in under five minutes.
   - Run the LAN **and** the tunnel simultaneously; if the hotspot's internet
     drops, LAN scoring and OBS overlays continue untouched (only remote
     viewers and YouTube are affected — YouTube resumes when the uplink does).

**6. Port conflicts.** If `npm start` says the port is busy, another copy is
running — the message tells you; either close it or `PORT=3444 npm start`.

---

## H. Troubleshooting quick table

| Symptom | Fix |
|---|---|
| Phones can't open the LAN URL | Firewall rule (A.3), network profile → Private, avoid VPN adapters, or router client isolation → use a phone hotspot |
| Camera page won't open the camera | You're on plain HTTP — use the tunnel's `https://` URL (B/C/F) |
| Tunnel URL stopped working | Quick tunnels rotate on restart — rerun and reshare, or move to a named tunnel (C) |
| `EADDRINUSE` on start | Another copy is running; close it or use `PORT=3444 npm start` |
| Overlay frozen in OBS | Right-click source → Refresh cache; the server auto-resumes state |
| Wrong match on overlays | Pin the source URL with `?match=<id>` (copy buttons on the landing page do this) |
| Server died mid-match | Start it again — the match resumes from disk exactly where it was |
