// 服务端：静态文件 + WebSocket 房间
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./src/room');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// 任何未捕获的异常都不能让服务挂掉
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[未处理的 Promise]', err);
});

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // 云平台健康检查
  if (urlPath === '/health' || urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);

  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/** 房间表 */
const rooms = new Map();
/** playerId -> ws */
const conns = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    const r = new Room(id);
    r.lastActive = Date.now();
    rooms.set(id, r);
  }
  return rooms.get(id);
}

// 有人卡住不动（掉线 / 卡死），40 秒后帮他过掉这一手，避免全桌僵死
const TURN_TIMEOUT = 30000;
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'PLAYING') {
      room._lastSeq = room.seq;
      room._lastSeqAt = now;
      continue;
    }
    // 状态有变化 = 刚刚有人操作，重新计时
    if (room.seq !== room._lastSeq) {
      room._lastSeq = room.seq;
      room._lastSeqAt = now;
      continue;
    }
    if (room._lastSeqAt && now - room._lastSeqAt > TURN_TIMEOUT) {
      try {
        if (room.autoPlay()) {
          room._lastSeq = room.seq;
          room._lastSeqAt = now;
          broadcast(room);
          console.log(`[托管] 房间 ${room.id} 有人超时，已自动处理`);
        }
      } catch (e) {
        console.error('[托管出错]', e);
        room._lastSeqAt = now;
      }
    }
  }
}, 2000);

// 掉线超过 60 秒还不回来：腾出座位，别把房间堵死
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const stale = room.players.filter(
      p => !p.connected && p.disconnectedAt && now - p.disconnectedAt > 45000
    );
    if (!stale.length) continue;

    for (const p of stale) {
      room.kickPlayer(p.id);
      console.log(`[清理] 房间 ${room.id} 移除掉线玩家 ${p.name}`);
    }
    if (room.players.length < 4 && room.phase !== 'WAITING') {
      room.phase = 'WAITING';
      for (const x of room.players) { x.hand = []; x.out = false; }
      room.lastPlay = null;
      room.trickHistory = [];
      room.giveWind = null;
      room.chooseState = null;
      room.finishOrder = [];
      room.stickMode = null;
      room.stickSeats = [];
      room.addLog('有人掉线太久，这局作废，等人齐了重新开');
    }
    room.seq++;
    broadcast(room);
  }
}, 15000);

// 没人连着超过 30 分钟的房间，清掉，防止越积越多
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const anyOnline = room.players.some(p => p.connected);
    if (!anyOnline && now - (room.lastActive || 0) > 30 * 60 * 1000) {
      room.clearWindState && room.clearWindState();
      if (room.teamTimer) clearTimeout(room.teamTimer);
      rooms.delete(id);
      console.log(`[清理] 房间 ${id} 已回收`);
    }
  }
}, 5 * 60 * 1000);

function broadcast(room) {
  for (const p of room.players) {
    const ws = conns.get(p.id);
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'state', data: room.stateFor(p.id) }));
      } catch (e) { /* ignore */ }
    }
  }
}

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

const randomId = () => Math.random().toString(36).slice(2, 10);

wss.on('connection', (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    try {
      if (type === 'join') {
        roomId = String(data.roomId || 'main').slice(0, 20);
        const room = getRoom(roomId);
        const myName = String(data.name || '').slice(0, 12) || '玩家';
        const myReal = String(data.realName || myName).slice(0, 12);
        const now = Date.now();

        let p = data.playerId ? room.getPlayer(data.playerId) : null;

        if (p) {
          // 1. 老身份直接重连回来
          p.connected = true;
          p.disconnectedAt = null;
          playerId = p.id;
        } else {
          // 2. 换了浏览器 / 清了缓存：同名就把旧连接挤掉，坐回原位
          const sameName = room.players.find(x => x.name === myName);
          if (sameName) {
            const oldWs = conns.get(sameName.id);
            if (oldWs && oldWs !== ws) { try { oldWs.close(); } catch (e) {} }
            sameName.connected = true;
            sameName.disconnectedAt = null;
            playerId = sameName.id;
            p = sameName;
            room.addLog(`${sameName.name} 重新连回来了`);
            room.seq++;
          } else {
            // 3. 座位满了，先把掉线超过 20 秒的请走
            if (room.players.length >= 4) {
              const stale = room.players.filter(x => !x.connected && x.disconnectedAt && now - x.disconnectedAt > 15000);
              for (const x of stale) {
                room.kickPlayer(x.id);
                conns.delete(x.id);
                console.log(`[腾位] 房间 ${room.id} 请走掉线玩家 ${x.name}`);
              }
            }

            // 4. 有空位就坐下
            if (room.players.length < 4) {
              if (room.phase !== 'WAITING' && room.phase !== 'TEAM') {
                room.phase = 'WAITING';
                for (const x of room.players) { x.hand = []; x.out = false; }
                room.lastPlay = null;
                room.trickHistory = [];
                room.giveWind = null;
                room.chooseState = null;
                room.finishOrder = [];
                room.addLog('人不够了，这局作废');
              }
              playerId = randomId();
              p = room.addPlayer(playerId, myName, myReal);
            }

            if (!p) {
              send(ws, 'error', `房间满了（4/4），等里面的人退一个再进`);
              return;
            }
          }
        }

        conns.set(playerId, ws);
        send(ws, 'joined', { playerId, seat: p.seat });
        // 四人齐 → 先进组队阶段
        if (room.players.length === 4 && room.phase === 'WAITING') {
          room.beginTeamStage();
        }
        broadcast(room);
        return;
      }

      if (!playerId) { send(ws, 'error', '请先加入房间'); return; }
      const room = rooms.get(roomId);
      if (!room) { send(ws, 'error', '房间不存在'); return; }
      room.lastActive = Date.now();
      const me = room.getPlayer(playerId);
      if (!me) { send(ws, 'error', '你不在这个房间'); return; }

      if (type === 'ready') {
        room.setReady(playerId, true);
        if (room.allReady() && room.phase === 'WAITING') {
          room.startGame();
        }
        broadcast(room);
        return;
      }

      if (type === 'start') {
        if (room.phase === 'WAITING' && room.players.length === 4) {
          room.startGame();
          broadcast(room);
        }
        return;
      }

      if (type === 'play') {
        const r = room.play(playerId, data.cardIds, data.asMap);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'pass') {
        const r = room.pass(playerId);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'leave') {
        const dr = room.dismissRoom(playerId);
        if (!dr.ok) { send(ws, 'error', dr.msg); return; }
        // 通知房间里所有人被请出去
        for (const id of dr.ids) {
          const sock = conns.get(id);
          if (sock) {
            try {
              send(sock, 'dismissed', { by: dr.byName });
              setTimeout(() => { try { sock.close(); } catch (e) {} }, 120);
            } catch (e) {}
            conns.delete(id);
          }
        }
        rooms.delete(roomId);
        console.log(`[房间解散] ${roomId} 被 ${dr.byName} 请走了所有人`);
        return;
      }

      if (type === 'restart') {
        const rr = room.restartGame(playerId);
        if (!rr.ok) send(ws, 'error', rr.msg);
        broadcast(room);
        return;
      }

      if (type === 'react') {
        const r2 = room.react(playerId, Number(data.targetSeat), data.kind);
        if (!r2.ok) send(ws, 'error', r2.msg);
        broadcast(room);
        return;
      }

      if (type === 'team') {
        const r = room.submitTeamPick(playerId, data.targetSeat, !!data.skip);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'wind') {
        const r = room.submitWind(playerId, data.action, data.cardIds, data.asMap);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'choose') {
        const r = room.chooseWind(playerId, data.choice);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'cha') {
        const r = room.chaTrick(playerId);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'answerStick') {
        const ar = room.answerStick(playerId, !!data.agree);
        if (!ar.ok) send(ws, 'error', ar.msg);
        broadcast(room);
        return;
      }

      if (type === 'declare') {
        const r = room.declareStick(playerId, !!data.want);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }

      if (type === 'cut') {
        const seat = room.getPlayer(playerId)?.seat;
        const cr = room.doCut(seat, data.index);
        if (!cr.ok) send(ws, 'error', cr.msg);
        broadcast(room);
        return;
      }

      if (type === 'nextRound') {
        if (room.nextRound()) broadcast(room);
        return;
      }

      if (type === 'chat') {
        const r = room.say(playerId, data.text);
        if (!r.ok) send(ws, 'error', r.msg);
        broadcast(room);
        return;
      }
    } catch (e) {
      console.error('消息处理异常', e);
      send(ws, 'error', '服务器处理出错');
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const p = room.getPlayer(playerId);
    if (p) {
      p.connected = false;
      p.disconnectedAt = Date.now();
      // 还没开局：直接让位，别人能马上进来
      if (room.phase === 'WAITING') {
        room.removePlayer(playerId);
        room.addLog(`${p.name} 离开了`);
      } else {
        room.addLog(`${p.name} 断线了，等他回来（15 秒内重连不丢座位）`);
      }
      room.seq++;
    }
    conns.delete(playerId);
    broadcast(room);
  });
});

function lanAddresses() {
  const os = require('os');
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address);
    }
  }
  return list;
}

server.listen(PORT, () => {
  console.log('');
  console.log('  游戏已启动');
  console.log('  ────────────────────────────────────');
  console.log(`  本机访问：   http://localhost:${PORT}`);
  const ips = lanAddresses();
  if (ips.length) {
    for (const ip of ips) {
      console.log(`  局域网访问： http://${ip}:${PORT}`);
    }
    console.log('  （同一个 WiFi 下，别人用上面的局域网地址就能进）');
  } else {
    console.log('  未检测到局域网地址，检查一下是否连着 WiFi');
  }
  console.log('  ────────────────────────────────────');
  console.log('');
});
