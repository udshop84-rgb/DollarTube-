const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dollartube.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}
initSchema();

// Run `node db.js --init` to (re)create the schema without starting the server.
if (require.main === module && process.argv.includes('--init')) {
  console.log(`Schema applied to ${DB_PATH}`);
  process.exit(0);
}

module.exports = db;
