# CLAUDE.md

## What This Is

An autonomous MCP (Model Context Protocol) server for the X (Twitter) API v2. Built-in safety rails for unattended LLM agent operation: daily budget limits, engagement dedup, TOON-encoded responses, Levenshtein-based parameter suggestions, destructive tool gating. Based on [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp).

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server, tool definitions, `wrapHandler()` for safety integration, global `VALID_KEYS` map |
| `src/x-api.ts` | `XApiClient` class — OAuth 1.0a + Bearer Token auth, raw fetch calls to `api.x.com/2` |
| `src/helpers.ts` | Pure utilities: `parseTweetId`, `errorMessage`, `formatResult` |
| `src/state.ts` | Persistent state: budget counters, engagement dedup sets, atomic file I/O |
| `src/compact.ts` | Response transformation: verbose API → compact form (flat metrics, author resolution, follower ratio) |
| `src/safety.ts` | Budget checks, dedup checks, action classification, Levenshtein hints |
| `src/toon.ts` | Vendored TOON encoder (from `@toon-format/toon`, MIT) |

No Twitter SDK dependency. Auth uses `oauth-1.0a` + `crypto.createHmac`. Read operations use Bearer Token, write operations use OAuth 1.0a.

## Tools

**Tweets:** `post_tweet`, `reply_to_tweet`, `quote_tweet`, `delete_tweet` (gated), `get_tweet`
**Search:** `search_tweets` (with `min_likes`/`min_retweets`/`sort_order`/`since_id`)
**Users:** `get_user`, `get_timeline`, `get_mentions` (with `since_id`), `get_followers`, `get_following`, `get_non_followers`
**Engagement:** `like_tweet`, `retweet`, `follow_user`, `unfollow_user` (gated)
**Media:** `upload_media`
**Metrics:** `get_metrics`

## Safety Features

1. **Daily budget limits** — `X_MCP_MAX_REPLIES`, `X_MCP_MAX_ORIGINALS`, `X_MCP_MAX_LIKES`, `X_MCP_MAX_RETWEETS`, `X_MCP_MAX_FOLLOWS`. Set `0` to disable, `-1` for unlimited.
2. **Budget in every response** — LLM sees remaining budget on every call (reads and writes).
3. **TOON encoding** — `X_MCP_TOON=true` (default). Responses in Token-Oriented Object Notation — field names once in headers, CSV-style rows for arrays. Set `false` for JSON.
4. **Compact responses** — `X_MCP_COMPACT=true` (default). Drops entities, flattens metrics, resolves author_id to @username, precomputes `author_ratio`.
5. **Engagement dedup** — `X_MCP_DEDUP=true` (default). Never reply/like/retweet same tweet twice. Tracked with 90-day pruning window.
6. **Levenshtein parameter suggestions** — Every tool checks unknown parameters against `VALID_KEYS` map and suggests closest match. Hardcoded redirects for common mistakes (e.g., `in_reply_to` → "Use reply_to_tweet tool instead").
7. **Destructive tool gating** — `X_MCP_ENABLE_DANGEROUS=true` required to expose `delete_tweet` and `unfollow_user`. Tools are completely hidden otherwise.
8. **Unknown parameter detection** — All tools use `.passthrough()` Zod schemas. Unknown keys trigger Levenshtein suggestions instead of opaque Zod validation errors.

## Key Features

1. **Engagement filtering** — `search_tweets` accepts `min_likes` and `min_retweets`. Fetches 100 internally, filters by `public_metrics`, returns up to `max_results`.
2. **Relevancy sorting** — `search_tweets` accepts `sort_order` (`recency` or `relevancy`).
3. **Incremental polling** — `search_tweets` and `get_mentions` accept `since_id`.
4. **Author metrics** — Compact tweets include `author_followers` and `author_ratio` (followers/following, precomputed).
5. **Non-followers detection** — `get_non_followers` computes set difference of following vs followers.
6. **Lean responses** — Omits `profile_image_url` and media expansions from API requests.

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
X_MCP_MAX_REPLIES      # Daily reply limit (-1=unlimited, 0=disabled, default 8)
X_MCP_MAX_ORIGINALS    # Daily original post limit (default 2)
X_MCP_MAX_LIKES        # Daily like limit (default 20)
X_MCP_MAX_RETWEETS     # Daily retweet limit (default 5)
X_MCP_MAX_FOLLOWS      # Daily follow limit (default 10)
X_MCP_TOON             # TOON encoding (default: true, set "false" for JSON)
X_MCP_COMPACT          # Compact responses (default: true)
X_MCP_DEDUP            # Engagement dedup (default: true)
X_MCP_ENABLE_DANGEROUS # Expose delete_tweet, unfollow_user (default: false)
X_MCP_STATE_FILE       # State file path (default: {cwd}/x-mcp-state.json)
```

## Rules

1. Keep the server minimal. No feature creep.
2. Every tool must handle errors gracefully and return `isError: true`.
3. Don't add dependencies without a strong reason.
4. Token efficiency matters. Don't add fields to API requests unless they're actually used.
5. Run `npm test` before every commit.
6. All timestamps must be ISO 8601.
