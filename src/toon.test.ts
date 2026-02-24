import { describe, it, expect } from "vitest";
import { encode } from "./toon.js";

describe("TOON encode", () => {
  describe("primitives", () => {
    it("encodes strings", () => {
      expect(encode("hello")).toBe("hello");
    });

    it("encodes numbers", () => {
      expect(encode(42)).toBe("42");
      expect(encode(3.14)).toBe("3.14");
      expect(encode(-7)).toBe("-7");
    });

    it("encodes booleans", () => {
      expect(encode(true)).toBe("true");
      expect(encode(false)).toBe("false");
    });

    it("encodes null", () => {
      expect(encode(null)).toBe("null");
    });

    it("encodes undefined as null", () => {
      expect(encode(undefined)).toBe("null");
    });

    it("quotes strings that look like numbers", () => {
      expect(encode("42")).toBe('"42"');
      expect(encode("3.14")).toBe('"3.14"');
    });

    it("quotes strings that look like booleans", () => {
      expect(encode("true")).toBe('"true"');
      expect(encode("false")).toBe('"false"');
      expect(encode("null")).toBe('"null"');
    });

    it("quotes strings with special characters", () => {
      expect(encode("hello, world")).toBe('"hello, world"');
      expect(encode("key: value")).toBe('"key: value"');
      expect(encode("line1\nline2")).toBe('"line1\\nline2"');
    });

    it("quotes empty strings", () => {
      expect(encode("")).toBe('""');
    });
  });

  describe("flat objects", () => {
    it("encodes key-value pairs", () => {
      expect(encode({ name: "Alice", age: 30 })).toBe(
        "name: Alice\nage: 30",
      );
    });

    it("encodes nested objects with indentation", () => {
      expect(encode({ meta: { count: 2, token: "abc" } })).toBe(
        "meta:\n  count: 2\n  token: abc",
      );
    });

    it("encodes empty nested objects", () => {
      expect(encode({ empty: {} })).toBe("empty:");
    });

    it("quotes keys with special characters", () => {
      expect(encode({ "my-key": 1 })).toBe('"my-key": 1');
    });
  });

  describe("tabular arrays (uniform objects)", () => {
    it("encodes as header + CSV rows", () => {
      const data = [
        { id: "1", name: "Alice", score: 95 },
        { id: "2", name: "Bob", score: 87 },
      ];
      // String "1"/"2" are quoted to distinguish from number 1/2
      expect(encode(data)).toBe(
        '[2]{id,name,score}:\n  "1",Alice,95\n  "2",Bob,87',
      );
    });

    it("encodes numeric IDs unquoted when they are actual numbers", () => {
      const data = [
        { id: 1, name: "Alice", score: 95 },
        { id: 2, name: "Bob", score: 87 },
      ];
      expect(encode(data)).toBe(
        "[2]{id,name,score}:\n  1,Alice,95\n  2,Bob,87",
      );
    });

    it("encodes tabular array inside an object", () => {
      const response = {
        data: [
          { id: 123, text: "Hello", likes: 5 },
          { id: 456, text: "World", likes: 3 },
        ],
      };
      expect(encode(response)).toBe(
        "data[2]{id,text,likes}:\n  123,Hello,5\n  456,World,3",
      );
    });

    it("quotes values with commas in tabular rows", () => {
      const data = [
        { id: 1, text: "hello, world" },
      ];
      expect(encode(data)).toBe(
        '[1]{id,text}:\n  1,"hello, world"',
      );
    });

    it("quotes values with colons in tabular rows", () => {
      const data = [
        { id: 1, time: "2026-02-23T13:00:00.000Z" },
      ];
      expect(encode(data)).toBe(
        '[1]{id,time}:\n  1,"2026-02-23T13:00:00.000Z"',
      );
    });
  });

  describe("non-tabular arrays", () => {
    it("encodes primitive arrays inline", () => {
      expect(encode({ tags: [1, 2, 3] })).toBe("tags[3]: 1,2,3");
    });

    it("encodes empty arrays", () => {
      expect(encode({ items: [] })).toBe("items[0]:");
    });

    it("encodes mixed-key objects as list items", () => {
      const data = [
        { id: "1", name: "A" },
        { id: "2", name: "B", extra: true },
      ];
      const result = encode(data);
      expect(result).toContain("[2]:");
      expect(result).toContain('- id: "1"');
      expect(result).toContain('- id: "2"');
    });
  });

  describe("full MCP response shape", () => {
    it("encodes a timeline response", () => {
      const response = {
        data: [
          { id: "123", text: "Hello world", author: "@foo", likes: 9, retweets: 2, replies: 0, created_at: "2026-02-23T17:00:01.000Z" },
          { id: "456", text: "Another tweet", author: "@foo", likes: 3, retweets: 0, replies: 1, created_at: "2026-02-23T16:00:00.000Z" },
        ],
        meta: { result_count: 2, next_token: "abc" },
        x_rate_limit: "299/300 (900s)",
        x_budget: "3/8 replies used, 0/2 originals used",
      };

      const result = encode(response);
      const lines = result.split("\n");

      // Header with field names
      expect(lines[0]).toBe("data[2]{id,text,author,likes,retweets,replies,created_at}:");
      // Rows: string IDs get quoted, created_at (has colons) gets quoted
      expect(lines[1]).toBe('  "123",Hello world,@foo,9,2,0,"2026-02-23T17:00:01.000Z"');
      expect(lines[2]).toBe('  "456",Another tweet,@foo,3,0,1,"2026-02-23T16:00:00.000Z"');
      // Meta as nested object
      expect(lines[3]).toBe("meta:");
      expect(lines[4]).toBe("  result_count: 2");
      expect(lines[5]).toBe("  next_token: abc");
      // Scalar fields (x_budget has commas, gets quoted)
      expect(lines[6]).toBe("x_rate_limit: 299/300 (900s)");
      expect(lines[7]).toBe('x_budget: "3/8 replies used, 0/2 originals used"');
    });

    it("encodes a single tweet response", () => {
      const response = {
        data: { id: "123", text: "Hello", author: "@foo", likes: 5, retweets: 1, replies: 0 },
        x_rate_limit: "299/300 (900s)",
      };

      const result = encode(response);
      // String ID "123" gets quoted to distinguish from number 123
      expect(result).toContain("data:");
      expect(result).toContain('  id: "123"');
      expect(result).toContain("  text: Hello");
      expect(result).toContain("  author: @foo");
      expect(result).toContain("x_rate_limit: 299/300 (900s)");
    });

    it("encodes a user list response", () => {
      const response = {
        data: [
          { id: "1", username: "alice", name: "Alice", followers: 100, following: 50, tweets: 200, bio: "Hello" },
          { id: "2", username: "bob", name: "Bob", followers: 200, following: 100, tweets: 400, bio: "World" },
        ],
        meta: { result_count: 2 },
      };

      const result = encode(response);
      expect(result).toContain("data[2]{id,username,name,followers,following,tweets,bio}:");
      expect(result).toContain('  "1",alice,Alice,100,50,200,Hello');
      expect(result).toContain('  "2",bob,Bob,200,100,400,World');
    });

    it("encodes a delete response (passthrough-like)", () => {
      const response = { data: { deleted: true } };
      const result = encode(response);
      expect(result).toBe("data:\n  deleted: true");
    });

    it("encodes an upload response", () => {
      const response = { data: { media_id: "123", message: "Upload complete." } };
      const result = encode(response);
      // String "123" gets quoted
      expect(result).toContain('media_id: "123"');
      expect(result).toContain("message: Upload complete.");
    });
  });

  describe("edge cases", () => {
    it("handles NaN and Infinity as null", () => {
      expect(encode({ a: NaN, b: Infinity, c: -Infinity })).toBe(
        "a: null\nb: null\nc: null",
      );
    });

    it("handles Date objects", () => {
      const d = new Date("2026-01-01T00:00:00.000Z");
      const result = encode({ time: d });
      expect(result).toBe('time: "2026-01-01T00:00:00.000Z"');
    });

    it("handles -0 as 0", () => {
      expect(encode(-0)).toBe("0");
    });

    it("escapes backslashes and quotes in strings", () => {
      expect(encode('say "hello"')).toBe('"say \\"hello\\""');
      expect(encode("back\\slash")).toBe('"back\\\\slash"');
    });

    it("handles strings starting with hyphen", () => {
      expect(encode("-foo")).toBe('"-foo"');
    });
  });
});
