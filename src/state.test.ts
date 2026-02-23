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
    const existing: StateFile = {
      budget: { date: "2020-01-01", replies: 8, originals: 2, likes: 20, retweets: 5 },
      last_write_at: "2020-01-01T23:59:00.000Z",
      engaged: {
        replied_to: [{ tweet_id: "111", at: "2020-01-01T12:00:00.000Z" }],
        liked: [{ tweet_id: "222", at: "2020-01-01T12:00:00.000Z" }],
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
    // Engaged should be preserved
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.liked).toHaveLength(1);
    // last_write_at should be preserved
    expect(state.last_write_at).toBe("2020-01-01T23:59:00.000Z");
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
    const state: StateFile = {
      budget: { date: todayString(), replies: 5, originals: 1, likes: 12, retweets: 3 },
      last_write_at: "2026-02-23T15:30:00.000Z",
      engaged: {
        replied_to: [{ tweet_id: "aaa", at: "2026-02-23T15:00:00.000Z" }],
        liked: [{ tweet_id: "bbb", at: "2026-02-23T15:10:00.000Z" }],
        retweeted: [],
        quoted: [{ tweet_id: "ccc", at: "2026-02-23T15:20:00.000Z" }],
      },
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
    const nested = path.join(os.tmpdir(), `x-mcp-nested-${Date.now()}`, "sub", "state.json");
    const state = getDefaultState();

    saveState(nested, state);
    expect(fs.existsSync(nested)).toBe(true);

    // Cleanup
    fs.rmSync(path.join(os.tmpdir(), `x-mcp-nested-${Date.now()}`), { recursive: true, force: true });
  });
});
