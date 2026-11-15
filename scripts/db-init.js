// Creates the database tables (safe to run many times).
//   vercel env pull .env.local && npm run db:init
require('./load-env');
const { ensureSchema } = require('../lib/db');

ensureSchema()
  .then(() => console.log('database ready'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
