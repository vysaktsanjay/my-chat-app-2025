// server.js
// Complete Secure Chat server (Express + Socket.IO + SQLite + Uploads)
// Drop into project root. Requires: express, socket.io, multer, uuid, better-sqlite3

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

// --- Config ---
const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PORT = process.env.PORT || 3001;

// Multer setup for HTTP uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9\-_]/gi, '_');
    cb(null, `${Date.now()}-${uuidv4()}-${base}${ext}`);
  }
});
const upload = multer({ storage });

// --- Express + HTTP server ---
const app = express();
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

// Basic upload endpoint (multipart/form-data, field name: file)
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname });
});

// Serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = http.createServer(app);

// --- Socket.IO with permissive CORS (change for production) ---
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
});

// --- SQLite DB setup ---
const DB_DIR = path.join(APP_ROOT, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'messages.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create messages table if missing. Schema includes the columns server expects.
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  username TEXT,
  content TEXT,
  type TEXT,
  filename TEXT,
  mime TEXT,
  created_at INTEGER
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);`);

// Helper: store a message object into DB
function storeMessage(msg) {
  const stmt = db.prepare(`
    INSERT INTO messages (id, room_id, username, content, type, filename, mime, created_at)
    VALUES (@id, @room_id, @username, @content, @type, @filename, @mime, @created_at)
  `);
  return stmt.run({
    id: msg.id,
    room_id: msg.room_id,
    username: msg.username,
    content: msg.content,
    type: msg.type || 'text',
    filename: msg.filename || null,
    mime: msg.mime || null,
    created_at: msg.created_at || Date.now()
  });
}

// Helper: get recent messages for a room (limit)
function getRecentMessages(roomId, limit = 50) {
  const stmt = db.prepare(`
    SELECT id, room_id, username, content, type, filename, mime, created_at
    FROM messages
    WHERE room_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(roomId, limit);
  // return oldest -> newest (reverse)
  return rows.reverse();
}

// --- In-memory participants tracking ---
const rooms = {}; // { roomId: Set(username) }

function addParticipant(roomId, username) {
  rooms[roomId] = rooms[roomId] || new Set();
  rooms[roomId].add(username);
}
function removeParticipant(roomId, username) {
  if (!rooms[roomId]) return;
  rooms[roomId].delete(username);
  if (rooms[roomId].size === 0) delete rooms[roomId];
}
function listParticipants(roomId) {
  return rooms[roomId] ? Array.from(rooms[roomId]) : [];
}

// --- Socket.IO logic ---
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  socket.data.username = null;
  socket.data.roomId = null;

  // Client uses 'join-room' (we matched the client earlier)
  socket.on('join-room', ({ roomId, username }) => {
    try {
      // If no roomId provided, create one
      if (!roomId) roomId = 'room-' + Math.random().toString(36).slice(2, 9).toUpperCase();
      const name = (username && String(username)) || 'Anonymous';

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = name;

      addParticipant(roomId, name);
      const participants = listParticipants(roomId);

      // Confirm to joining client
      socket.emit('joined', { roomId, participants });

      // Notify others
      socket.to(roomId).emit('user-joined', { username: name, participants });

      // Send recent message history to the joining client only (last 50)
      const history = getRecentMessages(roomId, 50);
      if (history && history.length) {
        // Send each historic message as 'chat-message' so client UI can render consistently
        history.forEach(m => {
          socket.emit('chat-message', {
            id: m.id,
            username: m.username,
            text: m.content,
            timestamp: m.created_at,
            type: m.type,
            filename: m.filename,
            mime: m.mime
          });
        });
      }

      console.log(`${name} joined ${roomId} (participants: ${participants.length})`);
    } catch (err) {
      console.error('join-room error:', err);
      socket.emit('error-message', { message: 'join-room failed: ' + String(err.message || err) });
    }
  });

  // Client uses 'chat-message' or 'message' — support both by mapping
  socket.on('chat-message', (payload, ack) => {
    // We still support an ack callback from client if provided
    // Normalize payload
    const msg = payload || {};
    // Delegates to shared handler
    handleIncomingMessage(socket, msg, ack);
  });
  socket.on('message', (payload, ack) => {
    const msg = payload || {};
    handleIncomingMessage(socket, msg, ack);
  });

  function handleIncomingMessage(socket, msg, ack) {
    try {
      const roomId = msg.roomId || socket.data.roomId;
      const text = (msg.text || '').toString().trim();
      const username = msg.username || socket.data.username || 'Anonymous';

      if (!roomId || !text) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Invalid payload' });
        return;
      }

      // Build canonical message object with unique id BEFORE storing
      const messageData = {
        id: 'msg-' + uuidv4(),
        room_id: roomId,
        username,
        content: text,
        type: msg.type || 'text',
        filename: msg.filename || null,
        mime: msg.mime || null,
        created_at: Date.now()
      };

      // Store in DB (atomic)
      try {
        storeMessage(messageData);
      } catch (dbErr) {
        // If unique constraint or other DB error happens, log and ack error
        console.error('DB store error:', dbErr);
        if (typeof ack === 'function') ack({ ok: false, error: String(dbErr.message || dbErr) });
        socket.emit('error-message', { message: 'Store failed: ' + String(dbErr.message || dbErr) });
        return;
      }

      // Emit canonical stored message to everyone in the room (including sender)
      io.to(roomId).emit('chat-message', {
        id: messageData.id,
        username: messageData.username,
        text: messageData.content,
        timestamp: messageData.created_at,
        type: messageData.type,
        filename: messageData.filename,
        mime: messageData.mime
      });

      if (typeof ack === 'function') ack({ ok: true, id: messageData.id });

      console.log(`Stored & emitted message [${messageData.id}] in ${roomId} from ${username}`);
    } catch (err) {
      console.error('handleIncomingMessage error:', err);
      if (typeof ack === 'function') ack({ ok: false, error: String(err.message || err) });
      socket.emit('error-message', { message: 'Send failed: ' + String(err.message || err) });
    }
  }

  // Typing indicators
  socket.on('typing', ({ roomId }) => {
    const r = roomId || socket.data.roomId;
    const username = socket.data.username || 'Someone';
    if (r) socket.to(r).emit('typing', { username });
  });

  socket.on('stop-typing', ({ roomId }) => {
    const r = roomId || socket.data.roomId;
    const username = socket.data.username || 'Someone';
    if (r) socket.to(r).emit('stop-typing', { username });
  });

  // End session (client requested leave)
  socket.on('end-session', ({ roomId, username }) => {
    try {
      const r = roomId || socket.data.roomId;
      const name = username || socket.data.username;
      if (r && name) {
        socket.leave(r);
        removeParticipant(r, name);
        const participants = listParticipants(r);
        io.to(r).emit('participants', { participants });
        io.to(r).emit('user-left', { username: name, participants });
        console.log(`end-session: ${name} left ${r}`);
      }
    } catch (err) {
      console.error('end-session error:', err);
    }
  });

  // Socket file event (in case client sends file metadata over socket)
  socket.on('file', (fileMsg) => {
    try {
      const roomId = fileMsg.roomId || socket.data.roomId;
      const username = fileMsg.username || socket.data.username || 'Anonymous';
      if (!roomId || !fileMsg.url) {
        socket.emit('error-message', { message: 'Invalid file payload' });
        return;
      }

      const fileData = {
        id: 'file-' + uuidv4(),
        room_id: roomId,
        username,
        content: JSON.stringify({ url: fileMsg.url, filename: fileMsg.filename }),
        type: 'file',
        filename: fileMsg.filename || null,
        mime: fileMsg.mime || null,
        created_at: Date.now()
      };

      storeMessage({
        id: fileData.id,
        room_id: fileData.room_id,
        username: fileData.username,
        content: fileMsg.url,
        type: 'file',
        filename: fileData.filename,
        mime: fileData.mime,
        created_at: fileData.created_at
      });

      io.to(roomId).emit('file', {
        id: fileData.id,
        username: fileData.username,
        url: fileMsg.url,
        filename: fileMsg.filename,
        ts: fileData.created_at
      });

      console.log(`File message stored & emitted in ${roomId} by ${username}: ${fileMsg.filename || fileMsg.url}`);
    } catch (err) {
      console.error('file handler error:', err);
      socket.emit('error-message', { message: 'File send failed: ' + String(err.message || err) });
    }
  });

  // Handle when socket is leaving rooms (disconnecting)
  socket.on('disconnecting', () => {
    const name = socket.data.username;
    for (const r of socket.rooms) {
      if (r === socket.id) continue; // skip own socket room
      removeParticipant(r, name);
      const participants = listParticipants(r);
      socket.to(r).emit('user-left', { username: name, participants });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', socket.id, 'reason:', reason);
  });
});

// --- Start server ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server running on port ${PORT}`);
});