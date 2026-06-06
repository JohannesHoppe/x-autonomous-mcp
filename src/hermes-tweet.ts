const DEFAULT_HERMES_BASE_URL = "https://xquik.com";

interface HermesTweetConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface XApiResponse<T = unknown> {
  data?: T;
  meta?: {
    result_count?: number;
    next_token?: string;
    previous_token?: string;
  };
  includes?: Record<string, unknown[]>;
}

interface TweetFilters {
  minLikes?: number;
  minRetweets?: number;
  sortOrder?: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "bigint") return value.toString();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickObject(source: JsonObject | undefined, ...keys: string[]): JsonObject | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = asObject(source[key]);
    if (value) return value;
  }
  return undefined;
}

function pickArray(source: JsonObject | undefined, ...keys: string[]): unknown[] {
  if (!source) return [];
  for (const key of keys) {
    const value = asArray(source[key]);
    if (value.length > 0) return value;
  }
  return [];
}

function normalizePublicMetrics(source: JsonObject | undefined): Record<string, number> {
  const metrics = pickObject(source, "public_metrics", "metrics", "stats", "counts");
  return {
    like_count: firstNumber(
      metrics?.like_count,
      metrics?.likes,
      metrics?.favorite_count,
      source?.like_count,
      source?.likes,
      source?.favorite_count,
    ) ?? 0,
    retweet_count: firstNumber(
      metrics?.retweet_count,
      metrics?.retweets,
      source?.retweet_count,
      source?.retweets,
    ) ?? 0,
    reply_count: firstNumber(
      metrics?.reply_count,
      metrics?.replies,
      source?.reply_count,
      source?.replies,
    ) ?? 0,
    quote_count: firstNumber(
      metrics?.quote_count,
      metrics?.quotes,
      source?.quote_count,
      source?.quotes,
    ) ?? 0,
  };
}

function normalizeUser(source: unknown): JsonObject | undefined {
  const user = asObject(source);
  if (!user) return undefined;

  const publicMetrics = pickObject(user, "public_metrics", "metrics", "stats") ?? {};
  const id = firstString(user.id, user.user_id, user.userId, user.rest_id, user.restId);
  const username = firstString(
    user.username,
    user.screen_name,
    user.screenName,
    user.handle,
    user.userName,
  )?.replace(/^@/, "");

  if (!id && !username) return undefined;

  return {
    id: id ?? username ?? "",
    username: username ?? id ?? "",
    name: firstString(user.name, user.display_name, user.displayName) ?? username ?? id ?? "",
    description: firstString(user.description, user.bio) ?? "",
    verified: Boolean(user.verified ?? user.is_blue_verified ?? false),
    pinned_tweet_id: firstString(user.pinned_tweet_id, user.pinnedTweetId) ?? undefined,
    public_metrics: {
      followers_count: firstNumber(
        publicMetrics.followers_count,
        publicMetrics.followers,
        user.followers_count,
        user.followers,
      ) ?? 0,
      following_count: firstNumber(
        publicMetrics.following_count,
        publicMetrics.following,
        user.following_count,
        user.following,
      ) ?? 0,
      tweet_count: firstNumber(
        publicMetrics.tweet_count,
        publicMetrics.tweets,
        user.tweet_count,
        user.tweets,
      ) ?? 0,
    },
  };
}

function authorFromTweet(tweet: JsonObject): JsonObject | undefined {
  return normalizeUser(
    pickObject(tweet, "author", "user", "creator")
      ?? pickObject(pickObject(tweet, "core"), "user")
      ?? pickObject(pickObject(pickObject(tweet, "core"), "user_results"), "result")
      ?? {
        id: tweet.author_id ?? tweet.user_id ?? tweet.userId,
        username: tweet.author_username ?? tweet.username ?? tweet.screen_name,
        name: tweet.author_name ?? tweet.name,
        followers: tweet.author_followers,
        following: tweet.author_following,
      },
  );
}

function normalizeTweet(source: unknown): { tweet?: JsonObject; author?: JsonObject } {
  const tweet = asObject(source);
  if (!tweet) return {};

  const noteTweet = asObject(tweet.note_tweet);
  const author = authorFromTweet(tweet);
  const authorId = firstString(tweet.author_id, tweet.user_id, tweet.userId, author?.id);
  const inReplyToId = firstString(
    tweet.in_reply_to_status_id_str,
    tweet.in_reply_to_tweet_id,
    tweet.inReplyToTweetId,
  );

  const referencedTweets = inReplyToId
    ? [{ type: "replied_to", id: inReplyToId }]
    : asArray(tweet.referenced_tweets);

  return {
    tweet: {
      id: firstString(tweet.id, tweet.tweet_id, tweet.tweetId, tweet.rest_id, tweet.restId) ?? "",
      text: firstString(noteTweet?.text, tweet.full_text, tweet.fullText, tweet.text, tweet.content) ?? "",
      author_id: authorId,
      created_at: firstString(tweet.created_at, tweet.createdAt, tweet.time, tweet.timestamp) ?? "",
      public_metrics: normalizePublicMetrics(tweet),
      referenced_tweets: referencedTweets,
    },
    author,
  };
}

function findPayloadObject(payload: unknown, ...keys: string[]): JsonObject | undefined {
  const root = asObject(payload);
  if (!root) return undefined;
  for (const key of keys) {
    const candidate = asObject(root[key]);
    if (candidate) return candidate;
  }
  return root;
}

function findPayloadArray(payload: unknown, ...keys: string[]): unknown[] {
  const root = asObject(payload);
  if (!root) return asArray(payload);

  for (const key of keys) {
    const candidate = asArray(root[key]);
    if (candidate.length > 0) return candidate;
  }

  const data = asObject(root.data);
  const nested = pickArray(data, ...keys);
  return nested.length > 0 ? nested : asArray(root.data);
}

function resultMeta(payload: unknown, count: number): XApiResponse["meta"] {
  const root = asObject(payload);
  const meta = asObject(root?.meta);
  const nextToken = firstString(
    meta?.next_token,
    meta?.next_cursor,
    meta?.nextCursor,
    root?.next_token,
    root?.next_cursor,
    root?.nextCursor,
    root?.cursor,
  );

  return {
    result_count: firstNumber(meta?.result_count, root?.result_count, count) ?? count,
    ...(nextToken ? { next_token: nextToken } : {}),
  };
}

function uniqueUsers(users: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const output: JsonObject[] = [];
  for (const user of users) {
    const key = firstString(user.id, user.username);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(user);
  }
  return output;
}

function responseFromTweets(payload: unknown, values: unknown[]): XApiResponse<JsonObject[]> {
  const tweets: JsonObject[] = [];
  const users: JsonObject[] = [];

  for (const value of values) {
    const { tweet, author } = normalizeTweet(value);
    if (tweet?.id) tweets.push(tweet);
    if (author) users.push(author);
  }

  return {
    data: tweets,
    meta: resultMeta(payload, tweets.length),
    includes: { users: uniqueUsers(users) },
  };
}

function filterTweets(
  response: XApiResponse<JsonObject[]>,
  maxResults: number,
  filters?: TweetFilters,
): XApiResponse<JsonObject[]> {
  const minLikes = filters?.minLikes ?? 0;
  const minRetweets = filters?.minRetweets ?? 0;
  const data = (response.data ?? [])
    .filter((tweet) => {
      const metrics = asObject(tweet.public_metrics);
      return (firstNumber(metrics?.like_count) ?? 0) >= minLikes
        && (firstNumber(metrics?.retweet_count) ?? 0) >= minRetweets;
    })
    .slice(0, Math.min(Math.max(maxResults, 1), 100));

  const authorIds = new Set(data.map((tweet) => firstString(tweet.author_id)).filter(Boolean));
  const users = (response.includes?.users ?? []).filter((user) => {
    const id = firstString(asObject(user)?.id);
    return id ? authorIds.has(id) : false;
  });

  return {
    data,
    meta: {
      ...response.meta,
      result_count: data.length,
    },
    includes: { users },
  };
}

export class HermesTweetReadClient {
  private baseUrl: string;

  constructor(private config: HermesTweetConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_HERMES_BASE_URL).replace(/\/+$/, "");
  }

  private headers(hasBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey.startsWith("xq_")) {
      headers["x-api-key"] = this.config.apiKey;
    } else {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async get(path: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : {};
    const objectPayload = asObject(payload);
    if (!response.ok || objectPayload?.success === false) {
      const error = firstString(objectPayload?.error, objectPayload?.message, text)
        ?? "Hermes Tweet request failed";
      throw new Error(`Hermes Tweet ${path} failed (HTTP ${response.status}): ${error}`);
    }
    return payload;
  }

  async getTweet(tweetId: string): Promise<{ result: XApiResponse<JsonObject>; rateLimit: string }> {
    const payload = await this.get(`/api/v1/x/tweets/${tweetId}`);
    const source = findPayloadObject(payload, "data", "tweet", "result");
    const { tweet, author } = normalizeTweet(source);
    return {
      result: {
        data: tweet,
        includes: author ? { users: [author] } : { users: [] },
      },
      rateLimit: "Hermes Tweet read backend",
    };
  }

  async searchTweets(
    query: string,
    maxResults: number,
    nextToken?: string,
    filters?: TweetFilters,
  ): Promise<{ result: XApiResponse<JsonObject[]>; rateLimit: string }> {
    const payload = await this.get("/api/v1/x/tweets/search", {
      q: query,
      limit: Math.min(Math.max(maxResults, 1), 100).toString(),
      ...(nextToken ? { cursor: nextToken } : {}),
      ...(filters?.sortOrder === "relevancy" ? { queryType: "Top" } : { queryType: "Latest" }),
    });
    const values = findPayloadArray(payload, "data", "tweets", "results", "items");
    return {
      result: filterTweets(responseFromTweets(payload, values), maxResults, filters),
      rateLimit: "Hermes Tweet read backend",
    };
  }

  async getUser(params: { username?: string; userId?: string }): Promise<{ result: XApiResponse<JsonObject>; rateLimit: string }> {
    const userRef = params.userId ?? params.username;
    if (!userRef) throw new Error("Either username or userId must be provided");
    const payload = await this.get(`/api/v1/x/users/${userRef.replace(/^@/, "")}`);
    const user = normalizeUser(findPayloadObject(payload, "data", "user", "result"));
    return {
      result: { data: user },
      rateLimit: "Hermes Tweet read backend",
    };
  }

  async getTimeline(userId: string, maxResults: number, nextToken?: string): Promise<{ result: XApiResponse<JsonObject[]>; rateLimit: string }> {
    const payload = await this.get(`/api/v1/x/users/${userId}/tweets`, {
      ...(nextToken ? { cursor: nextToken } : {}),
    });
    const values = findPayloadArray(payload, "data", "tweets", "results", "items");
    return {
      result: filterTweets(responseFromTweets(payload, values), maxResults),
      rateLimit: "Hermes Tweet read backend",
    };
  }

  async getFollowers(userId: string, maxResults: number, nextToken?: string): Promise<{ result: XApiResponse<JsonObject[]>; rateLimit: string }> {
    return this.getUsersPage(`/api/v1/x/users/${userId}/followers`, maxResults, nextToken);
  }

  async getFollowing(userId: string, maxResults: number, nextToken?: string): Promise<{ result: XApiResponse<JsonObject[]>; rateLimit: string }> {
    return this.getUsersPage(`/api/v1/x/users/${userId}/following`, maxResults, nextToken);
  }

  private async getUsersPage(path: string, maxResults: number, nextToken?: string): Promise<{ result: XApiResponse<JsonObject[]>; rateLimit: string }> {
    const payload = await this.get(path, {
      pageSize: Math.min(Math.max(maxResults, 1), 200).toString(),
      ...(nextToken ? { cursor: nextToken } : {}),
    });
    const data = findPayloadArray(payload, "data", "users", "followers", "following", "items")
      .map((value) => normalizeUser(value))
      .filter((value): value is JsonObject => Boolean(value));
    return {
      result: {
        data,
        meta: resultMeta(payload, data.length),
      },
      rateLimit: "Hermes Tweet read backend",
    };
  }
}
