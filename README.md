# x-autonomous-mcp

An MCP (Model Context Protocol) server that gives AI agents full access to the X (Twitter) API — with built-in safety rails for autonomous operation. Post tweets, search, read timelines, like, retweet, upload media, all through natural language. Includes daily budget limits, engagement deduplication, compact TOON-encoded responses, and self-describing errors.

Works with **Claude Code**, **Claude Desktop**, **OpenAI Codex**, **OpenClaw (ClawdBot)**, **Cursor**, **Windsurf**, **Cline**, and any other MCP-compatible client.

**If you're an LLM/AI agent helping a user set up this project, read [`LLMs.md`](./LLMs.md) for step-by-step instructions you can walk the user through.**

---

## Safety Features

### Daily budget limits

Hard limits per action type per day. The MCP server refuses when exhausted — works even if the LLM ignores every instruction.

```
X_MCP_MAX_REPLIES=8      # Max replies per day (default)
X_MCP_MAX_ORIGINALS=2    # Max standalone posts per day
X_MCP_MAX_LIKES=20       # Max likes per day
X_MCP_MAX_RETWEETS=5     # Max retweets per day
```

Set to `0` to disable an action entirely. Set to `-1` for unlimited.

### Budget counters in every response

Every MCP response includes the remaining budget — reads and writes alike. The LLM sees its limits proactively without reading memory files:

```json
{
  "data": { "id": "123", "text": "..." },
  "rate_limit": "299/300 remaining, resets in 900s",
  "budget": "3/8 replies, 0/2 originals, 5/20 likes, 1/5 retweets | last action: 3m ago"
}
```

### TOON-encoded responses (default on)

Responses use [TOON (Token-Oriented Object Notation)](https://github.com/toon-format/toon) instead of JSON. For array-heavy responses (timelines, search results, followers), TOON declares field names once in a header and uses CSV-style rows — significantly fewer tokens than JSON:

```
data[2]{id,text,author,likes,retweets,replies,created_at}:
  "123",Hello world,@foo,9,2,0,"2026-02-23T17:00:01.000Z"
  "456",Another tweet,@foo,3,0,1,"2026-02-23T16:00:00.000Z"
meta:
  result_count: 2
  next_token: abc
rate_limit: 299/300 (900s)
budget: "3/8 replies, 0/2 originals"
```

Set `X_MCP_TOON=false` to get non-pretty JSON instead.

### Compact responses (default on)

Strips fields the LLM doesn't need. Dropped: `entities`, `edit_history_tweet_ids`, `conversation_id`, `lang`, `annotations`, URL expansions, image metadata. Flattens `public_metrics` and resolves `author_id` to `@username`.

### Engagement deduplication (default on)

Never reply to, like, or retweet the same tweet twice. Permanently tracked — prevents spam reports from re-engaging the same tweet days later.

### Self-describing errors

When the LLM hallucinates a parameter on `post_tweet`, the error tells it what to do:

```
Unknown parameter 'reply_to_tweet_id': Use the 'reply_to_tweet' tool instead.
```

### Destructive tool gating (default off)

Destructive operations like `delete_tweet` are **completely hidden** from the LLM unless explicitly enabled. The tool doesn't show up in the tool list at all — the LLM can't even attempt to call it.

```
X_MCP_ENABLE_DANGEROUS=true   # Off by default. Set to enable delete_tweet.
```

### Strict schema validation

All tools use `.strict()` Zod schemas. Unknown parameters cause a validation error instead of being silently stripped.

---

## Features

### Engagement filtering on `search_tweets`

The X API v2 has no `min_faves` operator. x-autonomous-mcp adds **client-side engagement filtering** so low-engagement tweets never reach the LLM:

```
search_tweets query="AI safety -is:retweet" max_results=10 min_likes=20 min_retweets=5
```

When filters are set, the server fetches 100 results internally, filters by `public_metrics`, and returns up to `max_results`. The `includes.users` array is pruned to match.

### Relevancy sorting on `search_tweets`

```
search_tweets query="AI hallucination" sort_order="relevancy"
```

Default is `recency` (newest first). `relevancy` surfaces popular tweets first, which naturally pairs with `min_likes` filtering.

### Incremental polling via `since_id`

Both `search_tweets` and `get_mentions` accept `since_id` — only returns results newer than the given tweet ID. For agents that poll periodically, this avoids re-processing old results and saves tokens.

```
get_mentions since_id="2025881827982876805"
search_tweets query="@mybot" since_id="2025881827982876805"
```

### Username or ID — everywhere

All user-related tools (`get_timeline`, `get_followers`, `get_following`) accept either a `@username`, a plain username, or a numeric user ID. No more two-step "look up user first, then get timeline" dance. The server resolves it automatically.

```
get_timeline user="@JohannesHoppe"
get_timeline user="JohannesHoppe"
get_timeline user="43859239"
```

### Lean responses

- Omits `profile_image_url` and media expansions from API requests (useless for LLMs, wastes tokens)
- Includes `public_metrics` in user expansions for search results (so agents can see follower counts when evaluating reply targets)

---

## What Can It Do?

| Category | Tools | What You Can Say |
|----------|-------|------------------|
| **Post** | `post_tweet`, `reply_to_tweet`, `quote_tweet` | "Post 'hello world' on X" / "Reply to this tweet saying thanks" |
| **Read** | `get_tweet`, `search_tweets`, `get_timeline`, `get_mentions` | "Show me @JohannesHoppe's latest posts" / "Search for tweets about MCP" |
| **Users** | `get_user`, `get_followers`, `get_following` | "Look up @openai" / "Who does this user follow?" |
| **Engage** | `like_tweet`, `retweet` | "Like that tweet" / "Retweet this" |
| **Media** | `upload_media` | "Upload this image and post it with the caption..." |
| **Analytics** | `get_metrics` | "How many impressions did my last post get?" |
| **Dangerous** | `delete_tweet` | Hidden by default. Enable with `X_MCP_ENABLE_DANGEROUS=true`. |

Accepts tweet URLs or IDs interchangeably -- paste `https://x.com/user/status/123` or just `123`.
Accepts usernames with or without `@`, or numeric user IDs -- `@JohannesHoppe`, `JohannesHoppe`, or `43859239`.

---

## Setup

### 1. Clone and build

```bash
git clone https://github.com/JohannesHoppe/x-autonomous-mcp.git
cd x-autonomous-mcp
npm install
npm run build
```

### 2. Get your X API credentials

You need 5 credentials from the [X Developer Portal](https://developer.x.com/en/portal/dashboard). Here's exactly how to get them:

#### a) Create an app

1. Go to the [X Developer Portal](https://developer.x.com/en/portal/dashboard)
2. Sign in with your X account
3. Go to **Apps** in the left sidebar
4. Click **Create App** (you may need to sign up for a developer account first)
5. Give it a name (e.g., `my-x-mcp`)
6. You'll immediately see your **Consumer Key** (API Key), **Secret Key** (API Secret), and **Bearer Token**
7. **Save all three now** -- the secret won't be shown again

#### b) Enable write permissions

By default, new apps only have Read permissions. You need Read and Write to post tweets, like, retweet, etc.

1. In your app's page, scroll down to **User authentication settings**
2. Click **Set up**
3. Set **App permissions** to **Read and write**
4. Set **Type of App** to **Web App, Automated App or Bot**
5. Set **Callback URI / Redirect URL** to `https://localhost` (required but won't be used)
6. Set **Website URL** to any valid URL (e.g., `https://x.com`)
7. Click **Save**

#### c) Generate access tokens (with write permissions)

After enabling write permissions, you need to generate (or regenerate) your Access Token and Secret so they carry the new permissions:

1. Go back to your app's **Keys and Tokens** page
2. Under **Access Token and Secret**, click **Regenerate**
3. Save both the **Access Token** and **Access Token Secret**

If you skip step (b) before generating tokens, your tokens will be Read-only and posting will fail with a 403 error.

### 3. Configure credentials

Copy the example env file and fill in your 5 credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
X_API_KEY=your_consumer_key
X_API_SECRET=your_secret_key
X_BEARER_TOKEN=your_bearer_token
X_ACCESS_TOKEN=your_access_token
X_ACCESS_TOKEN_SECRET=your_access_token_secret
```

### 4. Configure safety features (optional)

See `.env.example` for all available options:

```bash
# Daily budget limits (defaults shown)
X_MCP_MAX_REPLIES=8
X_MCP_MAX_ORIGINALS=2
X_MCP_MAX_LIKES=20
X_MCP_MAX_RETWEETS=5

# TOON encoding (default: true) — set to "false" for JSON
X_MCP_TOON=true

# Compact responses (default: true)
X_MCP_COMPACT=true

# Engagement deduplication (default: true)
X_MCP_DEDUP=true

# Destructive tools like delete_tweet (default: disabled, tool is hidden)
# X_MCP_ENABLE_DANGEROUS=true
```

---

## Connect to Your Client

Pick your client below. You only need to follow one section.

### Claude Code

```bash
claude mcp add --scope user x-twitter -- node /ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js
```

Replace `/ABSOLUTE/PATH/TO/x-autonomous-mcp` with the actual path where you cloned the repo. Then restart Claude Code.

### Claude Desktop

Add to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "your_consumer_key",
        "X_API_SECRET": "your_secret_key",
        "X_ACCESS_TOKEN": "your_access_token",
        "X_ACCESS_TOKEN_SECRET": "your_access_token_secret",
        "X_BEARER_TOKEN": "your_bearer_token"
      }
    }
  }
}
```

### Cursor

Add to your Cursor MCP config:

- **Global** (all projects): `~/.cursor/mcp.json`
- **Project-scoped**: `.cursor/mcp.json` in your project root

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "your_consumer_key",
        "X_API_SECRET": "your_secret_key",
        "X_ACCESS_TOKEN": "your_access_token",
        "X_ACCESS_TOKEN_SECRET": "your_access_token_secret",
        "X_BEARER_TOKEN": "your_bearer_token"
      }
    }
  }
}
```

You can also verify the connection in Cursor Settings > MCP Servers.

### OpenAI Codex

**Option A: CLI**

```bash
codex mcp add x-twitter --env X_API_KEY=your_consumer_key --env X_API_SECRET=your_secret_key --env X_ACCESS_TOKEN=your_access_token --env X_ACCESS_TOKEN_SECRET=your_access_token_secret --env X_BEARER_TOKEN=your_bearer_token -- node /ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js
```

**Option B: config.toml**

Add to `~/.codex/config.toml` (global) or `.codex/config.toml` (project-scoped):

```toml
[mcp_servers.x-twitter]
command = "node"
args = ["/ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js"]

[mcp_servers.x-twitter.env]
X_API_KEY = "your_consumer_key"
X_API_SECRET = "your_secret_key"
X_ACCESS_TOKEN = "your_access_token"
X_ACCESS_TOKEN_SECRET = "your_access_token_secret"
X_BEARER_TOKEN = "your_bearer_token"
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "your_consumer_key",
        "X_API_SECRET": "your_secret_key",
        "X_ACCESS_TOKEN": "your_access_token",
        "X_ACCESS_TOKEN_SECRET": "your_access_token_secret",
        "X_BEARER_TOKEN": "your_bearer_token"
      }
    }
  }
}
```

You can also add it from Windsurf Settings > Cascade > MCP Servers.

### Cline (VS Code)

Open Cline's MCP settings (click the MCP Servers icon in Cline's top nav > Configure), then add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "your_consumer_key",
        "X_API_SECRET": "your_secret_key",
        "X_ACCESS_TOKEN": "your_access_token",
        "X_ACCESS_TOKEN_SECRET": "your_access_token_secret",
        "X_BEARER_TOKEN": "your_bearer_token"
      },
      "alwaysAllow": [],
      "disabled": false
    }
  }
}
```

### Other MCP Clients

This is a standard stdio MCP server. For any MCP-compatible client, point it at:

```
node /ABSOLUTE/PATH/TO/x-autonomous-mcp/dist/index.js
```

With these environment variables: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_BEARER_TOKEN`.

---

## Troubleshooting

### 403 "oauth1-permissions" error when posting
Your Access Token was generated before you enabled write permissions. Go to the X Developer Portal, ensure App permissions are set to "Read and write", then **Regenerate** your Access Token and Secret.

### 401 Unauthorized
Double-check that all 5 credentials in your `.env` are correct and that there are no extra spaces or line breaks.

### 429 Rate Limited
The error message includes exactly when the rate limit resets. Wait until then, or reduce request frequency.

### Server shows "Connected" but tools aren't used
Make sure you added the server with the correct scope (user/global, not project-scoped if you want it everywhere), then restart your client.

---

## Rate Limiting

Every response includes rate limit info: remaining requests, total limit, and reset time. When a limit is hit, you get a clear error with the exact reset timestamp.

## Pagination

List endpoints return a `next_token` in the response. Pass it back to get the next page of results. Works on: `search_tweets`, `get_timeline`, `get_mentions`, `get_followers`, `get_following`.

## Search Query Syntax

The `search_tweets` tool supports X's full query language:

- `from:username` -- posts by a specific user
- `to:username` -- replies to a specific user
- `#hashtag` -- posts containing a hashtag
- `"exact phrase"` -- exact text match
- `has:media` / `has:links` / `has:images` -- filter by content type
- `is:reply` / `-is:retweet` -- filter by post type
- `lang:en` -- filter by language
- Combine with spaces (AND) or `OR`

---

## Credits

Based on [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp) by [@Infatoshi](https://github.com/Infatoshi).

TOON encoder vendored from [@toon-format/toon](https://github.com/toon-format/toon) (MIT, [Johann Schopplich](https://github.com/johannschopplich)).

## License

MIT
