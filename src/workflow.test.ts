import { describe, it, expect, vi } from "vitest";
import {
  processWorkflows,
  submitTaskResponse,
  createWorkflow,
  getWorkflowStatus,
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

function makeMockClient(overrides?: Partial<Record<string, unknown>>): XApiClient {
  return {
    followUser: vi.fn().mockResolvedValue({ result: { data: { following: true } }, rateLimit: "" }),
    getUser: vi.fn().mockResolvedValue({ result: { data: { id: "12345", pinned_tweet_id: "pin123", public_metrics: { followers_count: 5000 } } }, rateLimit: "" }),
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

  it("creates a reply_track with initial context", () => {
    const state = makeState();
    const { error, workflow } = createWorkflow(state, "reply_track", "12345", "testuser", { reply_tweet_id: "rt999" });
    expect(error).toBeNull();
    expect(workflow!.context.reply_tweet_id).toBe("rt999");
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

  it("allows same target after previous workflow completed", () => {
    const completed = makeWorkflow({ outcome: "cleaned_up", current_step: "done" });
    const state = makeState({ workflows: [completed] });
    const { error, workflow } = createWorkflow(state, "follow_cycle", "12345", "testuser");
    expect(error).toBeNull();
    expect(workflow).not.toBeNull();
    expect(state.workflows).toHaveLength(2);
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

  it("finds active workflow when completed workflow with same ID exists", () => {
    const completed = makeWorkflow({ outcome: "cleaned_up", current_step: "done" });
    const active = makeWorkflow({ current_step: "need_reply_text" });
    const state = makeState({ workflows: [completed, active] });
    const { error } = submitTaskResponse(state, "fc:testuser", { reply_text: "Hello!" });
    expect(error).toBeNull();
    expect(active.current_step).toBe("post_reply");
    expect(active.context.reply_text).toBe("Hello!");
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
// processWorkflows — batch processing
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

    const result = await processWorkflows(state, client, makeConfig(), []);

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

    const result = await processWorkflows(state, client, makeConfig(), []);

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

    const result = await processWorkflows(state, client, makeConfig(), []);

    expect(result.next_task).not.toBeNull();
    expect(result.next_task!.workflow_id).toBe("fc:alice"); // first one
  });
});
