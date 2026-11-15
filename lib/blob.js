// Private Vercel Blob storage for recordings, question audio and upload parts.
const { put, get, head, del, list, issueSignedToken, presignUrl } = require('@vercel/blob');

async function write(pathname, body, contentType) {
  await put(pathname, body, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
  });
}

// Returns a Buffer, or null when the blob does not exist.
async function read(pathname, { fresh = false } = {}) {
  const r = await get(pathname, { access: 'private', useCache: !fresh });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

async function stream(pathname) {
  const r = await get(pathname, { access: 'private' });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return r;
}

async function exists(pathname) {
  try {
    await head(pathname);
    return true;
  } catch {
    return false;
  }
}

async function listPrefix(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function removePrefix(prefix) {
  const blobs = await listPrefix(prefix);
  for (let i = 0; i < blobs.length; i += 100) {
    await del(blobs.slice(i, i + 100).map(b => b.url));
  }
  return blobs.length;
}

// Short-lived browser URL for a private recording (no proxying of big files).
const signedUrls = new Map(); // pathname -> { url, until }
async function signedReadUrl(pathname, seconds = 3600) {
  const hit = signedUrls.get(pathname);
  if (hit && hit.until > Date.now() + 5 * 60 * 1000) return hit.url;
  const until = Date.now() + seconds * 1000;
  const token = await issueSignedToken({ operations: ['get'], pathname, validUntil: until });
  const { presignedUrl } = await presignUrl(token, { operation: 'get', access: 'private', pathname, validUntil: until });
  if (signedUrls.size > 500) signedUrls.clear();
  signedUrls.set(pathname, { url: presignedUrl, until });
  return presignedUrl;
}

module.exports = { write, read, stream, exists, listPrefix, removePrefix, signedReadUrl };
