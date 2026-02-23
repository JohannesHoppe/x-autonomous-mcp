export interface CompactTweet {
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  replies: number;
  is_reply_to?: string;
  created_at: string;
}

export interface CompactUser {
  id: string;
  username: string;
  name: string;
  verified: boolean;
  followers: number;
  following: number;
  tweets: number;
  bio: string;
}

interface TweetLike {
  id?: string;
  text?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
  };
  referenced_tweets?: Array<{ type?: string; id?: string }>;
  created_at?: string;
}

interface UserLike {
  id?: string;
  username?: string;
  name?: string;
  verified?: boolean;
  description?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
  };
}

function isTweet(obj: unknown): obj is TweetLike {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.id === "string";
}

function isUser(obj: unknown): obj is UserLike {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return typeof o.username === "string" && typeof o.id === "string" && !("text" in o);
}

function resolveAuthor(authorId: string | undefined, users: UserLike[]): string {
  if (!authorId) return "unknown";
  const user = users.find((u) => u.id === authorId);
  return user?.username ? `@${user.username}` : authorId;
}

export function compactTweet(tweet: TweetLike, users: UserLike[]): CompactTweet {
  const metrics = tweet.public_metrics;
  const repliedTo = tweet.referenced_tweets?.find((r) => r.type === "replied_to");

  const result: CompactTweet = {
    id: tweet.id ?? "",
    text: tweet.text ?? "",
    author: resolveAuthor(tweet.author_id, users),
    likes: metrics?.like_count ?? 0,
    retweets: metrics?.retweet_count ?? 0,
    replies: metrics?.reply_count ?? 0,
    created_at: tweet.created_at ?? "",
  };

  if (repliedTo?.id) {
    result.is_reply_to = repliedTo.id;
  }

  return result;
}

export function compactUser(user: UserLike): CompactUser {
  const metrics = user.public_metrics;
  return {
    id: user.id ?? "",
    username: user.username ?? "",
    name: user.name ?? "",
    verified: user.verified ?? false,
    followers: metrics?.followers_count ?? 0,
    following: metrics?.following_count ?? 0,
    tweets: metrics?.tweet_count ?? 0,
    bio: user.description ?? "",
  };
}

export function compactResponse(apiResponse: unknown): unknown {
  if (!apiResponse || typeof apiResponse !== "object") return apiResponse;

  const resp = apiResponse as Record<string, unknown>;
  const data = resp.data;
  const includes = resp.includes as Record<string, unknown[]> | undefined;
  const meta = resp.meta;
  const users = (includes?.users ?? []) as UserLike[];

  // Single tweet
  if (isTweet(data)) {
    const result: Record<string, unknown> = { data: compactTweet(data, users) };
    if (meta) result.meta = meta;
    return result;
  }

  // Tweet list
  if (Array.isArray(data) && data.length > 0 && isTweet(data[0])) {
    const result: Record<string, unknown> = {
      data: data.map((t) => compactTweet(t as TweetLike, users)),
    };
    if (meta) result.meta = meta;
    return result;
  }

  // Single user
  if (isUser(data)) {
    const result: Record<string, unknown> = { data: compactUser(data) };
    if (meta) result.meta = meta;
    return result;
  }

  // User list
  if (Array.isArray(data) && data.length > 0 && isUser(data[0])) {
    const result: Record<string, unknown> = {
      data: data.map((u) => compactUser(u as UserLike)),
    };
    if (meta) result.meta = meta;
    return result;
  }

  // Passthrough for other shapes (delete results, upload results, etc.)
  return apiResponse;
}
