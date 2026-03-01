const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const usernames = {};
const queue = {};
const games = {};
const challenges = {};

function getPublicUser(u) { return { username: u.username, online: true, inGame: u.inGame }; }
function broadcastUserList() { io.emit('userList', Object.values(users).map(getPublicUser)); }
function uid() { return Math.random().toString(36).slice(2, 10); }

// ── TTT ──────────────────────────────────────────────────────
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttCheckWinner(b) {
  for (const [a,c,d] of TTT_WINS) if (b[a] && b[a]===b[c] && b[a]===b[d]) return b[a];
  return b.every(c=>c) ? 'draw' : null;
}

// ── Chess ─────────────────────────────────────────────────────
function chessInitBoard() {
  return ['bR','bN','bB','bQ','bK','bB','bN','bR','bP','bP','bP','bP','bP','bP','bP','bP',
    null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,
    'wP','wP','wP','wP','wP','wP','wP','wP','wR','wN','wB','wQ','wK','wB','wN','wR'];
}

// ── VG ────────────────────────────────────────────────────────
function vgCheckWinner(board, color) {
  for(let r=0;r<6;r++) for(let c=0;c<=3;c++) if([0,1,2,3].every(i=>board[r][c+i]===color)) return[[r,c],[r,c+1],[r,c+2],[r,c+3]];
  for(let r=0;r<=2;r++) for(let c=0;c<7;c++) if([0,1,2,3].every(i=>board[r+i][c]===color)) return[[r,c],[r+1,c],[r+2,c],[r+3,c]];
  for(let r=0;r<=2;r++) for(let c=0;c<=3;c++) if([0,1,2,3].every(i=>board[r+i][c+i]===color)) return[[r,c],[r+1,c+1],[r+2,c+2],[r+3,c+3]];
  for(let r=0;r<=2;r++) for(let c=3;c<7;c++) if([0,1,2,3].every(i=>board[r+i][c-i]===color)) return[[r,c],[r+1,c-1],[r+2,c-2],[r+3,c-3]];
  return null;
}

// ── AIR HOCKEY PHYSICS (server-side) ─────────────────────────
const AH = {
  W:480, H:680, PR:32, PUR:18, GW:140, GD:14, BEVEL:52,
  FRICTION:0.992, MAXSPD:14, TICK:1000/60
};

function ahCreatePuck(scorer) {
  const cy = scorer===1 ? AH.H*0.65 : scorer===2 ? AH.H*0.35 : AH.H/2;
  return { x:AH.W/2, y:cy, vx:0, vy:0, touched:false, stuckTimer:0 };
}

function ahClamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

function ahHitPaddle(puck, pad) {
  const dx=puck.x-pad.x, dy=puck.y-pad.y, dist=Math.hypot(dx,dy), minD=AH.PUR+AH.PR;
  if(dist>=minD||dist===0) return false;
  const nx=dx/dist, ny=dy/dist;
  puck.x=pad.x+nx*(minD+1); puck.y=pad.y+ny*(minD+1);
  const rvx=puck.vx-pad.vx, rvy=puck.vy-pad.vy, dot=rvx*nx+rvy*ny;
  if(dot<0){puck.vx-=dot*nx*1.6;puck.vy-=dot*ny*1.6;puck.vx+=pad.vx*1.1;puck.vy+=pad.vy*1.1;}
  puck.x=ahClamp(puck.x,AH.PUR+1,AH.W-AH.PUR-1);
  puck.y=ahClamp(puck.y,AH.PUR+AH.GD+1,AH.H-AH.PUR-AH.GD-1);
  return true;
}

function ahTickPhysics(g) {
  const p = g.puck, p1 = g.p1, p2 = g.p2;
  p.x+=p.vx; p.y+=p.vy; p.vx*=AH.FRICTION; p.vy*=AH.FRICTION;
  const spd=Math.hypot(p.vx,p.vy);
  if(spd>AH.MAXSPD){p.vx=p.vx/spd*AH.MAXSPD;p.vy=p.vy/spd*AH.MAXSPD;}
  if(spd>1.5) p.touched=true;
  if(p.touched){
    if(spd<0.8) p.stuckTimer++; else p.stuckTimer=0;
    if(p.stuckTimer>50){const dx=AH.W/2-p.x,dy=AH.H/2-p.y,d=Math.hypot(dx,dy)||1;p.vx=dx/d*4;p.vy=dy/d*4;p.stuckTimer=0;}
  }
  const GL=(AH.W-AH.GW)/2, GR=GL+AH.GW;
  // Beveled corners
  [{cx:0,cy:AH.GD,nx:.707,ny:.707},{cx:AH.W,cy:AH.GD,nx:-.707,ny:.707},
   {cx:0,cy:AH.H-AH.GD,nx:.707,ny:-.707},{cx:AH.W,cy:AH.H-AH.GD,nx:-.707,ny:-.707}].forEach(c=>{
    const ddx=p.x-c.cx,ddy=p.y-c.cy,dd=Math.hypot(ddx,ddy);
    if(dd<AH.BEVEL){const nx=dd>0?ddx/dd:c.nx,ny=dd>0?ddy/dd:c.ny,dot=p.vx*nx+p.vy*ny;
      if(dot<0){p.vx-=2*dot*nx;p.vy-=2*dot*ny;}p.x=c.cx+nx*(AH.BEVEL+1);p.y=c.cy+ny*(AH.BEVEL+1);}
  });
  // Walls
  if(p.y-AH.PUR<=AH.GD&&!(p.x>GL&&p.x<GR)){p.y=AH.PUR+AH.GD+1;p.vy=Math.abs(p.vy)*.85;}
  if(p.y+AH.PUR>=AH.H-AH.GD&&!(p.x>GL&&p.x<GR)){p.y=AH.H-AH.PUR-AH.GD-1;p.vy=-Math.abs(p.vy)*.85;}
  if(p.x-AH.PUR<=0){p.x=AH.PUR+1;p.vx=Math.abs(p.vx)*.88;}
  if(p.x+AH.PUR>=AH.W){p.x=AH.W-AH.PUR-1;p.vx=-Math.abs(p.vx)*.88;}
  // Paddle hits
  ahHitPaddle(p, p1); ahHitPaddle(p, p2);
  // Goal check
  if(p.y-AH.PUR<=0&&p.x>GL&&p.x<GR) return 1; // P1 scored
  if(p.y+AH.PUR>=AH.H&&p.x>GL&&p.x<GR) return 2; // P2 scored
  return 0;
}

function ahStartLoop(gameId) {
  const g = games[gameId];
  if(!g||g.type!=='ah') return;
  g.puck = ahCreatePuck(0);
  g.p1 = {x:AH.W/2, y:AH.H-120, vx:0, vy:0}; // P1 = red, bottom
  g.p2 = {x:AH.W/2, y:120,      vx:0, vy:0}; // P2 = blue, top
  g.scores = {p1:0, p2:0};
  g.waitTimer = 120; // 2 sec countdown at 60fps
  g.paused = false;
  g.over = false;
  // Send initial state
  ahBroadcast(gameId);
  // 60fps server loop
  g.interval = setInterval(()=>ahLoopTick(gameId), AH.TICK);
}

function ahBroadcast(gameId) {
  const g = games[gameId];
  if(!g) return;
  const ids = Object.keys(g.players);
  const p1id = ids.find(id=>g.players[id]==='red');
  const p2id = ids.find(id=>g.players[id]==='blue');
  // P1 sees field normally, P2 sees field mirrored (they're at bottom too from their POV)
  if(p1id) io.to(p1id).emit('ahState',{
    puck:{x:g.puck.x,y:g.puck.y},
    myPaddle:{x:g.p1.x,y:g.p1.y},
    oppPaddle:{x:g.p2.x,y:g.p2.y},
    scores:g.scores, wait:g.waitTimer
  });
  if(p2id) io.to(p2id).emit('ahState',{
    puck:{x:AH.W-g.puck.x,y:AH.H-g.puck.y},      // mirrored
    myPaddle:{x:AH.W-g.p2.x,y:AH.H-g.p2.y},       // mirrored
    oppPaddle:{x:AH.W-g.p1.x,y:AH.H-g.p1.y},      // mirrored
    scores:{p1:g.scores.p2,p2:g.scores.p1},         // swapped
    wait:g.waitTimer
  });
}

function ahLoopTick(gameId) {
  const g = games[gameId];
  if(!g||g.over){clearInterval(g?.interval);return;}
  if(g.paused){ahBroadcast(gameId);return;}
  if(g.waitTimer>0){g.waitTimer--;ahBroadcast(gameId);return;}
  const scored = ahTickPhysics(g);
  if(scored>0){
    g.paused=true;
    if(scored===1) g.scores.p1++; else g.scores.p2++;
    const milestone = g.scores.p1%7===0&&g.scores.p1>0 || g.scores.p2%7===0&&g.scores.p2>0;
    ahBroadcast(gameId);
    io.to(gameId).emit('ahGoalScored',{by:scored, scores:g.scores, milestone});
    setTimeout(()=>{
      if(!games[gameId]||g.over) return;
      g.puck=ahCreatePuck(scored);
      g.p2.x=AH.W/2; g.p2.y=120; // AI back to home (for p2)
      g.waitTimer=120; g.paused=false;
    }, milestone?2000:1200);
  } else {
    ahBroadcast(gameId);
  }
}


// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('login', (username, cb) => {
    const clean = (username||'').trim().replace(/[^a-zA-Z0-9_\-]/g,'').slice(0,20);
    if(!clean||clean.length<2) return cb({ok:false,msg:'Name zu kurz (min. 2 Zeichen)'});
    if(usernames[clean.toLowerCase()]) return cb({ok:false,msg:'Name bereits vergeben'});
    users[socket.id]={username:clean,socketId:socket.id,inGame:false,friendRequests:[],friends:[]};
    usernames[clean.toLowerCase()]=socket.id;
    cb({ok:true,username:clean});
    broadcastUserList();
  });

  socket.on('joinQueue',(game)=>{
    const me=users[socket.id]; if(!me||me.inGame)return;
    if(!queue[game])queue[game]=[];
    if(queue[game].includes(socket.id))return;
    queue[game].push(socket.id); socket.emit('queueJoined',game);
    if(queue[game].length>=2){const[p1,p2]=queue[game].splice(0,2);createGame(game,p1,p2);}
  });

  socket.on('leaveQueue',(game)=>{if(queue[game])queue[game]=queue[game].filter(id=>id!==socket.id);});

  // ── TTT ──
  socket.on('tttMove',({gameId,index})=>{
    const g=games[gameId]; if(!g||g.over||g.type!=='ttt')return;
    const sym=g.players[socket.id]; if(!sym||g.turn!==sym||g.board[index])return;
    g.board[index]=sym; g.turn=sym==='X'?'O':'X';
    const winner=tttCheckWinner(g.board);
    if(winner){g.over=true;io.to(gameId).emit('tttUpdate',{board:g.board,turn:g.turn,winner,gameId});
      Object.keys(g.players).forEach(sid=>{if(users[sid])users[sid].inGame=false;});broadcastUserList();
    }else{io.to(gameId).emit('tttUpdate',{board:g.board,turn:g.turn,winner:null,gameId});}
  });

  // ── VG ──
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

  // ── AIR HOCKEY: client sends paddle position ──
  socket.on('ahPaddle',({gameId,x,y})=>{
    const g=games[gameId]; if(!g||g.type!=='ah'||g.over)return;
    const color=g.players[socket.id];
    // Clamp to valid half
    if(color==='red'){
      // red = P1 = bottom half
      g.p1.vx=x-g.p1.x; g.p1.vy=y-g.p1.y;
      g.p1.x=ahClamp(x,AH.PR,AH.W-AH.PR);
      g.p1.y=ahClamp(y,AH.H/2+AH.PR,AH.H-AH.PR-AH.GD);
    } else {
      // blue = P2 = top half. Client sends mirrored coords so we un-mirror
      const rx=AH.W-x, ry=AH.H-y;
      g.p2.vx=rx-g.p2.x; g.p2.vy=ry-g.p2.y;
      g.p2.x=ahClamp(rx,AH.PR,AH.W-AH.PR);
      g.p2.y=ahClamp(ry,AH.PR+AH.GD,AH.H/2-AH.PR);
    }
  });

  // ── Chess ──
  socket.on('chessMove',({gameId,from,to,promotion})=>{
    const g=games[gameId]; if(!g||g.over||g.type!=='chess')return;
    const myColor=g.players[socket.id]; if(!myColor||g.turn!==myColor[0])return;
    const piece=g.board[from]; if(!piece||piece[0]!==myColor[0])return;
    const nb=[...g.board]; let newEP=null; const type=piece[1],col=piece[0];
    if(type==='P'&&to===g.enPassant){const dir=col==='w'?8:-8;nb[to+dir]=null;}
    if(type==='K'){if(col==='w'){g.castling.wK=false;g.castling.wRa=false;g.castling.wRh=false;}
      else{g.castling.bK=false;g.castling.bRa=false;g.castling.bRh=false;}
      const diff=to-from; if(diff===2){nb[to-1]=nb[from+3];nb[from+3]=null;} if(diff===-2){nb[to+1]=nb[from-4];nb[from-4]=null;}}
    if(type==='R'){if(from===56)g.castling.wRa=false;if(from===63)g.castling.wRh=false;if(from===0)g.castling.bRa=false;if(from===7)g.castling.bRh=false;}
    if(type==='P'&&Math.abs(to-from)===16)newEP=(from+to)>>1;
    nb[to]=piece;nb[from]=null;
    if(type==='P'&&(to<8||to>=56))nb[to]=col+(promotion||'Q');
    g.board=nb;g.enPassant=newEP;g.turn=g.turn==='w'?'b':'w';g.lastMove={from,to};
    io.to(gameId).emit('chessUpdate',{gameId,board:g.board,turn:g.turn,lastMove:g.lastMove,castling:g.castling,enPassant:g.enPassant});
  });

  socket.on('chessResign',({gameId})=>{
    const g=games[gameId];if(!g)return;g.over=true;
    const myColor=g.players[socket.id],winnerColor=myColor==='white'?'black':'white';
    io.to(gameId).emit('chessGameOver',{reason:'resign',winner:winnerColor,gameId});
    Object.keys(g.players).forEach(sid=>{if(users[sid])users[sid].inGame=false;});broadcastUserList();
  });

  socket.on('gameOver',({gameId,winner,reason})=>{
    const g=games[gameId];if(!g)return;g.over=true;
    io.to(gameId).emit('chessGameOver',{reason,winner,gameId});
    Object.keys(g.players).forEach(sid=>{if(users[sid])users[sid].inGame=false;});broadcastUserList();
  });

  socket.on('rematch',({gameId})=>{
    const g=games[gameId];if(!g)return;
    const ids=Object.keys(g.players);
    io.to(gameId).emit('rematchProposed',{by:users[socket.id]?.username});
    g.rematchVotes=(g.rematchVotes||0)+1;
    if(g.rematchVotes>=2)createGame(g.type,ids[0],ids[1]);
  });

  // ── Friends ──
  socket.on('sendFriendRequest',(toUsername)=>{
    const me=users[socket.id]; if(!me)return;
    const toId=usernames[toUsername.toLowerCase()]; if(!toId||toId===socket.id)return;
    const toUser=users[toId]; if(!toUser)return;
    if(toUser.friendRequests.includes(me.username))return;
    toUser.friendRequests.push(me.username);
    io.to(toId).emit('friendRequest',{from:me.username});
  });

  socket.on('acceptFriendRequest',(fromUsername)=>{
    const me=users[socket.id]; if(!me)return;
    me.friendRequests=me.friendRequests.filter(u=>u!==fromUsername);
    const fromId=usernames[fromUsername.toLowerCase()];
    if(fromId&&users[fromId]){
      if(!me.friends.includes(fromUsername))me.friends.push(fromUsername);
      if(!users[fromId].friends.includes(me.username))users[fromId].friends.push(me.username);
      io.to(fromId).emit('friendAccepted',{by:me.username});
    }
    socket.emit('friendsList',me.friends);
  });

  socket.on('declineFriendRequest',(fromUsername)=>{
    const me=users[socket.id]; if(!me)return;
    me.friendRequests=me.friendRequests.filter(u=>u!==fromUsername);
  });

  socket.on('getFriends',()=>{
    const me=users[socket.id]; if(!me)return;
    socket.emit('friendsList',me.friends);
    if(me.friendRequests.length>0)me.friendRequests.forEach(f=>socket.emit('friendRequest',{from:f}));
  });

  socket.on('challenge',({toUsername,game})=>{
    const me=users[socket.id]; if(!me||me.inGame)return;
    const toId=usernames[toUsername.toLowerCase()]; if(!toId)return;
    const toUser=users[toId]; if(!toUser||toUser.inGame)return;
    const challengeId=uid();
    challenges[challengeId]={from:me.username,to:toUsername,game,fromId:socket.id,toId};
    io.to(toId).emit('challenged',{challengeId,from:me.username,game});
  });

  socket.on('acceptChallenge',({challengeId})=>{
    const c=challenges[challengeId]; if(!c)return;
    delete challenges[challengeId];
    createGame(c.game,c.fromId,c.toId);
  });

  socket.on('declineChallenge',({challengeId})=>{
    const c=challenges[challengeId]; if(!c)return;
    delete challenges[challengeId];
    const fromId=usernames[c.from.toLowerCase()];
    if(fromId)io.to(fromId).emit('challengeDeclined',{by:c.to});
  });

  socket.on('disconnect',()=>{
    const me=users[socket.id]; if(!me)return;
    Object.values(games).forEach(g=>{
      if(g.players[socket.id]&&!g.over){
        g.over=true;
        if(g.type==='ah'&&g.interval){clearInterval(g.interval);g.interval=null;}
        io.to(g.id).emit('opponentLeft',{username:me.username});
        Object.keys(g.players).forEach(sid=>{if(users[sid])users[sid].inGame=false;});
      }
    });
    delete usernames[me.username.toLowerCase()];
    delete users[socket.id];
    Object.values(queue).forEach(q=>{const i=q.indexOf(socket.id);if(i>-1)q.splice(i,1);});
    broadcastUserList();
  });

  function createGame(type,p1Id,p2Id){
    const gameId=uid(),p1=users[p1Id],p2=users[p2Id];
    if(!p1||!p2)return;
    p1.inGame=true;p2.inGame=true;
    const players={};
    let g;
    if(type==='ttt'){
      players[p1Id]='X';players[p2Id]='O';
      g={id:gameId,type,board:Array(9).fill(null),turn:'X',over:false,players};
    } else if(type==='vg'){
      players[p1Id]=1;players[p2Id]=2;
      g={id:gameId,type,board:Array.from({length:6},()=>Array(7).fill(0)),turn:1,over:false,players};
    } else if(type==='ah'){
      players[p1Id]='red';players[p2Id]='blue';
      g={id:gameId,type,over:false,players,interval:null,puck:null,p1:null,p2:null,scores:{p1:0,p2:0}};
    } else {
      players[p1Id]='white';players[p2Id]='black';
      g={id:gameId,type:'chess',board:chessInitBoard(),turn:'w',over:false,
        castling:{wK:true,wRa:true,wRh:true,bK:true,bRa:true,bRh:true},enPassant:null,lastMove:null,players};
    }
    games[gameId]=g;
    [p1Id,p2Id].forEach(sid=>{const sock=io.sockets.sockets.get(sid);if(sock)sock.join(gameId);});
    const labels={'ttt':'Tic Tac Toe','vg':'Vier Gewinnt','ah':'Air Hockey','chess':'Schach'};
    io.to(p1Id).emit('gameStart',{gameId,type,myColor:type==='ttt'?'X':type==='vg'?'red':type==='ah'?'red':'white',opponent:p2.username,board:g.board,turn:g.turn});
    io.to(p2Id).emit('gameStart',{gameId,type,myColor:type==='ttt'?'O':type==='vg'?'blue':type==='ah'?'blue':'black',opponent:p1.username,board:g.board,turn:g.turn});
    if(type==='ah') setTimeout(()=>ahStartLoop(gameId),100);
    broadcastUserList();
  }
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Spielhalle läuft auf Port ${PORT}`));
