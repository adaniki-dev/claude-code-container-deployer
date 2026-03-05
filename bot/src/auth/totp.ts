import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(config.encryptionKey, "hex");

export function encrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decrypt(data: string): string {
  const [ivHex, authTagHex, encryptedHex] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function generateTotpSecret(telegramId: number): { secret: string; encryptedSecret: string } {
  const totp = new OTPAuth.TOTP({
    issuer: "ClaudeOnK8s",
    label: `user-${telegramId}`,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret(),
  });
  const secret = totp.secret.base32;
  return { secret, encryptedSecret: encrypt(secret) };
}

export function verifyTotp(encryptedSecret: string, token: string): boolean {
  const secret = decrypt(encryptedSecret);
  const totp = new OTPAuth.TOTP({
    issuer: "ClaudeOnK8s",
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

export async function generateQrDataUrl(encryptedSecret: string, telegramId: number): Promise<string> {
  const secret = decrypt(encryptedSecret);
  const totp = new OTPAuth.TOTP({
    issuer: "ClaudeOnK8s",
    label: `user-${telegramId}`,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return QRCode.toDataURL(totp.toString());
}
