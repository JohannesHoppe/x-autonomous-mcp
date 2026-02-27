import type { XApiClient, StateFile, BudgetConfig } from "./workflow-types.js";
import type { ProtectedAccount } from "./safety.js";
import { checkBudget, recordAction, isProtectedAccount } from "./safety.js";

// --- Cleanup Non-Followers (one-shot operation) ---

/** Collect user IDs targeted by active workflows (follow_cycle + reply_track). */
function getActiveWorkflowTargets(state: StateFile): Set<string> {
  const targets = new Set<string>();
  for (const w of state.workflows) {
    if (!w.outcome && w.target_user_id) {
      targets.add(w.target_user_id);
    }
  }
  return targets;
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
  const activeTargets = getActiveWorkflowTargets(state);

  try {
    const { result } = await client.getNonFollowers(maxPages);
    const nonFollowers = result.data;

    for (const user of nonFollowers) {
      if (unfollowed.length >= maxUnfollow) break;
      const username = (user.username as string) ?? "";
      const userId = (user.id as string) ?? "";

      // Skip users targeted by active workflows (follow_cycle or reply_track)
      if (activeTargets.has(userId)) {
        skipped.push(`@${username} (active workflow)`);
        continue;
      }

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
