import { randomBytes, createHash } from "node:crypto";
import logger from "./logger.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";

interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Active PKCE challenges per user */
const pendingChallenges = new Map<number, PkceChallenge>();

function base64url(buffer: Buffer): string {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generatePkce(): PkceChallenge {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  const state = base64url(randomBytes(32));
  return { codeVerifier, codeChallenge, state };
}

export function createAuthUrl(telegramId: number): string {
  const pkce = generatePkce();
  pendingChallenges.set(telegramId, pkce);

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state: pkce.state,
  });

  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(telegramId: number, code: string): Promise<OAuthTokens> {
  const pkce = pendingChallenges.get(telegramId);
  if (!pkce) {
    throw new Error("No pending OAuth challenge. Use /start first.");
  }

  pendingChallenges.delete(telegramId);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.codeVerifier,
  });

  logger.debug({ telegramId }, "Exchanging OAuth code for tokens");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  logger.info({ telegramId }, "OAuth token exchange successful");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export function hasPendingChallenge(telegramId: number): boolean {
  return pendingChallenges.has(telegramId);
}
