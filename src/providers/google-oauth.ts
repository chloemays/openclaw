import type { OAuthCredentials } from "@mariozechner/pi-ai";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;

// OAuth client credentials - decoded from google-antigravity-auth plugin
// These are shared for both google-antigravity and google-gemini-cli refresh
const decode = (s: string) => Buffer.from(s, "base64").toString();
const ANTIGRAVITY_CLIENT_ID = decode(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const ANTIGRAVITY_CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

export type GoogleOAuthCredential = OAuthCredentials & {
  projectId?: string;
  clientId?: string;
};

function coerceExpiresAt(expiresInSeconds: number, now: number): number {
  const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1000 - DEFAULT_EXPIRES_BUFFER_MS;
  return Math.max(value, now + 30_000);
}

/**
 * Refreshes Google OAuth tokens for google-antigravity and google-gemini-cli providers.
 * Uses the standard Google OAuth2 token refresh endpoint.
 */
export async function refreshGoogleOAuthTokens(params: {
  credential: GoogleOAuthCredential;
  provider: string;
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<GoogleOAuthCredential> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now();

  const refreshToken = params.credential.refresh?.trim();
  if (!refreshToken) {
    throw new Error(
      `Google OAuth credential is missing refresh token (provider: ${params.provider})`,
    );
  }

  // Determine client credentials based on provider
  // For google-antigravity, use the Antigravity client credentials
  // For google-gemini-cli, try env vars first, then fall back to Antigravity credentials
  let clientId: string;
  let clientSecret: string | undefined;

  if (params.provider === "google-gemini-cli") {
    clientId =
      params.credential.clientId?.trim() ||
      process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID?.trim() ||
      process.env.GEMINI_CLI_OAUTH_CLIENT_ID?.trim() ||
      ANTIGRAVITY_CLIENT_ID;
    clientSecret =
      process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET?.trim() ||
      process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET?.trim() ||
      ANTIGRAVITY_CLIENT_SECRET;
  } else {
    // google-antigravity
    clientId = params.credential.clientId?.trim() || ANTIGRAVITY_CLIENT_ID;
    clientSecret = ANTIGRAVITY_CLIENT_SECRET;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth token refresh failed (provider: ${params.provider}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const newRefresh = data.refresh_token?.trim();
  const expiresIn = data.expires_in ?? 0;

  if (!access) {
    throw new Error(
      `Google OAuth token refresh returned no access_token (provider: ${params.provider})`,
    );
  }

  return {
    ...params.credential,
    access,
    refresh: newRefresh || refreshToken,
    expires: coerceExpiresAt(expiresIn, now),
    clientId,
  };
}

/**
 * Check if a provider is a Google OAuth provider that needs custom refresh handling.
 */
export function isGoogleOAuthProvider(provider: string): boolean {
  return provider === "google-antigravity" || provider === "google-gemini-cli";
}
