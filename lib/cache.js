// Size-capped in-memory caches and rate limiters, so random queries can't grow memory without bound.

/** Map of key -> { at, data } that drops the oldest entries past `max` and treats entries older than ttl as missing. */
export class BoundedCache {
  constructor(max, ttl = Infinity) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
  }

  get(key, ttl = this.ttl) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= ttl) {
      this.map.delete(key);
      return undefined;
    }
    return hit.data;
  }

  set(key, data) {
    this.map.delete(key); // re-insert so the key counts as newest
    this.map.set(key, { at: Date.now(), data });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return data;
  }

  delete(key) {
    this.map.delete(key);
  }
}

/** Sliding-window limiter: allow(key) is true at most `limit` times per `windowMs` for each key. */
export class RateLimiter {
  constructor(limit, windowMs, maxKeys = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new BoundedCache(maxKeys, windowMs);
  }

  allow(key = '') {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
