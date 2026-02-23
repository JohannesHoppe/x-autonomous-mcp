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
});
