// public/app.js
(() => {
  console.info("Secure Chat client loaded...");

  // --- Socket.IO: connect to same origin on the correct path and force websocket transport
  const socket = io({
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    secure: location.protocol === 'https:'
  });

  // --- DOM elements (expected IDs in your index.html) ---
  const usernameInput = document.getElementById("usernameInput");
  const partnerInput = document.getElementById("partnerInput"); // optional
  const roomInput = document.getElementById("roomInput");
  // support both "joinBtn" and "joinRoomBtn" ids (robust)
  const joinBtn = document.getElementById("joinBtn") || document.getElementById("joinRoomBtn");
  const sendBtn = document.getElementById("sendBtn");
  const messageInput = document.getElementById("messageInput");
  const messagesDiv = document.getElementById("messages");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const endSessionBtn = document.getElementById("endSessionBtn");
  const participantsLabel = document.getElementById("participantsLabel"); // optional
  const typingIndicator = document.getElementById("typingIndicator"); // optional

  // We'll try multiple selectors for a Create button because templates vary
  const createBtn =
    document.getElementById("createBtn") ||
    document.getElementById("createRoomBtn") ||
    document.querySelector("[data-action='create-room']") ||
    null;

  // --- state ---
  let currentRoom = null;
  let myName = null;
  let lastSentAt = 0;
  const SEND_COOLDOWN_MS = 300;
  const MAX_MESSAGES = 300;
  const TYPING_DELAY = 900;
  let typingTimeout = null;

  // dedupe set for message ids from server
  const shownMessages = new Set();

  // --- helpers ---
  function nowIso() {
    return new Date().toLocaleString();
  }

  function pruneOldMessages() {
    while (messagesDiv && messagesDiv.children.length > MAX_MESSAGES) {
      messagesDiv.removeChild(messagesDiv.firstChild);
    }
  }

  function appendSystem(msg) {
    if (!messagesDiv) return;
    const d = document.createElement("div");
    d.className = "sys";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `[${nowIso()}] `;
    d.appendChild(ts);
    const txt = document.createElement("span");
    txt.textContent = msg;
    d.appendChild(txt);
    messagesDiv.appendChild(d);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    pruneOldMessages();
  }

  function appendMessage({ id = null, username = "Unknown", text = "", timestamp = nowIso(), me = false }) {
    if (!messagesDiv) return;

    // dedupe by server id (if provided)
    if (id) {
      if (shownMessages.has(id)) return;
      shownMessages.add(id);
    }

    const d = document.createElement("div");
    d.className = "msg" + (me ? " me" : "");
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `[${typeof timestamp === "number" ? new Date(timestamp).toLocaleString() : timestamp}] `;
    d.appendChild(ts);

    const who = document.createElement("strong");
    who.textContent = `${username}: `;
    d.appendChild(who);

    d.appendChild(document.createTextNode(text));
    messagesDiv.appendChild(d);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    pruneOldMessages();
  }

  function setControlsForJoined(joined) {
    if (joinBtn) joinBtn.disabled = joined;
    if (roomInput) roomInput.disabled = joined;
    if (usernameInput) usernameInput.disabled = joined;
    if (sendBtn) sendBtn.disabled = !joined;
    if (messageInput) messageInput.disabled = !joined;
    if (disconnectBtn) disconnectBtn.disabled = !joined;
    if (endSessionBtn) endSessionBtn.disabled = !joined;
    if (joined && messageInput) messageInput.focus();
  }

  function showParticipants(list) {
    if (!participantsLabel) return;
    participantsLabel.textContent = `Participants: ${list && list.length ? list.join(", ") : "—"}`;
  }

  function emitTyping() {
    if (!currentRoom) return;
    socket.emit("typing", { roomId: currentRoom, username: myName });
  }

  function emitStopTyping() {
    if (!currentRoom) return;
    socket.emit("stop-typing", { roomId: currentRoom, username: myName });
  }

  function scheduleStopTyping() {
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      emitStopTyping();
      typingTimeout = null;
    }, TYPING_DELAY);
  }

  function generateRoomId() {
    return "room-" + Math.random().toString(36).slice(2, 9).toUpperCase();
  }

  // --- create button wiring (robust) ---
  function wireCreateButton(btn) {
    if (!btn) return;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const rid = generateRoomId();
      if (roomInput) roomInput.value = rid;

      // small UI feedback
      appendSystem(`Creating and joining ${rid}...`);

      // Trigger the same join flow that joinBtn does
      if (joinBtn) {
        // make sure join handler runs (it will use the roomInput)
        joinBtn.click();
      } else {
        // fallback: directly emit join
        const username = (usernameInput && usernameInput.value) ? usernameInput.value.trim() : "Anonymous";
        myName = username;
        currentRoom = rid;
        socket.emit("join-room", { roomId: rid, username: myName });
        setControlsForJoined(true);
      }
    });
  }

  if (createBtn) wireCreateButton(createBtn);
  else console.info("Create button not found (createBtn/createRoomBtn/data-action='create-room'). If you want a Create button add one with id='createBtn' or id='createRoomBtn'.");

  // --- UI event handlers ---

  // Join room (expects roomInput and usernameInput)
  if (joinBtn) {
    joinBtn.addEventListener("click", () => {
      const username = (usernameInput && usernameInput.value) ? usernameInput.value.trim() : "Anonymous";
      const roomId = (roomInput && roomInput.value) ? roomInput.value.trim() : "";
      if (!roomId) {
        appendSystem("Please enter a room ID before joining.");
        return;
      }
      myName = username;
      appendSystem(`Joining room ${roomId}...`);
      socket.emit("join-room", { roomId, username });
      // optimistic controls while server confirms
      setControlsForJoined(true);
    });
  } else {
    console.warn("joinBtn not found in DOM (expected id 'joinBtn' or 'joinRoomBtn')");
  }

  // Send message — IMPORTANT: do NOT append locally (avoid duplicates).
  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      const text = (messageInput && messageInput.value) ? messageInput.value.trim() : "";
      if (!text) return;
      if (!currentRoom) {
        appendSystem("You must join a room first");
        setControlsForJoined(false);
        return;
      }
      const now = Date.now();
      if (now - lastSentAt < SEND_COOLDOWN_MS) return;
      lastSentAt = now;

      // emit to server. server should respond with 'chat-message' to everyone
      socket.emit("chat-message", { roomId: currentRoom, text, username: myName }, (ack) => {
        if (ack && ack.ok === false) {
          appendSystem("Send failed: " + (ack.error || "unknown"));
        }
      });

      // clear input but DO NOT append message locally
      if (messageInput) {
        messageInput.value = "";
        messageInput.focus();
      }
      emitStopTyping();
    });
  }

  // Enter sends, Shift+Enter newline
  if (messageInput) {
    messageInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (sendBtn) sendBtn.click();
        return;
      }
      if (!ev.ctrlKey && !ev.metaKey) {
        emitTyping();
        scheduleStopTyping();
      }
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", () => {
      socket.disconnect();
      appendSystem("Disconnected from server");
      setControlsForJoined(false);
    });
  }

  if (endSessionBtn) {
    endSessionBtn.addEventListener("click", () => {
      if (currentRoom) socket.emit("end-session", { roomId: currentRoom, username: myName });
      socket.disconnect();
      appendSystem("Session ended — reloading");
      setTimeout(() => location.reload(), 600);
    });
  }

  // --- Socket event handlers ---
  socket.on("connect", () => {
    appendSystem("Connected to server");
    // If we were in a room before a reconnect, try to rejoin
    if (currentRoom && myName) {
      appendSystem("Re-joining room after reconnect...");
      socket.emit("join-room", { roomId: currentRoom, username: myName });
    }
  });

  socket.on("disconnect", (reason) => {
    appendSystem(`Socket disconnected (${reason})`);
    setControlsForJoined(false);
  });

  socket.on("connect_error", (err) => {
    appendSystem("Connection error: " + (err && err.message ? err.message : String(err)));
    setControlsForJoined(false);
  });

  // server confirms join
  socket.on("joined", ({ roomId, participants }) => {
    currentRoom = roomId;
    appendSystem(`Joined ${roomId}. Participants: ${participants && participants.join ? participants.join(", ") : participants}`);
    setControlsForJoined(true);
    if (participants && Array.isArray(participants)) showParticipants(participants);
  });

  socket.on("user-joined", ({ username, participants }) => {
    appendSystem(`${username} joined the room`);
    if (participants && Array.isArray(participants)) showParticipants(participants);
  });

  // canonical server-sent chat message (the single source of truth)
  socket.on("chat-message", (m) => {
    // Expected server shape: { id, username, text, timestamp, type? }
    appendMessage({
      id: m.id || null,
      username: m.username || "Unknown",
      text: m.text || "",
      timestamp: m.timestamp || nowIso(),
      me: (m.username === myName)
    });
  });

  // file event
  socket.on("file", (f) => {
    const text = `[file] ${f.filename || f.url}`;
    appendMessage({
      id: f.id || null,
      username: f.username || "Unknown",
      text,
      timestamp: f.ts || nowIso(),
      me: (f.username === myName)
    });
  });

  socket.on("user-left", ({ username, participants }) => {
    appendSystem(`${username} left the room`);
    if (participants && Array.isArray(participants)) showParticipants(participants);
  });

  socket.on("typing", ({ username }) => {
    if (!typingIndicator) return;
    typingIndicator.textContent = `${username} is typing...`;
  });

  socket.on("stop-typing", () => {
    if (!typingIndicator) return;
    typingIndicator.textContent = "";
  });

  socket.on("participants", ({ participants }) => {
    if (participants) showParticipants(participants);
  });

  socket.on("error-message", ({ message }) => {
    appendSystem("Server: " + message);
  });

  // initial focus and initial state
  (function initialFocus() {
    if (roomInput) roomInput.focus();
  })();

  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      if (messageInput && !messageInput.disabled) messageInput.focus();
      else if (roomInput && !roomInput.disabled) roomInput.focus();
    }
  });

  setControlsForJoined(false);
})();
