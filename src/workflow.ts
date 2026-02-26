import type { StateFile, Workflow } from "./state.js";
import type { XApiClient } from "./x-api.js";
import type { BudgetConfig } from "./safety.js";
import { getMaxWorkflows } from "./state.js";
import { checkBudget, recordAction, checkDedup, isProtectedAccount, type ProtectedAccount } from "./safety.js";

// --- Workflow step types ---

export interface LlmTask {
  workflow_id: string;
  instruction: string;
  context: Record<string, unknown>;
  respond_with: string; // "submit_task"
}

export interface WorkflowResult {
  auto_completed: string[];
  next_task: LlmTask | null;
  status: string;
}

// --- Follow Cycle State Machine ---
// Steps: execute_follow → get_reply_context → need_reply_text → post_reply → waiting → check_followback → cleanup → done

async function advanceFollowCycle(
  workflow: Workflow,
  client: XApiClient,
  state: StateFile,
  budgetConfig: BudgetConfig,
  protectedAccounts: ProtectedAccount[],
): Promise<{ llmNeeded: boolean; summary: string | null }> {
  const step = workflow.current_step;

  if (step === "execute_follow") {
    // Check follow budget
    const budgetErr = checkBudget("follow_user", state, budgetConfig);
    if (budgetErr) {
      return { llmNeeded: false, summary: `Follow budget exhausted for @${workflow.target_username}: ${budgetErr}` };
    }

    // Check follow dedup
    const dedupErr = checkDedup("follow_user", workflow.target_user_id, state);
    if (dedupErr) {
      workflow.outcome = "skipped_duplicate";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `Skipped @${workflow.target_username}: ${dedupErr}` };
    }

    // Follow user
    try {
      await client.followUser(workflow.target_user_id);
      recordAction("follow_user", workflow.target_user_id, state);
      workflow.actions_done.push("followed");
    } catch (e: unknown) {
      workflow.outcome = "follow_failed";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `Follow failed for @${workflow.target_username}: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Get user to find pinned tweet
    try {
      const { result } = await client.getUser({ userId: workflow.target_user_id });
      const data = result as { data?: { pinned_tweet_id?: string; public_metrics?: { followers_count?: number } } };
      // Store follower count for LLM context
      if (data.data?.public_metrics?.followers_count !== undefined) {
        workflow.context.author_followers = String(data.data.public_metrics.followers_count);
      }
      if (data.data?.pinned_tweet_id) {
        workflow.context.pinned_tweet_id = data.data.pinned_tweet_id;

        // Like pinned tweet if budget allows
        const likeBudgetErr = checkBudget("like_tweet", state, budgetConfig);
        if (!likeBudgetErr) {
          const likeDedupErr = checkDedup("like_tweet", data.data.pinned_tweet_id, state);
          if (!likeDedupErr) {
            try {
              await client.likeTweet(data.data.pinned_tweet_id);
              recordAction("like_tweet", data.data.pinned_tweet_id, state);
              workflow.actions_done.push("liked_pinned");
            } catch {
              // Like failure is non-fatal
            }
          }
        }
      }
    } catch {
      // getUser failure is non-fatal for liking pinned
    }

    workflow.current_step = "get_reply_context";
    // Continue auto-executing
    return advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
  }

  if (step === "get_reply_context") {
    try {
      // Resolve user ID for timeline (may already have it)
      const { result } = await client.getTimeline(workflow.target_user_id, 5);
      const resp = result as { data?: Array<{ id?: string; text?: string; note_tweet?: { text?: string }; referenced_tweets?: Array<{ type?: string }> }> };
      if (resp.data && resp.data.length > 0) {
        // Pick most recent non-reply tweet
        const candidate = resp.data.find(
          (t) => !t.referenced_tweets?.some((r) => r.type === "replied_to"),
        ) ?? resp.data[0];
        workflow.context.target_tweet_id = candidate.id ?? "";
        workflow.context.target_tweet_text = candidate.note_tweet?.text ?? candidate.text ?? "";
      }
    } catch {
      // Timeline failure — no tweet to reply to
    }

    // If no target tweet was found, skip the reply step entirely
    if (!workflow.context.target_tweet_id) {
      const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      workflow.check_after = checkDate;
      workflow.current_step = "waiting";
      return { llmNeeded: false, summary: `No suitable tweet found for @${workflow.target_username}, skipping reply. Check-back set for ${checkDate}.` };
    }

    workflow.current_step = "need_reply_text";
    // Now return to LLM
    return { llmNeeded: true, summary: null };
  }

  if (step === "need_reply_text") {
    // This step requires LLM input
    return { llmNeeded: true, summary: null };
  }

  if (step === "post_reply") {
    const replyText = workflow.context.reply_text;
    const targetTweetId = workflow.context.target_tweet_id;

    if (!replyText || !targetTweetId) {
      workflow.current_step = "waiting";
      const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      workflow.check_after = checkDate;
      return { llmNeeded: false, summary: `No reply context for @${workflow.target_username}, skipping reply. Check-back set for ${checkDate}.` };
    }

    // Check reply budget
    const budgetErr = checkBudget("reply_to_tweet", state, budgetConfig);
    if (budgetErr) {
      workflow.current_step = "waiting";
      const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      workflow.check_after = checkDate;
      return { llmNeeded: false, summary: `Reply budget exhausted for @${workflow.target_username}. Check-back set for ${checkDate}.` };
    }

    try {
      const { result } = await client.postTweet({
        text: replyText,
        reply_to: targetTweetId,
      });
      const data = result as { data?: { id?: string } };
      if (data.data?.id) {
        workflow.context.reply_tweet_id = data.data.id;
      }
      recordAction("reply_to_tweet", targetTweetId, state);
      workflow.actions_done.push("replied");
    } catch {
      // Reply failure — continue to waiting state anyway
      workflow.actions_done.push("reply_failed");
    }

    const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    workflow.check_after = checkDate;
    workflow.current_step = "waiting";
    return { llmNeeded: false, summary: `Follow cycle for @${workflow.target_username}: reply posted. Check-back scheduled for ${checkDate}.` };
  }

  if (step === "waiting") {
    // check_after is enforced by processWorkflows — if we're here, we're due
    workflow.current_step = "check_followback";
    return advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
  }

  if (step === "check_followback") {
    try {
      const myId = await client.getAuthenticatedUserId();
      // Check if target follows us by paginating through the target's following list.
      // This is more reliable than checking our followers (which could be >1000 pages).
      // The target likely follows far fewer people than we have followers.
      let nextToken: string | undefined;
      const MAX_PAGES = 5;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { result } = await client.getFollowing(workflow.target_user_id, 1000, nextToken);
        const resp = result as { data?: Array<{ id?: string }>; meta?: { next_token?: string } };
        const followingIds = (resp.data ?? []).map((u) => u.id);

        if (followingIds.includes(myId)) {
          workflow.outcome = "followed_back";
          workflow.current_step = "done";
          return { llmNeeded: false, summary: `@${workflow.target_username} followed back!` };
        }

        nextToken = resp.meta?.next_token;
        if (!nextToken) break;
      }
    } catch {
      // If followback check fails, proceed to cleanup anyway
    }

    workflow.current_step = "cleanup";
    return advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
  }

  if (step === "cleanup") {
    // Check protected accounts
    if (isProtectedAccount(workflow.target_username, protectedAccounts)) {
      workflow.outcome = "protected_kept";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `@${workflow.target_username} is protected — kept follow, skipped cleanup.` };
    }

    // Unlike pinned tweet (ignore errors)
    if (workflow.context.pinned_tweet_id) {
      try {
        await client.unlikeTweet(workflow.context.pinned_tweet_id);
        workflow.actions_done.push("unliked_pinned");
      } catch {
        // Ignore
      }
    }

    // Delete reply within budget (ignore errors)
    if (workflow.context.reply_tweet_id) {
      const deleteBudgetErr = checkBudget("delete_tweet", state, budgetConfig);
      if (!deleteBudgetErr) {
        try {
          await client.deleteTweet(workflow.context.reply_tweet_id);
          recordAction("delete_tweet", null, state);
          workflow.actions_done.push("deleted_reply");
        } catch {
          // Ignore
        }
      }
    }

    // Unfollow within budget
    const unfollowBudgetErr = checkBudget("unfollow_user", state, budgetConfig);
    if (!unfollowBudgetErr) {
      try {
        await client.unfollowUser(workflow.target_user_id);
        recordAction("unfollow_user", null, state);
        workflow.actions_done.push("unfollowed");
      } catch {
        // Ignore
      }
    }

    workflow.outcome = "cleaned_up";
    workflow.current_step = "done";
    return { llmNeeded: false, summary: `@${workflow.target_username} cleaned up (${workflow.actions_done.filter((a) => a.startsWith("unliked") || a.startsWith("deleted") || a.startsWith("unfollowed")).join(", ")}).` };
  }

  // "done" or unknown step
  return { llmNeeded: false, summary: null };
}

// --- Reply Track State Machine ---
// Steps: posted → waiting_audit → audit → done

async function advanceReplyTrack(
  workflow: Workflow,
  client: XApiClient,
  state: StateFile,
  budgetConfig: BudgetConfig,
): Promise<{ llmNeeded: boolean; summary: string | null }> {
  const step = workflow.current_step;

  if (step === "posted") {
    // Set audit timer: 48h after created_at
    const auditDate = new Date(new Date(workflow.created_at).getTime() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    workflow.check_after = auditDate;
    workflow.current_step = "waiting_audit";
    return { llmNeeded: false, summary: null };
  }

  if (step === "waiting_audit") {
    // check_after is enforced by processWorkflows — if we're here, we're due
    workflow.current_step = "audit";
    return advanceReplyTrack(workflow, client, state, budgetConfig);
  }

  if (step === "audit") {
    const tweetId = workflow.context.reply_tweet_id;
    if (!tweetId) {
      workflow.outcome = "no_tweet_to_audit";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: null };
    }

    try {
      const { result } = await client.getTweetMetrics(tweetId);
      const data = result as { data?: { public_metrics?: { like_count?: number; reply_count?: number; impression_count?: number } } };
      const metrics = data.data?.public_metrics;
      const likes = metrics?.like_count ?? 0;
      const replies = metrics?.reply_count ?? 0;
      const impressions = metrics?.impression_count ?? 0;

      workflow.context.audit_likes = String(likes);
      workflow.context.audit_replies = String(replies);
      workflow.context.audit_impressions = String(impressions);

      // Auto-delete if very low engagement (0 likes, 0 replies after 48h)
      if (likes === 0 && replies === 0) {
        const deleteBudgetErr = checkBudget("delete_tweet", state, budgetConfig);
        if (!deleteBudgetErr) {
          try {
            await client.deleteTweet(tweetId);
            recordAction("delete_tweet", null, state);
            workflow.actions_done.push("deleted_low_engagement");
            workflow.outcome = "deleted_low_engagement";
            workflow.current_step = "done";
            return { llmNeeded: false, summary: `Reply ${tweetId} deleted (0 likes, 0 replies after 48h).` };
          } catch {
            // Ignore deletion failure
          }
        }
      }

      workflow.outcome = "audited_kept";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `Reply ${tweetId} audited: ${likes} likes, ${replies} replies, ${impressions} impressions — kept.` };
    } catch {
      workflow.outcome = "audit_failed";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `Reply ${tweetId} audit failed — kept.` };
    }
  }

  return { llmNeeded: false, summary: null };
}

// --- Public API ---

export async function processWorkflows(
  state: StateFile,
  client: XApiClient,
  budgetConfig: BudgetConfig,
  protectedAccounts: ProtectedAccount[],
): Promise<WorkflowResult> {
  const autoCompleted: string[] = [];
  let nextTask: LlmTask | null = null;

  // Process all workflows that have auto-steps pending
  const today = new Date().toISOString().slice(0, 10);
  for (const workflow of state.workflows) {
    if (workflow.outcome) continue; // Skip completed workflows

    // Skip workflows that aren't due yet (applies to all types)
    if (workflow.check_after && workflow.check_after > today) continue;

    let result: { llmNeeded: boolean; summary: string | null };

    if (workflow.type === "follow_cycle") {
      result = await advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
    } else if (workflow.type === "reply_track") {
      result = await advanceReplyTrack(workflow, client, state, budgetConfig);
    } else {
      continue;
    }

    if (result.summary) {
      autoCompleted.push(result.summary);
    }

    if (result.llmNeeded && !nextTask) {
      nextTask = buildLlmTask(workflow);
    }
  }

  // Build status
  const active = state.workflows.filter((w) => !w.outcome);
  const waiting = active.filter((w) => w.check_after && w.check_after > new Date().toISOString().slice(0, 10));
  const earliestCheck = waiting.length > 0
    ? waiting.reduce((earliest, w) => w.check_after! < earliest ? w.check_after! : earliest, waiting[0].check_after!)
    : null;

  let status: string;
  if (nextTask) {
    status = `${active.length} active workflows. Task ready.`;
  } else if (waiting.length > 0) {
    status = `No tasks pending. ${waiting.length} workflows waiting (earliest check-back: ${earliestCheck}).`;
  } else if (active.length > 0) {
    status = `${active.length} active workflows, no tasks pending.`;
  } else {
    status = "No active workflows.";
  }

  return { auto_completed: autoCompleted, next_task: nextTask, status };
}

function buildLlmTask(workflow: Workflow): LlmTask {
  if (workflow.type === "follow_cycle" && workflow.current_step === "need_reply_text") {
    return {
      workflow_id: workflow.id,
      instruction: "Write a genuine, insightful reply to this tweet. Spark conversation, don't be generic. Keep it under 280 characters.",
      context: {
        tweet_id: workflow.context.target_tweet_id || "",
        tweet_text: workflow.context.target_tweet_text || "",
        author: `@${workflow.target_username}`,
        author_followers: workflow.context.author_followers || "unknown",
      },
      respond_with: "submit_task",
    };
  }

  // Fallback for unknown steps that need LLM
  return {
    workflow_id: workflow.id,
    instruction: `Workflow ${workflow.type} at step ${workflow.current_step} needs input.`,
    context: { ...workflow.context },
    respond_with: "submit_task",
  };
}

export function submitTaskResponse(
  state: StateFile,
  workflowId: string,
  response: Record<string, string>,
): { error: string | null; workflow: Workflow | null } {
  // Find the active workflow — filter out completed ones to avoid ID collisions
  // (e.g., a second follow_cycle for the same user reuses the same fc:username ID)
  const workflow = state.workflows.find((w) => w.id === workflowId && !w.outcome);
  if (!workflow) {
    const completed = state.workflows.find((w) => w.id === workflowId && !!w.outcome);
    if (completed) {
      return { error: `Workflow '${workflowId}' is already completed (${completed.outcome}).`, workflow: null };
    }
    return { error: `Workflow '${workflowId}' not found.`, workflow: null };
  }

  // Validate response based on current step
  if (workflow.type === "follow_cycle" && workflow.current_step === "need_reply_text") {
    if (!response.reply_text) {
      return { error: "Missing 'reply_text' in response for need_reply_text step.", workflow: null };
    }
    workflow.context.reply_text = response.reply_text;
    workflow.current_step = "post_reply";
    return { error: null, workflow };
  }

  return { error: `Unexpected submit for workflow ${workflowId} at step ${workflow.current_step}.`, workflow: null };
}

export function createWorkflow(
  state: StateFile,
  type: string,
  targetUserId: string,
  targetUsername: string,
  initialContext?: Record<string, string>,
): { error: string | null; workflow: Workflow | null } {
  const maxWorkflows = getMaxWorkflows();
  const activeCount = state.workflows.filter((w) => !w.outcome).length;
  if (activeCount >= maxWorkflows) {
    return { error: `Maximum active workflows reached (${maxWorkflows}). Complete or remove existing workflows first.`, workflow: null };
  }

  // Check for duplicate active workflow for same target
  const existing = state.workflows.find(
    (w) => w.type === type && w.target_user_id === targetUserId && !w.outcome,
  );
  if (existing) {
    return { error: `Active ${type} workflow already exists for @${targetUsername} (${existing.id}).`, workflow: null };
  }

  let id: string;
  let firstStep: string;

  if (type === "follow_cycle") {
    id = `fc:${targetUsername.toLowerCase()}`;
    firstStep = "execute_follow";
  } else if (type === "reply_track") {
    id = `rt:${targetUsername.toLowerCase()}:${Date.now()}`;
    firstStep = "posted";
  } else {
    return { error: `Unknown workflow type: ${type}. Valid types: follow_cycle, reply_track.`, workflow: null };
  }

  const workflow: Workflow = {
    id,
    type,
    current_step: firstStep,
    target_user_id: targetUserId,
    target_username: targetUsername,
    created_at: new Date().toISOString(),
    check_after: null,
    context: { ...initialContext },
    actions_done: [],
    outcome: null,
  };

  state.workflows.push(workflow);
  return { error: null, workflow };
}

export function getWorkflowStatus(
  state: StateFile,
  typeFilter?: string,
  includeCompleted: boolean = false,
): Workflow[] {
  return state.workflows.filter((w) => {
    if (typeFilter && w.type !== typeFilter) return false;
    if (!includeCompleted && w.outcome) return false;
    return true;
  });
}

export async function cleanupNonFollowers(
  client: XApiClient,
  state: StateFile,
  budgetConfig: BudgetConfig,
  protectedAccounts: ProtectedAccount[],
  maxUnfollow: number = 10,
  maxPages: number = 5,
): Promise<{ unfollowed: string[]; skipped: string[]; error: string | null }> {
  const unfollowed: string[] = [];
  const skipped: string[] = [];

  try {
    const { result } = await client.getNonFollowers(maxPages);
    const nonFollowers = result.data;

    for (const user of nonFollowers) {
      if (unfollowed.length >= maxUnfollow) break;
      const username = (user.username as string) ?? "";
      const userId = (user.id as string) ?? "";

      // Check protected accounts (by username or numeric userId)
      if (isProtectedAccount(username, protectedAccounts) || isProtectedAccount(userId, protectedAccounts)) {
        skipped.push(`@${username} (protected)`);
        continue;
      }

      // Check unfollow budget
      const budgetErr = checkBudget("unfollow_user", state, budgetConfig);
      if (budgetErr) {
        skipped.push(`budget exhausted — stopped`);
        break;
      }

      try {
        await client.unfollowUser(userId);
        recordAction("unfollow_user", null, state);
        unfollowed.push(`@${username}`);
      } catch {
        skipped.push(`@${username} (API error)`);
      }
    }

    return { unfollowed, skipped, error: null };
  } catch (e: unknown) {
    return { unfollowed, skipped, error: e instanceof Error ? e.message : String(e) };
  }
}
