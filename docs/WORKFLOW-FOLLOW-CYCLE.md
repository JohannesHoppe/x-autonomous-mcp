# Workflow: follow_cycle

## Overview

The follow_cycle is a multi-step growth workflow that automates the full engagement loop: follow a target user, like their pinned tweet, reply to one of their recent tweets, wait 7 days, check if they followed back, and clean up if they didn't. The MCP auto-executes every step except composing the reply, which it delegates to the LLM.

The workflow is persistent. If the LLM disconnects mid-session, the workflow picks up exactly where it left off on the next `get_next_task` call. If the target follows back, the engagement stays. If they don't, everything gets undone: the pinned like, the reply, and the follow itself.

---

## State Machine

```
                         budget exhausted?
                         ──────────────── (blocks, retries next call)
                        │
execute_follow ─────────┤
   (AUTO)               │ follow API fails?
                        ├──────────────── outcome: "follow_failed" ──► done
                        │ dedup hit?
                        ├──────────────── outcome: "skipped_duplicate" ──► done
                        │
                        ▼
               get_reply_context
                    (AUTO)
                        │
              ┌─────────┴──────────┐
              │                    │
         tweet found          no tweet found
              │                    │
              ▼                    ▼
       need_reply_text          waiting ──────────────────────────┐
         (LLM INPUT)              ▲                              │
              │                   │                              │
              ▼                   │                              │
         post_reply ──────────────┘                              │
           (AUTO)            (always, 7-day timer)               │
                                                                 │
                              ┌──────────────────────────────────┘
                              │  (7 days pass)
                              ▼
                       check_followback
                            (AUTO)
                              │
                    ┌─────────┴──────────┐
                    │                    │
              followed back         didn't follow back
                    │                    │
                    ▼                    ▼
                  done               cleanup
           outcome: "followed_back"   (AUTO)
                                        │
                              ┌─────────┴──────────┐
                              │                    │
                         protected            not protected
                              │                    │
                              ▼                    ▼
                            done              unlike + delete + unfollow
                     outcome:                      │
                     "protected_kept"              ▼
                                                 done
                                          outcome: "cleaned_up"
                                          or "partially_cleaned_up"
```

---

## Step-by-Step Specification

### Step 1: execute_follow (AUTO)

The MCP follows the target, fetches their profile, and likes their pinned tweet.

**Pre-checks (any failure aborts or blocks):**
- Follow budget (`X_MCP_MAX_FOLLOWS`, default 10/day). If exhausted: workflow is NOT advanced. A summary is returned. The workflow retries on the next `get_next_task` call.
- Follow dedup (has this user been followed before?). If hit: `outcome = "skipped_duplicate"`, workflow terminates.

**Actions (in order):**
1. `client.followUser(target_user_id)` — if this fails, workflow aborts with `outcome = "follow_failed"`.
2. `recordAction("follow_user", target_user_id, state)` — increments `state.budget.follows`, adds to `state.engaged.followed`.
3. `client.getUser({ userId })` — fetches profile. Non-fatal if it fails.
4. If pinned tweet exists, like budget is available, and tweet hasn't been liked before: `client.likeTweet(pinned_tweet_id)`. Non-fatal if it fails.

**Context stored:**
| Key | Value | Source |
|-----|-------|--------|
| `pinned_tweet_id` | Target's pinned tweet ID | getUser response |
| `author_followers` | Follower count as string | getUser response |

**Actions recorded:** `"followed"`, optionally `"liked_pinned"`.

**Budget consumed:** `follows` (+1), optionally `likes` (+1).

**Auto-advances to:** `get_reply_context` (no return to LLM yet).

---

### Step 2: get_reply_context (AUTO)

The MCP fetches the target's recent timeline and picks a tweet to reply to.

**Logic:**
1. `client.getTimeline(target_user_id, 5)` — fetches 5 most recent tweets.
2. Finds the first non-reply tweet (no `referenced_tweets` with type `"replied_to"`). Falls back to the first tweet if all are replies.
3. Stores the tweet ID and text in context.

**Context stored:**
| Key | Value | Source |
|-----|-------|--------|
| `target_tweet_id` | Tweet to reply to | Timeline, first non-reply |
| `target_tweet_text` | Full text of that tweet | Timeline (note_tweet.text preferred for long tweets) |

**If no suitable tweet found:**
- Sets `check_after` to 7 days from now.
- Advances directly to `waiting` (skips reply entirely).
- Summary: "No suitable tweet found for @username, skipping reply."

**If tweet found:** Advances to `need_reply_text` (returns to LLM).

---

### Step 3: need_reply_text (LLM INPUT REQUIRED)

The workflow pauses. The MCP returns an `LlmTask` to the bot:

```json
{
  "workflow_id": "fc:username",
  "instruction": "Write a genuine, insightful reply to this tweet. Spark conversation, don't be generic. Keep it under 280 characters.",
  "context": {
    "tweet_id": "1893660912",
    "tweet_text": "Hot take: MCP servers are the new APIs",
    "author": "@username",
    "author_followers": "98200"
  },
  "respond_with": "submit_task"
}
```

The bot calls `submit_task` with `{ workflow_id: "fc:username", response: { reply_text: "..." } }`.

**Validation:** `reply_text` must be a non-empty string. If missing, an error is returned and the workflow stays at this step.

**On valid submit:** `reply_text` is stored in context, workflow advances to `post_reply`.

---

### Step 4: post_reply (AUTO)

The MCP posts the reply and sets a 7-day timer.

**Pre-checks:**
- `reply_text` and `target_tweet_id` must be in context. If missing: skips reply, sets 7-day wait.
- Reply budget (`X_MCP_MAX_REPLIES`, default 8/day). If exhausted: skips reply, sets 7-day wait.

**Actions:**
1. `client.postTweet({ text: reply_text, reply_to: target_tweet_id })` — posts the reply.
2. Stores `reply_tweet_id` in context (for later deletion).
3. `recordAction("reply_to_tweet", target_tweet_id, state)` — increments `state.budget.replies`, adds to `state.engaged.replied_to`.

**Context stored:**
| Key | Value | Source |
|-----|-------|--------|
| `reply_text` | LLM-composed reply | submit_task |
| `reply_tweet_id` | ID of posted reply | postTweet response |

**Actions recorded:** `"replied"` (success) or `"reply_failed"` (API error).

**Budget consumed:** `replies` (+1) on success.

**If reply posting fails:** Non-fatal. Records `"reply_failed"`, still advances to `waiting`.

**Always:** Sets `check_after` to 7 days from now. Advances to `waiting`.

---

### Step 5: waiting (AUTO, TIME-GATED)

The workflow pauses for 7 days. `processWorkflows()` skips any workflow where `check_after > today`.

When the date arrives (or has passed), the workflow automatically advances to `check_followback`.

No actions, no data changes. Just a time gate.

---

### Step 6: check_followback (AUTO)

The MCP checks whether the target followed us back.

**Algorithm:**
1. Gets our authenticated user ID.
2. Paginates through the **target's following list** (who the target follows), up to 5 pages (5000 users max).
3. If our ID appears in their following list: `outcome = "followed_back"`, workflow terminates.
4. If not found after all pages: advances to `cleanup`.

**Why check target's following, not our followers?** The target likely follows far fewer people than we have followers. Scanning 5 pages of their following is cheaper than scanning potentially hundreds of pages of our followers.

**Limitation:** If the target follows more than 5000 people, our ID might not be found even if they did follow back. This triggers a false cleanup.

**If the API call fails:** Non-fatal. Proceeds to cleanup anyway (conservative — prefers cleanup over keeping a potentially dead follow).

---

### Step 7: cleanup (AUTO, PROTECTED-ACCOUNT-GATED)

The MCP undoes all engagement from this workflow.

**Protected account check:** Checks `target_username` AND `target_user_id` against the protected accounts list. If either matches: `outcome = "protected_kept"`, workflow terminates without any cleanup.

**Cleanup actions (in order, each non-fatal):**
1. **Unlike pinned tweet** — `client.unlikeTweet(pinned_tweet_id)` if it exists. No budget required.
2. **Delete reply** — `client.deleteTweet(reply_tweet_id)` if it exists and delete budget allows. Increments `state.budget.deletes`.
3. **Unfollow** — `client.unfollowUser(target_user_id)` if unfollow budget allows. Increments `state.budget.unfollows`.

**Outcome determination:**
- If the unfollow succeeded: `outcome = "cleaned_up"`.
- If the unfollow was skipped (budget exhausted or API error): `outcome = "partially_cleaned_up"`. The target remains followed. There is no retry.

---

### Step 8: done

Terminal state. The workflow is complete. It will be pruned from state after 30 days.

---

## Interaction Story

### Happy Path: Target Follows Back

```
Day 1, Session 1
─────────────────

Bot: start_workflow(type="follow_cycle", target="alice")

MCP (internally):
  → Resolves "alice" → userId "123456"
  → Creates workflow: id = "fc:alice", current_step = "execute_follow"
  → processWorkflows() runs immediately:

  → fc:alice at execute_follow
  → checkBudget("follow_user") → OK (1/10)
  → checkDedup("follow_user", "123456") → OK (first time)
  → client.followUser("123456") → success
  → recordAction → budget.follows = 1, engaged.followed += "123456"
  → client.getUser("123456") → pinned_tweet_id = "pin1", followers = 5000
  → checkBudget("like_tweet") → OK (1/20)
  → checkDedup("like_tweet", "pin1") → OK
  → client.likeTweet("pin1") → success
  → recordAction → budget.likes = 1, engaged.liked += "pin1"
  → client.getTimeline("123456", 5) → picks tweet "t1": "Hot take: MCP is underrated"
  → Stores target_tweet_id = "t1", target_tweet_text = "Hot take: MCP is underrated"
  → Step is now need_reply_text → LLM input required

MCP responds:
  {
    "auto_completed": [],
    "next_task": {
      "workflow_id": "fc:alice",
      "instruction": "Write a genuine, insightful reply to this tweet...",
      "context": { "tweet_id": "t1", "tweet_text": "Hot take: MCP is underrated", "author": "@alice", "author_followers": "5000" },
      "respond_with": "submit_task"
    },
    "status": "1 active workflows. Task ready."
  }

Bot: submit_task(workflow_id="fc:alice", response={ reply_text: "100% — composability is the killer feature" })

MCP (internally):
  → Stores reply_text in context
  → Advances to post_reply
  → checkBudget("reply_to_tweet") → OK (1/8)
  → client.postTweet({ text: "100% — composability is the killer feature", reply_to: "t1" })
  → Stores reply_tweet_id = "reply1"
  → recordAction → budget.replies = 1, engaged.replied_to += "t1"
  → Sets check_after = "2026-03-03" (7 days from now)
  → Advances to waiting

MCP responds:
  {
    "auto_completed": ["Follow cycle for @alice: reply posted. Check-back scheduled for 2026-03-03."],
    "next_task": null,
    "status": "No tasks pending. 1 workflows waiting (earliest check-back: 2026-03-03)."
  }


Day 8, Session 2
─────────────────

Bot: get_next_task()

MCP (internally):
  → Finds fc:alice at waiting, check_after = "2026-03-03", today = "2026-03-04"
  → check_after <= today → advances to check_followback
  → client.getAuthenticatedUserId() → "myid"
  → client.getFollowing("123456", 1000) → page 1: [..., { id: "myid" }, ...]
  → Our ID found! → outcome = "followed_back", step = "done"

MCP responds:
  {
    "auto_completed": ["@alice followed back!"],
    "next_task": null,
    "status": "No active workflows."
  }
```

### Sad Path: Target Doesn't Follow Back

```
Day 8, Session 2
─────────────────

Bot: get_next_task()

MCP (internally):
  → Finds fc:bob at waiting, check_after passed
  → Advances to check_followback
  → client.getFollowing("789", 1000) → pages 1-3 scanned, our ID not found
  → Advances to cleanup
  → isProtectedAccount("bob") → false
  → client.unlikeTweet("pin2") → success, actions_done += "unliked_pinned"
  → checkBudget("delete_tweet") → OK
  → client.deleteTweet("reply2") → success, budget.deletes = 1, actions_done += "deleted_reply"
  → checkBudget("unfollow_user") → OK
  → client.unfollowUser("789") → success, budget.unfollows = 1, actions_done += "unfollowed"
  → outcome = "cleaned_up", step = "done"

MCP responds:
  {
    "auto_completed": ["@bob cleaned up (unliked_pinned, deleted_reply, unfollowed)."],
    "next_task": null,
    "status": "No active workflows."
  }
```

### Edge Case: Protected Account

```
MCP (internally, during cleanup):
  → isProtectedAccount("mentor") → true (in X_MCP_PROTECTED_ACCOUNTS)
  → outcome = "protected_kept", step = "done"
  → Summary: "@mentor is protected — kept follow, skipped cleanup."
```

### Edge Case: No Suitable Tweet in Timeline

```
MCP (internally, during get_reply_context):
  → client.getTimeline("456", 5) → returns []
  → No target_tweet_id stored
  → Sets check_after = 7 days from now
  → Advances directly to waiting (skips reply)
  → Summary: "No suitable tweet found for @newuser, skipping reply."
```

### Edge Case: Budget Exhausted During Cleanup

```
MCP (internally, during cleanup):
  → client.unlikeTweet("pin3") → success, actions_done += "unliked_pinned"
  → checkBudget("delete_tweet") → exhausted → skips delete
  → checkBudget("unfollow_user") → exhausted → skips unfollow
  → cleanupActions = ["unliked_pinned"] → does NOT include "unfollowed"
  → outcome = "partially_cleaned_up"
  → Summary: "@charlie cleaned up (unliked_pinned)."
  → Note: charlie remains followed. No retry mechanism.
```

---

## Where It Can Get Stuck

### 1. Follow budget exhausted
- **When:** `execute_follow` step, before any action.
- **What happens:** Workflow is NOT advanced. Summary returned. Retries automatically on the next `get_next_task` call.
- **Mitigation:** Wait until tomorrow (budget resets daily) or increase `X_MCP_MAX_FOLLOWS`.

### 2. Follow dedup hit
- **When:** `execute_follow` step, after budget check.
- **What happens:** `outcome = "skipped_duplicate"`, workflow terminates immediately.
- **Mitigation:** This is intentional. The user was already followed (within 90-day dedup window). Start a new workflow only after the dedup entry expires.

### 3. No suitable tweet in timeline
- **When:** `get_reply_context` step, after timeline fetch.
- **What happens:** Reply is skipped entirely. Workflow jumps to `waiting` with a 7-day timer. After 7 days, check_followback runs normally.
- **Mitigation:** None needed. The follow and like still happened. The reply step is skipped but the workflow continues.

### 4. Reply budget exhausted
- **When:** `post_reply` step, before posting.
- **What happens:** Reply is skipped. Workflow advances to `waiting` with a 7-day timer. The reply is permanently skipped for this workflow (no retry for replying).
- **Mitigation:** Start fewer follow_cycles per day, or increase `X_MCP_MAX_REPLIES`.

### 5. Reply posting fails (API error)
- **When:** `post_reply` step, during `client.postTweet()`.
- **What happens:** `"reply_failed"` recorded in `actions_done`. Workflow advances to `waiting`. No `reply_tweet_id` stored, so cleanup won't try to delete a nonexistent reply.
- **Mitigation:** None needed. The workflow continues to check_followback as normal.

### 6. Followback false negative (target follows >5000 people)
- **When:** `check_followback` step, during following-list pagination.
- **What happens:** The scan has a 5-page (5000 user) limit. If the target follows more than 5000 people, our ID might not appear in the scanned pages even though the target did follow back. This triggers a false cleanup.
- **Mitigation:** Rare in practice — most individual users follow fewer than 5000 people. If this is a concern, protect the account via `X_MCP_PROTECTED_ACCOUNTS`.

### 7. Rate limit exhaustion during batch check_followback
- **When:** Multiple workflows come due on the same day. Each `check_followback` scans up to 5 pages using `GET /following` (rate limit: 15 requests per 15 minutes).
- **What happens:** With 3+ targets due simultaneously, the rate limit is hit. Subsequent followback checks fail (caught by try/catch), and those workflows proceed to cleanup.
- **Mitigation:** Natural staggering (workflows started on different days come due on different days). If starting many workflows at once, protect important accounts via `X_MCP_PROTECTED_ACCOUNTS`.

### 8. Unfollow budget exhausted during cleanup
- **When:** `cleanup` step, during `client.unfollowUser()`.
- **What happens:** Unfollow is skipped. `outcome = "partially_cleaned_up"`. The target remains followed. There is no retry — the workflow terminates.
- **Mitigation:** Run `unfollow_user` manually later, or increase `X_MCP_MAX_UNFOLLOWS`.

---

## All Possible Outcomes

| Outcome | Meaning | Engagement Status |
|---------|---------|-------------------|
| `"followed_back"` | Target followed us back within 7 days | Follow + like + reply preserved |
| `"cleaned_up"` | Target didn't follow back, all engagement undone | Unfollowed, reply deleted, pinned unliked |
| `"partially_cleaned_up"` | Cleanup ran but unfollow was skipped (budget/error) | Target still followed, some cleanup done |
| `"protected_kept"` | Target is in protected accounts list | Follow + like + reply preserved |
| `"follow_failed"` | Initial follow API call failed | No engagement created |
| `"skipped_duplicate"` | Target was already followed (dedup) | No new engagement created |

---

## Data Model

```typescript
interface Workflow {
  id: string;                      // "fc:username" (lowercase)
  type: "follow_cycle";
  current_step: string;            // execute_follow | get_reply_context | need_reply_text |
                                   // post_reply | waiting | check_followback | cleanup | done
  target_user_id: string;          // Numeric X user ID
  target_username: string;         // Username (original case)
  created_at: string;              // ISO 8601 timestamp
  check_after: string | null;      // ISO date (YYYY-MM-DD) — time gate for waiting step
  context: {
    pinned_tweet_id?: string;      // Target's pinned tweet (for unlike in cleanup)
    author_followers?: string;     // Follower count (for LLM context)
    target_tweet_id?: string;      // Tweet selected for reply
    target_tweet_text?: string;    // Text of that tweet
    reply_text?: string;           // LLM-composed reply text
    reply_tweet_id?: string;       // Posted reply ID (for deletion in cleanup)
  };
  actions_done: string[];          // Audit trail: "followed", "liked_pinned", "replied",
                                   // "reply_failed", "unliked_pinned", "deleted_reply", "unfollowed"
  outcome: string | null;          // null = active, or one of the outcomes above
}
```

**Source code:** [`src/workflow.ts`](../src/workflow.ts), function `advanceFollowCycle` (line 25).
