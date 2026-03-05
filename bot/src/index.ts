import { Bot } from "grammy";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { handleTotpVerification, loginCommand } from "./commands/login.js";
import { startCommand, handleTokenSubmission } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import logger from "./logger.js";

initDb();

const bot = new Bot(config.telegramToken);

bot.command("login", loginCommand);
bot.command("start", startCommand);
bot.command("stop", stopCommand);

bot.on("message:text", async (ctx) => {
  const handled = await handleTotpVerification(ctx);
  if (handled) return;
  await handleTokenSubmission(ctx);
});

bot.catch((err) => {
  logger.error({ err: err.error }, "Bot error");
});

bot.start({
  onStart: () => logger.info("Bot started"),
});
