import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadState, saveState, getDefaultState, todayString } from "./state.js";
import type { StateFile } from "./state.js";

function tmpFile(): string {
  return path.join(os.tmpdir(), `x-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
  try { fs.unlinkSync(filePath + ".tmp"); } catch {}
}

describe("todayString", () => {
  it("returns ISO date format YYYY-MM-DD", () => {
    const result = todayString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getDefaultState", () => {
  it("returns fresh state with today's date", () => {
    const state = getDefaultState();
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
    expect(state.budget.likes).toBe(0);
    expect(state.budget.retweets).toBe(0);
    expect(state.last_write_at).toBeNull();
    expect(state.engaged.replied_to).toEqual([]);
    expect(state.engaged.liked).toEqual([]);
    expect(state.engaged.retweeted).toEqual([]);
    expect(state.engaged.quoted).toEqual([]);
  });
});

describe("loadState", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("returns default state for non-existent file", () => {
    const state = loadState(filePath);
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.engaged.replied_to).toEqual([]);
  });

  it("loads valid state file", () => {
    const existing: StateFile = {
      budget: { date: todayString(), replies: 3, originals: 1, likes: 5, retweets: 2 },
      last_write_at: "2026-02-23T10:00:00.000Z",
      engaged: {
        replied_to: [{ tweet_id: "111", at: "2026-02-23T10:00:00.000Z" }],
        liked: [],
        retweeted: [],
        quoted: [],
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(existing));

    const state = loadState(filePath);
    expect(state.budget.replies).toBe(3);
    expect(state.budget.originals).toBe(1);
    expect(state.last_write_at).toBe("2026-02-23T10:00:00.000Z");
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("111");
  });

  it("resets budget when date has changed but preserves engaged", () => {
    // Use yesterday's date for budget (triggers reset) but recent timestamps
    // for engaged entries (within 90-day pruning window)
    const recentTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // yesterday
    const existing: StateFile = {
      budget: { date: "2020-01-01", replies: 8, originals: 2, likes: 20, retweets: 5 },
      last_write_at: recentTimestamp,
      engaged: {
        replied_to: [{ tweet_id: "111", at: recentTimestamp }],
        liked: [{ tweet_id: "222", at: recentTimestamp }],
        retweeted: [],
        quoted: [],
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(existing));

    const state = loadState(filePath);
    // Budget should be reset
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
    expect(state.budget.likes).toBe(0);
    expect(state.budget.retweets).toBe(0);
    // Engaged should be preserved (recent entries within pruning window)
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("111");
    expect(state.engaged.liked).toHaveLength(1);
    expect(state.engaged.liked[0].tweet_id).toBe("222");
    // last_write_at should be preserved
    expect(state.last_write_at).toBe(recentTimestamp);
  });

  it("returns default state for corrupt JSON", () => {
    fs.writeFileSync(filePath, "not valid json {{{");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const state = loadState(filePath);
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("saveState", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("round-trips state through save and load", () => {
    const now = new Date().toISOString();
    const state: StateFile = {
      budget: { date: todayString(), replies: 5, originals: 1, likes: 12, retweets: 3, follows: 0, unfollows: 0, deletes: 0 },
      last_write_at: now,
      engaged: {
        replied_to: [{ tweet_id: "aaa", at: now }],
        liked: [{ tweet_id: "bbb", at: now }],
        retweeted: [],
        quoted: [{ tweet_id: "ccc", at: now }],
        followed: [],
      },
      workflows: [],
    };

    saveState(filePath, state);
    const loaded = loadState(filePath);

    expect(loaded).toEqual(state);
  });

  it("cleans up temp file after atomic write", () => {
    const state = getDefaultState();
    saveState(filePath, state);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(filePath + ".tmp")).toBe(false);
  });

  it("creates parent directories if needed", () => {
    const dirName = `x-mcp-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nestedDir = path.join(os.tmpdir(), dirName);
    const nested = path.join(nestedDir, "sub", "state.json");
    const state = getDefaultState();

    saveState(nested, state);
    expect(fs.existsSync(nested)).toBe(true);

    // Cleanup using the captured directory name
    fs.rmSync(nestedDir, { recursive: true, force: true });
  });
});

describe("state validation", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("fills in missing fields from partial state file", () => {
    // State file with budget but no engaged section
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 3, originals: 1 },
      last_write_at: "2026-02-23T10:00:00.000Z",
    }));

    const state = loadState(filePath);
    expect(state.budget.replies).toBe(3);
    expect(state.budget.originals).toBe(1);
    expect(state.budget.likes).toBe(0);
    expect(state.budget.retweets).toBe(0);
    expect(state.last_write_at).toBe("2026-02-23T10:00:00.000Z");
    expect(state.engaged.replied_to).toEqual([]);
    expect(state.engaged.liked).toEqual([]);
    expect(state.engaged.retweeted).toEqual([]);
    expect(state.engaged.quoted).toEqual([]);
  });

  it("handles completely empty object", () => {
    fs.writeFileSync(filePath, "{}");
    const state = loadState(filePath);
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.last_write_at).toBeNull();
    expect(state.engaged.replied_to).toEqual([]);
  });

  it("rejects non-number budget counters", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: "not-a-number", originals: null },
    }));
    const state = loadState(filePath);
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
  });

  it("filters invalid engaged entries", () => {
    const now = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      engaged: {
        replied_to: [
          { tweet_id: "valid", at: now },
          { tweet_id: 123, at: now },           // invalid: numeric tweet_id
          { at: now },                           // invalid: missing tweet_id
          "not-an-object",                       // invalid: not an object
        ],
        liked: [],
        retweeted: [],
        quoted: [],
      },
    }));
    const state = loadState(filePath);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("valid");
  });
});

describe("dedup pruning", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("prunes entries older than 90 days", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();   // 100 days ago

    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: {
        replied_to: [
          { tweet_id: "recent", at: recent },
          { tweet_id: "old", at: old },
        ],
        liked: [{ tweet_id: "also-old", at: old }],
        retweeted: [],
        quoted: [{ tweet_id: "also-recent", at: recent }],
      },
    }));

    const state = loadState(filePath);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("recent");
    expect(state.engaged.liked).toHaveLength(0);
    expect(state.engaged.quoted).toHaveLength(1);
    expect(state.engaged.quoted[0].tweet_id).toBe("also-recent");
  });

  it("keeps all entries younger than 90 days", () => {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: {
        replied_to: [
          { tweet_id: "a", at: now },
          { tweet_id: "b", at: yesterday },
        ],
        liked: [],
        retweeted: [],
        quoted: [],
      },
    }));

    const state = loadState(filePath);
    expect(state.engaged.replied_to).toHaveLength(2);
  });
});
