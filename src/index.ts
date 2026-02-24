#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { XApiClient } from "./x-api.js";
import { parseTweetId, errorMessage, formatResult } from "./helpers.js";
import { loadState, saveState } from "./state.js";
import {
  loadBudgetConfig,
  formatBudgetString,
  checkBudget,
  checkDedup,
  recordAction,
  getParameterHint,
  isWriteTool,
} from "./safety.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example for required variables.`);
  }
  return value;
}

const client = new XApiClient({
  apiKey: requireEnv("X_API_KEY"),
  apiSecret: requireEnv("X_API_SECRET"),
  accessToken: requireEnv("X_ACCESS_TOKEN"),
  accessTokenSecret: requireEnv("X_ACCESS_TOKEN_SECRET"),
  bearerToken: requireEnv("X_BEARER_TOKEN"),
});

// --- Safety feature configuration ---

const statePath = process.env.X_MCP_STATE_FILE
  || path.resolve(process.cwd(), "x-mcp-state.json");
const budgetConfig = loadBudgetConfig();
const compactMode = process.env.X_MCP_COMPACT !== "false"; // default true
const dedupEnabled = process.env.X_MCP_DEDUP !== "false"; // default true
const dangerousEnabled = process.env.X_MCP_ENABLE_DANGEROUS === "true"; // default false
const toonEnabled = process.env.X_MCP_TOON !== "false"; // default true

// --- MCP server ---

const server = new McpServer({
  name: "x-autonomous-mcp",
  version: "0.1.0",
});

// --- Valid parameter keys per tool (for Levenshtein suggestions) ---

const VALID_KEYS: Record<string, string[]> = {
  post_tweet: ["text", "poll_options", "poll_duration_minutes", "media_ids"],
  reply_to_tweet: ["tweet_id", "text", "media_ids"],
  quote_tweet: ["tweet_id", "text", "media_ids"],
  delete_tweet: ["tweet_id"],
  get_tweet: ["tweet_id"],
  search_tweets: ["query", "max_results", "min_likes", "min_retweets", "sort_order", "since_id", "next_token"],
  get_user: ["username", "user_id"],
  get_timeline: ["user", "max_results", "next_token"],
  get_mentions: ["max_results", "since_id", "next_token"],
  get_followers: ["user", "max_results", "next_token"],
  get_following: ["user", "max_results", "next_token"],
  follow_user: ["user"],
  unfollow_user: ["user"],
  get_non_followers: ["max_pages"],
  like_tweet: ["tweet_id"],
  retweet: ["tweet_id"],
  upload_media: ["media_data", "mime_type", "media_category"],
  get_metrics: ["tweet_id"],
};

// --- Handler wrapper ---
// Centralizes: state loading, budget checks, dedup checks, action recording,
// response formatting (compact + budget string), and error handling.

interface WrapOptions {
  getTargetTweetId?: (args: Record<string, unknown>) => string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function wrapHandler(
  toolName: string,
  handler: (args: Record<string, unknown>, resolvedTargetId?: string) => Promise<{ result: unknown; rateLimit: string }>,
  opts?: WrapOptions,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      // Unknown parameter check with Levenshtein suggestions
      const validKeys = VALID_KEYS[toolName];
      if (validKeys) {
        const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
        if (unknownKeys.length > 0) {
          const hints = unknownKeys
            .map((k) => {
              const hint = getParameterHint(toolName, k, validKeys);
              return hint ? `Unknown parameter '${k}': ${hint}` : `Unknown parameter '${k}'.`;
            })
            .join("\n");
          const state = loadState(statePath);
          const budgetString = formatBudgetString(state, budgetConfig);
          return {
            content: [{ type: "text", text: `Error: ${hints}\n\nValid parameters for ${toolName}: ${validKeys.join(", ")}\n\nCurrent x_budget: ${budgetString}` }],
            isError: true,
          };
        }
      }

      const state = loadState(statePath);

      // Budget check (write tools only)
      const budgetError = checkBudget(toolName, state, budgetConfig);
      if (budgetError) {
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text", text: `Error: ${budgetError}\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      }

      // Dedup check (engagement tools only) — also resolves tweet ID once
      const targetId = opts?.getTargetTweetId?.(args);
      if (dedupEnabled && targetId) {
        const dedupError = checkDedup(toolName, targetId, state);
        if (dedupError) {
          const budgetString = formatBudgetString(state, budgetConfig);
          return {
            content: [{ type: "text", text: `Error: ${dedupError}\n\nCurrent x_budget: ${budgetString}` }],
            isError: true,
          };
        }
      }

      // Execute the actual API call, passing resolved ID to avoid re-parsing
      const { result, rateLimit } = await handler(args, targetId);

      // Record action and save state only for write tools
      if (isWriteTool(toolName)) {
        recordAction(toolName, targetId ?? null, state);
        saveState(statePath, state);
      }

      // Format response with budget string and compact mode
      const budgetString = formatBudgetString(state, budgetConfig);
      return {
        content: [{ type: "text", text: formatResult(result, rateLimit, budgetString, compactMode, toonEnabled) }],
      };
    } catch (e: unknown) {
      // Include budget in error responses when possible
      try {
        const state = loadState(statePath);
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage(e)}\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      } catch {
        return {
          content: [{ type: "text", text: `Error: ${errorMessage(e)}` }],
          isError: true,
        };
      }
    }
  };
}

// ============================================================
// TWEET TOOLS
// ============================================================

server.registerTool(
  "post_tweet",
  {
    description: "Create a new post on X (Twitter). Supports text, polls, and media attachments. To REPLY to a tweet, use reply_to_tweet instead.",
    inputSchema: z.object({
      text: z.string().describe("The text content of the tweet"),
      poll_options: z.array(z.string()).min(2).max(4).optional().describe("Poll options (2-4 choices)"),
      poll_duration_minutes: z.number().int().min(1).max(10080).optional().describe("Poll duration in minutes (1-10080, default 1440 = 24h)"),
      media_ids: z.array(z.string()).optional().describe("Media IDs to attach (from upload_media)"),
    }).passthrough(),
  },
  wrapHandler("post_tweet", async (args) => {
    return client.postTweet({
      text: args.text as string,
      poll_options: args.poll_options as string[] | undefined,
      poll_duration_minutes: args.poll_duration_minutes as number | undefined,
      media_ids: args.media_ids as string[] | undefined,
    });
  }),
);

server.registerTool(
  "reply_to_tweet",
  {
    description: "Reply to an existing post on X. Provide the tweet ID or URL to reply to.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to reply to"),
      text: z.string().describe("The reply text"),
      media_ids: z.array(z.string()).optional().describe("Media IDs to attach"),
    }).passthrough(),
  },
  wrapHandler("reply_to_tweet", async (args, resolvedId) => {
    return client.postTweet({
      text: args.text as string,
      reply_to: resolvedId!,
      media_ids: args.media_ids as string[] | undefined,
    });
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

server.registerTool(
  "quote_tweet",
  {
    description: "Quote retweet a post on X. Adds your commentary above the quoted post.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to quote"),
      text: z.string().describe("Your commentary text"),
      media_ids: z.array(z.string()).optional().describe("Media IDs to attach"),
    }).passthrough(),
  },
  wrapHandler("quote_tweet", async (args, resolvedId) => {
    return client.postTweet({
      text: args.text as string,
      quote_tweet_id: resolvedId!,
      media_ids: args.media_ids as string[] | undefined,
    });
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

// Destructive tools — hidden unless X_MCP_ENABLE_DANGEROUS=true
if (dangerousEnabled) {
  server.registerTool(
    "delete_tweet",
    {
      description: "Delete a post on X by its ID. This tool is only available when X_MCP_ENABLE_DANGEROUS=true.",
      inputSchema: z.object({
        tweet_id: z.string().describe("The tweet ID or URL to delete"),
      }).passthrough(),
    },
    wrapHandler("delete_tweet", async (args) => {
      const id = parseTweetId(args.tweet_id as string);
      return client.deleteTweet(id);
    }),
  );
}

server.registerTool(
  "get_tweet",
  {
    description: "Fetch a tweet and its metadata by ID or URL. Returns author info, metrics, and referenced tweets.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to fetch"),
    }).passthrough(),
  },
  wrapHandler("get_tweet", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.getTweet(id);
  }),
);

// ============================================================
// SEARCH
// ============================================================

server.registerTool(
  "search_tweets",
  {
    description: "Search recent tweets by query. Supports keywords, hashtags, from:user, to:user, is:reply, has:media, etc. Uses the recent search endpoint (last 7 days). Use min_likes/min_retweets to filter for high-engagement tweets only. Use sort_order=relevancy to surface popular tweets first.",
    inputSchema: z.object({
      query: z.string().describe("Search query (e.g. 'from:elonmusk', '#ai', 'machine learning')"),
      max_results: z.number().optional().describe("Number of results to return (10-100, default 10)"),
      min_likes: z.number().optional().describe("Only return tweets with at least this many likes"),
      min_retweets: z.number().optional().describe("Only return tweets with at least this many retweets"),
      sort_order: z.enum(["recency", "relevancy"]).optional().describe("Sort order: 'recency' (default) or 'relevancy' (popular first)"),
      since_id: z.string().optional().describe("Only return tweets newer than this tweet ID (for incremental polling)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("search_tweets", async (args) => {
    return client.searchTweets(
      args.query as string,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
      {
        minLikes: args.min_likes as number | undefined,
        minRetweets: args.min_retweets as number | undefined,
        sortOrder: args.sort_order as string | undefined,
        sinceId: args.since_id as string | undefined,
      },
    );
  }),
);

// ============================================================
// USER TOOLS
// ============================================================

server.registerTool(
  "get_user",
  {
    description: "Look up a user profile by username or user ID. Returns bio, metrics, verification status, etc.",
    inputSchema: z.object({
      username: z.string().optional().describe("Username (without @)"),
      user_id: z.string().optional().describe("Numeric user ID"),
    }).passthrough(),
  },
  async (args) => {
    if (!args.username && !args.user_id) {
      const state = loadState(statePath);
      const budgetString = formatBudgetString(state, budgetConfig);
      return { content: [{ type: "text" as const, text: `Error: Provide either username or user_id\n\nCurrent x_budget: ${budgetString}` }], isError: true };
    }
    return wrapHandler("get_user", async (a) => {
      return client.getUser({
        username: a.username as string | undefined,
        userId: a.user_id as string | undefined,
      });
    })(args as Record<string, unknown>);
  },
);

server.registerTool(
  "get_timeline",
  {
    description: "Fetch a user's recent posts. Accepts a username or numeric user ID.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
      max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_timeline", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.getTimeline(
      userId,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

server.registerTool(
  "get_mentions",
  {
    description: "Fetch recent mentions of the authenticated user. Use since_id to only get new mentions since last check (saves tokens).",
    inputSchema: z.object({
      max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
      since_id: z.string().optional().describe("Only return mentions newer than this tweet ID (for incremental polling)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_mentions", async (args) => {
    return client.getMentions(
      args.max_results as number | undefined,
      args.next_token as string | undefined,
      args.since_id as string | undefined,
    );
  }),
);

server.registerTool(
  "get_followers",
  {
    description: "List followers of a user. Accepts a username or numeric user ID.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
      max_results: z.number().optional().describe("Number of results (1-1000, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_followers", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.getFollowers(
      userId,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

server.registerTool(
  "get_following",
  {
    description: "List who a user follows. Accepts a username or numeric user ID.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
      max_results: z.number().optional().describe("Number of results (1-1000, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_following", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.getFollowing(
      userId,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

// ============================================================
// ENGAGEMENT TOOLS
// ============================================================

server.registerTool(
  "like_tweet",
  {
    description: "Like a post on X.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to like"),
    }).passthrough(),
  },
  wrapHandler("like_tweet", async (_args, resolvedId) => {
    return client.likeTweet(resolvedId!);
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

server.registerTool(
  "retweet",
  {
    description: "Retweet a post on X.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to retweet"),
    }).passthrough(),
  },
  wrapHandler("retweet", async (_args, resolvedId) => {
    return client.retweet(resolvedId!);
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

// ============================================================
// FOLLOW / UNFOLLOW
// ============================================================

server.registerTool(
  "follow_user",
  {
    description: "Follow a user on X. Accepts a username or numeric user ID. Budget-limited.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
    }).passthrough(),
  },
  wrapHandler("follow_user", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.followUser(userId);
  }),
);

// unfollow_user — gated behind X_MCP_ENABLE_DANGEROUS
if (dangerousEnabled) {
  server.registerTool(
    "unfollow_user",
    {
      description: "Unfollow a user on X. Accepts a username or numeric user ID. Only available when X_MCP_ENABLE_DANGEROUS=true.",
      inputSchema: z.object({
        user: z.string().describe("Username (with or without @) or numeric user ID"),
      }).passthrough(),
    },
    wrapHandler("unfollow_user", async (args) => {
      const userId = await client.resolveUserId(args.user as string);
      return client.unfollowUser(userId);
    }),
  );
}

server.registerTool(
  "get_non_followers",
  {
    description: "Find accounts you follow that don't follow you back. Returns a list sorted by follower count (lowest first = best unfollow candidates). Fetches up to 5 pages of following/followers — covers up to 5000 accounts.",
    inputSchema: z.object({
      max_pages: z.number().optional().describe("Max pages to fetch per list (default 5, each page = 1000 users)"),
    }).passthrough(),
  },
  wrapHandler("get_non_followers", async (args) => {
    return client.getNonFollowers(args.max_pages as number | undefined);
  }),
);

// ============================================================
// MEDIA
// ============================================================

server.registerTool(
  "upload_media",
  {
    description: "Upload an image or video to X. Returns a media_id that can be attached to posts. Provide the file as base64-encoded data.",
    inputSchema: z.object({
      media_data: z.string().describe("Base64-encoded media file data"),
      mime_type: z.string().describe("MIME type (e.g. 'image/png', 'image/jpeg', 'video/mp4')"),
      media_category: z.string().optional().describe("Category: 'tweet_image', 'tweet_gif', or 'tweet_video' (default: tweet_image)"),
    }).passthrough(),
  },
  wrapHandler("upload_media", async (args) => {
    const { mediaId, rateLimit } = await client.uploadMedia(
      args.media_data as string,
      args.mime_type as string,
      (args.media_category as string) || "tweet_image",
    );
    return {
      result: { media_id: mediaId, message: "Upload complete. Use this media_id in post_tweet." },
      rateLimit,
    };
  }),
);

// ============================================================
// METRICS
// ============================================================

server.registerTool(
  "get_metrics",
  {
    description: "Get engagement metrics for a specific post (impressions, likes, retweets, replies, quotes, bookmarks). Requires the tweet to be authored by the authenticated user for non-public metrics.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to get metrics for"),
    }).passthrough(),
  },
  wrapHandler("get_metrics", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.getTweetMetrics(id);
  }),
);

// ============================================================
// START SERVER
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
