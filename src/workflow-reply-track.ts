import type { Workflow, XApiClient, StateFile, BudgetConfig, AdvanceResult } from "./workflow-types.js";
import { checkBudget, recordAction } from "./safety.js";

// --- Reply Track State Machine ---
// Steps: posted → waiting_audit → audit → done

export async function advanceReplyTrack(
  workflow: Workflow,
  client: XApiClient,
  state: StateFile,
  budgetConfig: BudgetConfig,
): Promise<AdvanceResult> {
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
