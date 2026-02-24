import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processWorkflows,
  submitTaskResponse,
  createWorkflow,
  getWorkflowStatus,
  cleanupNonFollowers,
} from "./workflow.js";
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

// Minimal mock XApiClient — only methods used by workflow engine
function makeMockClient(overrides?: Partial<Record<string, unknown>>): XApiClient {
  return {
    followUser: vi.fn().mockResolvedValue({ result: { data: { following: true } }, rateLimit: "" }),
    getUser: vi.fn().mockResolvedValue({ result: { data: { id: "12345", pinned_tweet_id: "pin123" } }, rateLimit: "" }),
    likeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: true } }, rateLimit: "" }),
    unlikeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: false } }, rateLimit: "" }),
    getTimeline: vi.fn().mockResolvedValue({
      result: {
        data: [
          { id: "tweet1", text: "Original post about AI", author_id: "12345" },
          { id: "tweet2", text: "Reply to someone", author_id: "12345", referenced_tweets: [{ type: "replied_to", id: "other" }] },
        ],
      },
      rateLimit: "",
    }),
    postTweet: vi.fn().mockResolvedValue({ result: { data: { id: "reply789" } }, rateLimit: "" }),
    deleteTweet: vi.fn().mockResolvedValue({ result: { data: { deleted: true } }, rateLimit: "" }),
    unfollowUser: vi.fn().mockResolvedValue({ result: { data: { following: false } }, rateLimit: "" }),
    getAuthenticatedUserId: vi.fn().mockResolvedValue("myid"),
    getFollowers: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    getTweetMetrics: vi.fn().mockResolvedValue({
      result: { data: { public_metrics: { like_count: 5, reply_count: 2, impression_count: 100 } } },
      rateLimit: "",
    }),
    resolveUserId: vi.fn().mockResolvedValue("12345"),
    getNonFollowers: vi.fn().mockResolvedValue({
      result: {
        data: [
          { id: "nf1", username: "nonfollower1", name: "NF1", followers: 10, following: 100 },
          { id: "nf2", username: "nonfollower2", name: "NF2", followers: 5, following: 50 },
          { id: "nf3", username: "protecteduser", name: "Protected", followers: 100, following: 100 },
        ],
        total_following: 100,
        total_followers: 50,
        non_followers_count: 3,
      },
      rateLimit: "",
    }),
    ...overrides,
  } as unknown as XApiClient;
}

// ============================================================
// createWorkflow
// ============================================================

describe("createWorkflow", () => {
  it("creates a follow_cycle workflow", () => {
    const state = makeState();
    const { error, workflow } = createWorkflow(state, "follow_cycle", "12345", "testuser");
    expect(error).toBeNull();
    expect(workflow).not.toBeNull();
    expect(workflow!.id).toBe("fc:testuser");
    expect(workflow!.type).toBe("follow_cycle");
    expect(workflow!.current_step).toBe("execute_follow");
    expect(state.workflows).toHaveLength(1);
  });

  it("creates a reply_track workflow", () => {
    const state = makeState();
    const { error, workflow } = createWorkflow(state, "reply_track", "12345", "testuser");
    expect(error).toBeNull();
    expect(workflow).not.toBeNull();
    expect(workflow!.type).toBe("reply_track");
    expect(workflow!.current_step).toBe("posted");
    expect(workflow!.id).toMatch(/^rt:testuser:\d+$/);
  });

  it("rejects unknown workflow type", () => {
    const state = makeState();
    const { error } = createWorkflow(state, "unknown_type", "12345", "testuser");
    expect(error).toContain("Unknown workflow type");
  });

  it("rejects duplicate active workflow for same target", () => {
    const state = makeState({ workflows: [makeWorkflow()] });
    const { error } = createWorkflow(state, "follow_cycle", "12345", "testuser");
    expect(error).toContain("already exists");
  });

  it("allows workflow for different target", () => {
    const state = makeState({ workflows: [makeWorkflow()] });
    const { error, workflow } = createWorkflow(state, "follow_cycle", "99999", "otheruser");
    expect(error).toBeNull();
    expect(workflow).not.toBeNull();
    expect(state.workflows).toHaveLength(2);
  });

  it("respects max workflows limit", () => {
    const workflows = Array.from({ length: 200 }, (_, i) =>
      makeWorkflow({ id: `fc:user${i}`, target_user_id: String(i), target_username: `user${i}` }),
    );
    const state = makeState({ workflows });
    const { error } = createWorkflow(state, "follow_cycle", "99999", "newuser");
    expect(error).toContain("Maximum active workflows");
  });
});

// ============================================================
// submitTaskResponse
// ============================================================

describe("submitTaskResponse", () => {
  it("accepts reply_text for need_reply_text step", () => {
    const workflow = makeWorkflow({ current_step: "need_reply_text" });
    const state = makeState({ workflows: [workflow] });
    const { error } = submitTaskResponse(state, "fc:testuser", { reply_text: "Great post!" });
    expect(error).toBeNull();
    expect(workflow.current_step).toBe("post_reply");
    expect(workflow.context.reply_text).toBe("Great post!");
  });

  it("rejects missing reply_text", () => {
    const workflow = makeWorkflow({ current_step: "need_reply_text" });
    const state = makeState({ workflows: [workflow] });
    const { error } = submitTaskResponse(state, "fc:testuser", {});
    expect(error).toContain("Missing 'reply_text'");
  });

  it("rejects unknown workflow ID", () => {
    const state = makeState();
    const { error } = submitTaskResponse(state, "fc:nonexistent", { reply_text: "Hi" });
    expect(error).toContain("not found");
  });

  it("rejects completed workflow", () => {
    const workflow = makeWorkflow({ outcome: "followed_back", current_step: "done" });
    const state = makeState({ workflows: [workflow] });
    const { error } = submitTaskResponse(state, "fc:testuser", { reply_text: "Hi" });
    expect(error).toContain("already completed");
  });

  it("rejects unexpected step", () => {
    const workflow = makeWorkflow({ current_step: "waiting" });
    const state = makeState({ workflows: [workflow] });
    const { error } = submitTaskResponse(state, "fc:testuser", { reply_text: "Hi" });
    expect(error).toContain("Unexpected submit");
  });
});

// ============================================================
// getWorkflowStatus
// ============================================================

describe("getWorkflowStatus", () => {
  it("returns active workflows only by default", () => {
    const active = makeWorkflow();
    const completed = makeWorkflow({ id: "fc:done", outcome: "followed_back", current_step: "done" });
    const state = makeState({ workflows: [active, completed] });
    const result = getWorkflowStatus(state);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("fc:testuser");
  });

  it("includes completed when requested", () => {
    const active = makeWorkflow();
    const completed = makeWorkflow({ id: "fc:done", outcome: "followed_back", current_step: "done" });
    const state = makeState({ workflows: [active, completed] });
    const result = getWorkflowStatus(state, undefined, true);
    expect(result).toHaveLength(2);
  });

  it("filters by type", () => {
    const fc = makeWorkflow();
    const rt = makeWorkflow({ id: "rt:testuser:123", type: "reply_track", current_step: "posted" });
    const state = makeState({ workflows: [fc, rt] });

    expect(getWorkflowStatus(state, "follow_cycle")).toHaveLength(1);
    expect(getWorkflowStatus(state, "reply_track")).toHaveLength(1);
    expect(getWorkflowStatus(state, "nonexistent")).toHaveLength(0);
  });
});

// ============================================================
// processWorkflows — Follow Cycle
// ============================================================

describe("processWorkflows — follow_cycle", () => {
  it("auto-executes follow + like pinned + get timeline, returns at need_reply_text", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();
    const config = makeConfig();

    const result = await processWorkflows(state, client, config, new Set());

    expect(client.followUser).toHaveBeenCalledWith("12345");
    expect(client.getUser).toHaveBeenCalled();
    expect(client.likeTweet).toHaveBeenCalledWith("pin123");
    expect(client.getTimeline).toHaveBeenCalled();

    expect(workflow.current_step).toBe("need_reply_text");
    expect(workflow.actions_done).toContain("followed");
    expect(workflow.actions_done).toContain("liked_pinned");
    expect(workflow.context.target_tweet_id).toBe("tweet1"); // picks non-reply
    expect(workflow.context.pinned_tweet_id).toBe("pin123");

    expect(result.next_task).not.toBeNull();
    expect(result.next_task!.workflow_id).toBe("fc:testuser");
    expect(result.next_task!.instruction).toContain("reply");
  });

  it("skips duplicate follow", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({
      workflows: [workflow],
      engaged: { ...getDefaultState().engaged, followed: [{ tweet_id: "12345", at: new Date().toISOString() }] },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(client.followUser).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("skipped_duplicate");
    expect(workflow.current_step).toBe("done");
  });

  it("respects follow budget exhaustion", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, follows: 10 },
    });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), new Set());

    expect(client.followUser).not.toHaveBeenCalled();
    expect(result.auto_completed[0]).toContain("budget exhausted");
  });

  it("posts reply and sets check-back date", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(client.postTweet).toHaveBeenCalledWith({
      text: "Great insight!",
      reply_to: "tweet1",
    });
    expect(workflow.current_step).toBe("waiting");
    expect(workflow.check_after).not.toBeNull();
    expect(workflow.context.reply_tweet_id).toBe("reply789");
    expect(workflow.actions_done).toContain("replied");
  });

  it("skips waiting workflows that haven't reached check_after", async () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: futureDate,
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), new Set());

    expect(workflow.current_step).toBe("waiting"); // unchanged
    expect(result.next_task).toBeNull();
    expect(result.status).toContain("waiting");
  });

  it("advances to check_followback when check_after has passed", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [workflow] });
    // Mock: target did NOT follow back
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(client.getFollowers).toHaveBeenCalled();
    // Since mock getFollowers returns empty array → not followed back → cleanup
    expect(workflow.outcome).toBe("cleaned_up");
    expect(workflow.current_step).toBe("done");
  });

  it("detects followback", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [workflow] });
    // Mock: target followed back
    const client = makeMockClient({
      getFollowers: vi.fn().mockResolvedValue({
        result: { data: [{ id: "12345" }] },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(workflow.outcome).toBe("followed_back");
    expect(workflow.current_step).toBe("done");
  });

  it("protects accounts from cleanup", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), new Set(["testuser"]));

    expect(client.unfollowUser).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("protected_kept");
  });

  it("performs cleanup — unlike, delete, unfollow", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(client.unlikeTweet).toHaveBeenCalledWith("pin123");
    expect(client.deleteTweet).toHaveBeenCalledWith("reply789");
    expect(client.unfollowUser).toHaveBeenCalledWith("12345");
    expect(workflow.outcome).toBe("cleaned_up");
    expect(workflow.actions_done).toContain("unliked_pinned");
    expect(workflow.actions_done).toContain("deleted_reply");
    expect(workflow.actions_done).toContain("unfollowed");
  });
});

// ============================================================
// processWorkflows — Reply Track
// ============================================================

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

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(workflow.current_step).toBe("waiting_audit");
    expect(workflow.check_after).not.toBeNull();
  });

  it("skips audit when under 48h", async () => {
    const workflow = makeWorkflow({
      id: "rt:testuser:123",
      type: "reply_track",
      current_step: "waiting_audit",
      created_at: new Date().toISOString(), // just created
      context: { reply_tweet_id: "reply1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), new Set());

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

    await processWorkflows(state, client, makeConfig(), new Set());

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

    await processWorkflows(state, client, makeConfig(), new Set());

    expect(client.deleteTweet).toHaveBeenCalledWith("reply1");
    expect(workflow.outcome).toBe("deleted_low_engagement");
  });
});

// ============================================================
// cleanupNonFollowers
// ============================================================

describe("cleanupNonFollowers", () => {
  it("unfollows non-followers within budget", async () => {
    const state = makeState();
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), new Set(), 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1", "@nonfollower2", "@protecteduser"]);
    expect(result.skipped).toEqual([]);
    expect(result.error).toBeNull();
    expect(state.budget.unfollows).toBe(3);
  });

  it("skips protected accounts", async () => {
    const state = makeState();
    const client = makeMockClient();
    const protectedSet = new Set(["protecteduser"]);

    const result = await cleanupNonFollowers(client, state, makeConfig(), protectedSet, 10, 5);

    expect(result.unfollowed).toEqual(["@nonfollower1", "@nonfollower2"]);
    expect(result.skipped).toContain("@protecteduser (protected)");
  });

  it("respects max_unfollow limit", async () => {
    const state = makeState();
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), new Set(), 1, 5);

    expect(result.unfollowed).toHaveLength(1);
  });

  it("stops when budget exhausted", async () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, unfollows: 10 },
    });
    const client = makeMockClient();

    const result = await cleanupNonFollowers(client, state, makeConfig(), new Set(), 10, 5);

    expect(result.unfollowed).toEqual([]);
    expect(result.skipped).toContain("budget exhausted — stopped");
  });
});

// ============================================================
// processWorkflows — multiple workflows
// ============================================================

describe("processWorkflows — batch processing", () => {
  it("auto-processes multiple due workflows in one call", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const wf1 = makeWorkflow({
      id: "fc:alice",
      target_username: "alice",
      target_user_id: "111",
      current_step: "waiting",
      check_after: pastDate,
    });
    const wf2 = makeWorkflow({
      id: "fc:bob",
      target_username: "bob",
      target_user_id: "222",
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [wf1, wf2] });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), new Set());

    expect(wf1.outcome).not.toBeNull();
    expect(wf2.outcome).not.toBeNull();
    expect(result.auto_completed.length).toBeGreaterThanOrEqual(2);
  });

  it("skips completed workflows", async () => {
    const completed = makeWorkflow({
      current_step: "done",
      outcome: "followed_back",
    });
    const state = makeState({ workflows: [completed] });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), new Set());

    expect(result.auto_completed).toEqual([]);
    expect(result.next_task).toBeNull();
    expect(result.status).toContain("No active workflows");
  });

  it("returns first LLM-required task only", async () => {
    const wf1 = makeWorkflow({
      id: "fc:alice",
      target_username: "alice",
      current_step: "need_reply_text",
      context: { target_tweet_id: "t1", target_tweet_text: "Hello" },
    });
    const wf2 = makeWorkflow({
      id: "fc:bob",
      target_username: "bob",
      current_step: "need_reply_text",
      context: { target_tweet_id: "t2", target_tweet_text: "World" },
    });
    const state = makeState({ workflows: [wf1, wf2] });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), new Set());

    expect(result.next_task).not.toBeNull();
    expect(result.next_task!.workflow_id).toBe("fc:alice"); // first one
  });
});
