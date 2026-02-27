# LLMs.md — Operational Guide for AI Agents

Read **[README.md](./README.md)** first for setup instructions, tool reference, safety features, example responses, and troubleshooting.

This file contains LLM-specific operational guidance — how to behave as an autonomous agent using this MCP server.

---

## Response Format

Responses use TOON (Token-Oriented Object Notation) by default. Field names appear once in headers, array data uses CSV-style rows. You can parse it natively. If `X_MCP_TOON=false` is set, responses are JSON instead.

The `text` field always contains the full tweet text, even for premium long tweets (>280 characters). No special handling needed.

Every response includes `x_budget` — your remaining daily budget. Watch it.

---

## Workflow System

The MCP server runs hardcoded workflows and is the authority on what happens next. You are a service provider — the MCP tells you what it needs.

### How to Start

1. **Call `get_next_task`** — always do this first. It processes pending work and returns your next assignment.
2. **If you get a task** — do what it asks (write a reply, etc.), then call `submit_task` with your answer. Then call `get_next_task` again.
3. **If there are no active workflows** — you need to create some. Find interesting accounts to engage with, then call `start_workflow`:
   - `start_workflow(type="follow_cycle", target="@username")` — follows the user, likes their pinned tweet, fetches their timeline, and asks you to write a reply. After you reply, it waits 7 days and checks if they followed back.
   - `start_workflow(type="reply_track", target="@username", reply_tweet_id="...")` — tracks a reply you already posted. After 48h, it checks engagement and auto-deletes if zero likes/replies.
4. **Repeat** — call `get_next_task` after each submit. When it says "nothing pending", you're done for now.

**Finding targets:** Use `search_tweets` to find accounts in your niche, `get_followed_lists` → `get_list_members` to browse curated lists, or `get_timeline` to explore who's active. Then `start_workflow` for the best candidates.

Do NOT skip steps. Do NOT improvise your own workflow. The MCP tracks everything.
If you get distracted, just call `get_next_task` — it picks up where you left off.

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

---

## Algorithm Rules

Based on X's [open-sourced algorithm](https://github.com/twitter/the-algorithm-ml/blob/main/projects/home/recap/README.md) (April 2023). Weights may have changed since.

- **Replies are worth far more than likes or retweets.** The algorithm weights replies at 13.5x a retweet, and replies where the author engages back at 75x. Likes are only 0.5x. Always prefer replying over liking.
- **Never put links in your main tweet.** X heavily penalizes external links (confirmed by Musk, Nov 2024). Put links in a self-reply instead.
- **Keep your following/follower ratio low.** If you follow 500+ accounts and your following/follower ratio exceeds 0.6, the algorithm applies an exponential penalty to your account's reputation score. The `author_follower_ratio` in responses is followers/following — keep it well above 1.7.
- **Early engagement matters most.** The algorithm measures engagement velocity. A tweet that gets replies in the first 30-60 minutes will be distributed much more widely. Engage with others before and after posting.
- **Quote your own tweet hours later** to give the content a second round of distribution. The quote tweet is scored independently as a new tweet.
- **Never mass-unfollow.** Unfollowing 100+ accounts per day triggers visibility penalties (48h-14 days). Our budget defaults to 10/day for this reason.

---

## Additional Tactics (use alongside workflows)

These are manual tactics using primitive tools — not managed by the workflow engine. Use them in addition to `follow_cycle` and `reply_track`.

- **Self-Quote Boost:** After posting (`post_tweet`), reply to your own tweet with a link 60s later (`reply_to_tweet`), then quote it 4-6h later (`quote_tweet`) for a second round of distribution.
- **Pre-Engagement Warm-Up:** Before posting your own content, like 5-10 and reply to 3-5 niche posts. This primes the algorithm to show your next tweet to those audiences.
- **Non-Follower Cleanup:** Run `cleanup_non_followers` periodically to keep your following/follower ratio healthy.
- **List Targeting:** Use `get_followed_lists` → `get_list_members` to find high-quality accounts, then `start_workflow` for the best candidates.

---

## Setup Help

If a user asks you to help set up this MCP server, walk them through:

1. **[README.md](./README.md)** — Clone, build, get X API credentials, configure `.env`
2. **[Client Setup](docs/CLIENT-SETUP.md)** — Register with their specific client (Claude Code, Cursor, etc.)

**Common setup mistake:** The user generates Access Tokens *before* enabling write permissions. Tokens must be regenerated after setting permissions to "Read and write", or posting will fail with 403.
