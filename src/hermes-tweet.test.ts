import { describe, expect, it, vi, beforeEach } from "vitest";
import { XApiClient } from "./x-api.js";

function makeHermesClient(apiKey = "xq_test"): XApiClient {
  return new XApiClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    accessToken: "test-access",
    accessTokenSecret: "test-access-secret",
    bearerToken: "test-bearer",
    readBackend: "hermes",
    hermesApiKey: apiKey,
    hermesBaseUrl: "https://example.test",
  });
}

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
  }));
}

function firstFetchCall(): [string, RequestInit] {
  const call = vi.mocked(fetch).mock.calls[0];
  return [String(call[0]), call[1] as RequestInit];
}

describe("Hermes Tweet read backend", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes tweet reads into X API response shape", async () => {
    mockFetchResponse({
      data: {
        id: "123",
        full_text: "full tweet text",
        createdAt: "2026-06-06T12:00:00.000Z",
        likes: 7,
        retweets: 2,
        replies: 1,
        user: {
          id: "u1",
          screen_name: "alice",
          name: "Alice",
          followers: 20,
          following: 5,
          tweets: 100,
        },
      },
    });

    const client = makeHermesClient();
    const { result, rateLimit } = await client.getTweet("123");

    expect(result.data).toMatchObject({
      id: "123",
      text: "full tweet text",
      author_id: "u1",
      public_metrics: {
        like_count: 7,
        retweet_count: 2,
        reply_count: 1,
      },
    });
    expect(result.includes?.users?.[0]).toMatchObject({
      id: "u1",
      username: "alice",
      public_metrics: {
        followers_count: 20,
        following_count: 5,
        tweet_count: 100,
      },
    });
    expect(rateLimit).toBe("Hermes Tweet read backend");

    const [url, init] = firstFetchCall();
    expect(url).toBe("https://example.test/api/v1/x/tweets/123");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("xq_test");
  });

  it("maps search options and filters normalized tweet results", async () => {
    mockFetchResponse({
      tweets: [
        {
          id: "low",
          text: "low engagement",
          likes: 3,
          retweets: 4,
          author: { id: "u1", username: "low_user" },
        },
        {
          id: "high",
          text: "high engagement",
          likes: 12,
          retweets: 5,
          author: { id: "u2", username: "high_user" },
        },
      ],
      next_cursor: "next-page",
    });

    const client = makeHermesClient();
    const { result } = await client.searchTweets("mcp", 10, "cursor-1", {
      minLikes: 10,
      minRetweets: 5,
      sortOrder: "relevancy",
    });

    expect(result.data).toEqual([
      expect.objectContaining({ id: "high", author_id: "u2" }),
    ]);
    expect(result.includes?.users).toEqual([
      expect.objectContaining({ id: "u2", username: "high_user" }),
    ]);
    expect(result.meta).toMatchObject({
      result_count: 1,
      next_token: "next-page",
    });

    const [url] = firstFetchCall();
    const requestUrl = new URL(url);
    expect(requestUrl.pathname).toBe("/api/v1/x/tweets/search");
    expect(requestUrl.searchParams.get("q")).toBe("mcp");
    expect(requestUrl.searchParams.get("cursor")).toBe("cursor-1");
    expect(requestUrl.searchParams.get("queryType")).toBe("Top");
  });

  it("uses bearer auth for non-Xquik Hermes-compatible keys", async () => {
    mockFetchResponse({
      data: {
        id: "u1",
        username: "alice",
      },
    });

    const client = makeHermesClient("generic-token");
    await client.getUser({ username: "alice" });

    const [, init] = firstFetchCall();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer generic-token");
  });

  it("falls back to X API search when since_id is requested", async () => {
    mockFetchResponse({ data: [], meta: { result_count: 0 } });

    const client = makeHermesClient();
    await client.searchTweets("mcp", 10, undefined, { sinceId: "999" });

    const [url, init] = firstFetchCall();
    expect(url).toContain("https://api.x.com/2/tweets/search/recent");
    expect(url).toContain("since_id=999");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-bearer");
  });
});
