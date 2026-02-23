import { describe, it, expect } from "vitest";
import { compactTweet, compactUser, compactResponse } from "./compact.js";

describe("compactTweet", () => {
  it("compacts a full tweet with metrics and author resolution", () => {
    const tweet = {
      id: "123",
      text: "Hello world",
      author_id: "456",
      public_metrics: { like_count: 10, retweet_count: 5, reply_count: 2 },
      created_at: "2026-02-23T13:34:36.000Z",
      entities: { mentions: [], urls: [] },
      edit_history_tweet_ids: ["123"],
      conversation_id: "100",
      lang: "en",
    };
    const users = [{ id: "456", username: "testuser", name: "Test User" }];

    const result = compactTweet(tweet, users);

    expect(result).toEqual({
      id: "123",
      text: "Hello world",
      author: "@testuser",
      likes: 10,
      retweets: 5,
      replies: 2,
      created_at: "2026-02-23T13:34:36.000Z",
    });
  });

  it("maps referenced_tweets replied_to to is_reply_to", () => {
    const tweet = {
      id: "200",
      text: "replying",
      author_id: "456",
      public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0 },
      referenced_tweets: [{ type: "replied_to", id: "100" }],
      created_at: "2026-02-23T14:00:00.000Z",
    };

    const result = compactTweet(tweet, []);
    expect(result.is_reply_to).toBe("100");
  });

  it("uses author_id as fallback when user not in includes", () => {
    const tweet = {
      id: "300",
      text: "orphan tweet",
      author_id: "999",
      public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0 },
      created_at: "2026-02-23T14:00:00.000Z",
    };

    const result = compactTweet(tweet, []);
    expect(result.author).toBe("999");
  });

  it("defaults missing metrics to 0", () => {
    const tweet = {
      id: "400",
      text: "no metrics",
      created_at: "2026-02-23T14:00:00.000Z",
    };

    const result = compactTweet(tweet, []);
    expect(result.likes).toBe(0);
    expect(result.retweets).toBe(0);
    expect(result.replies).toBe(0);
  });
});

describe("compactUser", () => {
  it("compacts a full user object", () => {
    const user = {
      id: "456",
      username: "testuser",
      name: "Test User",
      verified: true,
      description: "I test things",
      public_metrics: { followers_count: 1000, following_count: 50, tweet_count: 500 },
      created_at: "2020-01-01T00:00:00.000Z",
      url: "https://example.com",
      location: "Internet",
      profile_image_url: "https://pbs.twimg.com/...",
    };

    const result = compactUser(user);

    expect(result).toEqual({
      id: "456",
      username: "testuser",
      name: "Test User",
      verified: true,
      followers: 1000,
      following: 50,
      tweets: 500,
      bio: "I test things",
    });
  });

  it("defaults missing metrics to 0", () => {
    const user = { id: "789", username: "minimal", name: "Min" };
    const result = compactUser(user);
    expect(result.followers).toBe(0);
    expect(result.following).toBe(0);
    expect(result.tweets).toBe(0);
    expect(result.verified).toBe(false);
    expect(result.bio).toBe("");
  });
});

describe("compactResponse", () => {
  it("compacts a single tweet response", () => {
    const response = {
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

    const result = compactResponse(response) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect(data.id).toBe("123");
    expect(data.author).toBe("@author");
    expect(data.likes).toBe(5);
    expect(data).not.toHaveProperty("entities");
    expect(data).not.toHaveProperty("author_id");
    expect(result).not.toHaveProperty("includes");
  });

  it("compacts a tweet list response", () => {
    const response = {
      data: [
        { id: "1", text: "First", author_id: "10", public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0 }, created_at: "2026-02-23T13:00:00.000Z" },
        { id: "2", text: "Second", author_id: "10", public_metrics: { like_count: 2, retweet_count: 0, reply_count: 0 }, created_at: "2026-02-23T14:00:00.000Z" },
      ],
      includes: {
        users: [{ id: "10", username: "bulk", name: "Bulk" }],
      },
      meta: { result_count: 2, next_token: "abc" },
    };

    const result = compactResponse(response) as Record<string, unknown>;
    const data = result.data as Array<Record<string, unknown>>;

    expect(data).toHaveLength(2);
    expect(data[0].author).toBe("@bulk");
    expect(data[1].likes).toBe(2);
    expect(result.meta).toEqual({ result_count: 2, next_token: "abc" });
    expect(result).not.toHaveProperty("includes");
  });

  it("compacts a single user response", () => {
    const response = {
      data: {
        id: "456",
        username: "testuser",
        name: "Test",
        verified: false,
        description: "bio",
        public_metrics: { followers_count: 100, following_count: 50, tweet_count: 200 },
        profile_image_url: "https://pbs.twimg.com/...",
        created_at: "2020-01-01T00:00:00.000Z",
      },
    };

    const result = compactResponse(response) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect(data.username).toBe("testuser");
    expect(data.followers).toBe(100);
    expect(data).not.toHaveProperty("profile_image_url");
    expect(data).not.toHaveProperty("created_at");
  });

  it("compacts a user list response", () => {
    const response = {
      data: [
        { id: "1", username: "a", name: "A", public_metrics: { followers_count: 10, following_count: 5, tweet_count: 20 } },
        { id: "2", username: "b", name: "B", public_metrics: { followers_count: 20, following_count: 10, tweet_count: 40 } },
      ],
      meta: { result_count: 2, next_token: "xyz" },
    };

    const result = compactResponse(response) as Record<string, unknown>;
    const data = result.data as Array<Record<string, unknown>>;

    expect(data).toHaveLength(2);
    expect(data[0].username).toBe("a");
    expect(data[1].followers).toBe(20);
    expect(result.meta).toEqual({ result_count: 2, next_token: "xyz" });
  });

  it("passes through non-standard responses unchanged", () => {
    const deleteResponse = { data: { deleted: true } };
    expect(compactResponse(deleteResponse)).toEqual(deleteResponse);
  });

  it("passes through upload results unchanged", () => {
    const uploadResponse = { data: { media_id: "123", message: "Upload complete." } };
    expect(compactResponse(uploadResponse)).toEqual(uploadResponse);
  });

  it("passes through null/undefined unchanged", () => {
    expect(compactResponse(null)).toBeNull();
    expect(compactResponse(undefined)).toBeUndefined();
  });

  it("passes through empty data array unchanged", () => {
    const response = { data: [], meta: { result_count: 0 } };
    expect(compactResponse(response)).toEqual(response);
  });
});
