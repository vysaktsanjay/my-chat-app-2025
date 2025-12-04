// server.js
// Secure Chat server (Express + Socket.IO + SQLite + Uploads)
// Requires: express, socket.io, multer, uuid, better-sqlite3

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

// Use Render / environment port; fallback is only for local dev
const PORT = parseInt(process.env.PORT, 10) || 10080;

// Multer setup for HTTP uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path
      .basename(file.originalname || 'file', ext)
      .replace(/[^a-z0-9\-_]/gi, '_')
      .slice(0, 80); // avoid excessively long names
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}-${base}${ext}`);
  }
});
const upload = multer({ storage });

// --- Express + HTTP server ---
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve uploads and public files
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

// Basic upload endpoint (multipart/form-data, field name: "file")
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Return URL that client can use (relative)
  return res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname });
});

// Serve index.html
app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(404).send('Index not found');
});

const server = http.createServer(app);

// --- Socket.IO (permissive CORS for dev; tighten in prod) ---
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  path: '/socket.io'
});

// --- SQLite DB setup ---
const DB_DIR = path.join(APP_ROOT, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'messages.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create messages table if missing
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
  return rows.reverse(); // oldest -> newest
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

  socket.on('join-room', ({ roomId, username }) => {
    try {
