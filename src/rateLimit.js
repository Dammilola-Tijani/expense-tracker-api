// Fixed-window, in-memory rate limiter. Keyed by client IP by default, or by any
// string returned from `key(req)` (used to limit login attempts per account).
// Good enough for a single process; several instances would need a shared store (e.g. Redis).
export function rateLimit({ max, windowMs, key = (req) => req.ip }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Periodically drop expired entries so the map can't grow forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (h.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(k, h);
    }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    next();
  };
}
