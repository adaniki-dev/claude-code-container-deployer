import { config } from "./config.js";
import type { SessionManager } from "./session-manager.js";

let manager: SessionManager | null = null;

export async function getManager(): Promise<SessionManager> {
  if (manager) return manager;

  if (config.runtimeMode === "docker") {
    const { dockerManager } = await import("./docker/manager.js");
    manager = dockerManager;
  } else {
    const { k8sManager } = await import("./k8s/manager.js");
    manager = k8sManager;
  }

  return manager;
}
