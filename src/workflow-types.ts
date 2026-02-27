import type { StateFile, Workflow } from "./state.js";
import type { XApiClient } from "./x-api.js";
import type { BudgetConfig, ProtectedAccount } from "./safety.js";

export type { StateFile, Workflow, XApiClient, BudgetConfig, ProtectedAccount };

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

// Shared return type for all advance functions
export interface AdvanceResult {
  llmNeeded: boolean;
  summary: string | null;
}
