'use strict';
// Simple manual/scheduled backup: copies data/lms.sqlite to
// data/backups/lms-<timestamp>.sqlite. Run with `node backup-db.js`.
// Keeps the most recent 30 backups and prunes older ones automatically.

const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'data', 'lms.sqlite');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const KEEP = 30;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database found at ${DB_PATH} — nothing to back up.`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `lms-${timestamp()}.sqlite`);
  fs.copyFileSync(DB_PATH, dest);
  console.log(`Backed up database to ${dest}`);

  // Prune old backups, keeping the most recent KEEP files.
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('lms-') && f.endsWith('.sqlite'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(KEEP).forEach(({ f }) => {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`Pruned old backup ${f}`);
  });
}

main();
