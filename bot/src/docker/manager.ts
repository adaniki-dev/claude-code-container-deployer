import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { config } from "../config.js";
import logger from "../logger.js";
import type { SessionManager } from "../session-manager.js";

const execFileAsync = promisify(execFile);

function containerName(telegramId: number): string {
  return `${config.runnerContainerName}-${telegramId}`;
}

async function docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", args);
}

const URL_REGEX = /https?:\/\/[^\s\])"']+/;

const remoteControlProcesses = new Map<number, ChildProcess>();

function extractUrlFromProcess(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for URL after ${timeoutMs}ms. Output so far: ${output}`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      output += text;
      logger.debug({ text: text.trim() }, "Process output");
      const match = output.match(URL_REGEX);
      if (match) {
        clearTimeout(timer);
        proc.stdout?.removeListener("data", onData);
        proc.stderr?.removeListener("data", onStderr);
        resolve(match[0]);
      }
    }

    function onStderr(chunk: Buffer) {
      const text = chunk.toString();
      output += text;
      logger.debug({ text: text.trim() }, "Process stderr");
      const match = output.match(URL_REGEX);
      if (match) {
        clearTimeout(timer);
        proc.stdout?.removeListener("data", onData);
        proc.stderr?.removeListener("data", onStderr);
        resolve(match[0]);
      }
    }

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onStderr);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited with code ${code} before URL was found. Output: ${output}`));
    });
  });
}

export const dockerManager: SessionManager = {
  async startContainer(telegramId) {
    const name = containerName(telegramId);

    try {
      const { stdout } = await docker("inspect", "--format", "{{.State.Running}}", name);
      if (stdout.trim() === "true") {
        logger.info({ name }, "Container already running");
        return name;
      }
      await docker("start", name);
      logger.info({ name }, "Container started");
      return name;
    } catch {
      // Container doesn't exist — create it
    }

    const runArgs = [
      "run", "-d",
      "--name", name,
      "--network", config.dockerNetwork,
      "--label", `telegram-user=${telegramId}`,
    ];

    if (config.anthropicApiKey) {
      runArgs.push("-e", `ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
    }

    // Mount full-scope credentials file (from claude auth login) — preferred over CLAUDE_CODE_OAUTH_TOKEN
    // because setup-token only grants user:inference scope, while .credentials.json has all scopes
    if (config.claudeCredentialsPath) {
      runArgs.push("-v", `${config.claudeCredentialsPath}:/home/claude/.claude/.credentials.json:ro`);
    } else if (config.claudeOauthToken) {
      // Fallback: use setup-token env var (limited scopes — no remote-control)
      runArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeOauthToken}`);
    }

    // NOTE: .claude.json is NOT mounted as volume — it's copied + patched in waitForReady
    // so we can inject workspace trust into it

    runArgs.push(config.runnerImage);

    await docker(...runArgs);
    logger.info({ name }, "Container created");
    return name;
  },

  async stopContainer(telegramId) {
    const name = containerName(telegramId);
    await this.stopRemoteControl(telegramId);
    await docker("stop", name);
    logger.info({ name }, "Container stopped");
  },

  async isContainerRunning(telegramId) {
    const name = containerName(telegramId);
    try {
      const { stdout } = await docker("inspect", "--format", "{{.State.Running}}", name);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  },

  async waitForReady(telegramId, timeoutMs = 120_000) {
    const name = containerName(telegramId);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await docker("inspect", "--format", "{{.State.Running}}", name);
        if (stdout.trim() === "true") {
          // Fix volume permissions (Docker volumes mount as root)
          await execFileAsync("docker", [
            "exec", "-u", "root", name,
            "chown", "-R", "claude:claude", "/home/claude/.claude",
          ]).catch(() => {});

          // Copy .claude.json with feature flags + workspace trust injected
          if (config.claudeConfigPath) {
            try {
              const configFile = process.env.RUNTIME_MODE === "docker" ? "/config/.claude.json" : config.claudeConfigPath;
              const raw = readFileSync(configFile, "utf-8");
              const claudeJson = JSON.parse(raw);
              // Inject workspace trust so remote-control doesn't prompt
              if (!claudeJson.projects) claudeJson.projects = {};
              const wsKey = "/home/claude/workspace";
              if (!claudeJson.projects[wsKey]) claudeJson.projects[wsKey] = {};
              claudeJson.projects[wsKey].hasTrustDialogAccepted = true;
              // Ensure onboarding is done and remote-control dialog is skipped
              claudeJson.hasCompletedOnboarding = true;
              claudeJson.remoteDialogSeen = true;
              const patched = JSON.stringify(claudeJson);
              await docker(
                "exec", name, "bash", "-c",
                `cat > /home/claude/.claude.json << 'ENDOFCONFIG'\n${patched}\nENDOFCONFIG`,
              );
              logger.debug({ name }, "Copied and patched .claude.json");
            } catch (err) {
              logger.warn({ err, name }, "Failed to copy .claude.json");
            }
          }

          // Create settings.json to allow all tools (bypass permission prompts)
          await docker(
            "exec", name, "bash", "-c",
            `echo '{"permissions":{"allow":["Bash","Read","Write","Edit","Glob","Grep","WebFetch","WebSearch","NotebookEdit"],"deny":[]}}' > /home/claude/.claude/settings.json`,
          ).catch(() => {});

          // Create project settings with allowed tools
          await docker(
            "exec", name, "bash", "-c",
            `mkdir -p /home/claude/.claude/projects/-home-claude-workspace && echo '{"allowedTools":["Bash","Read","Write","Edit","Glob","Grep","WebFetch","WebSearch","NotebookEdit"]}' > /home/claude/.claude/projects/-home-claude-workspace/settings.json`,
          ).catch(() => {});

          return true;
        }
      } catch {
        // container not found yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  },

  async isClaudeAuthenticated(telegramId) {
    const name = containerName(telegramId);
    try {
      const { stdout } = await docker("exec", name, "claude", "auth", "status");
      const parsed = JSON.parse(stdout);
      return parsed.loggedIn === true;
    } catch {
      return false;
    }
  },

  async setupToken(telegramId, token) {
    const name = containerName(telegramId);

    // Write onboarding flag so Claude doesn't show first-run wizard
    await docker(
      "exec", name, "bash", "-c",
      `echo '{"hasCompletedOnboarding":true}' > /home/claude/.claude.json`,
    );

    logger.info({ telegramId }, "Token setup complete (token comes from container env)");
  },

  async startRemoteControl(telegramId) {
    const name = containerName(telegramId);

    const existing = remoteControlProcesses.get(telegramId);
    if (existing) {
      existing.kill();
      remoteControlProcesses.delete(telegramId);
    }

    const proc = spawn("docker", [
      "exec", "-i", name, "claude", "remote-control",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    remoteControlProcesses.set(telegramId, proc);

    // Auto-answer "y" to "Enable Remote Control? (y/n)" prompt
    let answered = false;
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (!answered && chunk.toString().includes("(y/n)")) {
        answered = true;
        proc.stdin?.write("y\n");
        logger.debug({ telegramId }, "Auto-answered y to remote-control prompt");
      }
    });

    proc.on("close", (code) => {
      logger.info({ telegramId, code }, "Remote-control process exited");
      remoteControlProcesses.delete(telegramId);
    });

    try {
      const url = await extractUrlFromProcess(proc, 30_000);
      logger.info({ telegramId, url }, "Remote-control URL captured");
      return url;
    } catch (err) {
      proc.kill();
      remoteControlProcesses.delete(telegramId);
      throw err;
    }
  },

  async executePrompt(telegramId, prompt, timeoutMs = 300_000) {
    const name = containerName(telegramId);
    return new Promise<string>((resolve, reject) => {
      const proc = spawn("docker", [
        "exec", "-i", name, "claude", "-p", "-",
      ], { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("Prompt execution timed out"));
      }, timeoutMs);

      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`claude exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },

  async stopRemoteControl(telegramId) {
    const proc = remoteControlProcesses.get(telegramId);
    if (proc) {
      proc.kill();
      remoteControlProcesses.delete(telegramId);
      logger.info({ telegramId }, "Remote-control process killed");
    } else {
      const name = containerName(telegramId);
      try {
        await docker("exec", name, "bash", "-c", "kill $(pgrep -f 'claude remote-control') 2>/dev/null");
      } catch {
        // No process to kill
      }
    }
  },
};
