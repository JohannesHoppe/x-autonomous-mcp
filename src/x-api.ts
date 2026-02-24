import crypto from "crypto";
import OAuth from "oauth-1.0a";

const DEFAULT_API_BASE = "https://api.x.com/2";
const UPLOAD_BASE = "https://upload.twitter.com/1.1";

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

interface XApiResponse<T = unknown> {
  data?: T;
  meta?: {
    result_count?: number;
    next_token?: string;
    previous_token?: string;
  };
  includes?: Record<string, unknown[]>;
  errors?: Array<{ message: string; title?: string; detail?: string; type?: string }>;
}

export interface XApiConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  bearerToken: string;
  apiBase?: string; // default: "https://api.x.com/2"
}

export class XApiClient {
  private oauth: OAuth;
  private token: OAuth.Token;
  private bearerToken: string;
  private apiBase: string;
  private authenticatedUserIdPromise: Promise<string> | null = null;

  constructor(private config: XApiConfig) {
    this.apiBase = config.apiBase ?? DEFAULT_API_BASE;
    this.oauth = new OAuth({
      consumer: { key: config.apiKey, secret: config.apiSecret },
      signature_method: "HMAC-SHA1",
      hash_function(baseString, key) {
        return crypto.createHmac("sha1", key).update(baseString).digest("base64");
      },
    });
    this.token = { key: config.accessToken, secret: config.accessTokenSecret };
    this.bearerToken = config.bearerToken;
  }

  // --- Internal helpers ---

  private parseRateLimit(headers: Headers): RateLimitInfo | null {
    const limit = headers.get("x-rate-limit-limit");
    const remaining = headers.get("x-rate-limit-remaining");
    const reset = headers.get("x-rate-limit-reset");
    if (limit && remaining && reset) {
      return {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
      };
    }
    return null;
  }

  private formatRateLimit(rl: RateLimitInfo): string {
    const resetDate = new Date(rl.reset * 1000);
    const secondsUntilReset = Math.max(0, Math.ceil((rl.reset * 1000 - Date.now()) / 1000));
    return `Rate limit: ${rl.remaining}/${rl.limit} remaining. Resets at ${resetDate.toISOString()} (${secondsUntilReset}s)`;
  }

  private async oauthFetch(
    url: string,
    method: string,
    body?: unknown,
    contentType?: string,
  ): Promise<Response> {
    const requestData = { url, method };
    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, this.token));

    const headers: Record<string, string> = {
      Authorization: authHeader.Authorization,
    };
    if (contentType) {
      headers["Content-Type"] = contentType;
    } else if (body && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const init: RequestInit = { method, headers };
    if (body) {
      if (body instanceof FormData) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
      }
    }

    return fetch(url, init);
  }

  private async bearerFetch(url: string): Promise<Response> {
    return fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
      },
    });
  }

  private async handleResponse<T>(response: Response, operation: string): Promise<{ result: T; rateLimit: string }> {
    const rateLimit = this.parseRateLimit(response.headers);
    const rateLimitStr = rateLimit ? this.formatRateLimit(rateLimit) : "";

    if (response.status === 429) {
      const resetTime = rateLimit
        ? new Date(rateLimit.reset * 1000).toISOString()
        : "unknown";
      throw new Error(
        `Rate limited on ${operation}. Reset at: ${resetTime}. ${rateLimitStr}`,
      );
    }

    const text = await response.text();
    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `${operation} failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
      );
    }

    if (!response.ok) {
      const errorBody = data as unknown as XApiResponse;
      const errorMsg = (Array.isArray(errorBody.errors)
        ? errorBody.errors.map((e) => e.detail || e.message).join("; ")
        : "") || text.slice(0, 500);
      throw new Error(
        `${operation} failed (HTTP ${response.status}): ${errorMsg}. ${rateLimitStr}`,
      );
    }

    return { result: data, rateLimit: rateLimitStr };
  }

  async getAuthenticatedUserId(): Promise<string> {
    if (!this.authenticatedUserIdPromise) {
      this.authenticatedUserIdPromise = this.fetchAuthenticatedUserId();
    }
    return this.authenticatedUserIdPromise;
  }

  private async fetchAuthenticatedUserId(): Promise<string> {
    const url = `${this.apiBase}/users/me`;
    const response = await this.oauthFetch(url, "GET");
    const { result } = await this.handleResponse<XApiResponse<{ id: string }>>(response, "getAuthenticatedUser");
    if (!result.data?.id) {
      throw new Error("getAuthenticatedUser: API returned no user data");
    }
    return result.data.id;
  }

  // --- User ID resolution ---

  async resolveUserId(userRef: string): Promise<string> {
    // If it's all digits, it's already a numeric ID
    if (/^\d+$/.test(userRef)) return userRef;
    // Strip leading @ if present
    const username = userRef.replace(/^@/, "");
    const { result } = await this.getUser({ username });
    const data = result as { data?: { id?: string } };
    if (!data.data?.id) {
      throw new Error(`User '${username}' not found`);
    }
    return data.data.id;
  }

  // --- Tweet operations ---

  async postTweet(params: {
    text: string;
    reply_to?: string;
    quote_tweet_id?: string;
    poll_options?: string[];
    poll_duration_minutes?: number;
    media_ids?: string[];
  }) {
    const body: Record<string, unknown> = { text: params.text };

    if (params.reply_to) {
      body.reply = { in_reply_to_tweet_id: params.reply_to };
    }
    if (params.quote_tweet_id) {
      body.quote_tweet_id = params.quote_tweet_id;
    }
    if (params.poll_options && params.poll_options.length > 0) {
      body.poll = {
        options: params.poll_options,
        duration_minutes: params.poll_duration_minutes || 1440,
      };
    }
    if (params.media_ids && params.media_ids.length > 0) {
      body.media = { media_ids: params.media_ids };
    }

    const response = await this.oauthFetch(`${this.apiBase}/tweets`, "POST", body);
    return this.handleResponse(response, "postTweet");
  }

  async deleteTweet(tweetId: string) {
    const response = await this.oauthFetch(`${this.apiBase}/tweets/${tweetId}`, "DELETE");
    return this.handleResponse(response, "deleteTweet");
  }

  async getTweet(tweetId: string) {
    const params = new URLSearchParams({
      "tweet.fields": "created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,entities,lang",
      expansions: "author_id",
      "user.fields": "name,username,verified,public_metrics",
    });
    const url = `${this.apiBase}/tweets/${tweetId}?${params}`;
    const response = await this.bearerFetch(url);
    return this.handleResponse(response, "getTweet");
  }

  async searchTweets(
    query: string,
    maxResults: number = 10,
    nextToken?: string,
    filters?: { minLikes?: number; minRetweets?: number; sortOrder?: string; sinceId?: string },
  ) {
    const hasEngagementFilters = filters && (filters.minLikes || filters.minRetweets);
    // When filtering by engagement, fetch max results to have enough after filtering
    const fetchCount = hasEngagementFilters ? 100 : Math.min(Math.max(maxResults, 10), 100);

    const params = new URLSearchParams({
      query,
      max_results: fetchCount.toString(),
      "tweet.fields": "created_at,public_metrics,author_id,conversation_id,entities,lang",
      expansions: "author_id",
      "user.fields": "name,username,verified,public_metrics",
    });
    if (nextToken) params.set("next_token", nextToken);
    if (filters?.sortOrder) params.set("sort_order", filters.sortOrder);
    if (filters?.sinceId) params.set("since_id", filters.sinceId);

    const url = `${this.apiBase}/tweets/search/recent?${params}`;
    const response = await this.bearerFetch(url);
    const { result, rateLimit } = await this.handleResponse<XApiResponse>(response, "searchTweets");

    // Apply engagement filters client-side
    if (hasEngagementFilters && result.data && Array.isArray(result.data)) {
      const minLikes = filters!.minLikes || 0;
      const minRetweets = filters!.minRetweets || 0;

      const filtered = (result.data as Array<Record<string, unknown>>).filter((tweet) => {
        const metrics = tweet.public_metrics as { like_count?: number; retweet_count?: number } | undefined;
        if (!metrics) return false;
        return (metrics.like_count || 0) >= minLikes && (metrics.retweet_count || 0) >= minRetweets;
      });

      // Trim to requested count
      const trimmed = filtered.slice(0, Math.min(Math.max(maxResults, 10), 100));

      // Filter includes.users to only keep authors of surviving tweets
      const authorIds = new Set(trimmed.map((t) => t.author_id));
      if (result.includes && Array.isArray((result.includes as Record<string, unknown[]>).users)) {
        (result.includes as Record<string, unknown[]>).users = (
          (result.includes as Record<string, unknown[]>).users as Array<Record<string, unknown>>
        ).filter((u) => authorIds.has(u.id));
      }

      result.data = trimmed as typeof result.data;
      if (result.meta) {
        result.meta.result_count = trimmed.length;
      }
    }

    return { result, rateLimit };
  }

  // --- User operations ---

  async getUser(params: { username?: string; userId?: string }) {
    const fields = new URLSearchParams({
      "user.fields": "created_at,description,public_metrics,verified,url,location,pinned_tweet_id",
    });

    let url: string;
    if (params.username) {
      url = `${this.apiBase}/users/by/username/${params.username}?${fields}`;
    } else if (params.userId) {
      url = `${this.apiBase}/users/${params.userId}?${fields}`;
    } else {
      throw new Error("Either username or userId must be provided");
    }

    const response = await this.bearerFetch(url);
    return this.handleResponse(response, "getUser");
  }

  async getTimeline(userId: string, maxResults: number = 10, nextToken?: string) {
    const params = new URLSearchParams({
      max_results: Math.min(Math.max(maxResults, 5), 100).toString(),
      "tweet.fields": "created_at,public_metrics,author_id,conversation_id,entities,lang",
      expansions: "author_id",
      "user.fields": "name,username,verified",
    });
    if (nextToken) params.set("pagination_token", nextToken);

    const url = `${this.apiBase}/users/${userId}/tweets?${params}`;
    const response = await this.bearerFetch(url);
    return this.handleResponse(response, "getTimeline");
  }

  async getMentions(maxResults: number = 10, nextToken?: string, sinceId?: string) {
    const userId = await this.getAuthenticatedUserId();
    const params = new URLSearchParams({
      max_results: Math.min(Math.max(maxResults, 5), 100).toString(),
      "tweet.fields": "created_at,public_metrics,author_id,conversation_id",
      expansions: "author_id",
      "user.fields": "name,username,verified",
    });
    if (nextToken) params.set("pagination_token", nextToken);
    if (sinceId) params.set("since_id", sinceId);

    const url = `${this.apiBase}/users/${userId}/mentions?${params}`;
    const response = await this.oauthFetch(url, "GET");
    return this.handleResponse(response, "getMentions");
  }

  async getFollowers(userId: string, maxResults: number = 100, nextToken?: string) {
    const params = new URLSearchParams({
      max_results: Math.min(Math.max(maxResults, 1), 1000).toString(),
      "user.fields": "created_at,description,public_metrics,verified",
    });
    if (nextToken) params.set("pagination_token", nextToken);

    const url = `${this.apiBase}/users/${userId}/followers?${params}`;
    const response = await this.bearerFetch(url);
    return this.handleResponse(response, "getFollowers");
  }

  async getFollowing(userId: string, maxResults: number = 100, nextToken?: string) {
    const params = new URLSearchParams({
      max_results: Math.min(Math.max(maxResults, 1), 1000).toString(),
      "user.fields": "created_at,description,public_metrics,verified",
    });
    if (nextToken) params.set("pagination_token", nextToken);

    const url = `${this.apiBase}/users/${userId}/following?${params}`;
    const response = await this.bearerFetch(url);
    return this.handleResponse(response, "getFollowing");
  }

  // --- Follow operations ---

  async followUser(targetUserId: string) {
    const userId = await this.getAuthenticatedUserId();
    const response = await this.oauthFetch(`${this.apiBase}/users/${userId}/following`, "POST", {
      target_user_id: targetUserId,
    });
    return this.handleResponse(response, "followUser");
  }

  async unfollowUser(targetUserId: string) {
    const userId = await this.getAuthenticatedUserId();
    const response = await this.oauthFetch(
      `${this.apiBase}/users/${userId}/following/${targetUserId}`,
      "DELETE",
    );
    return this.handleResponse(response, "unfollowUser");
  }

  async getNonFollowers(maxPages: number = 5): Promise<{
    result: { data: Array<{ id: string; username: string; name: string; followers: number; following: number }>; total_following: number; total_followers: number; non_followers_count: number };
    rateLimit: string;
  }> {
    const userId = await this.getAuthenticatedUserId();
    let lastRateLimit = "";

    // Fetch all following (paginated)
    const followingIds = new Set<string>();
    const followingUsers = new Map<string, { id: string; username: string; name: string; followers: number; following: number }>();
    let nextToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const { result, rateLimit } = await this.getFollowing(userId, 1000, nextToken);
      lastRateLimit = rateLimit;
      const resp = result as XApiResponse<Array<Record<string, unknown>>>;
      if (resp.data) {
        for (const user of resp.data) {
          const id = user.id as string;
          const metrics = user.public_metrics as { followers_count?: number; following_count?: number } | undefined;
          followingIds.add(id);
          followingUsers.set(id, {
            id,
            username: (user.username as string) ?? "",
            name: (user.name as string) ?? "",
            followers: metrics?.followers_count ?? 0,
            following: metrics?.following_count ?? 0,
          });
        }
      }
      nextToken = resp.meta?.next_token;
      if (!nextToken) break;
    }

    // Fetch all followers (paginated)
    const followerIds = new Set<string>();
    nextToken = undefined;
    for (let page = 0; page < maxPages; page++) {
      const { result, rateLimit } = await this.getFollowers(userId, 1000, nextToken);
      lastRateLimit = rateLimit;
      const resp = result as XApiResponse<Array<Record<string, unknown>>>;
      if (resp.data) {
        for (const user of resp.data) {
          followerIds.add(user.id as string);
        }
      }
      nextToken = resp.meta?.next_token;
      if (!nextToken) break;
    }

    // Set difference: following but not follower
    const nonFollowers: Array<{ id: string; username: string; name: string; followers: number; following: number }> = [];
    for (const id of followingIds) {
      if (!followerIds.has(id)) {
        const user = followingUsers.get(id)!;
        nonFollowers.push(user);
      }
    }

    // Sort by follower count ascending (lowest quality first)
    nonFollowers.sort((a, b) => a.followers - b.followers);

    return {
      result: {
        data: nonFollowers,
        total_following: followingIds.size,
        total_followers: followerIds.size,
        non_followers_count: nonFollowers.length,
      },
      rateLimit: lastRateLimit,
    };
  }

  // --- Engagement operations ---

  async likeTweet(tweetId: string) {
    const userId = await this.getAuthenticatedUserId();
    const response = await this.oauthFetch(`${this.apiBase}/users/${userId}/likes`, "POST", {
      tweet_id: tweetId,
    });
    return this.handleResponse(response, "likeTweet");
  }

  async retweet(tweetId: string) {
    const userId = await this.getAuthenticatedUserId();
    const response = await this.oauthFetch(`${this.apiBase}/users/${userId}/retweets`, "POST", {
      tweet_id: tweetId,
    });
    return this.handleResponse(response, "retweet");
  }

  // --- Media upload ---

  async uploadMedia(
    mediaData: string,
    mimeType: string,
    mediaCategory: string = "tweet_image",
  ) {
    const buffer = Buffer.from(mediaData, "base64");
    const totalBytes = buffer.length;

    // INIT
    const initForm = new URLSearchParams({
      command: "INIT",
      media_type: mimeType,
      total_bytes: totalBytes.toString(),
      media_category: mediaCategory,
    });
    const initRes = await fetch(`${UPLOAD_BASE}/media/upload.json`, {
      method: "POST",
      headers: {
        ...this.getOAuthHeaders(`${UPLOAD_BASE}/media/upload.json`, "POST"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: initForm.toString(),
    });
    const { result: initData } = await this.handleResponse<{ media_id_string: string }>(
      initRes,
      "uploadMedia:INIT",
    );
    const mediaId = initData.media_id_string;

    // APPEND -- upload in 1MB chunks
    const chunkSize = 1024 * 1024;
    for (let i = 0; i * chunkSize < totalBytes; i++) {
      const chunk = buffer.subarray(i * chunkSize, (i + 1) * chunkSize);
      const formData = new FormData();
      formData.append("command", "APPEND");
      formData.append("media_id", mediaId);
      formData.append("segment_index", i.toString());
      formData.append("media_data", chunk.toString("base64"));

      const appendRes = await fetch(`${UPLOAD_BASE}/media/upload.json`, {
        method: "POST",
        headers: this.getOAuthHeaders(`${UPLOAD_BASE}/media/upload.json`, "POST"),
        body: formData,
      });

      if (!appendRes.ok) {
        const text = await appendRes.text();
        throw new Error(`uploadMedia:APPEND segment ${i} failed (HTTP ${appendRes.status}): ${text}`);
      }
    }

    // FINALIZE
    const finalizeForm = new URLSearchParams({
      command: "FINALIZE",
      media_id: mediaId,
    });
    const finalizeRes = await fetch(`${UPLOAD_BASE}/media/upload.json`, {
      method: "POST",
      headers: {
        ...this.getOAuthHeaders(`${UPLOAD_BASE}/media/upload.json`, "POST"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: finalizeForm.toString(),
    });
    const finalizeResult = await this.handleResponse(finalizeRes, "uploadMedia:FINALIZE");

    return { mediaId, ...finalizeResult };
  }

  private getOAuthHeaders(url: string, method: string): Record<string, string> {
    const requestData = { url, method };
    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, this.token));
    return { Authorization: authHeader.Authorization };
  }

  // --- Metrics ---

  async getTweetMetrics(tweetId: string) {
    const params = new URLSearchParams({
      "tweet.fields": "public_metrics,non_public_metrics,organic_metrics",
    });
    const url = `${this.apiBase}/tweets/${tweetId}?${params}`;
    // Metrics require user context (OAuth 1.0a) for non_public_metrics
    const response = await this.oauthFetch(url, "GET");
    return this.handleResponse(response, "getTweetMetrics");
  }
}
