import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { getManager } from "../manager-factory.js";
import logger from "../logger.js";

const API_USER_ID = -1;

let containerReady: Promise<void> | null = null;

async function ensureContainer(): Promise<void> {
  if (!containerReady) {
    containerReady = (async () => {
      const mgr = await getManager();
      const running = await mgr.isContainerRunning(API_USER_ID);
      if (!running) {
        await mgr.startContainer(API_USER_ID);
        const ready = await mgr.waitForReady(API_USER_ID);
        if (!ready) throw new Error("API container failed to become ready");
      }
    })();
  }
  return containerReady;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!config.apiKey) return true;
  const provided = req.headers["x-api-key"];
  if (provided === config.apiKey) return true;
  json(res, 401, { error: "Unauthorized" });
  return false;
}

async function handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let body: { prompt?: string; timeout?: number };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (!body.prompt || typeof body.prompt !== "string") {
    json(res, 400, { error: "Missing or invalid 'prompt' field" });
    return;
  }

  const timeoutMs = body.timeout ?? 300_000;

  try {
    await ensureContainer();
    const mgr = await getManager();
    const start = Date.now();
    const response = await mgr.executePrompt(API_USER_ID, body.prompt, timeoutMs);
    const duration_ms = Date.now() - start;
    json(res, 200, { response, duration_ms });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timed out")) {
      json(res, 504, { error: "Prompt execution timed out" });
    } else {
      logger.error({ err }, "API prompt error");
      json(res, 500, { error: message });
    }
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const mgr = await getManager();
    const container_running = await mgr.isContainerRunning(API_USER_ID);
    json(res, 200, { status: "ok", container_running });
  } catch {
    json(res, 200, { status: "ok", container_running: false });
  }
}

export function startApiServer(): void {
  const server = createServer(async (req, res) => {
    const { method, url } = req;

    if (method === "POST" && url === "/api/prompt") {
      await handlePrompt(req, res);
    } else if (method === "GET" && url === "/api/health") {
      await handleHealth(req, res);
    } else {
      json(res, 404, { error: "Not found" });
    }
  });

  server.listen(config.apiPort, () => {
    logger.info({ port: config.apiPort }, "HTTP API server started");
  });
}
