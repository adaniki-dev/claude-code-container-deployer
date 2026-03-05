import { type CommandContext, type Context, InputFile } from "grammy";
import { config } from "../config.js";
import { getUser, markRegistered, upsertUser } from "../db.js";
import { generateQrDataUrl, generateTotpSecret, verifyTotp } from "../auth/totp.js";
import logger from "../logger.js";

const pendingVerification = new Map<number, boolean>();

export async function loginCommand(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (!config.allowedUserIds.includes(telegramId)) {
    await ctx.reply("Access denied.");
    return;
  }

  const user = getUser(telegramId);

  if (user?.is_registered) {
    pendingVerification.set(telegramId, true);
    await ctx.reply("Send your 6-digit TOTP code to authenticate:");
    return;
  }

  const { encryptedSecret } = generateTotpSecret(telegramId);
  upsertUser(telegramId, encryptedSecret);

  const qrDataUrl = await generateQrDataUrl(encryptedSecret, telegramId);
  const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");

  await ctx.replyWithPhoto(new InputFile(buffer, "totp-qr.png"), {
    caption: "Scan this QR code with your authenticator app, then send the 6-digit code to verify.",
  });
  pendingVerification.set(telegramId, true);

  logger.info({ telegramId }, "TOTP setup initiated");
}

export async function handleTotpVerification(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;

  if (!pendingVerification.get(telegramId)) return false;

  const text = ctx.message?.text?.trim();
  if (!text || !/^\d{6}$/.test(text)) {
    await ctx.reply("Please send a valid 6-digit code.");
    return true;
  }

  const user = getUser(telegramId);
  if (!user?.totp_secret) {
    await ctx.reply("No TOTP setup found. Use /login first.");
    pendingVerification.delete(telegramId);
    return true;
  }

  if (verifyTotp(user.totp_secret, text)) {
    if (!user.is_registered) {
      markRegistered(telegramId);
    }
    pendingVerification.delete(telegramId);
    authenticatedUsers.add(telegramId);
    await ctx.reply("Authenticated! You can now use /start and send messages.");
    logger.info({ telegramId }, "User authenticated");
  } else {
    await ctx.reply("Invalid code. Try again.");
  }

  return true;
}

export const authenticatedUsers = new Set<number>();

export function isAuthenticated(telegramId: number): boolean {
  return authenticatedUsers.has(telegramId);
}
