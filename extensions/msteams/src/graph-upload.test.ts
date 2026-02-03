import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";

// Mock token provider
const mockTokenProvider: MSTeamsAccessTokenProvider = {
  getAccessToken: vi.fn(async () => "mock-token"),
  refreshToken: vi.fn(async () => {}),
};

describe("graph-upload", () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("uploadToOneDrive", () => {
    it("uses simple upload for files under 4MB", async () => {
      const { uploadToOneDrive } = await import("./graph-upload.js");

      const smallBuffer = Buffer.alloc(1024 * 1024); // 1MB
      const mockFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "item-123",
          webUrl: "https://onedrive.com/item-123",
          name: "test.txt",
        }),
      })) as unknown as typeof fetch;

      const result = await uploadToOneDrive({
        buffer: smallBuffer,
        filename: "test.txt",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch,
      });

      expect(result.id).toBe("item-123");
      expect(result.webUrl).toBe("https://onedrive.com/item-123");
      expect(result.name).toBe("test.txt");

      // Should use simple PUT upload, not createUploadSession
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/content");
      expect(url).not.toContain("createUploadSession");
      expect(options.method).toBe("PUT");
    });

    it("uses resumable upload for files over 4MB", async () => {
      const { uploadToOneDrive } = await import("./graph-upload.js");

      const largeBuffer = Buffer.alloc(5 * 1024 * 1024); // 5MB
      let callCount = 0;

      const mockFetch = vi.fn(async (url: string) => {
        callCount++;
        if ((url as string).includes("createUploadSession")) {
          return {
            ok: true,
            json: async () => ({ uploadUrl: "https://upload.microsoft.com/session/abc" }),
          };
        }
        // Chunk upload
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "item-456",
            webUrl: "https://onedrive.com/item-456",
            name: "large-file.bin",
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadToOneDrive({
        buffer: largeBuffer,
        filename: "large-file.bin",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch,
      });

      expect(result.id).toBe("item-456");
      expect(result.name).toBe("large-file.bin");

      // Should create upload session first, then upload chunks
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [sessionUrl] = mockFetch.mock.calls[0] as [string];
      expect(sessionUrl).toContain("createUploadSession");
    });

    it("uploads in chunks for very large files", async () => {
      const { uploadToOneDrive } = await import("./graph-upload.js");

      // 12MB file - should require 3 chunks (5MB + 5MB + 2MB)
      const veryLargeBuffer = Buffer.alloc(12 * 1024 * 1024);
      const chunkCalls: string[] = [];

      const mockFetch = vi.fn(async (url: string, options?: RequestInit) => {
        if ((url as string).includes("createUploadSession")) {
          return {
            ok: true,
            json: async () => ({ uploadUrl: "https://upload.microsoft.com/session/xyz" }),
          };
        }

        // Track chunk uploads
        const contentRange = (options?.headers as Record<string, string>)?.["Content-Range"];
        if (contentRange) {
          chunkCalls.push(contentRange);
        }

        // Return 202 for partial uploads, 200 for final chunk
        if (chunkCalls.length < 3) {
          return { ok: true, status: 202 };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "item-789",
            webUrl: "https://onedrive.com/item-789",
            name: "very-large.bin",
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadToOneDrive({
        buffer: veryLargeBuffer,
        filename: "very-large.bin",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch,
      });

      expect(result.id).toBe("item-789");

      // Should have 3 chunk uploads after the session creation
      expect(chunkCalls.length).toBe(3);

      // Verify Content-Range headers
      const expectedTotal = 12 * 1024 * 1024;
      expect(chunkCalls[0]).toBe(`bytes 0-5242879/${expectedTotal}`);
      expect(chunkCalls[1]).toBe(`bytes 5242880-10485759/${expectedTotal}`);
      expect(chunkCalls[2]).toBe(`bytes 10485760-12582911/${expectedTotal}`);
    });

    it("throws error when upload session creation fails", async () => {
      const { uploadToOneDrive } = await import("./graph-upload.js");

      const largeBuffer = Buffer.alloc(5 * 1024 * 1024);

      const mockFetch = vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Access denied",
      })) as unknown as typeof fetch;

      await expect(
        uploadToOneDrive({
          buffer: largeBuffer,
          filename: "forbidden.bin",
          tokenProvider: mockTokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("OneDrive create upload session failed: 403 Forbidden");
    });
  });

  describe("uploadToSharePoint", () => {
    it("uses simple upload for files under 4MB", async () => {
      const { uploadToSharePoint } = await import("./graph-upload.js");

      const smallBuffer = Buffer.alloc(1024 * 1024); // 1MB
      const mockFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "sp-item-123",
          webUrl: "https://sharepoint.com/item-123",
          name: "test.docx",
        }),
      })) as unknown as typeof fetch;

      const result = await uploadToSharePoint({
        buffer: smallBuffer,
        filename: "test.docx",
        tokenProvider: mockTokenProvider,
        siteId: "contoso.sharepoint.com,guid1,guid2",
        fetchFn: mockFetch,
      });

      expect(result.id).toBe("sp-item-123");
      expect(result.webUrl).toBe("https://sharepoint.com/item-123");

      // Should use simple PUT upload
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/sites/");
      expect(url).toContain("/content");
      expect(options.method).toBe("PUT");
    });

    it("uses resumable upload for files over 4MB", async () => {
      const { uploadToSharePoint } = await import("./graph-upload.js");

      const largeBuffer = Buffer.alloc(5 * 1024 * 1024); // 5MB

      const mockFetch = vi.fn(async (url: string) => {
        if ((url as string).includes("createUploadSession")) {
          return {
            ok: true,
            json: async () => ({ uploadUrl: "https://upload.sharepoint.com/session/abc" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "sp-item-456",
            webUrl: "https://sharepoint.com/item-456",
            name: "large-doc.docx",
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadToSharePoint({
        buffer: largeBuffer,
        filename: "large-doc.docx",
        tokenProvider: mockTokenProvider,
        siteId: "contoso.sharepoint.com,guid1,guid2",
        fetchFn: mockFetch,
      });

      expect(result.id).toBe("sp-item-456");
      expect(result.name).toBe("large-doc.docx");

      // Should create upload session first
      const [sessionUrl] = mockFetch.mock.calls[0] as [string];
      expect(sessionUrl).toContain("createUploadSession");
      expect(sessionUrl).toContain("sites/");
    });

    it("throws error when SharePoint upload session creation fails", async () => {
      const { uploadToSharePoint } = await import("./graph-upload.js");

      const largeBuffer = Buffer.alloc(5 * 1024 * 1024);

      const mockFetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Site not found",
      })) as unknown as typeof fetch;

      await expect(
        uploadToSharePoint({
          buffer: largeBuffer,
          filename: "missing.bin",
          tokenProvider: mockTokenProvider,
          siteId: "nonexistent.sharepoint.com,guid1,guid2",
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("SharePoint create upload session failed: 404 Not Found");
    });
  });

  describe("createSharingLink", () => {
    it("creates organization-scoped sharing link by default", async () => {
      const { createSharingLink } = await import("./graph-upload.js");

      const mockFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.onedrive.com/abc123" },
        }),
      })) as unknown as typeof fetch;

      const result = await createSharingLink({
        itemId: "item-123",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch,
      });

      expect(result.webUrl).toBe("https://share.onedrive.com/abc123");

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.scope).toBe("organization");
      expect(body.type).toBe("view");
    });

    it("creates anonymous sharing link when requested", async () => {
      const { createSharingLink } = await import("./graph-upload.js");

      const mockFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.onedrive.com/xyz789" },
        }),
      })) as unknown as typeof fetch;

      await createSharingLink({
        itemId: "item-123",
        tokenProvider: mockTokenProvider,
        scope: "anonymous",
        fetchFn: mockFetch,
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.scope).toBe("anonymous");
    });
  });

  describe("uploadAndShareOneDrive", () => {
    it("uploads and creates sharing link in one call", async () => {
      const { uploadAndShareOneDrive } = await import("./graph-upload.js");

      let callIndex = 0;
      const mockFetch = vi.fn(async () => {
        callIndex++;
        if (callIndex === 1) {
          // Upload response
          return {
            ok: true,
            json: async () => ({
              id: "item-combo",
              webUrl: "https://onedrive.com/item-combo",
              name: "combo.txt",
            }),
          };
        }
        // Share link response
        return {
          ok: true,
          json: async () => ({
            link: { webUrl: "https://share.onedrive.com/combo-share" },
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadAndShareOneDrive({
        buffer: Buffer.from("test content"),
        filename: "combo.txt",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch,
      });

      expect(result.itemId).toBe("item-combo");
      expect(result.webUrl).toBe("https://onedrive.com/item-combo");
      expect(result.shareUrl).toBe("https://share.onedrive.com/combo-share");
      expect(result.name).toBe("combo.txt");

      // Should make 2 calls: upload + createLink
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
