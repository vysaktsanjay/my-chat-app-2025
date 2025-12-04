// migrate-add-roomid.js
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'db', 'messages.sqlite'); // adjust only if your DB path differs
const db = new Database(dbPath);

try {
  const cols = db.prepare("PRAGMA table_info(messages);").all();
  console.log('Current columns:', cols.map(c => `${c.cid}:${c.name}:${c.type}`).join(', '));

  const hasRoomId = cols.some(c => c.name === 'room_id');
  if (hasRoomId) {
    console.log('room_id column already exists — nothing to do.');
    process.exit(0);
  }

  console.log('Adding room_id column...');
  db.prepare("ALTER TABLE messages ADD COLUMN room_id TEXT;").run();

  const colsAfter = db.prepare("PRAGMA table_info(messages);").all();
  console.log('Columns after change:', colsAfter.map(c => `${c.cid}:${c.name}:${c.type}`).join(', '));
  console.log('Migration complete — please restart your server (node server.js).');
} catch (err) {
  console.error('Migration error:', err.message);
  process.exit(2);
} finally {
  db.close();
}