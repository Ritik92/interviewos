// Small, short-lived values (device heartbeat, live interview state, test lookups).
// Uses the Vercel Runtime Cache so the database can sleep while the Pi is idle.
// Falls back to process memory when running locally.
const mem = new Map();

function runtimeCache() {
  if (!process.env.VERCEL) return null;
  try {
    const { getCache } = require('@vercel/functions');
    return getCache({ namespace: 'ios' });
  } catch {
    return null;
  }
}

async function get(key) {
  const rc = runtimeCache();
  if (rc) {
    try {
      return await rc.get(key);
    } catch (err) {
      console.error('[cache] get failed:', err.message);
    }
  }
  const hit = mem.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return hit.value;
}

async function set(key, value, ttlSeconds) {
  mem.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
  const rc = runtimeCache();
  if (rc) {
    try {
      await rc.set(key, value, { ttl: ttlSeconds });
    } catch (err) {
      console.error('[cache] set failed:', err.message);
    }
  }
}

async function del(key) {
  mem.delete(key);
  const rc = runtimeCache();
  if (rc) {
    try {
      await rc.delete(key);
    } catch (err) {
      console.error('[cache] delete failed:', err.message);
    }
  }
}

module.exports = { get, set, del };
