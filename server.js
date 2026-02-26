const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ──────────────────────────────────────────
const users = {};        // socketId → { username, socketId, inGame, friendRequests:[], friends:[] }
const usernames = {};    // username (lower) → socketId
const queue = {};        // game → [socketId]   ('ttt'|'chess')
const games = {};        // gameId → gameState
const challenges = {};   // challengeId → { from, to, game, gameId }

function getPublicUser(u) {
  return { username: u.username, online: true, inGame: u.inGame };
}

// ── Helpers ──────────────────────────────────────────────────
function broadcastUserList() {
  const list = Object.values(users).map(getPublicUser);
  io.emit('userList', list);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── TTT logic ────────────────────────────────────────────────
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function tttCheckWinner(board) {
  for (const [a,b,c] of TTT_WINS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(c => c)) return 'draw';
  return null;
}

// ── Chess helpers ─────────────────────────────────────────────
function chessInitBoard() {
  return [
    'bR','bN','bB','bQ','bK','bB','bN','bR',
    'bP','bP','bP','bP','bP','bP','bP','bP',
    null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,
    'wP','wP','wP','wP','wP','wP','wP','wP',
    'wR','wN','wB','wQ','wK','wB','wN','wR'
  ];
}

// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Register username ──
  socket.on('register', (username, cb) => {
    const key = username.trim().toLowerCase();
    if (!key || key.length < 2 || key.length > 20) return cb({ error: 'Name muss 2–20 Zeichen lang sein.' });
    if (!/^[a-z0-9_äöüß]+$/i.test(username.trim())) return cb({ error: 'Nur Buchstaben, Zahlen und _ erlaubt.' });
    if (usernames[key]) return cb({ error: `"${username.trim()}" ist bereits vergeben.` });

    const user = {
      username: username.trim(),
      socketId: socket.id,
      inGame: false,
      friends: [],
      friendRequests: []
    };
    users[socket.id] = user;
    usernames[key] = socket.id;

    broadcastUserList();
    cb({ ok: true, username: user.username });
  });

  // ── Friend request ──
  socket.on('friendRequest', (targetUsername) => {
    const me = users[socket.id];
    if (!me) return;
    const targetId = usernames[targetUsername.toLowerCase()];
    if (!targetId || targetId === socket.id) return;
    const target = users[targetId];
    if (!target) return;
    if (me.friends.includes(targetUsername)) return;
    target.friendRequests.push(me.username);
    io.to(targetId).emit('friendRequest', { from: me.username });
  });

  socket.on('friendAccept', (fromUsername) => {
    const me = users[socket.id];
    if (!me) return;
    me.friendRequests = me.friendRequests.filter(n => n !== fromUsername);
    me.friends.push(fromUsername);
    const fromId = usernames[fromUsername.toLowerCase()];
    if (fromId && users[fromId]) {
      users[fromId].friends.push(me.username);
      io.to(fromId).emit('friendAccepted', { by: me.username });
    }
    socket.emit('friendsList', me.friends);
    if (fromId) io.to(fromId).emit('friendsList', users[fromId].friends);
  });

  socket.on('friendDecline', (fromUsername) => {
    const me = users[socket.id];
    if (!me) return;
    me.friendRequests = me.friendRequests.filter(n => n !== fromUsername);
  });

  socket.on('getFriends', (cb) => {
    const me = users[socket.id];
    if (!me) return cb([]);
    // Enrich with online status
    const enriched = me.friends.map(f => {
      const fId = usernames[f.toLowerCase()];
      return { username: f, online: !!fId && !!users[fId], inGame: fId && users[fId] ? users[fId].inGame : false };
    });
    cb(enriched);
  });

  // ── Challenge friend ──
  socket.on('challenge', ({ targetUsername, game }) => {
    const me = users[socket.id];
    if (!me) return;
    const targetId = usernames[targetUsername.toLowerCase()];
    if (!targetId || !users[targetId]) return;
    const cid = uid();
    challenges[cid] = { from: me.username, fromId: socket.id, to: targetUsername, toId: targetId, game };
    io.to(targetId).emit('challenged', { challengeId: cid, from: me.username, game });
  });

  socket.on('challengeAccept', (challengeId) => {
    const ch = challenges[challengeId];
    if (!ch) return;
    delete challenges[challengeId];
    createGame(ch.game, ch.fromId, socket.id);
  });

  socket.on('challengeDecline', (challengeId) => {
    const ch = challenges[challengeId];
    if (!ch) return;
    io.to(ch.fromId).emit('challengeDeclined', { by: ch.to });
    delete challenges[challengeId];
  });

  // ── Matchmaking queue ──
  socket.on('joinQueue', (game) => {
    const me = users[socket.id];
    if (!me || me.inGame) return;
    if (!queue[game]) queue[game] = [];
    if (queue[game].includes(socket.id)) return;
    queue[game].push(socket.id);
    socket.emit('queueJoined', game);

    if (queue[game].length >= 2) {
      const [p1, p2] = queue[game].splice(0, 2);
      createGame(game, p1, p2);
    }
  });

  socket.on('leaveQueue', (game) => {
    if (queue[game]) queue[game] = queue[game].filter(id => id !== socket.id);
  });

  // ── Game moves ──
  socket.on('tttMove', ({ gameId, index }) => {
    const g = games[gameId];
    if (!g || g.over) return;
    const me = users[socket.id];
    if (!me) return;

    // Verify it's this player's turn
    const mySymbol = g.players[socket.id];
    if (!mySymbol) return;
    if (g.turn !== mySymbol) return;
    if (g.board[index]) return;

    g.board[index] = mySymbol;
    g.turn = mySymbol === 'X' ? 'O' : 'X';

    const winner = tttCheckWinner(g.board);
    if (winner) {
      g.over = true;
      g.winner = winner;
      io.to(gameId).emit('tttUpdate', { board: g.board, turn: g.turn, winner, gameId });
      // Free players
      Object.keys(g.players).forEach(sid => { if (users[sid]) users[sid].inGame = false; });
      broadcastUserList();
    } else {
      io.to(gameId).emit('tttUpdate', { board: g.board, turn: g.turn, winner: null, gameId });
    }
  });

  socket.on('chessMove', ({ gameId, from, to, promotion }) => {
    const g = games[gameId];
    if (!g || g.over) return;
    const myColor = g.players[socket.id];
    if (!myColor) return;
    if (g.turn !== myColor[0]) return; // 'w' or 'b'

    // Apply move server-side (basic — trust client validation for now, revalidate key rules)
    const piece = g.board[from];
    if (!piece || piece[0] !== myColor[0]) return;

    const nb = [...g.board];
    let newEP = null;
    const type = piece[1];
    const col = piece[0];

    // En passant capture
    if (type === 'P' && to === g.enPassant) {
      const dir = col === 'w' ? 8 : -8;
      nb[to + dir] = null;
    }
    // Castling rook move
    if (type === 'K') {
      if (col === 'w') { g.castling.wK = false; g.castling.wRa = false; g.castling.wRh = false; }
      else { g.castling.bK = false; g.castling.bRa = false; g.castling.bRh = false; }
      const diff = to - from;
      if (diff === 2)  { nb[to-1] = nb[from+3]; nb[from+3] = null; }
      if (diff === -2) { nb[to+1] = nb[from-4]; nb[from-4] = null; }
    }
    if (type === 'R') {
      if (from === 56) g.castling.wRa = false;
      if (from === 63) g.castling.wRh = false;
      if (from === 0)  g.castling.bRa = false;
      if (from === 7)  g.castling.bRh = false;
    }
    if (type === 'P' && Math.abs(to - from) === 16) newEP = (from + to) >> 1;

    nb[to] = piece; nb[from] = null;
    if (type === 'P' && (to < 8 || to >= 56)) nb[to] = col + (promotion || 'Q');

    g.board = nb;
    g.enPassant = newEP;
    g.turn = g.turn === 'w' ? 'b' : 'w';
    g.lastMove = { from, to };

    const update = {
      gameId, board: g.board, turn: g.turn,
      lastMove: g.lastMove, castling: g.castling, enPassant: g.enPassant
    };
    io.to(gameId).emit('chessUpdate', update);
  });

  socket.on('chessResign', ({ gameId }) => {
    const g = games[gameId];
    if (!g) return;
    g.over = true;
    const myColor = g.players[socket.id];
    const winnerColor = myColor === 'white' ? 'black' : 'white';
    io.to(gameId).emit('chessGameOver', { reason: 'resign', winner: winnerColor, gameId });
    Object.keys(g.players).forEach(sid => { if (users[sid]) users[sid].inGame = false; });
    broadcastUserList();
  });

  socket.on('gameOver', ({ gameId, winner, reason }) => {
    const g = games[gameId];
    if (!g) return;
    g.over = true;
    io.to(gameId).emit('chessGameOver', { reason, winner, gameId });
    Object.keys(g.players).forEach(sid => { if (users[sid]) users[sid].inGame = false; });
    broadcastUserList();
  });

  // ── Rematch ──
  socket.on('rematch', ({ gameId }) => {
    const g = games[gameId];
    if (!g) return;
    const ids = Object.keys(g.players);
    io.to(gameId).emit('rematchProposed', { by: users[socket.id]?.username });
    g.rematchVotes = (g.rematchVotes || 0) + 1;
    if (g.rematchVotes >= 2) {
      createGame(g.type, ids[0], ids[1]);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const me = users[socket.id];
    if (!me) return;

    // Notify game partners
    Object.values(games).forEach(g => {
      if (g.players[socket.id] && !g.over) {
        g.over = true;
        io.to(g.id).emit('opponentLeft', { username: me.username });
        Object.keys(g.players).forEach(sid => { if (users[sid]) users[sid].inGame = false; });
      }
    });

    delete usernames[me.username.toLowerCase()];
    delete users[socket.id];

    // Remove from queues
    Object.values(queue).forEach(q => {
      const idx = q.indexOf(socket.id);
      if (idx > -1) q.splice(idx, 1);
    });

    broadcastUserList();
  });

  // ── Helpers ──
  function createGame(type, p1Id, p2Id) {
    const gameId = uid();
    const p1 = users[p1Id];
    const p2 = users[p2Id];
    if (!p1 || !p2) return;

    p1.inGame = true; p2.inGame = true;

    let players = {};
    if (type === 'ttt') {
      players[p1Id] = 'X'; players[p2Id] = 'O';
      games[gameId] = {
        id: gameId, type,
        board: Array(9).fill(null),
        turn: 'X', over: false,
        players
      };
    } else {
      // chess: p1 = white, p2 = black
      players[p1Id] = 'white'; players[p2Id] = 'black';
      games[gameId] = {
        id: gameId, type,
        board: chessInitBoard(),
        turn: 'w', over: false,
        castling: { wK:true, wRa:true, wRh:true, bK:true, bRa:true, bRh:true },
        enPassant: null, lastMove: null,
        players
      };
    }

    [p1Id, p2Id].forEach(sid => {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.join(gameId);
    });

    io.to(p1Id).emit('gameStart', {
      gameId, type,
      myColor: type === 'ttt' ? 'X' : 'white',
      opponent: p2.username,
      board: games[gameId].board,
      turn: games[gameId].turn
    });
    io.to(p2Id).emit('gameStart', {
      gameId, type,
      myColor: type === 'ttt' ? 'O' : 'black',
      opponent: p1.username,
      board: games[gameId].board,
      turn: games[gameId].turn
    });

    broadcastUserList();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Spielhalle läuft auf Port ${PORT}`));
