import * as k8s from "@kubernetes/client-node";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";
import logger from "../logger.js";
import type { SessionManager } from "../session-manager.js";

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

const ns = config.namespace;

function deploymentName(telegramId: number): string {
  return `claude-session-${telegramId}`;
}

function pvcName(telegramId: number): string {
  return `claude-workspace-${telegramId}`;
}

function claudeConfigPvcName(telegramId: number): string {
  return `claude-config-${telegramId}`;
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

async function ensurePvc(name: string): Promise<void> {
  try {
    await coreApi.readNamespacedPersistentVolumeClaim({ name, namespace: ns });
  } catch {
    await coreApi.createNamespacedPersistentVolumeClaim({
      namespace: ns,
      body: {
        metadata: { name, namespace: ns },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "1Gi" } },
        },
      },
    });
    logger.info({ name }, "PVC created");
  }
}

async function getPodName(telegramId: number): Promise<string | null> {
  const labelSelector = `app=claude-session,user=${telegramId}`;
  const pods = await coreApi.listNamespacedPod({ namespace: ns, labelSelector });
  const running = pods.items.find(
    (p) => p.status?.phase === "Running" && p.status?.containerStatuses?.every((c) => c.ready),
  );
  return running?.metadata?.name ?? null;
}

function kubectlScale(deployName: string, replicas: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("kubectl", [
      "scale", "deployment", deployName, "-n", ns, `--replicas=${replicas}`,
    ]);
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`kubectl scale exited ${code}: ${out}`)));
    proc.on("error", reject);
  });
}

function kubectlExec(podName: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("kubectl", [
      "exec", "-n", ns, podName, "-c", "claude", "--",
      "bash", "-c", command,
    ]);
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`kubectl exited ${code}: ${out}`)));
    proc.on("error", reject);
  });
}

/** Read and patch .claude.json with workspace trust + feature flags */
function buildClaudeConfig(): string | null {
  const configFile = "/config/credentials/claude-config.json";
  try {
    const raw = readFileSync(configFile, "utf-8");
    const claudeJson = JSON.parse(raw);
    // Inject workspace trust
    if (!claudeJson.projects) claudeJson.projects = {};
    const wsKey = "/home/claude/workspace";
    if (!claudeJson.projects[wsKey]) claudeJson.projects[wsKey] = {};
    claudeJson.projects[wsKey].hasTrustDialogAccepted = true;
    claudeJson.hasCompletedOnboarding = true;
    claudeJson.remoteDialogSeen = true;
    return JSON.stringify(claudeJson);
  } catch (err) {
    logger.warn({ err }, "Failed to read claude-config.json from secret");
    return null;
  }
}

export const k8sManager: SessionManager = {
  async startContainer(telegramId) {
    const name = deploymentName(telegramId);
    const workspace = pvcName(telegramId);
    const claudeConfig = claudeConfigPvcName(telegramId);

    await ensurePvc(workspace);
    await ensurePvc(claudeConfig);

    try {
      const existing = await appsApi.readNamespacedDeployment({ name, namespace: ns });
      const replicas = existing.spec?.replicas ?? 0;
      if (replicas === 0) {
        await kubectlScale(name, 1);
        logger.info({ name }, "Scaled up to 1");
      }
      return name;
    } catch {
      // Deployment doesn't exist, create it
    }

    const volumes: k8s.V1Volume[] = [
      { name: "workspace", persistentVolumeClaim: { claimName: workspace } },
      { name: "claude-config", persistentVolumeClaim: { claimName: claudeConfig } },
      {
        name: "claude-credentials",
        secret: {
          secretName: "claude-secrets",
          items: [
            { key: "credentials.json", path: "credentials.json" },
          ],
        },
      },
    ];

    const volumeMounts: k8s.V1VolumeMount[] = [
      { name: "workspace", mountPath: "/home/claude/workspace" },
      { name: "claude-config", mountPath: "/home/claude/.claude" },
      { name: "claude-credentials", mountPath: "/credentials", readOnly: true },
    ];

    await appsApi.createNamespacedDeployment({
      namespace: ns,
      body: {
        metadata: { name, namespace: ns, labels: { app: "claude-session", user: String(telegramId) } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "claude-session", user: String(telegramId) } },
          template: {
            metadata: { labels: { app: "claude-session", user: String(telegramId) } },
            spec: {
              serviceAccountName: "claude-runner",
              containers: [
                {
                  name: "claude",
                  image: config.runnerImage,
                  imagePullPolicy: "Never" as const,
                  command: ["sleep", "infinity"],
                  volumeMounts,
                  resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "1Gi" } },
                  securityContext: { runAsNonRoot: true, runAsUser: 1000 },
                },
              ],
              volumes,
            },
          },
        },
      },
    });

    logger.info({ name }, "Deployment created");
    return name;
  },

  async stopContainer(telegramId) {
    const name = deploymentName(telegramId);
    await this.stopRemoteControl(telegramId);
    await kubectlScale(name, 0);
    logger.info({ name }, "Scaled down to 0");
  },

  async isContainerRunning(telegramId) {
    const name = deploymentName(telegramId);
    try {
      const dep = await appsApi.readNamespacedDeployment({ name, namespace: ns });
      return (dep.spec?.replicas ?? 0) > 0 && (dep.status?.readyReplicas ?? 0) > 0;
    } catch {
      return false;
    }
  },

  async waitForReady(telegramId, timeoutMs = 120_000) {
    const name = deploymentName(telegramId);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const dep = await appsApi.readNamespacedDeployment({ name, namespace: ns });
        if ((dep.status?.readyReplicas ?? 0) >= 1) {
          const podName = await getPodName(telegramId);
          if (podName) {
            // Copy credentials file from secret mount to .claude directory
            await kubectlExec(podName,
              "cp /credentials/credentials.json /home/claude/.claude/.credentials.json 2>/dev/null || true");

            // Write patched .claude.json with trust + feature flags
            const claudeConfig = buildClaudeConfig();
            if (claudeConfig) {
              await kubectlExec(podName,
                `cat > /home/claude/.claude.json << 'ENDOFCONFIG'\n${claudeConfig}\nENDOFCONFIG`);
            }

            // Create settings.json to allow all tools (bypass permission prompts)
            await kubectlExec(podName,
              `echo '{"permissions":{"allow":["Bash","Read","Write","Edit","Glob","Grep","WebFetch","WebSearch","NotebookEdit"],"deny":[]}}' > /home/claude/.claude/settings.json`);

            // Create project settings with allowed tools
            await kubectlExec(podName,
              `mkdir -p /home/claude/.claude/projects/-home-claude-workspace && echo '{"allowedTools":["Bash","Read","Write","Edit","Glob","Grep","WebFetch","WebSearch","NotebookEdit"]}' > /home/claude/.claude/projects/-home-claude-workspace/settings.json`);

            logger.debug({ podName }, "Credentials, config and permissions injected into pod");
          }
          return true;
        }
      } catch {
        // deployment not found yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  },

  async isClaudeAuthenticated(telegramId) {
    const podName = await getPodName(telegramId);
    if (!podName) return false;

    try {
      const result = await kubectlExec(podName, "claude auth status");
      const parsed = JSON.parse(result);
      return parsed.loggedIn === true;
    } catch {
      return false;
    }
  },

  async setupToken(telegramId, token) {
    const podName = await getPodName(telegramId);
    if (!podName) throw new Error("No running pod found for this session");

    await kubectlExec(podName,
      `echo '{"hasCompletedOnboarding":true}' > /home/claude/.claude.json`);

    logger.info({ telegramId }, "Token setup complete");
  },

  async startRemoteControl(telegramId) {
    const podName = await getPodName(telegramId);
    if (!podName) throw new Error("No running pod found for this session");

    const existing = remoteControlProcesses.get(telegramId);
    if (existing) {
      existing.kill();
      remoteControlProcesses.delete(telegramId);
    }

    const proc = spawn("kubectl", [
      "exec", "-i", "-n", ns, podName, "-c", "claude", "--",
      "claude", "remote-control",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    remoteControlProcesses.set(telegramId, proc);

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
    const podName = await getPodName(telegramId);
    if (!podName) throw new Error("No running pod found for this session");

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("kubectl", [
        "exec", "-i", "-n", ns, podName, "-c", "claude", "--",
        "claude", "-p", "-",
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
      const podName = await getPodName(telegramId);
      if (podName) {
        try {
          const kill = spawn("kubectl", [
            "exec", "-n", ns, podName, "-c", "claude", "--",
            "bash", "-c", "kill $(pgrep -f 'claude remote-control') 2>/dev/null",
          ]);
          await new Promise<void>((resolve) => kill.on("close", () => resolve()));
        } catch {
          // No process to kill
        }
      }
    }
  },
};
