# Streaming a match to YouTube — the complete beginner guide

This walks you from nothing to a live YouTube stream with a professional score
overlay, using one laptop, one camera, and a phone hotspot. It assumes you can
already run the scoring app (`npm start` — see [README.md](README.md)).

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

## 2. OBS setup

Install **OBS Studio** — free, open source, from
[obsproject.com](https://obsproject.com). Run its auto-configuration wizard
once ("Optimize for streaming") and then set up one scene with three things:

### Camera

- **USB webcam:** in OBS, **Sources → + → Video Capture Device**, pick the
  camera. Simplest and most reliable option.
- **Phone as camera** (better lens, but more moving parts — be honest with
  yourself about complexity on match day):
  - **DroidCam** (Android/iOS): phone app + OBS plugin/client. The free tier
    is limited to 480p; HD needs the paid version.
  - **IP Webcam** (Android, free): the phone serves a video URL on your
    hotspot; add it in OBS as a **Media Source** (or Browser source) pointing
    at the URL the app shows.
  - **Check the app's current terms before match day** — free tiers and
    limits change often.
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

- [ ] Charge: laptop, camera/phone-camera, scorer's phone, hotspot phone. Bring a power bank.
- [ ] Start the hotspot; connect the **laptop** to it.
- [ ] On the laptop: `npm start` in the CricketOps folder.
- [ ] Create the match at `http://localhost:3333` → **write down both PINs** (shown once).
- [ ] Scorer's phone: same hotspot → scan the QR on the landing page → console → scorer PIN.
- [ ] Score one practice ball, see it on the overlay, then **undo** it.
- [ ] OBS scene check: camera framed, overlay on top, mic meter moving.
- [ ] **Record 30 seconds** (Start Recording, not streaming) and play it back — picture and sound.
- [ ] YouTube Studio → Go live; Start Streaming in OBS; confirm the dashboard shows green.
- [ ] Start scoring for real.
- [ ] Share the spectator link: `http://<laptop-LAN-address>:3333/live/<matchId>` on the hotspot, or a
      `trycloudflare.com` link for the outside world (see README, "Letting people watch from anywhere").

## 5. Troubleshooting

**Overlay has a black/white background instead of transparent**
Use an `/overlay/...` page URL, not `/live/...` — the live scorecard is a
normal web page, not an overlay. Then right-click the Browser source →
**Refresh cache of current page**. Last resort: in the director panel set the
theme to **chroma** (solid green background) and add a Color Key filter in
OBS keyed to green.

**Scorer's phone can't reach the laptop**
- Both devices must be on the **same** hotspot/Wi-Fi.
- Windows: the first `npm start` pops a firewall prompt — allow Node.js on
  **private networks**. If you dismissed it: Windows Security → Firewall →
  Allow an app → Node.js.
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
server keeps every ball on disk, so the overlay comes back at the correct
live score. Same cure if you restarted the server mid-match — the match
resumes automatically.
