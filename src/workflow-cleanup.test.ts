import { describe, it, expect, vi } from "vitest";
import { cleanupNonFollowers } from "./workflow.js";
import { getDefaultState } from "./state.js";
import type { StateFile } from "./state.js";
import type { BudgetConfig } from "./safety.js";
import type { XApiClient } from "./x-api.js";

function makeConfig(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return {
    maxReplies: 8,
    maxOriginals: 2,
    maxLikes: 20,
    maxRetweets: 5,
    maxFollows: 10,
    maxUnfollows: 10,
    maxDeletes: 5,
    ...overrides,
  };
}

function makeState(overrides?: Partial<StateFile>): StateFile {
  return { ...getDefaultState(), ...overrides };
}

function makeMockClient(overrides?: Partial<Record<string, unknown>>): XApiClient {
  return {
    followUser: vi.fn().mockResolvedValue({ result: { data: { following: true } }, rateLimit: "" }),
    getUser: vi.fn().mockResolvedValue({ result: { data: {} }, rateLimit: "" }),
    likeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: true } }, rateLimit: "" }),
    unlikeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: false } }, rateLimit: "" }),
    getTimeline: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    postTweet: vi.fn().mockResolvedValue({ result: { data: { id: "reply789" } }, rateLimit: "" }),
    deleteTweet: vi.fn().mockResolvedValue({ result: { data: { deleted: true } }, rateLimit: "" }),
    unfollowUser: vi.fn().mockResolvedValue({ result: { data: { following: false } }, rateLimit: "" }),
    getAuthenticatedUserId: vi.fn().mockResolvedValue("myid"),
    getFollowers: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    getFollowing: vi.fn().mockResolvedValue({ result: { data: [], meta: {} }, rateLimit: "" }),
    getTweetMetrics: vi.fn().mockResolvedValue({ result: { data: { public_metrics: {} } }, rateLimit: "" }),
    resolveUserId: vi.fn().mockResolvedValue("12345"),
    getNonFollowers: vi.fn().mockResolvedValue({
      result: {
        data: [
          { id: "nf1", username: "nonfollower1", name: "NF1", public_metrics: { followers_count: 10, following_count: 100 } },
          { id: "nf2", username: "nonfollower2", name: "NF2", public_metrics: { followers_count: 5, following_count: 50 } },
          { id: "nf3", username: "protecteduser", name: "Protected", public_metrics: { followers_count: 100, following_count: 100 } },
        ],
        meta: {
          total_following: 100,
          total_followers: 50,
          non_followers_count: 3,
        },
      },
      rateLimit: "",
    }),
    ...overrides,
  } as unknown as XApiClient;
}

describe("cleanupNonFollowers", () => {
  it("unfollows non-followers within budget", async () => {
    const state = makeState();
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), [], 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1", "@nonfollower2", "@protecteduser"]);
    expect(result.skipped).toEqual([]);
    expect(result.error).toBeNull();
    expect(state.budget.unfollows).toBe(3);
  });

  it("skips protected accounts", async () => {
    const state = makeState();
    const client = makeMockClient();
    const protectedSet = [{ username: "protecteduser", userId: "nf3" }];

    const result = await cleanupNonFollowers(client, state, makeConfig(), protectedSet, 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1", "@nonfollower2"]);
    expect(result.skipped).toContain("@protecteduser (protected)");
  });

  it("skips protected accounts matched by userId", async () => {
    const state = makeState();
    const client = makeMockClient();
    // Only userId matches — username in protected list doesn't match "protecteduser"
    const protectedSet = [{ username: "different_name", userId: "nf3" }];

    const result = await cleanupNonFollowers(client, state, makeConfig(), protectedSet, 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1", "@nonfollower2"]);
    expect(result.skipped).toContain("@protecteduser (protected)");
  });

  it("respects max_unfollow limit", async () => {
    const state = makeState();
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), [], 1, 5);

    expect(result.unfollowed).toHaveLength(1);
  });

  it("stops when budget exhausted", async () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, unfollows: 10 },
    });
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), [], 10, 5);

    expect(result.unfollowed).toEqual([]);
    expect(result.skipped).toContain("budget exhausted — stopped");
  });

  it("records API error for individual unfollow failures", async () => {
    const state = makeState();
    const client = makeMockClient({
      unfollowUser: vi.fn()
        .mockResolvedValueOnce({ result: { data: { following: false } }, rateLimit: "" })
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValueOnce({ result: { data: { following: false } }, rateLimit: "" }),
    });

    const result = await cleanupNonFollowers(client, state, makeConfig(), [], 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1", "@protecteduser"]);
    expect(result.skipped).toEqual(["@nonfollower2 (API error)"]);
    expect(state.budget.unfollows).toBe(2);
  });

  it("handles API error during getNonFollowers", async () => {
    const state = makeState();
    const client = makeMockClient({
      getNonFollowers: vi.fn().mockRejectedValue(new Error("API down")),
    });

    const result = await cleanupNonFollowers(client, state, makeConfig(), [], 10, 5);

    expect(result.error).toContain("API down");
    expect(result.unfollowed).toEqual([]);
  });

  it("unfollows some then stops when budget exhausted mid-batch", async () => {
    // Budget starts at 9/10 — first unfollow succeeds (10/10), second blocked
    const state = makeState({
      budget: { ...getDefaultState().budget, unfollows: 9 },
    });
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), [], 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1"]);
    expect(result.skipped).toContain("budget exhausted — stopped");
    expect(state.budget.unfollows).toBe(10);
  });
});
