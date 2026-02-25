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
      await expect(client.getTweet("999")).rejects.toThrow("X API rate limited");
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

    it("sends correct body for quote tweet", async () => {
      mockFetchResponse({ data: { id: "999" } });
      const client = makeClient();
      await client.postTweet({ text: "my take", quote_tweet_id: "456" });

      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.quote_tweet_id).toBe("456");
    });

    it("sends correct body for poll", async () => {
      mockFetchResponse({ data: { id: "999" } });
      const client = makeClient();
      await client.postTweet({
        text: "What do you think?",
        poll_options: ["Yes", "No"],
        poll_duration_minutes: 60,
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.poll).toEqual({ options: ["Yes", "No"], duration_minutes: 60 });
    });

    it("sends correct body with media_ids", async () => {
      mockFetchResponse({ data: { id: "999" } });
      const client = makeClient();
      await client.postTweet({ text: "pic", media_ids: ["media1", "media2"] });

      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.media).toEqual({ media_ids: ["media1", "media2"] });
    });
  });

  describe("resolveUserId", () => {
    it("returns numeric ID as-is without fetching", async () => {
      mockFetchResponse({}); // stub fetch but it should NOT be called
      const client = makeClient();
      const id = await client.resolveUserId("12345");
      expect(id).toBe("12345");
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("strips @ and resolves username", async () => {
      mockFetchResponse({ data: { id: "67890", username: "testuser" } });
      const client = makeClient();
      const id = await client.resolveUserId("@testuser");
      expect(id).toBe("67890");
    });

    it("resolves plain username without @", async () => {
      mockFetchResponse({ data: { id: "67890", username: "testuser" } });
      const client = makeClient();
      const id = await client.resolveUserId("testuser");
      expect(id).toBe("67890");
    });

    it("throws when user not found", async () => {
      mockFetchResponse({ data: null });
      const client = makeClient();
      await expect(client.resolveUserId("@ghost")).rejects.toThrow("not found");
    });
  });

  describe("followUser", () => {
    it("sends POST with target_user_id", async () => {
      // First call: getAuthenticatedUserId
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ data: { id: "me123" } })),
        })
        // Second call: followUser
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ data: { following: true } })),
        });
      vi.stubGlobal("fetch", fetchMock);

      const client = makeClient();
      const { result } = await client.followUser("target456");

      // Check the follow request
      const followCall = fetchMock.mock.calls[1];
      expect(followCall[0]).toContain("/users/me123/following");
      expect(followCall[1]?.method).toBe("POST");
      const body = JSON.parse(followCall[1]?.body as string);
      expect(body.target_user_id).toBe("target456");
      expect(result).toEqual({ data: { following: true } });
    });
  });

  describe("unfollowUser", () => {
    it("sends DELETE to correct URL", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ data: { id: "me123" } })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ data: { following: false } })),
        });
      vi.stubGlobal("fetch", fetchMock);

      const client = makeClient();
      await client.unfollowUser("target456");

      const unfollowCall = fetchMock.mock.calls[1];
      expect(unfollowCall[0]).toContain("/users/me123/following/target456");
      expect(unfollowCall[1]?.method).toBe("DELETE");
    });
  });

  describe("getNonFollowers", () => {
    it("computes set difference of following vs followers", async () => {
      let callIndex = 0;
      const responses = [
        // getAuthenticatedUserId
        { data: { id: "me123" } },
        // getFollowing page 1 (user A follows B, C, D)
        { data: [
          { id: "B", username: "b", name: "B", public_metrics: { followers_count: 100, following_count: 50 } },
          { id: "C", username: "c", name: "C", public_metrics: { followers_count: 10, following_count: 500 } },
          { id: "D", username: "d", name: "D", public_metrics: { followers_count: 5000, following_count: 200 } },
        ], meta: {} },
        // getFollowers page 1 (only B follows back)
        { data: [
          { id: "B", username: "b", name: "B", public_metrics: { followers_count: 100 } },
          { id: "E", username: "e", name: "E", public_metrics: { followers_count: 200 } },
        ], meta: {} },
      ];

      const fetchMock = vi.fn().mockImplementation(() => {
        const resp = responses[callIndex++] ?? {};
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify(resp)),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = makeClient();
      const { result } = await client.getNonFollowers(1);

      // C and D are not in followers — should appear as non-followers
      expect(result.meta.non_followers_count).toBe(2);
      expect(result.meta.total_following).toBe(3);
      expect(result.meta.total_followers).toBe(2);
      // Sorted by follower count ascending
      expect(result.data[0].id).toBe("C"); // 10 followers
      expect(result.data[1].id).toBe("D"); // 5000 followers
      // Raw user objects preserved (public_metrics intact for compactResponse)
      expect((result.data[0] as Record<string, unknown>).public_metrics).toBeDefined();
    });
  });
});
