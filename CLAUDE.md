# CLAUDE.md

## What This Is

A fork of [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp) — an MCP (Model Context Protocol) server for the X (Twitter) API v2.

This fork adds **client-side engagement filtering** to `search_tweets`: optional `min_likes` and `min_retweets` parameters that filter results before returning them to the caller. This keeps low-engagement noise out of the response, saving tokens and context when the server is used by an LLM agent.

## Architecture

Two source files in `src/`:

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server setup, all 16 tool definitions (Zod schemas + handlers) |
| `src/x-api.ts` | `XApiClient` class — OAuth 1.0a + Bearer Token auth, raw fetch calls to `api.x.com/2` |

No Twitter SDK dependency. Auth is handled with `oauth-1.0a` + `crypto.createHmac`. Read operations use Bearer Token, write operations use OAuth 1.0a.

## Tools (16)

**Tweets:** `post_tweet`, `reply_to_tweet`, `quote_tweet`, `delete_tweet`, `get_tweet`
**Search:** `search_tweets` (with `min_likes`/`min_retweets` filtering)
**Users:** `get_user`, `get_timeline`, `get_mentions`, `get_followers`, `get_following`
**Engagement:** `like_tweet`, `retweet`
**Media:** `upload_media`
**Metrics:** `get_metrics`

## Our Changes (vs upstream)

- `search_tweets` accepts optional `min_likes` and `min_retweets` params
- When filters are set, fetches 100 results internally, filters by `public_metrics`, returns up to `max_results`
- `includes.users` is pruned to match surviving tweets

## Build & Run

```bash
npm install
npm run build    # tsc → dist/
npm start        # node dist/index.js (stdio MCP server)
```

## Environment Variables (5 required)

```
X_API_KEY=...              # Consumer Key (OAuth 1.0a)
X_API_SECRET=...           # Consumer Secret
X_ACCESS_TOKEN=...         # User Access Token (Read and Write)
X_ACCESS_TOKEN_SECRET=...  # User Access Token Secret
X_BEARER_TOKEN=...         # OAuth 2.0 Bearer Token (for reads)
```

Get these from developer.x.com → Projects & Apps → Keys and Tokens.

## Rules

1. Keep the server minimal. No feature creep.
2. Every tool must handle errors gracefully and return `isError: true`.
3. Don't add dependencies without a strong reason. The current 4 deps are fine.
4. Test changes with `mcporter list twitter --schema` and manual `mcporter call` before deploying.
5. Upstream changes can be merged with `git fetch upstream && git merge upstream/main`.
