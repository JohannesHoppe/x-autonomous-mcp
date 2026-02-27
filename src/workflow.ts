import type { StateFile, Workflow } from "./state.js";
import type { XApiClient } from "./x-api.js";
import type { BudgetConfig } from "./safety.js";
import type { ProtectedAccount } from "./safety.js";
import type { LlmTask, WorkflowResult } from "./workflow-types.js";
import { getMaxWorkflows } from "./state.js";
import { advanceFollowCycle, buildLlmTask } from "./workflow-follow-cycle.js";
import { advanceReplyTrack } from "./workflow-reply-track.js";

// Re-export types and functions for backwards compatibility with index.ts
export type { LlmTask, WorkflowResult } from "./workflow-types.js";
export { cleanupNonFollowers } from "./workflow-cleanup.js";

// --- Workflow Orchestrator ---

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
  const waiting = active.filter((w) => w.check_after && w.check_after > today);
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

// --- Submit Task Response ---

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

// --- Workflow Factory ---

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

// --- Workflow Query ---

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
