import { describe, it, expect, vi, beforeEach } from "vitest";
import { XApiClient } from "./x-api.js";

function makeClient(): XApiClient {
  return new XApiClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    accessToken: "test-access",
    accessTokenSecret: "test-access-secret",
    bearerToken: "test-bearer",
  });
}

function mockFetchResponse(body: unknown, status = 200, headers: Record<string, string> = {}): void {
  const h = new Headers(headers);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    text: () => Promise.resolve(JSON.stringify(body)),
  }));
}

describe("XApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getAuthenticatedUserId", () => {
    it("fetches and caches user ID", async () => {
      mockFetchResponse({ data: { id: "12345" } });
      const client = makeClient();

      const id = await client.getAuthenticatedUserId();
      expect(id).toBe("12345");

      // Second call should not trigger another fetch
      const id2 = await client.getAuthenticatedUserId();
      expect(id2).toBe("12345");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent calls", async () => {
      mockFetchResponse({ data: { id: "12345" } });
      const client = makeClient();

      const [id1, id2] = await Promise.all([
        client.getAuthenticatedUserId(),
        client.getAuthenticatedUserId(),
      ]);
      expect(id1).toBe("12345");
      expect(id2).toBe("12345");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("throws when API returns no data", async () => {
      mockFetchResponse({});
      const client = makeClient();
      await expect(client.getAuthenticatedUserId()).rejects.toThrow("no user data");
    });
  });

  describe("error handling", () => {
    it("extracts error details from structured error response", async () => {
      mockFetchResponse(
        { errors: [{ detail: "Not Found", message: "fallback" }] },
        404,
      );
      const client = makeClient();
      await expect(client.getTweet("999")).rejects.toThrow("Not Found");
    });

    it("handles non-array errors field gracefully", async () => {
      mockFetchResponse(
        { errors: "unexpected string" },
        400,
      );
      const client = makeClient();
      await expect(client.getTweet("999")).rejects.toThrow("getTweet failed");
    });

    it("handles 429 rate limit error", async () => {
      mockFetchResponse(
        {},
        429,
        {
          "x-rate-limit-limit": "15",
          "x-rate-limit-remaining": "0",
          "x-rate-limit-reset": "1700000000",
        },
      );
      const client = makeClient();
      await expect(client.getTweet("999")).rejects.toThrow("Rate limited");
    });
  });

  describe("getTweet", () => {
    it("uses bearer token for read operations", async () => {
      mockFetchResponse({ data: { id: "123", text: "hello" } });
      const client = makeClient();
      await client.getTweet("123");

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-bearer");
    });

    it("does not request referenced_tweets.id expansion", async () => {
      mockFetchResponse({ data: { id: "123", text: "hello" } });
      const client = makeClient();
      await client.getTweet("123");

      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).not.toContain("referenced_tweets.id");
      expect(url).toContain("expansions=author_id");
    });
  });

  describe("getUser", () => {
    it("does not request profile_image_url", async () => {
      mockFetchResponse({ data: { id: "123", username: "test" } });
      const client = makeClient();
      await client.getUser({ username: "test" });

      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).not.toContain("profile_image_url");
    });
  });

  describe("postTweet", () => {
    it("uses OAuth for write operations", async () => {
      mockFetchResponse({ data: { id: "999" } });
      const client = makeClient();
      await client.postTweet({ text: "hello" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toContain("OAuth");
    });

    it("sends correct body for reply", async () => {
      mockFetchResponse({ data: { id: "999" } });
      const client = makeClient();
      await client.postTweet({ text: "reply", reply_to: "123" });

      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.reply).toEqual({ in_reply_to_tweet_id: "123" });
    });
  });
});
