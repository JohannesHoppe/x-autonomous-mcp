# Workflow: reply_track

## Overview

The reply_track is a post-publication audit workflow. After a reply is posted (either manually via `reply_to_tweet` or automatically via a follow_cycle), the MCP tracks it for 48 hours, then checks engagement metrics. If the reply got zero likes and zero replies after 48 hours, it's automatically deleted — it wasn't contributing and might look like spam. If it got any engagement at all, it's kept.

This workflow is fully automatic. The LLM is never asked for input. The MCP creates the workflow, waits 48 hours, fetches metrics, and decides.

---

## State Machine

```
posted ──► waiting_audit ──────────► audit ──► done
             (AUTO)       (48h gate)  (AUTO)
                                        │
                              ┌─────────┴──────────┐
                              │                    │
                        0 likes AND            any engagement
                        0 replies                  │
                              │                    ▼
                              ▼                  done
                    delete budget?          outcome: "audited_kept"
                              │
                    ┌─────────┴──────────┐
                    │                    │
                 budget OK          budget exhausted
                    │                    │
                    ▼                    ▼
                  done                 done
           outcome:              outcome: "audited_kept"
           "deleted_low_engagement"   (kept by default)
```

---

## Step-by-Step Specification

### Step 1: posted (AUTO)

The workflow's initial state. The MCP sets the 48-hour audit timer.

**What happens:**
1. Computes the audit date: `created_at + 48 hours`, truncated to a date (YYYY-MM-DD).
2. Sets `check_after` to that date.
3. Advances to `waiting_audit`.

**Context expected:** `reply_tweet_id` must already be in context (passed via `start_workflow`'s `reply_tweet_id` parameter).

**Auto-advances to:** `waiting_audit`.

---

### Step 2: waiting_audit (AUTO, TIME-GATED)

The workflow pauses for 48 hours. `processWorkflows()` skips any workflow where `check_after > today`.

When the date arrives (or has passed), the workflow automatically advances to `audit`.

**Note on timing precision:** The `check_after` field is a date (YYYY-MM-DD), not a datetime. This means:
- A reply posted at 01:00 UTC on Monday gets an audit date of Wednesday. The audit runs on Wednesday — that's ~48-71 hours later, depending on when `get_next_task` is called.
- A reply posted at 23:00 UTC on Monday gets an audit date of Wednesday. The audit runs on Wednesday — that's ~25-48 hours later.

This imprecision is by design. The 48-hour metric window is approximate.

---

### Step 3: audit (AUTO)

The MCP fetches engagement metrics and decides whether to keep or delete the reply.

**Algorithm:**
1. Checks that `reply_tweet_id` exists in context. If missing: `outcome = "no_tweet_to_audit"`, done.
2. Calls `client.getTweetMetrics(reply_tweet_id)`.
3. Extracts `like_count`, `reply_count`, `impression_count` from `public_metrics`.
4. Stores all three in context (as strings: `audit_likes`, `audit_replies`, `audit_impressions`).
5. **Decision:**
   - If `like_count === 0 AND reply_count === 0`: auto-delete.
   - Otherwise: keep.

**Auto-delete logic:**
1. Checks delete budget (`X_MCP_MAX_DELETES`, default 5/day).
2. If budget available: `client.deleteTweet(reply_tweet_id)`.
3. `recordAction("delete_tweet", null, state)` — increments `state.budget.deletes`.
4. Records `"deleted_low_engagement"` in `actions_done`.
5. `outcome = "deleted_low_engagement"`.

**If delete budget exhausted:** Tweet is kept. `outcome = "audited_kept"`.

**If delete API call fails:** Silently ignored. Tweet is kept. `outcome = "audited_kept"`.

**If metrics API call fails:** `outcome = "audit_failed"`. Tweet is kept (conservative default — better to keep a potentially good tweet than delete blindly).

**Context stored:**
| Key | Value | Source |
|-----|-------|--------|
| `audit_likes` | Like count as string | getTweetMetrics |
| `audit_replies` | Reply count as string | getTweetMetrics |
| `audit_impressions` | Impression count as string | getTweetMetrics |

**Actions recorded:** `"deleted_low_engagement"` (only if deleted).

**Budget consumed:** `deletes` (+1, only if deleted).

---

### Step 4: done

Terminal state. The workflow is complete. It will be pruned from state after 30 days.

---

## Interaction Story

### Happy Path: Tweet Performs Well

```
Day 1, Session 1
─────────────────

Bot: start_workflow(type="reply_track", target="alice", reply_tweet_id="reply123")

MCP (internally):
  → Creates workflow: id = "rt:alice:1709000000000"
  → current_step = "posted"
  → context = { reply_tweet_id: "reply123" }
  → processWorkflows() runs immediately:
    → posted step: sets check_after = "2026-02-28" (48h from now)
    → advances to waiting_audit
    → check_after > today → skipped (time-gated)

MCP responds:
  {
    "result": "Workflow reply_track started for @alice.",
    "status": "No tasks pending. 1 workflows waiting (earliest check-back: 2026-02-28).",
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }


Day 3, Session 2
─────────────────

Bot: get_next_task()

MCP (internally):
  → Finds rt:alice:... at waiting_audit, check_after = "2026-02-28", today = "2026-02-28"
  → check_after <= today → advances to audit
  → client.getTweetMetrics("reply123")
    → { public_metrics: { like_count: 3, reply_count: 1, impression_count: 450 } }
  → Stores: audit_likes = "3", audit_replies = "1", audit_impressions = "450"
  → 3 likes, 1 reply → engagement detected → keep
  → outcome = "audited_kept", step = "done"

MCP responds:
  {
    "auto_completed": "Reply reply123 audited: 3 likes, 1 replies, 450 impressions — kept.",
    "status": "No active workflows.",
    "x_budget": "0/8 replies used, 0/2 originals used, ..."
  }
```

### Sad Path: Zero Engagement, Auto-Deleted

```
Day 3, Session 2
─────────────────

Bot: get_next_task()

MCP (internally):
  → Finds rt:bob:... at waiting_audit, check_after passed
  → Advances to audit
  → client.getTweetMetrics("reply456")
    → { public_metrics: { like_count: 0, reply_count: 0, impression_count: 80 } }
  → Stores: audit_likes = "0", audit_replies = "0", audit_impressions = "80"
  → 0 likes AND 0 replies → auto-delete
  → checkBudget("delete_tweet") → OK (1/5)
  → client.deleteTweet("reply456") → success
  → recordAction → budget.deletes = 1
  → actions_done += "deleted_low_engagement"
  → outcome = "deleted_low_engagement", step = "done"

MCP responds:
  {
    "auto_completed": "Reply reply456 deleted (0 likes, 0 replies after 48h).",
    "status": "No active workflows.",
    "x_budget": "0/8 replies used, 0/2 originals used, 1/5 deletes used, ..."
  }
```

### Edge Case: Metrics API Fails

```
MCP (internally, during audit):
  → client.getTweetMetrics("reply789") → throws Error("rate limited")
  → Caught by try/catch
  → outcome = "audit_failed", step = "done"
  → Summary: "Reply reply789 audit failed — kept."
  → Tweet is preserved (conservative default)
```

### Edge Case: Delete Budget Exhausted

```
MCP (internally, during audit):
  → Metrics show 0 likes, 0 replies → should delete
  → checkBudget("delete_tweet") → "limit reached (5/5)"
  → Delete skipped
  → outcome = "audited_kept", step = "done"
  → Tweet is preserved despite zero engagement
```

---

## Where It Can Get Stuck

### 1. Missing reply_tweet_id
- **When:** `audit` step, at the start.
- **What happens:** `outcome = "no_tweet_to_audit"`, workflow completes silently.
- **Mitigation:** Always provide `reply_tweet_id` when calling `start_workflow` with `type="reply_track"`. The `start_workflow` tool validates this parameter.

### 2. Delete budget exhausted
- **When:** `audit` step, after detecting zero engagement.
- **What happens:** Tweet is kept despite zero engagement. `outcome = "audited_kept"`. No retry.
- **Mitigation:** Increase `X_MCP_MAX_DELETES` or delete the tweet manually.

### 3. Metrics API failure
- **When:** `audit` step, during `client.getTweetMetrics()`.
- **What happens:** `outcome = "audit_failed"`. Tweet is kept (conservative default).
- **Mitigation:** The tweet stays. You can check metrics manually or create a new reply_track workflow.

### 4. Audit timing imprecision
- **When:** `waiting_audit` step, time gate check.
- **What happens:** Because `check_after` is a date (not datetime), the actual audit can happen anywhere from ~25 to ~71 hours after creation, depending on when the reply was posted and when `get_next_task` is called.
- **Mitigation:** This is by design. The 48-hour window is approximate. Metrics are cumulative, so a few extra hours don't change the outcome meaningfully.

---

## All Possible Outcomes

| Outcome | Meaning | Tweet Status |
|---------|---------|--------------|
| `"audited_kept"` | Tweet had engagement (>0 likes or replies), or delete budget exhausted | Kept |
| `"deleted_low_engagement"` | Zero likes and zero replies after 48h, deleted | Deleted |
| `"audit_failed"` | Metrics API call failed | Kept (conservative) |
| `"no_tweet_to_audit"` | reply_tweet_id missing from context | N/A |

---

## Data Model

```typescript
interface Workflow {
  id: string;                      // "rt:username:timestamp" (lowercase username + creation timestamp)
  type: "reply_track";
  current_step: string;            // posted | waiting_audit | audit | done
  target_user_id: string;          // ID of the original tweet's author (for context)
  target_username: string;         // Username of the original tweet's author
  created_at: string;              // ISO 8601 timestamp
  check_after: string | null;      // ISO date (YYYY-MM-DD) — 48h audit gate
  context: {
    reply_tweet_id: string;        // Required: the tweet being tracked
    audit_likes?: string;          // Like count at audit time
    audit_replies?: string;        // Reply count at audit time
    audit_impressions?: string;    // Impression count at audit time
  };
  actions_done: string[];          // ["deleted_low_engagement"] or empty
  outcome: string | null;          // null = active, or one of the outcomes above
}
```

**Source code:** [`src/workflow.ts`](../src/workflow.ts), function `advanceReplyTrack` (line 267).
