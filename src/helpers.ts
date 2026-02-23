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

import { compactResponse } from "./compact.js";

/**
 * Format API result and rate limit info as a JSON string for MCP responses.
 */
export function formatResult(
  data: unknown,
  rateLimit: string,
  budgetString?: string,
  compact?: boolean,
): string {
  let processedData = data;
  if (compact && data && typeof data === "object") {
    processedData = compactResponse(data);
  }
  const output: Record<string, unknown> = { data: processedData };
  if (rateLimit) output.rate_limit = rateLimit;
  if (budgetString) output.budget = budgetString;
  return JSON.stringify(output, null, 2);
}
