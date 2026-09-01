/**
 * In-process TTL cache. The dev account is capped at 10,000 calls/day, and the
 * country list is effectively static, so caching is not an optimisation here —
 * it's what keeps the quota from being burned by page views.
 *
 * Single process only. If this ever runs behind more than one node, move to Redis
 * or a Supabase table; the interface stays the same.
 */
const store = new Map();

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export async function cached(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit !== undefined) return { value: hit, fromCache: true };
  const value = await producer();
  cacheSet(key, value, ttlMs);
  return { value, fromCache: false };
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const entry of store.values()) if (entry.expiresAt > now) live += 1;
  return { entries: store.size, live };
}

export function cacheClear(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}
