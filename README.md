# Claude Code Container Deployer

A Telegram bot that provisions isolated Claude Code containers on-demand, giving each user their own persistent Claude Code session accessible via browser through [Remote Control](https://docs.anthropic.com/en/docs/claude-code/remote).

## How It Works

```
User → /login (TOTP) → /start → Bot provisions container
                                   → Injects credentials & config
                                   → Starts claude remote-control
                                   → Returns browser URL to user
User → Opens URL → Full Claude Code session in browser
User → /stop → Bot kills remote-control + stops container
```

Each user gets:
- **Isolated container** with Claude Code installed (native binary)
- **Persistent workspace** — files survive container restarts
- **Persistent Claude config** — authentication carries over
- **Browser-based access** via Claude Remote Control URL
- **TOTP authentication** — only authorized users can start sessions

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│  Telegram    │────▶│   Bot Container   │────▶│  Runner Container(s) │
│  User        │◀────│  (orchestrator)   │     │  (Claude Code)       │
└─────────────┘     │                    │     │                      │
                    │ - grammY bot       │     │ - claude binary      │
                    │ - SQLite DB        │     │ - kubectl            │
                    │ - Docker/K8s API   │     │ - git                │
                    └──────────────────┘     └──────────────────────┘
```

**Two runtime modes:**
- **Docker** — for local development (`docker compose up`)
- **Kubernetes** — for production (one deployment per user)

## Prerequisites

- **Claude Code account** with an active subscription (Pro/Team/Enterprise)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **Docker** (for local dev) or **Kubernetes cluster** (for production)
- **Claude credentials** from `claude auth login` on your local machine

### Getting Claude Credentials

Claude Remote Control requires OAuth tokens with full scopes (`user:sessions:claude_code`). The `setup-token` command only grants `user:inference` which is **not enough**.

You need to use the credentials from a full interactive login:

```bash
# On your local machine, run:
claude auth login

# This creates two files:
# ~/.claude/.credentials.json  — OAuth tokens (full scopes)
# ~/.claude.json               — Config with feature flags
```

Both files are needed. The bot copies and patches them into each runner container.

## Quick Start (Docker)

### 1. Clone and configure

```bash
git clone https://github.com/adaniki-dev/claude-code-container-deployer.git
cd claude-code-container-deployer
cp .env.example .env
```

### 2. Edit `.env`

```env
# Required
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
ENCRYPTION_KEY=your-32-byte-hex-key
ALLOWED_USER_IDS=123456789

# Runtime
RUNTIME_MODE=docker
RUNNER_CONTAINER_NAME=claude-runner
DOCKER_NETWORK=claude-code-on-kluster_default
RUNNER_IMAGE=claude-code-on-kluster-runner:latest

# Claude credentials (recommended — full scopes for remote-control)
CLAUDE_CREDENTIALS_PATH=/home/youruser/.claude/.credentials.json
CLAUDE_CONFIG_PATH=/home/youruser/.claude.json
```

Generate the encryption key:

```bash
openssl rand -hex 32
```

Get your Telegram user ID: message [@userinfobot](https://t.me/userinfobot) on Telegram.

### 3. Check Docker GID

The bot needs access to the Docker socket. Match the GID:

```bash
# Linux
stat -c '%g' /var/run/docker.sock

# macOS
stat -f '%g' /var/run/docker.sock
```

If the GID is not `1001`, set it in `.env`:

```env
DOCKER_GID=999  # replace with your actual GID
```

### 4. Start

```bash
docker compose up --build
```

### 5. Use

1. Open your Telegram bot
2. `/login` — bot sends QR code, scan with authenticator app (Google Authenticator, Authy, etc.)
3. Enter the 6-digit TOTP code
4. `/start` — bot provisions container and returns a Remote Control URL
5. Open the URL in your browser — full Claude Code session
6. `/stop` — stops the session (workspace is preserved)

## Kubernetes Deployment

### 1. Create namespace and resources

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/runner-rbac.yaml
```

### 2. Create secrets

Edit `k8s/secrets.yaml` and replace the `REPLACE_ME` placeholders with base64-encoded values:

```bash
# Encode your values
echo -n "your-telegram-token" | base64
echo -n "your-encryption-key" | base64
cat ~/.claude/.credentials.json | base64 -w0
cat ~/.claude.json | base64 -w0
```

```bash
kubectl apply -f k8s/secrets.yaml
```

### 3. Create configmap

Edit `k8s/configmap.yaml` with your settings:

```yaml
data:
  ALLOWED_USER_IDS: "your-telegram-id"
  K8S_NAMESPACE: "claude-sessions"
  RUNNER_IMAGE: "your-runner-image:latest"
  RUNTIME_MODE: "k8s"
  LOG_LEVEL: "info"
```

```bash
kubectl apply -f k8s/configmap.yaml
```

### 4. Build and load images

```bash
# Build images
docker build -t claude-bot:latest ./bot
docker build -t claude-runner:latest ./runner

# For Docker Desktop Kubernetes:
# Images are shared between Docker and K8s — no extra steps needed.

# For other local clusters (kind, minikube, k3s):
# Load images into the cluster's container runtime.
# Example for containerd-based clusters:
docker save claude-bot:latest | ctr -n k8s.io images import --all-platforms -
docker save claude-runner:latest | ctr -n k8s.io images import --all-platforms -
```

### 5. Deploy

```bash
kubectl apply -f k8s/bot-pvc.yaml
kubectl apply -f k8s/bot-deployment.yaml
```

### How K8s mode works

- Each `/start` creates a **Deployment** (`claude-session-<telegramId>`) with 1 replica
- Each user gets **two PVCs**: workspace (`claude-workspace-<id>`) and config (`claude-config-<id>`)
- `/stop` scales the deployment to 0 (PVCs persist)
- Next `/start` scales back to 1 — workspace and auth are preserved
- Runner pods use `serviceAccountName: claude-runner` with cluster-scoped RBAC
- Bot communicates with runners via `kubectl exec`

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `ENCRYPTION_KEY` | Yes | — | 32-byte hex key for TOTP encryption |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs |
| `RUNTIME_MODE` | No | `k8s` | `docker` or `k8s` |
| `CLAUDE_CREDENTIALS_PATH` | No* | — | Path to `~/.claude/.credentials.json` |
| `CLAUDE_CONFIG_PATH` | No* | — | Path to `~/.claude.json` |
| `CLAUDE_CODE_OAUTH_TOKEN` | No* | — | OAuth token (limited scopes) |
| `RUNNER_IMAGE` | No | `ghcr.io/...` | Runner container image |
| `RUNNER_CONTAINER_NAME` | No | `claude-runner` | Docker container name prefix |
| `DOCKER_NETWORK` | No | `claude-code-on-kluster_default` | Docker network name |
| `K8S_NAMESPACE` | No | `claude-sessions` | Kubernetes namespace |
| `DB_PATH` | No | `/data/bot.db` | SQLite database path |
| `LOG_LEVEL` | No | `info` | Log level (debug, info, warn, error) |

\* **Authentication**: `CLAUDE_CREDENTIALS_PATH` + `CLAUDE_CONFIG_PATH` is the recommended approach (full scopes, supports remote-control). `CLAUDE_CODE_OAUTH_TOKEN` is a fallback with limited scopes.

## Security Model

- **TOTP authentication** — users must register with an authenticator app before starting sessions
- **User allowlist** — only `ALLOWED_USER_IDS` can interact with the bot
- **Encrypted secrets** — TOTP secrets stored with AES-256-GCM encryption
- **Non-root containers** — runner containers run as `claude` user (UID 1000)
- **Read-only credential mounts** — `.credentials.json` mounted read-only in runners
- **Namespace isolation** (K8s) — all session resources scoped to `claude-sessions` namespace
- **RBAC** (K8s) — bot and runner service accounts with least-privilege roles

## Project Structure

```
.
├── bot/                    # Telegram bot (orchestrator)
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.ts        # Bot entrypoint
│   │   ├── config.ts       # Environment configuration
│   │   ├── db.ts           # SQLite database (users, sessions)
│   │   ├── logger.ts       # Pino logger
│   │   ├── session-manager.ts  # SessionManager interface
│   │   ├── manager-factory.ts  # Runtime mode factory
│   │   ├── auth/
│   │   │   └── totp.ts     # TOTP generation, verification, QR codes
│   │   ├── commands/
│   │   │   ├── login.ts    # /login — TOTP registration & auth
│   │   │   ├── start.ts    # /start — provision & remote-control
│   │   │   └── stop.ts     # /stop — cleanup
│   │   ├── docker/
│   │   │   └── manager.ts  # Docker SessionManager implementation
│   │   └── k8s/
│   │       └── manager.ts  # Kubernetes SessionManager implementation
│   └── package.json
├── runner/                 # Runner container (Claude Code environment)
│   └── Dockerfile
├── k8s/                    # Kubernetes manifests
│   ├── namespace.yaml
│   ├── rbac.yaml           # Bot RBAC
│   ├── runner-rbac.yaml    # Runner RBAC (cluster access for Claude)
│   ├── secrets.yaml        # Secret templates
│   ├── configmap.yaml      # Bot configuration
│   ├── bot-pvc.yaml        # Bot data volume
│   └── bot-deployment.yaml # Bot deployment
├── docker-compose.yaml     # Local dev setup
├── .env.example            # Environment template
└── README.md
```

## Troubleshooting

### "Remote Control is not yet enabled for your account"

Your credentials don't have the `user:sessions:claude_code` scope. This happens when using `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Use `CLAUDE_CREDENTIALS_PATH` instead (from `claude auth login`).

### Session starts but URL doesn't work

Check that `.claude.json` contains the `tengu_ccr_bridge` feature flag. The bot patches this automatically from your local config, but if the source file doesn't have it, remote-control won't work. Run a `claude` session locally first to populate the feature flags.

### Container starts but Claude isn't authenticated

Verify the credentials file is mounted correctly:
```bash
# Docker mode
docker exec claude-runner-<id> cat /home/claude/.claude/.credentials.json

# K8s mode
kubectl exec -n claude-sessions <pod-name> -c claude -- cat /home/claude/.claude/.credentials.json
```

### "node: bad option: --sdk-url"

The runner is using an npm-installed Claude Code instead of the native binary. Rebuild the runner image — it should use `curl -fsSL https://claude.ai/install.sh | bash` (not `npm install -g`).

### K8s pods stuck in ErrImageNeverPull

Images need to be loaded into the cluster's container runtime. See the [Build and load images](#4-build-and-load-images) section.

### Permission issues inside Claude session

The bot injects `settings.json` with pre-approved tools. If Claude still prompts for permissions, check that the settings file exists:
```bash
kubectl exec -n claude-sessions <pod-name> -c claude -- cat /home/claude/.claude/settings.json
```

## License

MIT
