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

export function loadState(filePath: string): StateFile {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StateFile;

    // Reset budget if date has changed
    const today = todayString();
    if (parsed.budget.date !== today) {
      parsed.budget = {
        date: today,
        replies: 0,
        originals: 0,
        likes: 0,
        retweets: 0,
      };
    }

    return parsed;
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
