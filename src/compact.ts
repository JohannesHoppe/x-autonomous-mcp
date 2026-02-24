export interface CompactTweet {
  id: string;
  text: string;
  author: string;
  author_followers: number;
  author_follower_ratio: number;
  likes: number;
  retweets: number;
  replies: number;
  replied_to_id: string | null;
  created_at: string;
}

export interface CompactUser {
  id: string;
  username: string;
  name: string;
  followers: number;
  following: number;
  tweets: number;
  bio: string;
}

interface TweetLike {
  id?: string;
  text?: string;
  note_tweet?: { text?: string };
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

function findAuthor(authorId: string | undefined, users: UserLike[]): UserLike | undefined {
  if (!authorId) return undefined;
  return users.find((u) => u.id === authorId);
}

function followerRatio(followers: number, following: number): number {
  if (following <= 0) return followers; // follows nobody → ratio is effectively the follower count
  return Math.round((followers / following) * 10) / 10;
}

export function compactTweet(tweet: TweetLike, users: UserLike[]): CompactTweet {
  const metrics = tweet.public_metrics;
  const repliedTo = tweet.referenced_tweets?.find((r) => r.type === "replied_to");
  const author = findAuthor(tweet.author_id, users);
  const authorFollowers = author?.public_metrics?.followers_count ?? 0;
  const authorFollowing = author?.public_metrics?.following_count ?? 0;

  return {
    id: tweet.id ?? "",
    text: tweet.note_tweet?.text ?? tweet.text ?? "",
    author: author?.username ? `@${author.username}` : (tweet.author_id ?? "unknown"),
    author_followers: authorFollowers,
    author_follower_ratio: author ? followerRatio(authorFollowers, authorFollowing) : 0,
    likes: metrics?.like_count ?? 0,
    retweets: metrics?.retweet_count ?? 0,
    replies: metrics?.reply_count ?? 0,
    replied_to_id: repliedTo?.id ?? null,
    created_at: tweet.created_at ?? "",
  };
}

export function compactUser(user: UserLike): CompactUser {
  const metrics = user.public_metrics;
  return {
    id: user.id ?? "",
    username: user.username ?? "",
    name: user.name ?? "",
    followers: metrics?.followers_count ?? 0,
    following: metrics?.following_count ?? 0,
    tweets: metrics?.tweet_count ?? 0,
    bio: user.description ?? "",
  };
}

function compactMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  // Keep result_count and next_token, drop redundant newest_id/oldest_id
  const result: Record<string, unknown> = {};
  if (m.result_count !== undefined) result.result_count = m.result_count;
  if (m.next_token) result.next_token = m.next_token;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function compactResponse(apiResponse: unknown): unknown {
  if (!apiResponse || typeof apiResponse !== "object") return apiResponse;

  const resp = apiResponse as Record<string, unknown>;
  const data = resp.data;
  const includes = resp.includes as Record<string, unknown[]> | undefined;
  const meta = compactMeta(resp.meta);
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
