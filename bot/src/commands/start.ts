import type { CommandContext, Context } from "grammy";
import { isAuthenticated } from "./login.js";
import { upsertSession, updateSessionStatus } from "../db.js";
import { getManager } from "../manager-factory.js";
import logger from "../logger.js";

export function isWaitingForToken(_telegramId: number): boolean {
  return false;
}

export async function handleTokenSubmission(_ctx: Context): Promise<boolean> {
  return false;
}

export async function startCommand(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (!isAuthenticated(telegramId)) {
    await ctx.reply("Please /login first.");
    return;
  }

  await ctx.reply("Starting your Claude session...");

  try {
    const mgr = await getManager();

    // 1. Start container
    const deploymentName = await mgr.startContainer(telegramId);
    upsertSession(telegramId, deploymentName);

    // 2. Wait for container to be ready
    const ready = await mgr.waitForReady(telegramId);
    if (!ready) {
      await ctx.reply("Container failed to start in time. Try again later.");
      return;
    }

    await ctx.reply("Container ready. Starting remote-control...");

    // 3. Start remote-control (token comes from CLAUDE_CODE_OAUTH_TOKEN env var)
    const remoteUrl = await mgr.startRemoteControl(telegramId);
    updateSessionStatus(telegramId, "running");

    await ctx.reply(
      `Session ready! Open in your browser:\n\n${remoteUrl}`,
      { link_preview_options: { is_disabled: true } },
    );

    logger.info({ telegramId, deploymentName, remoteUrl }, "Remote-control session started");
  } catch (err) {
    logger.error({ err, telegramId }, "Failed to start session");
    await ctx.reply("Failed to start session. Check logs for details.");
  }
}
