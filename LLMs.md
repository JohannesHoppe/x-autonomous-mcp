# LLMs.md -- Setup Guide for AI Agents

You are an AI agent helping a user set up the x-autonomous-mcp server. This file contains everything you need to walk them through it. Follow these instructions in order.

---

## What This Is

x-autonomous-mcp is an MCP (Model Context Protocol) server that connects AI agents to the X (Twitter) API with built-in safety rails for autonomous operation. Once set up, you (the AI) will have access to tools for posting tweets, reading timelines, searching, liking, retweeting, following/unfollowing, uploading media, and more — with daily budget limits, engagement deduplication, and compact TOON-encoded responses.

**Response format:** By default, responses use TOON (Token-Oriented Object Notation) instead of JSON. You can parse TOON natively — field names appear once in headers, and array data uses CSV-style rows. If `X_MCP_TOON=false` is set, responses are non-pretty JSON instead.

**Long tweets:** The `text` field always contains the full tweet text, even for premium long tweets (>280 characters). No special handling needed — truncation is resolved server-side.

## Prerequisites

- Node.js 18+ installed
- An X (Twitter) account
- Access to a terminal

---

## Step 1: Clone and Build

Run these commands:

```bash
git clone https://github.com/JohannesHoppe/x-autonomous-mcp.git
cd x-autonomous-mcp
npm install
npm run build
```

If `npm install` fails, make sure Node.js 18+ is installed (`node --version`).

---

## Step 2: Get X API Credentials

The user needs 5 credentials from the X Developer Portal. Walk them through each sub-step below. This is the part users struggle with most -- be specific and patient.

### 2a: Create a Developer Account and App

1. Direct the user to https://developer.x.com/en/portal/dashboard
2. They need to sign in with their X account
3. If they don't have a developer account, they'll need to sign up (it's free for basic access)
4. Once in the dashboard, go to **Apps** in the left sidebar
5. Click **Create App**
6. Enter any app name (e.g., `my-x-autonomous`)
7. After creation, they will see three credentials on screen:
   - **Consumer Key** (also called API Key) --> this is `X_API_KEY`
   - **Secret Key** (also called API Secret) --> this is `X_API_SECRET`
   - **Bearer Token** --> this is `X_BEARER_TOKEN`
8. **IMPORTANT**: Tell the user to save all three immediately. The secret won't be shown again.

### 2b: Enable Write Permissions

This step is critical. Without it, posting/liking/retweeting will fail with a 403 error.

1. On the app's page, scroll to **User authentication settings**
2. Click **Set up**
3. Set these values:
   - **App permissions**: **Read and write** (NOT just Read)
   - **Type of App**: **Web App, Automated App or Bot**
   - **Callback URI / Redirect URL**: `https://localhost`
   - **Website URL**: `https://x.com` (or any valid URL)
4. Click **Save**
5. It will show an OAuth 2.0 Client Secret -- the user can save this but it's not needed for this MCP server

### 2c: Generate Access Tokens

The Access Token and Secret must be generated AFTER enabling write permissions (step 2b). If they were generated before, they need to be regenerated.

1. Go back to the app's **Keys and Tokens** page
2. Find **Access Token and Secret**
3. Click **Generate** (or **Regenerate** if tokens already exist)
4. Save both values:
   - **Access Token** --> this is `X_ACCESS_TOKEN`
   - **Access Token Secret** --> this is `X_ACCESS_TOKEN_SECRET`

### Verify Permissions

After generating, the Access Token section should show **"Read and Write"** (not just "Read"). If it says "Read", the user needs to:
1. Go back to User authentication settings
2. Confirm permissions are set to "Read and write"
3. Regenerate the Access Token and Secret again

---

## Step 3: Configure Environment

Create the `.env` file in the project root:

```bash
cp .env.example .env
```

Then fill in all 5 values:

```
X_API_KEY=<Consumer Key from step 2a>
X_API_SECRET=<Secret Key from step 2a>
X_BEARER_TOKEN=<Bearer Token from step 2a>
X_ACCESS_TOKEN=<Access Token from step 2c>
X_ACCESS_TOKEN_SECRET=<Access Token Secret from step 2c>
```

---

## Step 4: Register with Your Client

Determine which client the user is using and follow the corresponding instructions. Only one of these is needed.

### Claude Code

Run this command (replace the path with the actual absolute path to the cloned repo):

```bash
claude mcp add --scope user x-twitter -- node /absolute/path/to/x-autonomous-mcp/dist/index.js
```

Then restart Claude Code. To verify:

```bash
claude mcp list
```

The output should show `x-twitter: ... - Connected`.

### Claude Desktop

Add to `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor

Add to the Cursor MCP config file:

- **Global** (all projects): `~/.cursor/mcp.json`
- **Project-scoped**: `.cursor/mcp.json` in the project root

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      }
    }
  }
}
```

Verify in Cursor: Settings > MCP Servers -- the server should appear as connected.

### OpenAI Codex

**Option A -- CLI:**

```bash
codex mcp add x-twitter --env X_API_KEY=value --env X_API_SECRET=value --env X_ACCESS_TOKEN=value --env X_ACCESS_TOKEN_SECRET=value --env X_BEARER_TOKEN=value -- node /absolute/path/to/x-autonomous-mcp/dist/index.js
```

**Option B -- config.toml:**

Add to `~/.codex/config.toml` (global) or `.codex/config.toml` (project-scoped):

```toml
[mcp_servers.x-twitter]
command = "node"
args = ["/absolute/path/to/x-autonomous-mcp/dist/index.js"]

[mcp_servers.x-twitter.env]
X_API_KEY = "value"
X_API_SECRET = "value"
X_ACCESS_TOKEN = "value"
X_ACCESS_TOKEN_SECRET = "value"
X_BEARER_TOKEN = "value"
```

The CLI and the Codex VS Code extension share this config -- set it up once and both work.

### Windsurf

Add to the Windsurf MCP config:

- **macOS**: `~/.codeium/windsurf/mcp_config.json`
- **Windows**: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      }
    }
  }
}
```

Can also be added from Windsurf Settings > Cascade > MCP Servers.

### Cline (VS Code)

Open Cline's MCP settings: click the MCP Servers icon in Cline's top navigation bar, then click "Configure MCP Servers" to open `cline_mcp_settings.json`. Add:

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      },
      "alwaysAllow": [],
      "disabled": false
    }
  }
}
```

### Any Other MCP Client

This is a standard stdio MCP server. Point your client at:

```
node /absolute/path/to/x-autonomous-mcp/dist/index.js
```

With environment variables: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_BEARER_TOKEN`.

In all cases, replace `/absolute/path/to/x-autonomous-mcp` with the actual path where the repo was cloned, and replace `value` with the actual credentials from Step 2.

---

## Available Tools Reference

Once connected, you have access to these tools (prefixed with `mcp__x-twitter__` in Claude Code):

### Writing
- **post_tweet** -- Post text, polls, or media. Parameters: `text` (required), `poll_options`, `poll_duration_minutes`, `media_ids`
- **reply_to_tweet** -- Reply to a tweet. Parameters: `tweet_id` (ID or URL), `text`, `media_ids`
- **quote_tweet** -- Quote retweet. Parameters: `tweet_id` (ID or URL), `text`, `media_ids`
- **delete_tweet** -- Delete a tweet. Parameters: `tweet_id` (ID or URL). Budget-limited (default 5/day).

### Reading
- **get_tweet** -- Fetch tweet with metadata. Parameters: `tweet_id` (ID or URL)
- **search_tweets** -- Search recent tweets (last 7 days). Parameters: `query`, `max_results` (10-100), `min_likes`, `min_retweets`, `sort_order`, `since_id`, `next_token`
- **get_timeline** -- User's recent posts. Parameters: `user` (username with or without @, or numeric ID), `max_results`, `next_token`
- **get_mentions** -- Authenticated user's mentions. Parameters: `max_results`, `since_id`, `next_token`

### Users
- **get_user** -- Lookup by username or ID. Parameters: `username` OR `user_id`
- **get_followers** -- List followers. Parameters: `user` (username or numeric ID), `max_results`, `next_token`
- **get_following** -- List following. Parameters: `user` (username or numeric ID), `max_results`, `next_token`
- **get_non_followers** -- Find accounts you follow that don't follow back. Parameters: `max_pages` (default 5, each page = 1000 users). Sorted by follower count ascending (lowest quality first).

### Engagement
- **like_tweet** -- Like a tweet. Parameters: `tweet_id` (ID or URL)
- **retweet** -- Retweet. Parameters: `tweet_id` (ID or URL)
- **follow_user** -- Follow a user. Parameters: `user` (username or numeric ID). Budget-limited (default 10/day). Dedup-tracked.
- **unfollow_user** -- Unfollow a user. Parameters: `user` (username or numeric ID). Budget-limited (default 10/day). Protected accounts blocked.

### Undo
- **unlike_tweet** -- Unlike a tweet. Parameters: `tweet_id` (ID or URL)
- **unretweet** -- Remove a retweet. Parameters: `tweet_id` (ID or URL)

### Lists
- **get_list_members** -- Get members of a list. Parameters: `list_id`, `max_results` (1-100), `next_token`
- **get_list_tweets** -- Get tweets from a list. Parameters: `list_id`, `max_results` (1-100), `next_token`
- **get_followed_lists** -- Get lists you follow. Parameters: `max_results` (1-100), `next_token`

### Workflows
- **get_next_task** -- MUST call at session start. Auto-processes pending work, returns next assignment.
- **submit_task** -- Submit response to MCP request. Parameters: `workflow_id`, `response`
- **start_workflow** -- Begin workflow. Parameters: `type` (follow_cycle, reply_track), `target`, `reply_tweet_id` (required for reply_track)
- **get_workflow_status** -- Show workflows. Parameters: `type` (optional filter), `include_completed`
- **cleanup_non_followers** -- Batch-unfollow non-followers. Parameters: `max_unfollow`, `max_pages`

### Media
- **upload_media** -- Upload image/video (base64). Parameters: `media_data`, `mime_type`, `media_category`

### Analytics
- **get_metrics** -- Engagement metrics for a tweet. Parameters: `tweet_id` (ID or URL)

## Search Query Syntax

For `search_tweets`, the `query` parameter supports X's full search syntax:
- `from:username` -- posts by a user
- `to:username` -- replies to a user
- `#hashtag` -- hashtag search
- `"exact phrase"` -- exact match
- `has:media` / `has:links` / `has:images`
- `is:reply` / `-is:retweet`
- `lang:en` -- language filter
- Combine terms with spaces (AND) or `OR`

## Example Responses

Responses use TOON format by default (field names once in header, CSV-style rows for arrays). Every response includes `x_rate_limit` and `x_budget`.

**Tweet list** (get_timeline, search_tweets, get_mentions):
```
data[2]{id,text,author,author_followers,author_follower_ratio,likes,retweets,replies,replied_to_id,created_at}:
  "1893660912",Build agents not wrappers,@karpathy,3940281,118.6,4521,312,89,null,"2026-02-23T17:00:01.000Z"
  "1893660913",Hot take: MCP is underrated,@swyx,98200,3.2,210,45,12,null,"2026-02-23T16:30:00.000Z"
meta:
  result_count: 2
  next_token: abc123
x_rate_limit: 299/300 (900s)
x_budget: "3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

- `author_followers`: raw follower count
- `author_follower_ratio`: followers/following (precomputed, e.g., 118.6 means 118x more followers than following)
- `replied_to_id`: tweet ID this is replying to, or `null` for standalone tweets

**Single tweet** (get_tweet):
```
data:
  id: "1893660912"
  text: Build agents not wrappers
  author: "@karpathy"
  author_followers: 3940281
  author_follower_ratio: 118.6
  likes: 4521
  retweets: 312
  replies: 89
  replied_to_id: null
  created_at: "2026-02-23T17:00:01.000Z"
x_rate_limit: 299/300 (900s)
x_budget: "3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

**User profile** (get_user):
```
data:
  id: "43859239"
  username: JohannesHoppe
  name: Johannes Hoppe
  followers: 1234
  following: 567
  tweets: 890
  bio: Building things with TypeScript and AI
  pinned_tweet_id: "1893650001"
x_rate_limit: 299/300 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

**User list** (get_followers, get_following):
```
data[2]{id,username,name,followers,following,tweets,bio,pinned_tweet_id}:
  "123456",alice_dev,Alice,8900,450,1200,Full-stack engineer,"1893650100"
  "789012",bob_ai,Bob,340,120,890,ML researcher,null
meta:
  result_count: 2
  next_token: def456
x_rate_limit: 14/15 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

**Non-followers** (get_non_followers):
```
data[2]{id,username,name,followers,following,tweets,bio,pinned_tweet_id}:
  "111222",inactive_acc,Some Account,12,5000,3,,null
  "333444",spam_bot,Spammy,0,10000,50000,Follow me!,null
meta:
  total_following: 567
  total_followers: 1234
  non_followers_count: 2
x_rate_limit: 14/15 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```
Sorted by follower count ascending. Summary fields in `meta` (not `result_count`/`next_token`).

**Write result** (post_tweet, reply_to_tweet, quote_tweet):
```
data:
  id: "1893661000"
  text: Hello world!
x_rate_limit: 199/200 (900s)
x_budget: "0/8 replies used, 1/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used | last action: 0s ago"
```

**Engagement result** (like_tweet, retweet, follow_user):
```
data:
  liked: true
x_rate_limit: 199/200 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 1/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used | last action: 0s ago"
```

## Common Patterns

To get a user's latest posts (one step!):
```
get_timeline user="@JohannesHoppe"
```
No need to look up the user ID first — the server resolves usernames automatically.

To post with an image:
1. Call `upload_media` with the base64-encoded image data and MIME type
2. Use the returned `media_id` in `post_tweet`'s `media_ids` array

---

## Workflow System

IMPORTANT: You MUST call `get_next_task` at the START of every session.

The MCP server runs hardcoded workflows and is the authority on what happens next.
You are a service provider — the MCP tells you what it needs.

When you call `get_next_task`, the MCP:
1. Auto-executes ALL pending mechanical steps (follow, like, check follow-back, cleanup, audit)
2. Returns ONE task that needs YOUR input (write a reply, pick a target, etc.)

Your job:
1. Call `get_next_task`
2. Do what the MCP asks (write text, pick targets, make judgments)
3. Call `submit_task` with your answer
4. The MCP auto-continues the workflow
5. Call `get_next_task` again for the next task
6. Repeat until `get_next_task` says "nothing pending"

Do NOT skip steps. Do NOT improvise your own workflow. The MCP tracks everything.
If you get distracted, just call `get_next_task` — it picks up where you left off.

### Available Workflow Types

- **follow_cycle**: Follow → like pinned → reply → wait 7d → check follow-back → cleanup
- **reply_track**: Track a reply for performance audit after 48h → keep or delete

### Workflow Tools

- **get_next_task** — MUST be called at start of every session. Auto-processes all pending work, returns your next assignment.
- **submit_task** — Submit your response to the MCP's request. Parameters: `workflow_id`, `response` (e.g. `{ reply_text: "..." }`)
- **start_workflow** — Begin a new workflow. Parameters: `type` (follow_cycle, reply_track), `target` (username or ID), `reply_tweet_id` (required for reply_track)
- **get_workflow_status** — Show all workflows. Parameters: `type` (optional filter), `include_completed` (default false)
- **cleanup_non_followers** — Batch-unfollow non-followers. Parameters: `max_unfollow` (default 10), `max_pages` (default 5)

### Undo Tools

- **unlike_tweet** — Unlike a previously liked tweet. Parameters: `tweet_id`
- **unretweet** — Remove a retweet. Parameters: `tweet_id`

### List Tools

- **get_list_members** — Get members of a list. Parameters: `list_id`, `max_results`, `next_token`
- **get_list_tweets** — Get tweets from a list. Parameters: `list_id`, `max_results`, `next_token`
- **get_followed_lists** — Get lists you follow. Parameters: `max_results`, `next_token`

### Example Session

```
Bot: get_next_task()
MCP: [auto-processed 2 follow-back checks: 1 followed back, 1 cleaned up]
MCP: {
  "auto_completed": "Processed: @alice followed back! / @bob cleaned up (unliked, deleted, unfollowed)",
  "next_task": {
    "workflow_id": "fc:charlie",
    "instruction": "Write a genuine, insightful reply to this tweet. Spark conversation, don't be generic.",
    "context": { "tweet_id": "123", "tweet_text": "Hot take: MCP servers are the new APIs", "author": "@charlie", "author_followers": "98200" }
  },
  "x_budget": "2/8 replies used, 1/2 originals used, 5/20 likes used, ..."
}

Bot: submit_task(workflow_id="fc:charlie", response={ reply_text: "This resonates — we built x-autonomous-mcp and the composability is..." })
MCP: [posts reply, records ID, sets 7-day check-back — all automatic]
MCP: { "result": "Task submitted for workflow fc:charlie.", "status": "Reply posted. Check-back scheduled for 2026-03-03." }

Bot: get_next_task()
MCP: { "next_task": null, "status": "No tasks pending. 5 workflows waiting (earliest: 2026-03-01)." }
```

### Algorithm Cheat Sheet

```
Reply with follow-up = +75x | Reply = +13.5x | Retweet = +1x | Like = +0.5x
External links = -50% to -90% reach → put links in self-reply
Following/follower ratio > 0.6 = hard algorithmic penalty
First 30 minutes = algorithm's test window
Self-quote 4-6h later restarts engagement clock
Mass unfollow (>100/day) = 3-month shadowban
```

### Strategy Patterns (use primitive tools)

- **Self-Quote Boost:** `post_tweet` → 60s → `reply_to_tweet` (link) → 4-6h → `quote_tweet`
- **Pre-Engagement Warm-Up:** Like 5-10 + reply to 3-5 niche posts → then post your content
- **Non-Follower Cleanup:** `cleanup_non_followers` periodically, keep ratio < 0.6
- **List Targeting:** `get_followed_lists` → `get_list_members` → `start_workflow` for best candidates

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| 403 "oauth1-permissions" | Access Token has Read-only permissions | Enable "Read and write" in app settings, then **regenerate** Access Token and Secret |
| 401 Unauthorized | Bad credentials | Verify all 5 values in `.env` are correct, no extra whitespace |
| 429 Rate Limited | Too many requests | Error includes reset time -- wait until then |
| "Missing required environment variable" | `.env` file not found or incomplete | Ensure `.env` exists in project root with all 5 variables |
| Server connected but tools not visible | MCP server scope issue | Re-add with `claude mcp add --scope user`, restart Claude Code |
