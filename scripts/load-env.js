// Loads .env / .env.local from the project root for local scripts.
const fs = require('fs');
const path = require('path');

for (const f of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Some mobile networks (e.g. Jio) don't resolve *.neon.tech. For local scripts,
// resolve hostnames with public DNS when the system resolver fails.
try {
  const dns = require('dns');
  const { Agent, setGlobalDispatcher } = require('undici');
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const lookup = (hostname, options, cb) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (!err) return cb(null, address, family);
      resolver.resolve4(hostname, (err2, addrs) => {
        if (err2 || !addrs.length) return cb(err);
        if (options && options.all) return cb(null, addrs.map(a => ({ address: a, family: 4 })));
        cb(null, addrs[0], 4);
      });
    });
  };
  setGlobalDispatcher(new Agent({ connect: { lookup } }));
} catch {
  // undici not installed: use the system resolver
}
