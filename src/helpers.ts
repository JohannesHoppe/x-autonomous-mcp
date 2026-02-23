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
 */
export function formatResult(data: unknown, rateLimit: string): string {
  const output: Record<string, unknown> = { data };
  if (rateLimit) output.rate_limit = rateLimit;
  return JSON.stringify(output, null, 2);
}
