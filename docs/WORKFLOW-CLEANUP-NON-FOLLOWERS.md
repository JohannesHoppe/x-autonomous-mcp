# Workflow: cleanup_non_followers

## Overview

Unlike `follow_cycle` and `reply_track`, `cleanup_non_followers` is a **one-shot operation**, not a persistent workflow. It runs to completion in a single direct tool call — there's no state machine, no waiting period, no multi-session tracking. It is NOT triggered by `get_next_task` (which only processes `follow_cycle` and `reply_track` workflows). It finds accounts you follow that don't follow you back, and batch-unfollows them.

The purpose is to manage your following/follower ratio. X's algorithm penalizes accounts with a following/follower ratio above 0.6 (i.e., you follow more than 60% as many people as follow you). Periodic cleanup keeps this ratio healthy.

---

## Algorithm

When `cleanup_non_followers` is called:

```
1. client.getNonFollowers(max_pages)
   → Fetches your following list (up to max_pages * 1000 users)
   → Fetches your followers list (up to max_pages * 1000 users)
   → Computes set difference: following - followers = non-followers
   → Sorts by follower count ascending (lowest quality first)
   → Returns: { data: [...non-followers], meta: { total_following, total_followers, non_followers_count } }

2. For each non-follower (up to max_unfollow):
   a. Check active workflows (follow_cycle or reply_track targeting this user)
      → If active workflow exists: skip, add "@username (active workflow)" to skipped list
   b. Check protected accounts (by username AND userId)
      → If protected: skip, add "@username (protected)" to skipped list
   c. Check unfollow budget
      → If exhausted: add "budget exhausted — stopped" to skipped list, stop
   d. client.unfollowUser(userId)
      → If success: add "@username" to unfollowed list, recordAction (budget.unfollows += 1)
      → If API error: add "@username (API error)" to skipped list, continue

3. Return: { unfollowed: [...], skipped: [...], error: null }
```

If the initial `getNonFollowers` API call fails, the function returns `{ unfollowed: [], skipped: [], error: "error message" }`.

---

## Interaction Story

### Normal Run: Unfollows Low-Quality Non-Followers

```
Bot: cleanup_non_followers()

MCP (internally):
  → client.getNonFollowers(3)
  → Following: 567, Followers: 1234, Non-followers: 89
  → Sorted by follower count ascending:
    1. @inactive_acc (12 followers, 5000 following)
    2. @spambot (0 followers, 10000 following)
    3. @old_friend (500 followers, 200 following) ← protected
    4. @random_person (800 followers, 300 following)
    5. @abandoned_account (3 followers, 1000 following)
    ...

  → @inactive_acc: not protected, budget OK → unfollowUser → success
  → @spambot: not protected, budget OK → unfollowUser → success
  → @old_friend: protected → skip
  → @random_person: not protected, budget OK → unfollowUser → success
  → @abandoned_account: not protected, budget OK → unfollowUser → success
  → max_unfollow (5) not reached, but only 4 unfollows done (1 skipped)

MCP responds:
  {
    "unfollowed": ["@inactive_acc", "@spambot", "@random_person", "@abandoned_account"],
    "skipped": ["@old_friend (protected)"],
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }
```

### Protected Accounts Skipped

```
Bot: cleanup_non_followers(max_unfollow=10)

MCP (internally):
  → @mentor: isProtectedAccount("mentor") → true (in X_MCP_PROTECTED_ACCOUNTS)
    → skip, add "@mentor (protected)" to skipped
  → @friend1: isProtectedAccount("friend1") → true
    → skip, add "@friend1 (protected)" to skipped
  → @stranger: not protected → unfollowUser → success

MCP responds:
  {
    "unfollowed": ["@stranger"],
    "skipped": ["@mentor (protected)", "@friend1 (protected)"],
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }
```

### Active Workflow Targets Skipped

```
Bot: cleanup_non_followers(max_unfollow=10)

State: active workflows:
  → fc:alice (follow_cycle, target_user_id: "111", waiting for followback)
  → rt:bob:1709000000 (reply_track, target_user_id: "222", waiting for audit)

MCP (internally):
  → client.getNonFollowers(5)
  → Non-followers include @alice (id: 111) and @bob (id: 222)
  → @alice: active workflow target → skip, add "@alice (active workflow)"
  → @bob: active workflow target → skip, add "@bob (active workflow)"
  → @stranger: no active workflow, not protected → unfollowUser → success

MCP responds:
  {
    "unfollowed": ["@stranger"],
    "skipped": ["@alice (active workflow)", "@bob (active workflow)"],
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }
```

### Budget Runs Out Mid-Batch

```
Bot: cleanup_non_followers(max_unfollow=20)

MCP (internally):
  → Already unfollowed 9 users today (budget.unfollows = 9, limit = 10)
  → @first_user: budget OK (10/10 after this) → unfollowUser → success
  → @second_user: checkBudget("unfollow_user") → "limit reached (10/10)"
    → add "budget exhausted — stopped" to skipped, break

MCP responds:
  {
    "unfollowed": ["@first_user"],
    "skipped": ["budget exhausted — stopped"],
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }
```

### API Error During Individual Unfollow

```
MCP (internally):
  → @user_a: unfollowUser → success
  → @user_b: unfollowUser → throws Error("rate limited")
    → add "@user_b (API error)" to skipped, continue
  → @user_c: unfollowUser → success

MCP responds:
  {
    "unfollowed": ["@user_a", "@user_c"],
    "skipped": ["@user_b (API error)"],
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }
```

### getNonFollowers API Failure

```
Bot: cleanup_non_followers()

MCP (internally):
  → client.getNonFollowers(5) → throws Error("API down")

MCP responds:
  {
    "unfollowed": [],
    "skipped": [],
    "x_budget": "0/8 replies used, 0/2 originals used, ...",
    "error": "API down"
  }
```

---

## Where It Can Get Stuck

### 1. Unfollow budget exhausted
- **When:** During the unfollow loop.
- **What happens:** "budget exhausted — stopped" added to skipped list, loop breaks. Already-unfollowed users stay unfollowed.
- **Mitigation:** Wait until tomorrow (budget resets daily) and run again. Or increase `X_MCP_MAX_UNFOLLOWS`.

### 2. getNonFollowers API failure
- **When:** At the start, before any unfollows.
- **What happens:** Returns `{ unfollowed: [], skipped: [], error: "..." }`.
- **Mitigation:** Retry. The error message includes details (usually rate limiting or auth issues).

### 3. Rate limits during batch unfollow
- **When:** Mid-batch. The X API rate-limits `DELETE /following` requests.
- **What happens:** Individual unfollows fail with API errors. Those users are added to the skipped list. The loop continues attempting remaining users.
- **Mitigation:** Use a smaller `max_unfollow` value. Spread cleanup across multiple sessions.

### 4. Active workflow targets auto-skipped
- **When:** During the unfollow loop, for any user that is the target of an active `follow_cycle` or `reply_track` workflow.
- **What happens:** The user is skipped with "@username (active workflow)" in the skipped list. This prevents cleanup from undoing an in-progress follow cycle or unfollowing someone you're actively engaging with.
- **Mitigation:** Not a problem — this is intentional. Complete or cancel the workflow first if you want to unfollow the user.

### 5. Protected account userId not resolved at startup
- **When:** During protected account check.
- **What happens:** If `resolveProtectedAccountIds` (called at MCP server startup) failed for a username, that account's `userId` is `null`. The username check still works, but if the non-follower list only has the numeric ID (not the username), the protection check could miss it.
- **Mitigation:** Ensure `X_MCP_PROTECTED_ACCOUNTS` usernames are spelled correctly. The startup resolution logs errors to console.

### 6. Incomplete non-follower list
- **When:** If your following or followers list exceeds `max_pages * 1000`.
- **What happens:** The set difference may be incomplete. Some non-followers won't appear in the results.
- **Mitigation:** Increase `max_pages`. Default is 5 (5000 users). For accounts following/followed by more than 5000, use a higher value.

---

## Configuration

| Env Var | Default | Effect |
|---------|---------|--------|
| `X_MCP_MAX_UNFOLLOWS` | `10` | Daily unfollow budget. Set to `0` to disable all unfollows. Set to `-1` for unlimited. |
| `X_MCP_PROTECTED_ACCOUNTS` | (empty) | Comma-separated usernames that cannot be unfollowed. Example: `friend1,friend2,@mentor` |

| Parameter | Default | Effect |
|-----------|---------|--------|
| `max_unfollow` | `10` | Maximum users to unfollow in this call |
| `max_pages` | `5` | Pages to fetch for following/followers lists (1 page = 1000 users) |

**Source code:** [`src/workflow-cleanup.ts`](../src/workflow-cleanup.ts), function `cleanupNonFollowers`.
