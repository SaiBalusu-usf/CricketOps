# Hosting & Operations Guide — ICAT Cricket Live

CricketOps now runs as a Docker-only local stack. No Node, Postgres, ffmpeg,
Python venv, or tunnel tooling should be installed into the host OS.

## Services

- `nginx`: the only public entrypoint, exposing `3333:80` and `3443:443`.
- `app`: Node server with hot reload and ffmpeg, reachable only inside Docker.
- `postgres`: private Postgres database on `db_net`, with persistent volume.
- `certs`: generates the local CA/server certificate into a Docker volume.
- `tools`: optional Python utility container with `/venv` in a Docker volume.
- `db-debug`: optional profile for direct Postgres inspection inside Docker.

## Local Network Setup

1. Copy and edit the environment file:

   ```sh
   cp .env.docker.example .env
   ```

2. Set `LAN_IP` to the laptop IP on the match Wi-Fi/hotspot, and keep the
   public origins aligned:

   ```sh
   LAN_IP=192.168.1.50
   PUBLIC_HTTP_ORIGIN=http://192.168.1.50:3333
   PUBLIC_HTTPS_ORIGIN=https://192.168.1.50:3443
   ```

3. Start the stack:

   ```sh
   docker compose up --build
   ```

4. Open:

   - laptop: `http://localhost:3333`
   - phones: `http://<laptop-ip>:3333`
   - phone camera: `https://<laptop-ip>:3443/stream/<matchId>`

Phones must trust the generated local CA once. Download it from
`http://<laptop-ip>:3333/__ca.crt`.

## Match-Day Commands

```sh
docker compose ps
docker compose exec app npm run demo
docker compose exec app npm test
docker compose exec app npm run acceptance
```

## Backups

Match history lives in the `postgres_data` Docker volume. The safest per-match
backup is still the export button, which downloads a self-contained match JSON
that can be imported into another CricketOps stack.

For whole-stack backup, export the Postgres database from the debug profile:

```sh
docker compose --profile debug run --rm db-debug \
  pg_dump -h postgres -U "$POSTGRES_USER" "$POSTGRES_DB" > cricketops.sql
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone cannot open the LAN URL | Confirm same Wi-Fi/hotspot, macOS firewall, and `LAN_IP` in `.env` |
| Camera blocked | Use `https://<laptop-ip>:3443` and trust `__ca.crt` on the phone |
| OBS overlay frozen | Refresh the OBS Browser Source |
| Wrong match on overlays | Use `?match=<id>` in the overlay URL |
| YouTube streaming fails | Confirm app logs show ffmpeg and the network allows outbound RTMP |
