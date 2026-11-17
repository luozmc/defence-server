// Defence duel relay server
// -------------------------
// This does two jobs now:
//   1. The original job: lets one player "create" a private 5-letter
//      room code, lets a second player "join" that code, then relays
//      everything they send (position updates and shot events)
//      straight to the other player. Each browser tab still runs the
//      whole game itself (maps, bots, physics, damage) - this server
//      only passes messages back and forth between two players in a
//      room, like a mailbox.
//   2. Cross-device accounts: a tiny signup/login/save API so a
//      player's username, password and progress (coins, skins, etc.)
//      follow them to any device, not just the browser they signed
//      up in. Accounts are stored in a JSON file on this server's
//      disk (see accounts.json below).
//
// IMPORTANT - a heads up about account storage on Render's free tier:
// the free tier's disk is NOT guaranteed to survive a new deploy of
// this code (it usually survives the service just sleeping/waking,
// but a fresh deploy can reset it). That means if this file ever
// gets updated again in the future, there is a real chance everyone's
// accounts get wiped at that moment. That's an acceptable trade-off
// for a free hobby project, but it's worth knowing - if that ever
// becomes a problem, the fix is to upgrade to a Render paid plan with
// a persistent disk, or move accounts to a real hosted database.

const http = require('http');
const fs = require('fs');
const path = require('path');
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

/* ================= Accounts (cross-device login) ================= */

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};
try {
  accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
} catch (e) {
  accounts = {};
}
let accountsSaveTimer = null;
function saveAccountsToDisk() {
  // Debounced so a burst of saves (lots of players progressing at once)
  // doesn't hammer the disk with a write per request.
  if (accountsSaveTimer) return;
  accountsSaveTimer = setTimeout(() => {
    accountsSaveTimer = null;
    try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts)); }
    catch (e) { console.error('Could not save accounts.json:', e.message); }
  }, 1000);
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, obj) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
  res.end(JSON.stringify(obj));
}

function defaultAccount(name, hash) {
  return {
    name, hash,
    created: Date.now(),
    coins: 150,
    earned: 0,
    owned: { outfits: ['recruit', 'urban'], finishes: [] },
    yt: { clicked: false, subscribed: false },
    loadout: { tone: 1, outfit: 'recruit', weapon: 'ak47', gunSkins: {} },
  };
}

function handleSignup(data, res) {
  const name = String(data.name || '');
  const hash = String(data.hash || '');
  const key = name.toLowerCase();
  if (!NAME_RE.test(name) || !hash) return sendJson(res, 400, { ok: false, error: 'Invalid username or password.' });
  if (accounts[key]) return sendJson(res, 409, { ok: false, error: 'That username is already taken.' });

  let acct;
  if (data.acct && typeof data.acct === 'object') {
    // migrating an existing same-browser account up to the server so it
    // can now be used cross-device - keep its progress, just attach the
    // verified name/hash
    acct = Object.assign({}, data.acct, { name, hash });
  } else {
    acct = defaultAccount(name, hash);
  }
  accounts[key] = acct;
  saveAccountsToDisk();
  sendJson(res, 200, { ok: true, acct });
}

function handleLogin(data, res) {
  const name = String(data.name || '');
  const hash = String(data.hash || '');
  const key = name.toLowerCase();
  const a = accounts[key];
  if (!a) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'No account with that username on this server yet.' });
  if (a.hash !== hash) return sendJson(res, 401, { ok: false, code: 'WRONG_PASS', error: 'Wrong username or password.' });
  sendJson(res, 200, { ok: true, acct: a });
}

function handleSave(data, res) {
  const name = String(data.name || '');
  const hash = String(data.hash || '');
  const key = name.toLowerCase();
  const a = accounts[key];
  if (!a || a.hash !== hash) return sendJson(res, 401, { ok: false, error: 'Not authorized.' });
  if (data.acct && typeof data.acct === 'object') {
    // never let a save request change the stored name/hash - that keeps
    // "password change" out of scope and stops someone overwriting those
    // fields through this endpoint
    accounts[key] = Object.assign({}, data.acct, { name: a.name, hash: a.hash });
    saveAccountsToDisk();
  }
  sendJson(res, 200, { ok: true });
}

// A plain HTTP server so Render has something to health-check; the
// WebSocket server attaches to it and handles the real traffic. It also
// now serves the small account API above.
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

  if (req.method === 'POST' && (req.url === '/signup' || req.url === '/login' || req.url === '/save')) {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 200000) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let data;
      try { data = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request.' }); }
      if (req.url === '/signup') return handleSignup(data, res);
      if (req.url === '/login') return handleLogin(data, res);
      if (req.url === '/save') return handleSave(data, res);
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Defence duel relay is running.\n');
});

const wss = new WebSocketServer({ server });

// Keep every connection "hot" even when the game sends nothing for a
// while (e.g. during the plane-drop/parachute intro before a duel's
// real traffic starts). Without this, Render's proxy treats a quiet
// socket as idle and closes it, which looked like "Lost connection
// to the server." A ping every 25s is well under any idle timeout.
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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

    } else if (data.type === 'chat') {
      // menu/lobby chat is public: anyone connected who isn't currently paired
      // into a duel room sees it. The instant two players are matched into a
      // duel room, their chat becomes private - relayed only to each other.
      const text = String(data.text || '').slice(0, 140).trim();
      if (!text) return;
      const name = String(data.name || 'Player').slice(0, 24);
      if (ws.roomCode) {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const peer = ws.role === 'host' ? room.guest : room.host;
        send(peer, { type: 'chat', name, text });
      } else {
        for (const other of wss.clients) {
          if (other === ws || other.roomCode) continue;   // skip self and anyone currently in a duel
          send(other, { type: 'chat', name, text });
        }
      }

    } else {
      // everything else (state, shot, mapVote, mapChosen, roundSpawns, ...)
      // is just relayed as-is to whoever else is in the room. The server
      // has no idea what these mean; it's purely a mailbox between the
      // two players so new message types never need a server change.
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

// Ping all clients on a steady beat. If a client never answers two
// pings in a row (isAlive stays false), it's a dead/zombie connection
// and we terminate it so its room can be cleaned up.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('Defence duel relay listening on port ' + PORT));
