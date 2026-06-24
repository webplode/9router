# Docker

Run 9Router in a container. Published image: [`decolua/9router`](https://hub.docker.com/r/decolua/9router) — multi-platform `linux/amd64` + `linux/arm64`.

---

# 👤 For Users

## Persistent Docker Compose stack (recommended)

Build from this repo (or use the pull override) with a **named volume** so SQLite, settings, OAuth tokens, and certs survive restart, rebuild, and `docker compose up`:

```bash
# From repo root (9router/)
docker compose up -d --build
```

- UI: http://localhost:20128
- Data volume: `9router-data` → container `/app/data` (`DATA_DIR`)
- Policy: `restart: unless-stopped`

**Use published image (no local build):**

```bash
docker compose -f docker-compose.yml -f docker-compose.pull.yml up -d
```

**Rebuild app, keep data:**

```bash
docker compose up -d --build
# volume 9router-data is unchanged
```

**Stop without deleting data:**

```bash
docker compose down
# do NOT use: docker compose down -v   # -v removes named volumes
```

**Bind mount instead of named volume** (edit `docker-compose.yml`): comment `9router-data:` volume line and use:

```yaml
volumes:
  - ./data/9router:/app/data
```

Host path then mirrors `DOCKER.md` layout: `db/data.sqlite`, `jwt-secret`, `mitm/`, etc.

Optional env: copy `.env.docker.example` → `.env` and set `PORT`.

## Quick start (single `docker run`)

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  decolua/9router:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  decolua/9router:latest
```

## Optional Headroom sidecar

The 9Router image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    image: decolua/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull decolua/9router:latest
docker rm -f 9router
# re-run the quick start command
```

---

# 🛠 For Developers

## Why builds feel slow

Docker build time is mostly:

1. **`npm install`** — full dependency tree (Next, React, Monaco, optional native packages, etc.).
2. **`npm run build`** — Next.js **webpack** production compile (dashboard + all API routes).

The Dockerfile installs `python3`, `make`, `g++`, and `linux-headers` in the builder stage so optional native modules such as `better-sqlite3` and platform packages can compile on multi-arch builds. The final runtime image copies the Next **standalone** output, not the full builder toolchain. Rebuilds are faster with BuildKit cache (`--mount=type=cache` on npm). Use **`docker compose build`** only when code changes; data volume is unchanged.

## Build image locally (test)

```bash
docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router
```

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to:
- `ghcr.io/decolua/9router:v{version}` + `:latest`
- `decolua/9router:v{version}` + `:latest`

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.4.x && git push origin v0.4.x
```

Workflow: `app/.github/workflows/docker-publish.yml`
