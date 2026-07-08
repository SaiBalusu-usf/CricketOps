# Docker-Only Local Setup

This project is intended to run locally through Docker. Nothing needs to be
installed into macOS except Docker Desktop.

## First Run

1. Copy the Docker environment file:

   ```sh
   cp .env.docker.example .env
   ```

2. Edit `.env` and set `LAN_IP` to your laptop's Wi-Fi/hotspot IP.
   Keep these aligned:

   ```sh
   LAN_IP=192.168.1.50
   PUBLIC_HTTP_ORIGIN=http://192.168.1.50:3333
   PUBLIC_HTTPS_ORIGIN=https://192.168.1.50:3443
   ```

3. Start the stack:

   ```sh
   docker compose up --build
   ```

4. Seed the demo match:

   ```sh
   docker compose exec app npm run demo
   ```

## URLs

- Laptop: `http://localhost:3333`
- Phones on the same network: `http://<laptop-ip>:3333`
- Phone camera streaming: `https://<laptop-ip>:3443/stream/<matchId>`
- Local CA download: `http://<laptop-ip>:3333/__ca.crt`

Phones must trust the generated local CA once before browser camera access will
work over the direct HTTPS URL.

## Docker Layout

- Only `nginx` publishes host ports: `3333:80` and `3443:443`.
- `app` is reachable only inside Docker as `app:3333`.
- `postgres` is reachable only inside Docker as `postgres:5432`.
- `db_net` is internal; Postgres is not exposed to the host.
- `app_net` allows app egress so ffmpeg can publish RTMP to YouTube.

## Common Commands

```sh
docker compose ps
docker compose exec app npm test
docker compose exec app npm run acceptance
docker compose --profile test run --rm test
docker compose --profile debug run --rm db-debug psql
```
