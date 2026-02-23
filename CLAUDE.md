# CLAUDE.md

## What This Is

A fork of [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp) — an MCP (Model Context Protocol) server for the X (Twitter) API v2, optimized for autonomous LLM agents.

## Architecture

Two source files in `src/`:

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server setup, all 16 tool definitions (Zod schemas + handlers), response formatting |
| `src/x-api.ts` | `XApiClient` class — OAuth 1.0a + Bearer Token auth, raw fetch calls to `api.x.com/2` |

No Twitter SDK dependency. Auth uses `oauth-1.0a` + `crypto.createHmac`. Read operations use Bearer Token, write operations use OAuth 1.0a.

## Tools (16)

**Tweets:** `post_tweet`, `reply_to_tweet`, `quote_tweet`, `delete_tweet`, `get_tweet`
**Search:** `search_tweets` (with `min_likes`/`min_retweets`/`sort_order`/`since_id`)
**Users:** `get_user`, `get_timeline`, `get_mentions` (with `since_id`), `get_followers`, `get_following`
**Engagement:** `like_tweet`, `retweet`
**Media:** `upload_media`
**Metrics:** `get_metrics`

## Our Changes vs Upstream

1. **Engagement filtering** — `search_tweets` accepts `min_likes` and `min_retweets`. Fetches 100 internally, filters by `public_metrics`, returns up to `max_results`. Prunes `includes.users` to match.
2. **Relevancy sorting** — `search_tweets` accepts `sort_order` (`recency` or `relevancy`). Relevancy surfaces popular tweets first.
3. **Incremental polling** — `search_tweets` and `get_mentions` accept `since_id`. Only returns newer results. Saves tokens for periodic polling.
4. **Leaner responses** — Stripped `profile_image_url`, `preview_image_url`, and media expansions from responses. Added `public_metrics` to user expansions in search (follower counts visible).

## Build & Test

```bash
npm install
npm run build    # tsc -> dist/
npm start        # node dist/index.js (stdio MCP server)
```

No test suite exists yet. Verify changes manually:
```bash
# Check tool schemas
mcporter list twitter --schema

# Test search with engagement filter
mcporter call twitter.search_tweets query="AI -is:retweet" count=10 min_likes=20

# Test mentions with since_id
mcporter call twitter.get_mentions max_results=10 since_id="TWEET_ID"
```

## Environment Variables (5 required)

```
X_API_KEY              # Consumer Key (OAuth 1.0a)
X_API_SECRET           # Consumer Secret
X_ACCESS_TOKEN         # User Access Token (Read and Write)
X_ACCESS_TOKEN_SECRET  # User Access Token Secret
X_BEARER_TOKEN         # OAuth 2.0 Bearer Token (for reads)
```

## Key Implementation Details

- `oauthFetch()` — used for write operations + mentions (requires user context)
- `bearerFetch()` — used for read operations (search, get_tweet, get_user, etc.)
- `handleResponse()` — parses rate limit headers, formats errors, returns `{ result, rateLimit }`
- `stripBloat()` — recursively removes token-wasting fields before JSON serialization
- `getAuthenticatedUserId()` — cached call to `/users/me`, used by mentions/likes/retweets
- Engagement filtering in `searchTweets()` — fetches 100 when filters active, filters, trims to `max_results`

## Rules

1. Keep the server minimal. No feature creep.
2. Every tool must handle errors gracefully and return `isError: true`.
3. Don't add dependencies without a strong reason. The current 4 deps are fine.
4. Token efficiency matters. Don't add fields to API requests unless they're actually used.
5. Upstream changes can be merged with `git fetch upstream && git merge upstream/main`.
