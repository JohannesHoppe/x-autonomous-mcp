# CLAUDE.md

## What This Is

An autonomous MCP (Model Context Protocol) server for the X (Twitter) API v2. Built-in safety rails for unattended LLM agent operation: daily budget limits, engagement dedup, compact responses, self-describing errors. Based on [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp).

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server, 16 tool definitions, `wrapHandler()` for safety integration |
| `src/x-api.ts` | `XApiClient` class — OAuth 1.0a + Bearer Token auth, raw fetch calls to `api.x.com/2` |
| `src/helpers.ts` | Pure utilities: `parseTweetId`, `errorMessage`, `formatResult` |
| `src/state.ts` | Persistent state: budget counters, engagement dedup sets, atomic file I/O |
| `src/compact.ts` | Response transformation: verbose API → compact form (~80% fewer tokens) |
| `src/safety.ts` | Budget checks, dedup checks, action classification, error hints |

No Twitter SDK dependency. Auth uses `oauth-1.0a` + `crypto.createHmac`. Read operations use Bearer Token, write operations use OAuth 1.0a.

## Tools (16)

**Tweets:** `post_tweet`, `reply_to_tweet`, `quote_tweet`, `delete_tweet`, `get_tweet`
**Search:** `search_tweets` (with `min_likes`/`min_retweets`/`sort_order`/`since_id`)
**Users:** `get_user`, `get_timeline`, `get_mentions` (with `since_id`), `get_followers`, `get_following`
**Engagement:** `like_tweet`, `retweet`
**Media:** `upload_media`
**Metrics:** `get_metrics`

## Safety Features

1. **Daily budget limits** — `X_MCP_MAX_REPLIES=8`, `X_MCP_MAX_ORIGINALS=2`, `X_MCP_MAX_LIKES=20`, `X_MCP_MAX_RETWEETS=5`. Set `0` to disable, `-1` for unlimited.
2. **Budget in every response** — LLM sees remaining budget on every call (reads and writes).
3. **Compact responses** — `X_MCP_COMPACT=true` (default). Drops entities, flattens metrics, resolves author_id to @username.
4. **Engagement dedup** — `X_MCP_DEDUP=true` (default). Never reply/like/retweet same tweet twice. Permanent.
5. **Self-describing errors** — `post_tweet` with `reply_to_tweet_id` → "Use reply_to_tweet tool instead."
6. **Strict schemas** — `.strict()` Zod schemas via `registerTool()`. Unknown parameters cause validation error.

## Key Features

1. **Engagement filtering** — `search_tweets` accepts `min_likes` and `min_retweets`. Fetches 100 internally, filters by `public_metrics`, returns up to `max_results`.
2. **Relevancy sorting** — `search_tweets` accepts `sort_order` (`recency` or `relevancy`).
3. **Incremental polling** — `search_tweets` and `get_mentions` accept `since_id`.
4. **Lean responses** — Omits `profile_image_url` and media expansions from API requests.

## Build & Test

```bash
npm install
npm run build    # tsc -> dist/
npm test         # vitest
npm start        # node dist/index.js (stdio MCP server)
```

## Environment Variables

**Required (5):**
```
X_API_KEY              # Consumer Key (OAuth 1.0a)
X_API_SECRET           # Consumer Secret
X_ACCESS_TOKEN         # User Access Token (Read and Write)
X_ACCESS_TOKEN_SECRET  # User Access Token Secret
X_BEARER_TOKEN         # OAuth 2.0 Bearer Token (for reads)
```

**Safety (optional):**
```
X_MCP_MAX_REPLIES=8        # Daily reply limit (-1=unlimited, 0=disabled)
X_MCP_MAX_ORIGINALS=2      # Daily original post limit
X_MCP_MAX_LIKES=20         # Daily like limit
X_MCP_MAX_RETWEETS=5       # Daily retweet limit
X_MCP_COMPACT=true         # Compact responses (default: true)
X_MCP_DEDUP=true           # Engagement dedup (default: true)
X_MCP_STATE_FILE=path      # State file path (default: {cwd}/x-mcp-state.json)
```

## Rules

1. Keep the server minimal. No feature creep.
2. Every tool must handle errors gracefully and return `isError: true`.
3. Don't add dependencies without a strong reason. The current 4 deps are fine.
4. Token efficiency matters. Don't add fields to API requests unless they're actually used.
5. Run `npm test` before every commit.
6. All timestamps must be ISO 8601.
