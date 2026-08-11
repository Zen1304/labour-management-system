'use strict';
const http = require('node:http');

// db.js falls back to a local Postgres connection string when DATABASE_URL
// is unset, which is convenient for local dev/testing — but that fallback
// would silently point a real deployment at nothing useful, so warn loudly
// rather than let a missing env var surface later as a cryptic connection
// error deep in some route handler.
if (!process.env.DATABASE_URL) {
  console.warn(
    'WARNING: DATABASE_URL is not set. Falling back to a local Postgres ' +
      'default (postgresql://postgres:postgres@localhost:5432/lms_test). ' +
      'Set DATABASE_URL (e.g. your Neon connection string) before deploying.'
  );
}

const { ready } = require('./src/db');
const { handleRequest } = require('./src/app');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

ready
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Labour Management System running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start: database initialization failed.', err);
    process.exit(1);
  });
