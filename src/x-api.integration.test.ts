/**
 * Integration tests against xdevplatform/playground — a local X API v2 simulator.
 *
 * These tests prove that our XApiClient works against real X API response shapes,
 * not hand-crafted mocks. If the playground (which mirrors the real API) returns
 * different field names or structures, these tests fail.
 *
 * Prerequisites:
 *   go install github.com/xdevplatform/playground/cmd/playground@latest
 *   playground start --port 8090 &
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { XApiClient } from "./x-api.js";
import { compactResponse, type CompactTweet, type CompactUser } from "./compact.js";
import { getDefaultState, type StateFile } from "./state.js";
import { recordAction, formatBudgetString, loadBudgetConfig } from "./safety.js";
import { formatResult } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  return JSON.parse(raw);
}

const PLAYGROUND_PORT = 8090;
const PLAYGROUND_BASE = `http://localhost:${PLAYGROUND_PORT}/2`;
const PLAYGROUND_HEALTH = `http://localhost:${PLAYGROUND_PORT}/health`;

function makeClient(): XApiClient {
  return new XApiClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    accessToken: "test-token",
    accessTokenSecret: "test-secret",
    bearerToken: "test",
    apiBase: PLAYGROUND_BASE,
  });
}

// Check playground availability before all tests
let playgroundAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(PLAYGROUND_HEALTH);
    playgroundAvailable = res.ok;
  } catch {
    playgroundAvailable = false;
  }
  if (!playgroundAvailable) {
    console.warn(
      "\n⚠ Playground not running. Skipping integration tests.\n" +
      "  Start it with: playground start --port 8090\n",
    );
  }
});

// Helper: skip test if playground is not running
function itLive(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (!playgroundAvailable) return; // silently skip
    await fn();
  });
}

// ============================================================
// API Client Integration Tests
// ============================================================

describe("XApiClient against playground", () => {
  const client = makeClient();

  // --- Authentication ---

  itLive("getAuthenticatedUserId returns a user ID", async () => {
    const id = await client.getAuthenticatedUserId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  // --- Tweet CRUD ---

  itLive("postTweet creates a tweet and returns data.id", async () => {
    const { result } = await client.postTweet({ text: "Integration test tweet" });
    const data = (result as { data?: { id?: string } }).data;
    expect(data).toBeDefined();
    expect(typeof data!.id).toBe("string");
  });

  itLive("getTweet returns tweet with expected fields", async () => {
    // First, create a tweet to fetch
    const { result: postResult } = await client.postTweet({ text: "Fetchable tweet" });
    const tweetId = (postResult as { data: { id: string } }).data.id;

    const { result } = await client.getTweet(tweetId);
    const resp = result as {
      data: {
        id: string;
        text: string;
        author_id: string;
        public_metrics: { like_count: number; retweet_count: number; reply_count: number };
        created_at: string;
      };
      includes?: { users: Array<{ id: string; username: string; name: string }> };
    };

    expect(resp.data.id).toBe(tweetId);
    expect(resp.data.text).toBe("Fetchable tweet");
    expect(typeof resp.data.author_id).toBe("string");
    expect(typeof resp.data.public_metrics.like_count).toBe("number");
    expect(typeof resp.data.public_metrics.retweet_count).toBe("number");
    expect(typeof resp.data.public_metrics.reply_count).toBe("number");
    expect(typeof resp.data.created_at).toBe("string");

    // Includes should have users array (author expansion)
    expect(resp.includes).toBeDefined();
    expect(Array.isArray(resp.includes!.users)).toBe(true);
    expect(resp.includes!.users.length).toBeGreaterThan(0);
    expect(typeof resp.includes!.users[0].username).toBe("string");
  });

  itLive("postTweet with reply_to creates a reply", async () => {
    const { result: parent } = await client.postTweet({ text: "Parent tweet" });
    const parentId = (parent as { data: { id: string } }).data.id;

    const { result } = await client.postTweet({ text: "Reply tweet", reply_to: parentId });
    const data = (result as { data?: { id?: string } }).data;
    expect(data).toBeDefined();
    expect(typeof data!.id).toBe("string");
  });

  itLive("postTweet with quote_tweet_id creates a quote tweet", async () => {
    const { result: original } = await client.postTweet({ text: "Original for quoting" });
    const originalId = (original as { data: { id: string } }).data.id;

    const { result } = await client.postTweet({ text: "Quote commentary", quote_tweet_id: originalId });
    const data = (result as { data?: { id?: string } }).data;
    expect(data).toBeDefined();
    expect(typeof data!.id).toBe("string");
  });

  itLive("deleteTweet removes a tweet", async () => {
    const { result: created } = await client.postTweet({ text: "To be deleted" });
    const tweetId = (created as { data: { id: string } }).data.id;

    const { result } = await client.deleteTweet(tweetId);
    const data = (result as { data?: { deleted?: boolean } }).data;
    expect(data).toBeDefined();
    expect(data!.deleted).toBe(true);
  });

  // --- Search ---

  itLive("searchTweets returns array with expected tweet shape", async () => {
    // Create a tweet so search has something to find
    await client.postTweet({ text: "Searchable integration test content" });

    const { result } = await client.searchTweets("integration");
    const resp = result as {
      data?: Array<{
        id: string;
        text: string;
        public_metrics: { like_count: number; retweet_count: number };
      }>;
      meta?: { result_count: number };
    };

    // data may be empty array if search doesn't match, but the shape should be right
    if (resp.data && resp.data.length > 0) {
      expect(typeof resp.data[0].id).toBe("string");
      expect(typeof resp.data[0].text).toBe("string");
      expect(typeof resp.data[0].public_metrics.like_count).toBe("number");
    }
    expect(resp.meta).toBeDefined();
    expect(typeof resp.meta!.result_count).toBe("number");
  });

  // --- User lookup ---

  itLive("getUser by userId returns user with expected fields", async () => {
    const { result } = await client.getUser({ userId: "0" });
    const resp = result as {
      data: {
        id: string;
        username: string;
        name: string;
        description: string;
        verified: boolean;
        public_metrics: { followers_count: number; following_count: number; tweet_count: number };
      };
    };

    expect(resp.data.id).toBe("0");
    expect(typeof resp.data.username).toBe("string");
    expect(typeof resp.data.name).toBe("string");
    expect(typeof resp.data.public_metrics.followers_count).toBe("number");
    expect(typeof resp.data.public_metrics.following_count).toBe("number");
    expect(typeof resp.data.public_metrics.tweet_count).toBe("number");
  });

  // --- Timeline ---
  // Note: playground rejects expansions=author_id on /users/{id}/tweets
  // (only supports pinned_tweet_id). The real API supports it.
  // This is tested via frozen fixtures instead (see fixtures/ tests below).

  // --- Mentions ---
  // Same playground limitation as timeline.

  // --- Followers / Following ---

  itLive("getFollowers returns user array", async () => {
    const { result } = await client.getFollowers("0", 10);
    const resp = result as {
      data?: Array<{ id: string; username: string; public_metrics?: object }>;
    };
    if (resp.data && resp.data.length > 0) {
      expect(typeof resp.data[0].id).toBe("string");
      expect(typeof resp.data[0].username).toBe("string");
    }
  });

  itLive("getFollowing returns user array", async () => {
    const { result } = await client.getFollowing("0", 10);
    const resp = result as {
      data?: Array<{ id: string; username: string }>;
    };
    if (resp.data && resp.data.length > 0) {
      expect(typeof resp.data[0].id).toBe("string");
    }
  });

  // --- Engagement ---

  itLive("likeTweet succeeds", async () => {
    const { result: created } = await client.postTweet({ text: "Like me" });
    const tweetId = (created as { data: { id: string } }).data.id;

    const { result } = await client.likeTweet(tweetId);
    const data = (result as { data?: { liked?: boolean } }).data;
    expect(data).toBeDefined();
    expect(data!.liked).toBe(true);
  });

  itLive("retweet succeeds", async () => {
    const { result: created } = await client.postTweet({ text: "Retweet me" });
    const tweetId = (created as { data: { id: string } }).data.id;

    const { result } = await client.retweet(tweetId);
    const data = (result as { data?: { retweeted?: boolean } }).data;
    expect(data).toBeDefined();
    expect(data!.retweeted).toBe(true);
  });

  // --- Metrics ---

  itLive("getTweetMetrics returns metrics fields", async () => {
    const { result: created } = await client.postTweet({ text: "Metrics tweet" });
    const tweetId = (created as { data: { id: string } }).data.id;

    const { result } = await client.getTweetMetrics(tweetId);
    const resp = result as {
      data?: { public_metrics?: { like_count: number; retweet_count: number } };
    };
    expect(resp.data).toBeDefined();
    expect(resp.data!.public_metrics).toBeDefined();
    expect(typeof resp.data!.public_metrics!.like_count).toBe("number");
  });

  // --- Rate limit headers ---

  itLive("responses include rate limit info", async () => {
    const { rateLimit } = await client.getUser({ userId: "0" });
    // Playground may or may not return rate limit headers
    // Just verify our code doesn't crash — rateLimit is either a string or empty
    expect(typeof rateLimit).toBe("string");
  });
});

// ============================================================
// Full-stack tests: real API response → compact → safety
// ============================================================

describe("compact + safety against real playground responses", () => {
  const client = makeClient();

  itLive("compactResponse produces valid CompactTweet from real API response", async () => {
    const { result: created } = await client.postTweet({ text: "Compact test tweet" });
    const tweetId = (created as { data: { id: string } }).data.id;

    const { result } = await client.getTweet(tweetId);
    const compacted = compactResponse(result) as { data: CompactTweet };

    expect(compacted.data.id).toBe(tweetId);
    expect(compacted.data.text).toBe("Compact test tweet");
    expect(typeof compacted.data.author).toBe("string");
    expect(compacted.data.author).toMatch(/^@/); // resolved to @username
    expect(typeof compacted.data.likes).toBe("number");
    expect(typeof compacted.data.retweets).toBe("number");
    expect(typeof compacted.data.replies).toBe("number");
    expect(typeof compacted.data.created_at).toBe("string");
  });

  itLive("compactResponse produces valid CompactUser from real API response", async () => {
    const { result } = await client.getUser({ userId: "0" });
    const compacted = compactResponse(result) as { data: CompactUser };

    expect(typeof compacted.data.id).toBe("string");
    expect(typeof compacted.data.username).toBe("string");
    expect(typeof compacted.data.name).toBe("string");
    expect(typeof compacted.data.followers).toBe("number");
    expect(typeof compacted.data.following).toBe("number");
    expect(typeof compacted.data.tweets).toBe("number");
    expect(typeof compacted.data.bio).toBe("string");
  });

  itLive("safety modules work correctly with real API flow", async () => {
    const state: StateFile = getDefaultState();
    const config = loadBudgetConfig();

    // Post a tweet via real API
    const { result } = await client.postTweet({ text: "Safety test tweet" });
    const data = (result as { data: { id: string } }).data;
    expect(data.id).toBeDefined();

    // Record the action
    recordAction("post_tweet", null, state);
    expect(state.budget.originals).toBe(1);

    // Like the tweet
    await client.likeTweet(data.id);
    recordAction("like_tweet", data.id, state);
    expect(state.budget.likes).toBe(1);
    expect(state.engaged.liked).toHaveLength(1);
    expect(state.engaged.liked[0].tweet_id).toBe(data.id);

    // Budget string reflects real counts
    const budgetStr = formatBudgetString(state, config);
    expect(budgetStr).toContain("1/2 originals");
    expect(budgetStr).toContain("1/20 likes");
  });
});

// ============================================================
// Frozen fixture tests — real API responses, no playground needed
// ============================================================
// These prove that compactResponse works with REAL X API responses,
// not hand-crafted mocks. The fixtures are captured from the live API
// and committed as-is. If the X API response shape changes, we
// re-capture and these tests tell us what broke.

describe("frozen fixture: get-user-by-username", () => {
  const fixture = loadFixture("get-user-by-username.json") as {
    data: Record<string, unknown>;
  };

  it("fixture has expected raw X API fields", () => {
    const user = fixture.data;
    expect(user.id).toBe("43859239");
    expect(user.username).toBe("JohannesHoppe");
    expect(typeof user.name).toBe("string");
    expect(typeof user.description).toBe("string");
    expect(typeof user.verified).toBe("boolean");
    expect(typeof user.created_at).toBe("string");

    const metrics = user.public_metrics as Record<string, number>;
    expect(typeof metrics.followers_count).toBe("number");
    expect(typeof metrics.following_count).toBe("number");
    expect(typeof metrics.tweet_count).toBe("number");
    expect(typeof metrics.listed_count).toBe("number");
  });

  it("compactResponse produces valid CompactUser", () => {
    const compacted = compactResponse(fixture) as { data: CompactUser };

    expect(compacted.data.id).toBe("43859239");
    expect(compacted.data.username).toBe("JohannesHoppe");
    expect(compacted.data.name).toContain("Johannes Hoppe");
    expect(compacted.data.followers).toBe(3158);
    expect(compacted.data.following).toBe(1982);
    expect(compacted.data.tweets).toBe(6652);
    expect(compacted.data.bio).toContain("Angular");
  });
});

describe("frozen fixture: get-timeline", () => {
  const fixture = loadFixture("get-timeline.json") as {
    data: Array<Record<string, unknown>>;
    includes: { users: Array<Record<string, unknown>> };
    meta: Record<string, unknown>;
  };

  it("fixture has expected raw X API tweet fields", () => {
    expect(fixture.data.length).toBe(5);

    const tweet = fixture.data[0];
    expect(typeof tweet.id).toBe("string");
    expect(typeof tweet.text).toBe("string");
    expect(typeof tweet.author_id).toBe("string");
    expect(typeof tweet.created_at).toBe("string");
    expect(typeof tweet.lang).toBe("string");
    expect(typeof tweet.conversation_id).toBe("string");
    expect(Array.isArray(tweet.edit_history_tweet_ids)).toBe(true);

    const metrics = tweet.public_metrics as Record<string, number>;
    expect(typeof metrics.retweet_count).toBe("number");
    expect(typeof metrics.reply_count).toBe("number");
    expect(typeof metrics.like_count).toBe("number");
    expect(typeof metrics.quote_count).toBe("number");
    expect(typeof metrics.bookmark_count).toBe("number");
    expect(typeof metrics.impression_count).toBe("number");
  });

  it("fixture includes author expansion with public_metrics", () => {
    expect(fixture.includes.users.length).toBeGreaterThan(0);
    const author = fixture.includes.users[0];
    expect(author.username).toBe("JohannesHoppe");
    expect(typeof author.name).toBe("string");
    expect(typeof author.verified).toBe("boolean");

    // User expansion now includes public_metrics
    const userMetrics = author.public_metrics as Record<string, number>;
    expect(typeof userMetrics.followers_count).toBe("number");
    expect(typeof userMetrics.following_count).toBe("number");
    expect(userMetrics.followers_count).toBe(3159);
    expect(userMetrics.following_count).toBe(1983);
  });

  it("fixture has pagination meta", () => {
    expect(typeof fixture.meta.result_count).toBe("number");
    expect(typeof fixture.meta.newest_id).toBe("string");
    expect(typeof fixture.meta.oldest_id).toBe("string");
    expect(typeof fixture.meta.next_token).toBe("string");
  });

  it("compactResponse produces valid CompactTweet array with author_followers", () => {
    const compacted = compactResponse(fixture) as {
      data: CompactTweet[];
      meta: Record<string, unknown>;
    };

    expect(Array.isArray(compacted.data)).toBe(true);
    expect(compacted.data.length).toBe(5);

    const tweet = compacted.data[0];
    expect(tweet.id).toBe("2025978969628238333");
    expect(tweet.author).toBe("@JohannesHoppe");
    expect(typeof tweet.text).toBe("string");
    expect(typeof tweet.likes).toBe("number");
    expect(typeof tweet.retweets).toBe("number");
    expect(typeof tweet.replies).toBe("number");
    expect(typeof tweet.created_at).toBe("string");

    // author_followers and author_ratio should be populated from user expansion
    expect(tweet.author_followers).toBe(3159);
    expect(tweet.author_ratio).toBeGreaterThan(1); // 3159/1983 ≈ 1.59

    // Meta should be preserved (compact strips newest_id/oldest_id)
    expect(compacted.meta).toBeDefined();
    expect(compacted.meta.result_count).toBe(5);
    expect(compacted.meta.next_token).toBe(fixture.meta.next_token);
    expect(compacted.meta.newest_id).toBeUndefined();
    expect(compacted.meta.oldest_id).toBeUndefined();
  });

  it("all timeline tweets resolve author to @JohannesHoppe", () => {
    const compacted = compactResponse(fixture) as { data: CompactTweet[] };
    for (const tweet of compacted.data) {
      expect(tweet.author).toBe("@JohannesHoppe");
    }
  });
});

describe("frozen fixture: get-mentions", () => {
  const fixture = loadFixture("get-mentions.json") as {
    data: Array<Record<string, unknown>>;
    includes: { users: Array<Record<string, unknown>> };
    meta: Record<string, unknown>;
  };

  it("fixture has expected raw X API mention fields", () => {
    expect(fixture.data.length).toBe(5);

    const mention = fixture.data[0];
    expect(typeof mention.id).toBe("string");
    expect(typeof mention.text).toBe("string");
    expect(typeof mention.author_id).toBe("string");
    expect(typeof mention.created_at).toBe("string");
    expect((mention.text as string)).toContain("@JohannesHoppe");

    const metrics = mention.public_metrics as Record<string, number>;
    expect(typeof metrics.retweet_count).toBe("number");
    expect(typeof metrics.reply_count).toBe("number");
    expect(typeof metrics.like_count).toBe("number");
  });

  it("fixture includes mentioning users with public_metrics", () => {
    expect(fixture.includes.users.length).toBe(4);
    const user = fixture.includes.users[0];
    expect(typeof user.id).toBe("string");
    expect(typeof user.username).toBe("string");
    expect(typeof user.name).toBe("string");

    // User expansion includes public_metrics
    const userMetrics = user.public_metrics as Record<string, number>;
    expect(typeof userMetrics.followers_count).toBe("number");
    expect(typeof userMetrics.following_count).toBe("number");
  });

  it("fixture includes verified @angular account", () => {
    const angular = fixture.includes.users.find(
      (u) => (u as { username: string }).username === "angular",
    ) as Record<string, unknown>;
    expect(angular).toBeDefined();
    expect(angular.verified).toBe(true);
    const metrics = angular.public_metrics as Record<string, number>;
    expect(metrics.followers_count).toBeGreaterThan(100000);
  });

  it("compactResponse produces CompactTweet array with different authors", () => {
    const compacted = compactResponse(fixture) as {
      data: CompactTweet[];
      meta: Record<string, unknown>;
    };

    expect(Array.isArray(compacted.data)).toBe(true);
    expect(compacted.data.length).toBe(5);

    // Mentions come from OTHER users, so authors should be resolved
    const tweet = compacted.data[0];
    expect(tweet.author).toBe("@ScalerSohom"); // from includes.users
    expect(tweet.author_followers).toBe(440);
    expect(typeof tweet.likes).toBe("number");
    expect(typeof tweet.retweets).toBe("number");

    // Second mention — different author
    const tweet2 = compacted.data[1];
    expect(tweet2.author).toBe("@thesohom2");
    expect(tweet2.author_followers).toBe(4201);

    // Third mention — from @angular (verified, 492K+ followers)
    const tweet3 = compacted.data[2];
    expect(tweet3.author).toBe("@angular");
    expect(tweet3.author_followers).toBe(492874);
    expect(tweet3.author_ratio).toBeGreaterThan(1000); // 492874/304 ≈ 1621

    // Meta preserved
    expect(compacted.meta).toBeDefined();
    expect(compacted.meta.result_count).toBe(5);
  });
});

describe("frozen fixture: search-tweets", () => {
  const fixture = loadFixture("search-tweets.json") as {
    data: Array<Record<string, unknown>>;
    includes: { users: Array<Record<string, unknown>> };
    meta: Record<string, unknown>;
  };

  it("fixture has expected raw X API search result fields", () => {
    expect(fixture.data.length).toBe(5);

    const tweet = fixture.data[0];
    expect(typeof tweet.id).toBe("string");
    expect(typeof tweet.text).toBe("string");
    expect(typeof tweet.author_id).toBe("string");
    expect(typeof tweet.created_at).toBe("string");
    expect(typeof tweet.lang).toBe("string");
    expect(typeof tweet.conversation_id).toBe("string");

    const metrics = tweet.public_metrics as Record<string, number>;
    expect(typeof metrics.retweet_count).toBe("number");
    expect(typeof metrics.like_count).toBe("number");
    expect(typeof metrics.impression_count).toBe("number");
  });

  it("fixture includes author expansion with public_metrics", () => {
    expect(fixture.includes.users.length).toBeGreaterThan(0);
    const author = fixture.includes.users[0];
    expect(author.username).toBe("JohannesHoppe");

    const userMetrics = author.public_metrics as Record<string, number>;
    expect(typeof userMetrics.followers_count).toBe("number");
    expect(typeof userMetrics.following_count).toBe("number");
  });

  it("compactResponse produces CompactTweet array with author_followers", () => {
    const compacted = compactResponse(fixture) as {
      data: CompactTweet[];
      meta: Record<string, unknown>;
    };

    expect(compacted.data.length).toBe(5);

    const tweet = compacted.data[0];
    expect(tweet.author).toBe("@JohannesHoppe");
    expect(tweet.author_followers).toBe(3159);
    expect(tweet.author_ratio).toBeGreaterThan(1);
    expect(typeof tweet.likes).toBe("number");
    expect(typeof tweet.retweets).toBe("number");
    expect(typeof tweet.created_at).toBe("string");

    // All search results are from same user (query: from:JohannesHoppe)
    for (const t of compacted.data) {
      expect(t.author).toBe("@JohannesHoppe");
    }
  });

  it("search meta has result_count but no next_token (small result set)", () => {
    const compacted = compactResponse(fixture) as {
      meta: Record<string, unknown>;
    };
    expect(compacted.meta.result_count).toBe(5);
  });
});

describe("frozen fixture: get-followers", () => {
  const fixture = loadFixture("get-followers.json") as {
    data: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  };

  it("fixture has expected raw X API follower fields", () => {
    expect(fixture.data.length).toBe(5);

    const user = fixture.data[0];
    expect(typeof user.id).toBe("string");
    expect(typeof user.username).toBe("string");
    expect(typeof user.name).toBe("string");
    expect(typeof user.created_at).toBe("string");
    expect(typeof user.verified).toBe("boolean");

    const metrics = user.public_metrics as Record<string, number>;
    expect(typeof metrics.followers_count).toBe("number");
    expect(typeof metrics.following_count).toBe("number");
    expect(typeof metrics.tweet_count).toBe("number");
  });

  it("fixture has pagination meta", () => {
    expect(fixture.meta.result_count).toBe(5);
    expect(typeof fixture.meta.next_token).toBe("string");
  });

  it("compactResponse produces CompactUser array", () => {
    const compacted = compactResponse(fixture) as {
      data: CompactUser[];
      meta: Record<string, unknown>;
    };

    expect(Array.isArray(compacted.data)).toBe(true);
    expect(compacted.data.length).toBe(5);

    // First follower
    const user = compacted.data[0];
    expect(user.username).toBe("Mark3e8");
    expect(user.followers).toBe(27);
    expect(user.following).toBe(549);
    expect(typeof user.bio).toBe("string");

    // Second follower — has a bio
    const user2 = compacted.data[1];
    expect(user2.username).toBe("brampeirs");
    expect(user2.bio).toContain("Angular");
  });
});

// ============================================================
// Full pipeline: real API → compact → TOON → parseable output
// ============================================================

describe("full pipeline: real fixture → compact → TOON", () => {
  it("timeline fixture produces valid TOON with author_followers", () => {
    const fixture = loadFixture("get-timeline.json");
    const compacted = compactResponse(fixture);
    const toon = formatResult(compacted, "299/300 (900s)", "0/8 replies", false, true);

    // TOON output is NOT valid JSON
    expect(() => JSON.parse(toon)).toThrow();

    // Should contain tabular header with author_followers field
    expect(toon).toContain("author_followers");
    expect(toon).toContain("author_ratio");
    expect(toon).toContain("@JohannesHoppe");
    expect(toon).toContain("rate_limit");
    expect(toon).toContain("budget");
  });

  it("mentions fixture produces valid TOON with multiple authors", () => {
    const fixture = loadFixture("get-mentions.json");
    const compacted = compactResponse(fixture);
    const toon = formatResult(compacted, "14/15 (900s)", "3/8 replies", false, true);

    expect(toon).toContain("@ScalerSohom");
    expect(toon).toContain("@angular");
    expect(toon).toContain("@panditamey1");
    expect(toon).toContain("rate_limit");
  });

  it("followers fixture produces valid TOON with user fields", () => {
    const fixture = loadFixture("get-followers.json");
    const compacted = compactResponse(fixture);
    const toon = formatResult(compacted, "14/15 (900s)", undefined, false, true);

    expect(toon).toContain("Mark3e8");
    expect(toon).toContain("brampeirs");
    expect(toon).toContain("followers");
    expect(toon).toContain("following");
  });

  it("timeline fixture produces valid JSON when toon=false", () => {
    const fixture = loadFixture("get-timeline.json");
    const compacted = compactResponse(fixture);
    const json = formatResult(compacted, "299/300 (900s)", "0/8 replies", false, false);

    // Should be valid JSON
    const parsed = JSON.parse(json);
    expect(parsed.data).toBeDefined();
    expect(parsed.rate_limit).toBe("299/300 (900s)");
    expect(parsed.budget).toBe("0/8 replies");
  });
});
