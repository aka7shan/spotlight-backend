/**
 * Thin Redis cache wrapper used as a hot path in front of public
 * portfolio lookups. Backed by Upstash Redis when
 * `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are configured;
 * silently no-ops otherwise (every `get` misses, every `set` is a
 * no-op) so local dev and unconfigured prod deployments fall back to a
 * direct DB hit instead of crashing.
 *
 * Why a wrapper?
 * --------------
 * Two reasons:
 *   1. The no-op fallback keeps the rest of the codebase ignorant of
 *      whether caching is enabled. Routes call `cache.get`/`cache.set`
 *      unconditionally; only the wrapper knows whether a real client
 *      exists.
 *   2. We isolate the cache contract (`get/set/del`, JSON-serialized
 *      values, TTL in seconds) from the Upstash client surface. If we
 *      ever swap Upstash for ioredis, Vercel KV, or an in-process
 *      LRU, only this file changes.
 *
 * Cache keys & TTLs
 * -----------------
 * Cache keys are namespaced with a short prefix (e.g. `code:`) so
 * different lookups can share the same Redis database without
 * colliding. TTLs are passed by the caller — the default for
 * short-code lookups is 60s (see `routes/short.ts`), short enough that
 * a stale entry self-heals within a minute while still absorbing the
 * 99% case of a popular profile being viewed dozens of times in quick
 * succession.
 *
 * Errors are swallowed
 * --------------------
 * Cache hits/misses must never break the request. Redis is best-effort
 * — if Upstash is rate-limiting us, has a partial outage, or is just
 * slow, we log and fall back to the DB. The application contract is
 * "the cache is a performance optimization", not "the cache is a
 * source of truth".
 */

import { Redis } from '@upstash/redis';

import { env } from '../env.js';

export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Whether the cache is actually backed by a real client. Useful for
   * logging and for the `/health` endpoint to surface backing-service
   * status. Don't gate logic on this — call get/set/del normally and
   * let the no-op implementation handle the unconfigured case.
   */
  readonly enabled: boolean;
}

class NoopCache implements CacheClient {
  readonly enabled = false;

  async get<T>(_key: string): Promise<T | null> {
    return null;
  }

  async set<T>(_key: string, _value: T, _ttl: number): Promise<void> {
    /* no-op */
  }

  async del(_key: string): Promise<void> {
    /* no-op */
  }
}

class UpstashCache implements CacheClient {
  readonly enabled = true;
  private readonly client: Redis;

  constructor(url: string, token: string) {
    this.client = new Redis({ url, token });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      // Upstash auto-parses JSON on read because we always set with
      // JSON-serialized values, so the returned type is already the
      // structured object/array/primitive. We narrow back to T at the
      // call site.
      const value = await this.client.get<T>(key);
      return value ?? null;
    } catch (err) {
      // Treat any cache error as a miss. The caller will hit the DB
      // and (try to) repopulate on the next request.
      console.warn('[cache] get failed', { key, err });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      // `ex` = expire in seconds. We always set a TTL so a poisoned
      // entry self-heals within the window even if we forget to
      // explicitly invalidate.
      await this.client.set(key, value, { ex: ttlSeconds });
    } catch (err) {
      // Cache write failures are entirely best-effort; we already
      // have the data we'd be caching in hand, so the response can
      // proceed without it.
      console.warn('[cache] set failed', { key, err });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      // A failed delete leaves a stale entry, which is bounded by TTL
      // — annoying but not corrupting. Log and move on.
      console.warn('[cache] del failed', { key, err });
    }
  }
}

/**
 * Module-level singleton. We construct lazily on first access so that
 * pulling in `cache.ts` during typecheck or in scripts that don't
 * actually use Redis doesn't try to connect or fail loudly.
 */
let _cache: CacheClient | undefined;

export function getCache(): CacheClient {
  if (_cache) return _cache;

  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    _cache = new UpstashCache(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  } else {
    _cache = new NoopCache();
  }

  return _cache;
}

/**
 * Cache-key helpers. Centralized so different routes can't drift on
 * formatting (e.g. one writing `code:abc` and another reading
 * `shortcode-abc` and never hitting cache).
 */
export const cacheKeys = {
  /** Public portfolio lookup by short code → assembled user JSON. */
  shortCode: (code: string) => `code:${code}`,
} as const;
