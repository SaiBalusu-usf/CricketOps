# Streaming a match to YouTube — the complete beginner guide

This walks you from nothing to a live YouTube stream with a professional score
overlay, using one laptop, one camera, and a phone hotspot. It assumes you can
already run the Docker stack — see [README.md](README.md).

**Read section 1 today, even if the match is next month.**

## 1. One-time YouTube setup (do this DAYS before the match)

1. Sign in to YouTube with the channel you'll stream on. If the channel is
   brand new, YouTube may ask you to verify it with a phone number:
   [youtube.com/verify](https://www.youtube.com/verify).
2. Go to **YouTube Studio → Create → Go live** and enable live streaming.

**⚠️ The first time you enable live streaming, YouTube makes you wait
~24 hours before you can go live. There is no way around it. Enable it days
before your first match, not at the ground.**

Good news: streaming from **encoder software (OBS)** — which is what this
guide uses — has **no subscriber minimum**. The follower/subscriber
requirements you may have heard about apply to streaming from the YouTube
*mobile app*, which we don't use.

## Option B — stream from a phone, no laptop at the ground

> **HTTPS note:** phone browsers only unlock the camera on `https://` pages
> (or localhost). On plain LAN HTTP the `/stream` page cannot open the camera —
> use the Docker Nginx HTTPS entrypoint:
> `https://<laptop-ip>:3443/stream/<matchId>`. The phone must trust the local
> CA from `http://<laptop-ip>:3333/__ca.crt` once.

Because the Docker app container includes **ffmpeg**, you can skip OBS entirely:

1. Open `https://<laptop-ip>:3443/stream/<matchId>` on the camera phone
   and join with the **director PIN**.
2. Tap **Broadcast…** → paste the stream key from YouTube Studio
   (**Create → Go live → Streaming software**) → **Save key**. The key is
   stored on the server only — it is never shown again, never exported, and
   never appears in any page.
3. Tap **GO LIVE ON YOUTUBE**. The phone composites the live scorebug onto
   its camera (720p30, ~2.5 Mbps) and broadcasts through the server. Keep the
   phone plugged in and **keep the page in the foreground** — the page warns
   you if it goes to the background, and the director panel shows a live
   health chip (bitrate · uptime · drops).
4. To stop: **STOP BROADCAST**. If the connection blips, the stream resumes
   by itself after a short gap.

If outbound RTMP is blocked by the network, the same page still works as the
wireless camera for OBS (Option A below).

## 2. OBS setup

Install **OBS Studio** — free, open source, from
[obsproject.com](https://obsproject.com). Run its auto-configuration wizard
once ("Optimize for streaming") and then set up one scene with three things:

### Camera

- **Phone as camera — built in, free, HD (recommended):** open
  `https://<laptop-ip>:3443/stream/<matchId>` on the camera phone, enter
  the **director PIN**, and the phone becomes a wireless camera. In OBS add
  **Sources → + → Browser** with URL
  `http://localhost:3333/stream/program?match=<matchId>`, width 1920,
  height 1080 — the phone's camera appears as a clean feed over your
  hotspot (no third-party apps, no 480p limits, no watermarks). The phone
  shows a live program preview with the scorebug so the streamer can frame
  the shot. If the feed drops, the page shows a "reconnecting…" slate and
  recovers by itself.
- **USB webcam:** **Sources → + → Video Capture Device**, pick the camera.
  Simplest wiring of all, if the lens is good enough.
- The zero-software option: a cheap **HDMI capture card** plus a
  phone/camcorder with HDMI out shows up in OBS as a normal Video Capture
  Device.
- Test whatever you choose at home first, on the hotspot you'll actually use.

### Microphone

**Sources → + → Audio Input Capture**, pick your mic (or the webcam's
built-in one). Watch the audio meter move when you talk.

### Score overlay (this app)

1. **Sources → + → Browser**, name it `overlay`.
2. **URL:** `http://localhost:3333/overlay/full`
   (or `http://localhost:3333/overlay/scorebug` if you only want the score
   bar and nothing else).
3. **Width 1920, Height 1080.**
4. Leave **"Shutdown source when not visible" OFF** — the overlay stays
   connected and never misses a ball.
5. The page background is transparent automatically — no chroma key needed.
6. Drag the overlay **above** the camera in the Sources list.

`/overlay/full` is the single-source setup: scorebug, all the info cards, the
ticker, and the boundary/wicket stinger animations, all driven remotely from
the director panel and the scorer's console. Optionally you can instead add
separate Browser Sources for `/overlay/summary`, `/overlay/batting`,
`/overlay/bowling`, `/overlay/lineups`, `/overlay/target` — the director's
toggles show and hide each one.

## 3. Stream settings for a phone hotspot

In **OBS → Settings**:

- **Video:** Output (Scaled) Resolution **1280×720**, FPS **30**.
- **Output → Streaming:**
  - Video bitrate **2500–3500 kbps**
  - Audio bitrate **128 kbps**
  - Encoder: **x264** with preset **veryfast** — or a hardware encoder
    (NVENC / AMD / Apple) if OBS offers one; hardware is easier on the laptop.
  - Keyframe interval **2 s** (in x264 settings; YouTube wants this).
- Only go 1080p if you're on a strong, tested connection. A steady 720p
  always looks better than a stuttering 1080p.

Connect it to YouTube:

1. YouTube Studio → **Create → Go live** → **Streaming software** tab. Copy
   the **Stream key**.
2. OBS → **Settings → Stream** → Service **YouTube**, paste the key.
3. Click **Start Streaming** in OBS, then watch the stream health in the
   YouTube Studio live dashboard.

Remember the 24–48 hour first-time activation from section 1 — the dashboard
simply won't offer "Go live" until it's done.

## 4. Match-day checklist

Print this.

- [ ] Charge: laptop, **streamer phone** (bring its cable — it films the whole match), scorer's phone, hotspot phone. Bring a power bank.
- [ ] Start the hotspot; connect the **laptop** to it.
- [ ] On the laptop: `docker compose up --build` in the CricketOps folder.
- [ ] Create the match at `http://localhost:3333` → **write down both PINs** (shown once).
- [ ] Scorer's phone: same hotspot → scan the QR on the landing page → console → scorer PIN.
- [ ] Streamer phone: open `/stream/<matchId>` → director PIN → frame the pitch; **keep the page foregrounded**, disable auto-lock.
- [ ] Score one practice ball, see it on the overlay, then **undo** it.
- [ ] OBS scene check: camera framed (or `/stream/program` source live), overlay on top, mic meter moving.
- [ ] Phone-only broadcast? Test **GO LIVE → 30 seconds → STOP** once; check the health chip on the director panel.
- [ ] **Record 30 seconds** (Start Recording, not streaming) and play it back — picture and sound.
- [ ] YouTube Studio → Go live; Start Streaming in OBS; confirm the dashboard shows green.
- [ ] Start scoring for real.
- [ ] Share the spectator link on the hotspot:
      `http://<laptop-LAN-address>:3333/live/<matchId>`.

## 5. Troubleshooting

**Overlay has a black/white background instead of transparent**
Use an `/overlay/...` page URL, not `/live/...` — the live scorecard is a
normal web page, not an overlay. Then right-click the Browser source →
**Refresh cache of current page**. Last resort: in the director panel set the
theme to **chroma** (solid green background) and add a Color Key filter in
OBS keyed to green.

**Scorer's phone can't reach the laptop**
- Both devices must be on the **same** hotspot/Wi-Fi.
- If the OS firewall prompts, allow Docker Desktop/Nginx on private networks.
- Some venue/carrier hotspots have **client isolation** (devices can't see
  each other). Fix: use a phone's own hotspot instead of venue Wi-Fi.
- Type the exact `Phones (LAN):` URL from the server terminal, not
  `localhost` (localhost only works on the laptop itself).

**YouTube says dropped frames / stream keeps buffering**
Lower the video bitrate to **2000 kbps**; if still bad, drop to 540p. Move
the laptop closer to the hotspot phone, or the hotspot phone somewhere with
better signal. Keep them off a hot dashboard — phones throttle in the sun.

**"Invalid stream key"**
Re-copy the key from YouTube Studio → Go live → Streaming software. No
leading/trailing spaces. Keys can be reset from that page if in doubt.

**Overlay is frozen / stuck on an old score**
Right-click the Browser source → **Refresh cache of current page**. The
server keeps every ball in Postgres, so the overlay comes back at the correct
live score. Same cure if you restarted the Docker stack mid-match — the match
resumes automatically.
