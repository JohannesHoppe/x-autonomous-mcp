import { describe, it, expect } from "vitest";
import { parseTweetId, errorMessage, formatResult } from "./helpers.js";

describe("parseTweetId", () => {
  it("parses raw numeric ID", () => {
    expect(parseTweetId("1234567890")).toBe("1234567890");
  });

  it("parses x.com URL", () => {
    expect(parseTweetId("https://x.com/user/status/1234567890")).toBe("1234567890");
  });

  it("parses twitter.com URL", () => {
    expect(parseTweetId("https://twitter.com/user/status/1234567890")).toBe("1234567890");
  });

  it("parses URL with query parameters", () => {
    expect(parseTweetId("https://x.com/user/status/1234567890?s=20")).toBe("1234567890");
  });

  it("trims whitespace from raw ID", () => {
    expect(parseTweetId("  1234567890  ")).toBe("1234567890");
  });

  it("throws on invalid input", () => {
    expect(() => parseTweetId("not-a-valid-id")).toThrow("Invalid tweet ID or URL");
  });

  it("throws on empty string", () => {
    expect(() => parseTweetId("")).toThrow("Invalid tweet ID or URL");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string errors as-is", () => {
    expect(errorMessage("something broke")).toBe("something broke");
  });

  it("stringifies non-Error non-string values", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("formatResult", () => {
  it("wraps data in { data } envelope", () => {
    const result = JSON.parse(formatResult({ id: "1" }, ""));
    expect(result).toEqual({ data: { id: "1" } });
  });

  it("includes rate_limit when non-empty", () => {
    const result = JSON.parse(formatResult({ id: "1" }, "5/15 remaining"));
    expect(result.rate_limit).toBe("5/15 remaining");
  });

  it("omits rate_limit when empty string", () => {
    const result = JSON.parse(formatResult({}, ""));
    expect(result).not.toHaveProperty("rate_limit");
  });

  it("includes budget string when provided", () => {
    const result = JSON.parse(formatResult({ id: "1" }, "", "3/8 replies, 0/2 originals"));
    expect(result.budget).toBe("3/8 replies, 0/2 originals");
  });

  it("omits budget when undefined", () => {
    const result = JSON.parse(formatResult({ id: "1" }, ""));
    expect(result).not.toHaveProperty("budget");
  });

  it("compacts tweet response when compact=true (no double data wrapping)", () => {
    const apiResponse = {
      data: {
        id: "123",
        text: "Hello",
        author_id: "456",
        public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0 },
        entities: { urls: [] },
        created_at: "2026-02-23T13:00:00.000Z",
      },
      includes: {
        users: [{ id: "456", username: "author", name: "Author" }],
      },
    };
    const result = JSON.parse(formatResult(apiResponse, "", undefined, true));
    // compactResponse merges directly — { data: compactTweet, budget: ... }
    expect(result.data.author).toBe("@author");
    expect(result.data.likes).toBe(5);
    expect(result.data).not.toHaveProperty("entities");
    expect(result).not.toHaveProperty("includes");
  });

  it("does not compact when compact=false", () => {
    const apiResponse = {
      data: {
        id: "123",
        text: "Hello",
        author_id: "456",
        entities: { urls: [] },
      },
    };
    const result = JSON.parse(formatResult(apiResponse, "", undefined, false));
    // Non-compact: wraps raw API response in MCP envelope { data: <raw> }
    expect(result.data.data.entities).toBeDefined();
  });

  it("preserves meta in compact mode", () => {
    const apiResponse = {
      data: [
        { id: "1", text: "First", author_id: "10", public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0 }, created_at: "2026-02-23T13:00:00.000Z" },
      ],
      includes: { users: [{ id: "10", username: "u", name: "U" }] },
      meta: { result_count: 1, next_token: "abc" },
    };
    const result = JSON.parse(formatResult(apiResponse, "", "3/8 replies", true));
    expect(result.meta).toEqual({ result_count: 1, next_token: "abc" });
    expect(result.budget).toBe("3/8 replies");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].author).toBe("@u");
  });
});
