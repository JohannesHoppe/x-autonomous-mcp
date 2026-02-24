import { compactResponse } from "./compact.js";

/**
 * Extract tweet ID from a URL or raw numeric ID string.
 */
export function parseTweetId(input: string): string {
  const match = input.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  const stripped = input.trim();
  if (/^\d+$/.test(stripped)) return stripped;
  throw new Error(`Invalid tweet ID or URL: ${input}`);
}

/**
 * Safely extract a message string from an unknown error value.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * Format API result and rate limit info as a JSON string for MCP responses.
 *
 * In compact mode, compactResponse preserves the API's { data, meta } shape,
 * so we merge rate_limit/budget into that structure directly — no extra wrapper.
 * In non-compact mode, we wrap the raw API response in { data: ... } as an
 * MCP envelope.
 */
export function formatResult(
  data: unknown,
  rateLimit: string,
  budgetString?: string,
  compact?: boolean,
): string {
  let output: Record<string, unknown>;

  if (compact && data && typeof data === "object") {
    const compacted = compactResponse(data);
    if (compacted && typeof compacted === "object") {
      // compactResponse returns { data: compactTweet/User, meta?: ... } or passthrough
      // Merge budget/rate_limit alongside data/meta — no extra wrapping
      output = { ...(compacted as Record<string, unknown>) };
    } else {
      output = { data: compacted };
    }
  } else {
    output = { data };
  }

  if (rateLimit) output.rate_limit = rateLimit;
  if (budgetString) output.budget = budgetString;
  return JSON.stringify(output);
}
