import { describe, it, expect, vi } from "vitest";
import { processWorkflows } from "./workflow.js";
import { getDefaultState } from "./state.js";
import type { StateFile, Workflow } from "./state.js";
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

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "fc:testuser",
    type: "follow_cycle",
    current_step: "execute_follow",
    target_user_id: "12345",
    target_username: "testuser",
    created_at: new Date().toISOString(),
    check_after: null,
    context: {},
    actions_done: [],
    outcome: null,
    ...overrides,
  };
}

function makeMockClient(overrides?: Partial<Record<string, unknown>>): XApiClient {
  return {
    followUser: vi.fn().mockResolvedValue({ result: { data: { following: true } }, rateLimit: "" }),
    getUser: vi.fn().mockResolvedValue({ result: { data: { id: "12345", pinned_tweet_id: "pin123", public_metrics: { followers_count: 5000 } } }, rateLimit: "" }),
    likeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: true } }, rateLimit: "" }),
    unlikeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: false } }, rateLimit: "" }),
    getTimeline: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    postTweet: vi.fn().mockResolvedValue({ result: { data: { id: "reply789" } }, rateLimit: "" }),
    deleteTweet: vi.fn().mockResolvedValue({ result: { data: { deleted: true } }, rateLimit: "" }),
    unfollowUser: vi.fn().mockResolvedValue({ result: { data: { following: false } }, rateLimit: "" }),
    getAuthenticatedUserId: vi.fn().mockResolvedValue("myid"),
    getFollowers: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    getFollowing: vi.fn().mockResolvedValue({ result: { data: [], meta: {} }, rateLimit: "" }),
    getTweetMetrics: vi.fn().mockResolvedValue({
      result: { data: { public_metrics: { like_count: 5, reply_count: 2, impression_count: 100 } } },
      rateLimit: "",
    }),
    resolveUserId: vi.fn().mockResolvedValue("12345"),
    getNonFollowers: vi.fn().mockResolvedValue({ result: { data: [], meta: { total_following: 0, total_followers: 0, non_followers_count: 0 } }, rateLimit: "" }),
    ...overrides,
  } as unknown as XApiClient;
}

describe("processWorkflows — reply_track", () => {
  it("transitions from posted to waiting_audit", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "posted",
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("waiting_audit");
    expect(workflow.check_after).not.toBeNull();
  });

  it("skips audit when check_after is in the future", async () => {
    const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date().toISOString(), // just created
      check_after: futureDate,
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("waiting_audit"); // unchanged
  });

  it("audits after 48h — keeps if engaged", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient(); // mock returns 5 likes, 2 replies

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("done");
    expect(workflow.outcome).toBe("audited_kept");
    expect(workflow.context.audit_likes).toBe("5");
  });

  it("auto-deletes if zero engagement after 48h", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTweetMetrics: vi.fn().mockResolvedValue({
        result: { data: { public_metrics: { like_count: 0, reply_count: 0, impression_count: 50 } } },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.deleteTweet).toHaveBeenCalledWith("reply1");
    expect(workflow.outcome).toBe("deleted_low_engagement");
  });

  it("finishes with no_tweet_to_audit when reply_tweet_id is missing", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      context: {}, // no reply_tweet_id
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.outcome).toBe("no_tweet_to_audit");
    expect(workflow.current_step).toBe("done");
  });

  it("keeps tweet when metrics API fails", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTweetMetrics: vi.fn().mockRejectedValue(new Error("metrics API error")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.outcome).toBe("audit_failed");
    expect(workflow.current_step).toBe("done");
  });

  it("keeps tweet when zero engagement but delete budget exhausted", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, deletes: 5 },
    });
    const client = makeMockClient({
      getTweetMetrics: vi.fn().mockResolvedValue({
        result: { data: { public_metrics: { like_count: 0, reply_count: 0, impression_count: 50 } } },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.deleteTweet).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("audited_kept");
    expect(workflow.context.audit_likes).toBe("0");
    expect(workflow.context.audit_replies).toBe("0");
  });

  it("keeps tweet when zero engagement but delete API fails", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTweetMetrics: vi.fn().mockResolvedValue({
        result: { data: { public_metrics: { like_count: 0, reply_count: 0, impression_count: 30 } } },
        rateLimit: "",
      }),
      deleteTweet: vi.fn().mockRejectedValue(new Error("delete API error")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.deleteTweet).toHaveBeenCalledWith("reply1");
    expect(workflow.outcome).toBe("audited_kept"); // kept because delete failed
    expect(workflow.context.audit_likes).toBe("0");
  });
});
