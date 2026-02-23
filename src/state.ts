import fs from "fs";
import path from "path";

export interface EngagedEntry {
  tweet_id: string;
  at: string; // ISO 8601: "2026-02-23T13:34:36.000Z"
}

export interface StateFile {
  budget: {
    date: string; // ISO 8601 date: "2026-02-23"
    replies: number;
    originals: number;
    likes: number;
    retweets: number;
  };
  last_write_at: string | null; // ISO 8601: "2026-02-23T13:34:36.000Z"
  engaged: {
    replied_to: EngagedEntry[];
    liked: EngagedEntry[];
    retweeted: EngagedEntry[];
    quoted: EngagedEntry[];
  };
}

// Entries older than 90 days are pruned on load
const DEDUP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultState(): StateFile {
  return {
    budget: {
      date: todayString(),
      replies: 0,
      originals: 0,
      likes: 0,
      retweets: 0,
    },
    last_write_at: null,
    engaged: {
      replied_to: [],
      liked: [],
      retweeted: [],
      quoted: [],
    },
  };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && !isNaN(value) ? value : fallback;
}

function asEngagedArray(value: unknown): EngagedEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e) => e && typeof e === "object" && typeof e.tweet_id === "string" && typeof e.at === "string",
  );
}

function pruneEngaged(entries: EngagedEntry[]): EngagedEntry[] {
  const cutoff = Date.now() - DEDUP_MAX_AGE_MS;
  return entries.filter((e) => new Date(e.at).getTime() > cutoff);
}

/**
 * Validate and normalize a parsed JSON object into a safe StateFile.
 * Missing or invalid fields fall back to defaults.
 */
function validateState(raw: unknown): StateFile {
  if (!raw || typeof raw !== "object") return getDefaultState();

  const obj = raw as Record<string, unknown>;
  const budget = (obj.budget && typeof obj.budget === "object")
    ? obj.budget as Record<string, unknown>
    : {};
  const engaged = (obj.engaged && typeof obj.engaged === "object")
    ? obj.engaged as Record<string, unknown>
    : {};

  const today = todayString();
  const budgetDate = typeof budget.date === "string" ? budget.date : today;

  // Reset counters if date changed
  const dateChanged = budgetDate !== today;

  return {
    budget: {
      date: today,
      replies: dateChanged ? 0 : asNumber(budget.replies, 0),
      originals: dateChanged ? 0 : asNumber(budget.originals, 0),
      likes: dateChanged ? 0 : asNumber(budget.likes, 0),
      retweets: dateChanged ? 0 : asNumber(budget.retweets, 0),
    },
    last_write_at: typeof obj.last_write_at === "string" ? obj.last_write_at : null,
    engaged: {
      replied_to: pruneEngaged(asEngagedArray(engaged.replied_to)),
      liked: pruneEngaged(asEngagedArray(engaged.liked)),
      retweeted: pruneEngaged(asEngagedArray(engaged.retweeted)),
      quoted: pruneEngaged(asEngagedArray(engaged.quoted)),
    },
  };
}

export function loadState(filePath: string): StateFile {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateState(parsed);
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultState();
    }
    // Corrupt file — log warning, return fresh state
    console.error(`Warning: could not parse state file ${filePath}, starting fresh:`, e);
    return getDefaultState();
  }
}

export function saveState(filePath: string, state: StateFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}
