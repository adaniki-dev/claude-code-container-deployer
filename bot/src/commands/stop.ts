import type { CommandContext, Context } from "grammy";
import { isAuthenticated } from "./login.js";
import { getSession, updateSessionStatus } from "../db.js";
import { getManager } from "../manager-factory.js";
import logger from "../logger.js";

export async function stopCommand(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (!isAuthenticated(telegramId)) {
    await ctx.reply("Please /login first.");
    return;
  }

  const session = getSession(telegramId);
  if (!session || session.status === "stopped") {
    await ctx.reply("No active session to stop.");
    return;
  }

  try {
    const mgr = await getManager();
    await mgr.stopRemoteControl(telegramId);
    await mgr.stopContainer(telegramId);
    updateSessionStatus(telegramId, "stopped");
    await ctx.reply("Session stopped. Your workspace is preserved. Use /start to resume.");
    logger.info({ telegramId }, "Session stopped");
  } catch (err) {
    logger.error({ err, telegramId }, "Failed to stop session");
    await ctx.reply("Failed to stop session. Check logs for details.");
  }
}
