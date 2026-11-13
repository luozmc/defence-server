// Defence duel relay server
// -------------------------
// This does NOT run any game logic. It just:
//   1. lets one player "create" a private 5-letter room code
//   2. lets a second player "join" that code
//   3. once both are connected, relays everything they send (position
//      updates and shot events) straight to the other player
//
// Each browser tab still runs the whole game itself (maps, bots,
// physics, damage) - this server only passes messages back and forth
// between the two players in a room, like a mailbox.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map(); // room code -> { host: ws, guest: ws|null }

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function newCode() {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  return code;
}
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// A plain HTTP server so Render has something to health-check; the
// WebSocket server attaches to it and handles the real traffic.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Defence duel relay is running.\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === 'create') {
      const code = newCode();
      rooms.set(code, { host: ws, guest: null });
      ws.roomCode = code;
      ws.role = 'host';
      send(ws, { type: 'created', code });

    } else if (data.type === 'join') {
      const code = String(data.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'joinError', reason: 'No room with that code.' }); return; }
      if (room.guest) { send(ws, { type: 'joinError', reason: 'That room is already full.' }); return; }
      room.guest = ws;
      ws.roomCode = code;
      ws.role = 'guest';
      send(room.host, { type: 'ready', youAre: 'host', code });
      send(ws, { type: 'ready', youAre: 'guest', code });

    } else if (data.type === 'state' || data.type === 'shot') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const peer = ws.role === 'host' ? room.guest : room.host;
      send(peer, data);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = ws.role === 'host' ? room.guest : room.host;
    send(peer, { type: 'peerLeft' });
    rooms.delete(ws.roomCode);
  });
});

server.listen(PORT, () => console.log('Defence duel relay listening on port ' + PORT));
