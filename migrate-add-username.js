// migrate-add-username.js
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'db', 'messages.sqlite');
const db = new Database(dbPath);

try {
  const cols = db.prepare("PRAGMA table_info(messages);").all();
  console.log('Current columns:', cols.map(c => `${c.cid}:${c.name}:${c.type}`).join(', '));

  const hasUsername = cols.some(c => c.name === 'username');
  if (hasUsername) {
    console.log('username column already exists — nothing to do.');
    process.exit(0);
  }

  console.log('Adding username column...');
  db.prepare("ALTER TABLE messages ADD COLUMN username TEXT;").run();

  const colsAfter = db.prepare("PRAGMA table_info(messages);").all();
  console.log('Columns after change:', colsAfter.map(c => `${c.cid}:${c.name}:${c.type}`).join(', '));
  console.log('Migration complete — please restart your server (node server.js).');
} catch (err) {
  console.error('Migration error:', err.message);
  process.exit(2);
} finally {
  db.close();
}