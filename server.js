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


  socket.on('vgMove',({gameId,col})=>{
    const g=games[gameId]; if(!g||g.over||g.type!=='vg')return;
    const myColor=g.players[socket.id]; if(!myColor||g.turn!==myColor||g.board[0][col]!==0)return;
    let dropRow=-1;
    for(let r=5;r>=0;r--){if(g.board[r][col]===0){g.board[r][col]=myColor;dropRow=r;break;}}
    g.turn=myColor===1?2:1;
    const winCells=vgCheckWinner(g.board,myColor);
    const isDraw=!winCells&&g.board[0].every(c=>c!==0);
    if(winCells){g.over=true;io.to(gameId).emit('vgUpdate',{board:g.board,turn:g.turn,lastCol:col,lastRow:dropRow,winner:myColor,winCells});
      Object.keys(g.players).forEach(sid=>{if(users[sid])users[sid].inGame=false;});broadcastUserList();
    }else if(isDraw){g.over=true;io.to(gameId).emit('vgUpdate',{board:g.board,turn:g.turn,lastCol:col,lastRow:dropRow,winner:0,winCells:null});
      Object.keys(g.players).forEach(sid=>{if(users[sid])users[sid].inGame=false;});broadcastUserList();
    }else{io.to(gameId).emit('vgUpdate',{board:g.board,turn:g.turn,lastCol:col,lastRow:dropRow,winner:null,winCells:null});}
  });

  socket.on('ahPaddle',({gameId,x,y})=>{
    const g=games[gameId]; if(!g||g.type!=='ah'||g.over)return;
    const color=g.players[socket.id];
    if(color==='red'){
      g.p1.vx=x-g.p1.x;g.p1.vy=y-g.p1.y;
      g.p1.x=ahClamp(x,AH.PR,AH.W-AH.PR);
      g.p1.y=ahClamp(y,AH.H/2+AH.PR,AH.H-AH.PR-AH.GD);
    }else{
      const rx=AH.W-x,ry=AH.H-y;
      g.p2.vx=rx-g.p2.x;g.p2.vy=ry-g.p2.y;
      g.p2.x=ahClamp(rx,AH.PR,AH.W-AH.PR);
      g.p2.y=ahClamp(ry,AH.PR+AH.GD,AH.H/2-AH.PR);
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
        if(g.type==='ah'&&g.interval){clearInterval(g.interval);g.interval=null;}
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
    const p1 = users[p1Id], p2 = users[p2Id];
    if (!p1 || !p2) return;
    p1.inGame = true; p2.inGame = true;
    let players = {}, g;
    if (type === 'ttt') {
      players[p1Id]='X'; players[p2Id]='O';
      g={id:gameId,type,board:Array(9).fill(null),turn:'X',over:false,players};
    } else if (type === 'vg') {
      players[p1Id]=1; players[p2Id]=2;
      g={id:gameId,type,board:Array.from({length:6},()=>Array(7).fill(0)),turn:1,over:false,players};
    } else if (type === 'ah') {
      players[p1Id]='red'; players[p2Id]='blue';
      g={id:gameId,type,over:false,players,interval:null,puck:null,p1:null,p2:null,scores:{p1:0,p2:0}};
    } else {
      players[p1Id]='white'; players[p2Id]='black';
      g={id:gameId,type:'chess',board:chessInitBoard(),turn:'w',over:false,
        castling:{wK:true,wRa:true,wRh:true,bK:true,bRa:true,bRh:true},enPassant:null,lastMove:null,players};
    }
    games[gameId]=g;
    [p1Id,p2Id].forEach(sid=>{const sock=io.sockets.sockets.get(sid);if(sock)sock.join(gameId);});
    const b=g.board, t=g.turn;
    io.to(p1Id).emit('gameStart',{gameId,type,myColor:type==='ttt'?'X':type==='vg'?'red':type==='ah'?'red':'white',opponent:p2.username,board:b,turn:t});
    io.to(p2Id).emit('gameStart',{gameId,type,myColor:type==='ttt'?'O':type==='vg'?'blue':type==='ah'?'blue':'black',opponent:p1.username,board:b,turn:t});
    if(type==='ah') setTimeout(()=>ahStartLoop(gameId),100);
    broadcastUserList();
  }
});

// ── VG helper ─────────────────────────────────────────────────
function vgCheckWinner(board, color) {
  for(let r=0;r<6;r++) for(let c=0;c<=3;c++) if([0,1,2,3].every(i=>board[r][c+i]===color)) return[[r,c],[r,c+1],[r,c+2],[r,c+3]];
  for(let r=0;r<=2;r++) for(let c=0;c<7;c++) if([0,1,2,3].every(i=>board[r+i][c]===color)) return[[r,c],[r+1,c],[r+2,c],[r+3,c]];
  for(let r=0;r<=2;r++) for(let c=0;c<=3;c++) if([0,1,2,3].every(i=>board[r+i][c+i]===color)) return[[r,c],[r+1,c+1],[r+2,c+2],[r+3,c+3]];
  for(let r=0;r<=2;r++) for(let c=3;c<7;c++) if([0,1,2,3].every(i=>board[r+i][c-i]===color)) return[[r,c],[r+1,c-1],[r+2,c-2],[r+3,c-3]];
  return null;
}

// ── Air Hockey server-side physics ────────────────────────────
const AH={W:480,H:680,PR:32,PUR:18,GW:140,GD:14,BEVEL:52,FRICTION:0.992,MAXSPD:14,TICK:1000/60};
function ahClamp(v,a,b){return Math.max(a,Math.min(b,v));}
function ahCreatePuck(scorer){
  const cy=scorer===1?AH.H*0.65:scorer===2?AH.H*0.35:AH.H/2;
  return{x:AH.W/2,y:cy,vx:0,vy:0,touched:false,stuckTimer:0};
}
function ahHitPaddle(puck,pad){
  const dx=puck.x-pad.x,dy=puck.y-pad.y,dist=Math.hypot(dx,dy),minD=AH.PUR+AH.PR;
  if(dist>=minD||dist===0)return;
  const nx=dx/dist,ny=dy/dist;
  puck.x=pad.x+nx*(minD+1);puck.y=pad.y+ny*(minD+1);
  const rvx=puck.vx-pad.vx,rvy=puck.vy-pad.vy,dot=rvx*nx+rvy*ny;
  if(dot<0){puck.vx-=dot*nx*1.6;puck.vy-=dot*ny*1.6;puck.vx+=pad.vx*1.1;puck.vy+=pad.vy*1.1;}
  puck.x=ahClamp(puck.x,AH.PUR+1,AH.W-AH.PUR-1);
  puck.y=ahClamp(puck.y,AH.PUR+AH.GD+1,AH.H-AH.PUR-AH.GD-1);
}
function ahTickPhysics(g){
  const p=g.puck,p1=g.p1,p2=g.p2;
  p.x+=p.vx;p.y+=p.vy;p.vx*=AH.FRICTION;p.vy*=AH.FRICTION;
  const spd=Math.hypot(p.vx,p.vy);
  if(spd>AH.MAXSPD){p.vx=p.vx/spd*AH.MAXSPD;p.vy=p.vy/spd*AH.MAXSPD;}
  if(spd>1.5)p.touched=true;
  if(p.touched){if(spd<0.8)p.stuckTimer++;else p.stuckTimer=0;
    if(p.stuckTimer>50){const dx=AH.W/2-p.x,dy=AH.H/2-p.y,d=Math.hypot(dx,dy)||1;p.vx=dx/d*4;p.vy=dy/d*4;p.stuckTimer=0;}}
  const GL=(AH.W-AH.GW)/2,GR=GL+AH.GW;
  [{cx:0,cy:AH.GD,nx:.707,ny:.707},{cx:AH.W,cy:AH.GD,nx:-.707,ny:.707},
   {cx:0,cy:AH.H-AH.GD,nx:.707,ny:-.707},{cx:AH.W,cy:AH.H-AH.GD,nx:-.707,ny:-.707}].forEach(c=>{
    const ddx=p.x-c.cx,ddy=p.y-c.cy,dd=Math.hypot(ddx,ddy);
    if(dd<AH.BEVEL){const nx=dd>0?ddx/dd:c.nx,ny=dd>0?ddy/dd:c.ny,dot=p.vx*nx+p.vy*ny;
      if(dot<0){p.vx-=2*dot*nx;p.vy-=2*dot*ny;}p.x=c.cx+nx*(AH.BEVEL+1);p.y=c.cy+ny*(AH.BEVEL+1);}
  });
  if(p.y-AH.PUR<=AH.GD&&!(p.x>GL&&p.x<GR)){p.y=AH.PUR+AH.GD+1;p.vy=Math.abs(p.vy)*.85;}
  if(p.y+AH.PUR>=AH.H-AH.GD&&!(p.x>GL&&p.x<GR)){p.y=AH.H-AH.PUR-AH.GD-1;p.vy=-Math.abs(p.vy)*.85;}
  if(p.x-AH.PUR<=0){p.x=AH.PUR+1;p.vx=Math.abs(p.vx)*.88;}
  if(p.x+AH.PUR>=AH.W){p.x=AH.W-AH.PUR-1;p.vx=-Math.abs(p.vx)*.88;}
  ahHitPaddle(p,p1);ahHitPaddle(p,p2);
  if(p.y-AH.PUR<=0&&p.x>GL&&p.x<GR)return 1;
  if(p.y+AH.PUR>=AH.H&&p.x>GL&&p.x<GR)return 2;
  return 0;
}
function ahBroadcast(gameId){
  const g=games[gameId]; if(!g)return;
  const ids=Object.keys(g.players);
  const p1id=ids.find(id=>g.players[id]==='red');
  const p2id=ids.find(id=>g.players[id]==='blue');
  if(p1id) io.to(p1id).emit('ahState',{puck:{x:g.puck.x,y:g.puck.y},myPaddle:{x:g.p1.x,y:g.p1.y},oppPaddle:{x:g.p2.x,y:g.p2.y},scores:g.scores,wait:g.waitTimer});
  if(p2id) io.to(p2id).emit('ahState',{puck:{x:AH.W-g.puck.x,y:AH.H-g.puck.y},myPaddle:{x:AH.W-g.p2.x,y:AH.H-g.p2.y},oppPaddle:{x:AH.W-g.p1.x,y:AH.H-g.p1.y},scores:{p1:g.scores.p2,p2:g.scores.p1},wait:g.waitTimer});
}
function ahStartLoop(gameId){
  const g=games[gameId]; if(!g||g.type!=='ah')return;
  g.puck=ahCreatePuck(0);
  g.p1={x:AH.W/2,y:AH.H-120,vx:0,vy:0};
  g.p2={x:AH.W/2,y:120,vx:0,vy:0};
  g.scores={p1:0,p2:0}; g.waitTimer=120; g.paused=false;
  ahBroadcast(gameId);
  g.interval=setInterval(()=>{
    const g=games[gameId]; if(!g||g.over){clearInterval(g&&g.interval);return;}
    if(g.paused||g.waitTimer>0){if(g.waitTimer>0)g.waitTimer--;ahBroadcast(gameId);return;}
    const scored=ahTickPhysics(g);
    if(scored>0){
      g.paused=true;
      if(scored===1)g.scores.p1++;else g.scores.p2++;
      const ms=g.scores.p1%7===0&&g.scores.p1>0||g.scores.p2%7===0&&g.scores.p2>0;
      ahBroadcast(gameId);
      io.to(gameId).emit('ahGoalScored',{by:scored,scores:g.scores,milestone:ms});
      setTimeout(()=>{if(!games[gameId]||g.over)return;g.puck=ahCreatePuck(scored);g.waitTimer=120;g.paused=false;},ms?2000:1200);
    }else{ahBroadcast(gameId);}
  },AH.TICK);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Spielhalle läuft auf Port ${PORT}`));
