import { env } from "node:process";

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return env[name] ?? fallback;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: env["ANTHROPIC_API_KEY"] ?? "", // optional — login by session/subscription
  encryptionKey: required("ENCRYPTION_KEY"), // 32-byte hex for AES-256-GCM
  allowedUserIds: required("ALLOWED_USER_IDS")
    .split(",")
    .map((id) => parseInt(id.trim(), 10)),
  namespace: optional("K8S_NAMESPACE", "claude-sessions"),
  runnerImage: optional(
    "RUNNER_IMAGE",
    "ghcr.io/adam/claude-code-runner:latest",
  ),
  dbPath: optional("DB_PATH", "/data/bot.db"),
  logLevel: optional("LOG_LEVEL", "info"),
  runtimeMode: optional("RUNTIME_MODE", "k8s") as "docker" | "k8s",
  runnerContainerName: optional("RUNNER_CONTAINER_NAME", "claude-runner"),
  dockerNetwork: optional("DOCKER_NETWORK", "claude-code-on-kluster_default"),
  claudeOauthToken: env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "",
  claudeCredentialsPath: env["CLAUDE_CREDENTIALS_PATH"] ?? "",
  claudeConfigPath: env["CLAUDE_CONFIG_PATH"] ?? "",
  enableApi: optional("ENABLE_API", "false") === "true",
  apiKey: env["API_KEY"] ?? "",
  apiPort: parseInt(optional("API_PORT", "3000"), 10),
} as const;
