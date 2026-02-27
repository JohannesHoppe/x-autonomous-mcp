# CLAUDE.md

## What This Is

An autonomous MCP (Model Context Protocol) server for the X (Twitter) API v2. Built-in safety rails for unattended LLM agent operation: daily budget limits, engagement dedup, TOON-encoded responses, typo-correcting parameter suggestions, budget-gated destructive tools, multi-step workflow engine. Based on [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp) (MIT, [@Infatoshi](https://github.com/Infatoshi)).

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server, tool definitions, safety checks inline, global `VALID_KEYS` map |
| `src/x-api.ts` | `XApiClient` class — OAuth 1.0a + Bearer Token auth, raw fetch calls to `api.x.com/2` |
| `src/helpers.ts` | Pure utilities: `parseTweetId`, `errorMessage`, `formatResult` |
| `src/state.ts` | Persistent state: budget counters, engagement dedup sets, workflow storage, atomic file I/O |
| `src/compact.ts` | Response transformation: verbose API → compact form (flat metrics, author resolution, follower ratio) |
| `src/safety.ts` | Budget checks, dedup checks, action classification, typo suggestions, protected account checks |
| `src/toon.ts` | Vendored TOON encoder (from `@toon-format/toon`, MIT) |
| `src/workflow.ts` | Workflow orchestrator: `processWorkflows`, `submitTaskResponse`, `createWorkflow`, `getWorkflowStatus` |
| `src/workflow-types.ts` | Shared types: `LlmTask`, `WorkflowResult`, `AdvanceResult` |
| `src/workflow-follow-cycle.ts` | Follow cycle state machine: `advanceFollowCycle`, `buildLlmTask` |
| `src/workflow-reply-track.ts` | Reply track state machine: `advanceReplyTrack` |
| `src/workflow-cleanup.ts` | Non-follower cleanup: `cleanupNonFollowers` |

No Twitter SDK dependency. Auth uses `oauth-1.0a` + `crypto.createHmac`. Read operations use Bearer Token, write operations use OAuth 1.0a.

## Tools

**Tweets:** `post_tweet`, `reply_to_tweet`, `quote_tweet`, `delete_tweet`, `get_tweet`
**Search:** `search_tweets` (with `min_likes`/`min_retweets`/`sort_order`/`since_id`)
**Users:** `get_user`, `get_timeline`, `get_mentions` (with `since_id`), `get_followers`, `get_following`, `get_non_followers`
**Engagement:** `like_tweet`, `unlike_tweet`, `retweet`, `unretweet`, `follow_user`, `unfollow_user`
**Lists:** `get_list_members`, `get_list_tweets`, `get_followed_lists`
**Media:** `upload_media`
**Metrics:** `get_metrics`
**Workflows:** `get_next_task`, `submit_task`, `start_workflow`, `get_workflow_status`, `cleanup_non_followers`

## Safety Features

1. **Daily budget limits** — `X_MCP_MAX_REPLIES`, `X_MCP_MAX_ORIGINALS`, `X_MCP_MAX_LIKES`, `X_MCP_MAX_RETWEETS`, `X_MCP_MAX_FOLLOWS`, `X_MCP_MAX_UNFOLLOWS`, `X_MCP_MAX_DELETES`. Set `0` to disable, `-1` for unlimited.
2. **Budget in every response** — LLM sees remaining budget on every call (reads and writes).
3. **TOON encoding** — `X_MCP_TOON=true` (default). Responses in Token-Oriented Object Notation — field names once in headers, CSV-style rows for arrays. Set `false` for JSON.
4. **Compact responses** — `X_MCP_COMPACT=true` (default). Drops entities, flattens metrics, resolves author_id to @username, precomputes `author_follower_ratio`.
5. **Engagement dedup** — `X_MCP_DEDUP=true` (default). Never reply/like/retweet same tweet twice. Tracked with 90-day pruning window.
6. **Typo-correcting parameter suggestions** — Every tool checks unknown parameters against `VALID_KEYS` map and suggests closest match via fuzzy matching. Hardcoded redirects for common mistakes (e.g., `in_reply_to` → "Use reply_to_tweet tool instead").
7. **Destructive tool budget** — `delete_tweet` and `unfollow_user` are budget-limited like all other write tools. Set `X_MCP_MAX_DELETES=0` / `X_MCP_MAX_UNFOLLOWS=0` to block them entirely.
8. **Protected accounts** — `X_MCP_PROTECTED_ACCOUNTS` lists usernames that cannot be unfollowed by any tool or workflow.
9. **Active workflow protection** — `cleanup_non_followers` automatically skips users targeted by active `follow_cycle` or `reply_track` workflows.

## Key Features

1. **Engagement filtering** — `search_tweets` accepts `min_likes` and `min_retweets`. Fetches 100 internally, filters by `public_metrics`, returns up to `max_results`.
2. **Relevancy sorting** — `search_tweets` accepts `sort_order` (`recency` or `relevancy`).
3. **Incremental polling** — `search_tweets` and `get_mentions` accept `since_id`.
4. **Author metrics** — Compact tweets include `author_followers` and `author_follower_ratio` (followers/following ratio, precomputed).
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
X_MCP_MAX_UNFOLLOWS    # Daily unfollow limit (default 10, 0=disabled)
X_MCP_MAX_DELETES      # Daily delete limit (default 5, 0=disabled)
X_MCP_TOON             # TOON encoding (default: true, set "false" for JSON)
X_MCP_COMPACT          # Compact responses (default: true)
X_MCP_DEDUP            # Engagement dedup (default: true)
X_MCP_PROTECTED_ACCOUNTS # Comma-separated usernames that cannot be unfollowed
X_MCP_MAX_WORKFLOWS    # Max active workflows (default: 200)
X_MCP_STATE_FILE       # State file path (default: {cwd}/x-mcp-state.json)
```

## Rules

1. Keep the server minimal. No feature creep.
2. Every tool must handle errors gracefully and return `isError: true`.
3. Don't add dependencies without a strong reason.
4. Token efficiency matters. Don't add fields to API requests unless they're actually used.
5. Run `npm test` before every commit.
6. All timestamps must be ISO 8601.

## NEVER INVENT TEST DATA OR API RESPONSES

**THIS IS A HARD RULE. NO EXCEPTIONS.**

- **NEVER** fabricate fixture files and label them as "real API responses"
- **NEVER** add made-up fields (e.g. `public_metrics`) to existing real fixtures
- **NEVER** create JSON files with invented usernames, follower counts, tweet IDs, or any other data and commit them as if they came from the X API
- If you need test data that doesn't exist yet, **FETCH IT FROM THE LIVE API** (SSH to the Mac Mini, use Bearer Token, capture the real response)
- If you cannot fetch it, **say so** — do not silently invent data to fill the gap
- Frozen fixtures in `src/fixtures/` are sacred: they are byte-for-byte copies of real X API responses. The `_source` and `_endpoint` fields in each fixture are a contract — they mean the data was actually fetched from that endpoint on that date.

## Test Pattern: Frozen Fixtures

All integration tests follow this pattern:

1. **Capture** a real X API response (e.g. via `curl` with Bearer Token on the Mac Mini)
2. **Save** the raw JSON to `src/fixtures/<endpoint-name>.json` with `_source` and `_endpoint` metadata
3. **Never edit** the fixture after saving — it's a frozen snapshot of the real API
4. **Write tests** that load the fixture with `loadFixture()` and assert on the real field shapes, values, and compact transformation output
5. **If the API changes**, re-capture a new fixture — don't patch the old one

This ensures tests prove the code works against actual X API response shapes, not hand-crafted mocks. If someone changes `compactResponse()` and breaks it for real API data, these tests catch it.
