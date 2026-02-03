import { describe, expect, it, vi, afterEach } from "vitest";
import {
  isGoogleOAuthProvider,
  refreshGoogleOAuthTokens,
  type GoogleOAuthCredential,
} from "./google-oauth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe("isGoogleOAuthProvider", () => {
  it("returns true for google-antigravity", () => {
    expect(isGoogleOAuthProvider("google-antigravity")).toBe(true);
  });

  it("returns true for google-gemini-cli", () => {
    expect(isGoogleOAuthProvider("google-gemini-cli")).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(isGoogleOAuthProvider("anthropic")).toBe(false);
    expect(isGoogleOAuthProvider("openai")).toBe(false);
    expect(isGoogleOAuthProvider("google")).toBe(false);
    expect(isGoogleOAuthProvider("google-vertex")).toBe(false);
  });
});

describe("refreshGoogleOAuthTokens", () => {
  const baseCredential: GoogleOAuthCredential = {
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
    projectId: "test-project",
  };

  it("refreshes tokens for google-antigravity", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshGoogleOAuthTokens({
      credential: baseCredential,
      provider: "google-antigravity",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result.access).toBe("new-access");
    expect(result.refresh).toBe("new-refresh");
    expect(result.expires).toBeGreaterThan(Date.now());
    expect(result.projectId).toBe("test-project");
  });

  it("refreshes tokens for google-gemini-cli", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-gemini-access",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshGoogleOAuthTokens({
      credential: baseCredential,
      provider: "google-gemini-cli",
    });

    expect(result.access).toBe("new-gemini-access");
    expect(result.refresh).toBe("old-refresh");
  });

  it("keeps refresh token when refresh response omits it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 1800,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshGoogleOAuthTokens({
      credential: baseCredential,
      provider: "google-antigravity",
    });

    expect(result.refresh).toBe("old-refresh");
  });

  it("throws when refresh token is missing", async () => {
    const credWithoutRefresh: GoogleOAuthCredential = {
      access: "old-access",
      refresh: "",
      expires: Date.now() - 1000,
    };

    await expect(
      refreshGoogleOAuthTokens({
        credential: credWithoutRefresh,
        provider: "google-antigravity",
      }),
    ).rejects.toThrow("missing refresh token");
  });

  it("throws when token refresh fails", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      refreshGoogleOAuthTokens({
        credential: baseCredential,
        provider: "google-antigravity",
      }),
    ).rejects.toThrow("Google OAuth token refresh failed");
  });

  it("throws when no access_token in response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      refreshGoogleOAuthTokens({
        credential: baseCredential,
        provider: "google-antigravity",
      }),
    ).rejects.toThrow("no access_token");
  });

  it("uses custom clientId from credential", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const credWithClientId: GoogleOAuthCredential = {
      ...baseCredential,
      clientId: "custom-client-id",
    };

    const result = await refreshGoogleOAuthTokens({
      credential: credWithClientId,
      provider: "google-antigravity",
    });

    expect(result.clientId).toBe("custom-client-id");

    const callBody = fetchSpy.mock.calls[0][1].body as URLSearchParams;
    expect(callBody.get("client_id")).toBe("custom-client-id");
  });

  it("preserves projectId through refresh", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshGoogleOAuthTokens({
      credential: { ...baseCredential, projectId: "my-project-123" },
      provider: "google-antigravity",
    });

    expect(result.projectId).toBe("my-project-123");
  });
});
