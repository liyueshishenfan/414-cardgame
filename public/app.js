const $ = (id) => document.getElementById(id);

let ws = null;
let myId = null;
let myRoom = 'main';
let myName = '';
let myRealName = '';
let state = null;
let selected = new Set();    // 选中的牌 id
let asMap = {};              // 配牌 id -> 变成的点数
let pickerTarget = null;
let handOrder = [];          // 本地手牌顺序
let lastRoundNo = -1;
let lastHandKey = '';
let toastTimer = null;
let reconnectTimer = null;
let reconnectCount = 0;
let lastTurnKey = '';
let lastChaAt = 0;
let declareTick = null;
let drag = null;

const VALUE_TO_LABEL = { 3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2' };

/* ---------------- 连接 ---------------- */
function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectCount = 0;
    $('offline').hidden = true;
    ws.send(JSON.stringify({
      type: 'join',
      data: { roomId: myRoom, name: myName, realName: myRealName, playerId: myId },
    }));
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'dismissed') {
      try { ws.onclose = null; ws.close(); } catch (e) {}
      $('game').hidden = true;
      $('login').hidden = false;
      const who = (msg.data && msg.data.by) || '有人';
      toast(`${who} 把房间解散了，全部退出`, 3800);
      return;
    }

    if (msg.type === 'joined') {
      myId = msg.data.playerId;
      try {
        // playerId 存 sessionStorage：每个标签页独立，方便自己开四个窗口测试
        sessionStorage.setItem('card_playerId', myId);
        localStorage.setItem('card_room', myRoom);
        localStorage.setItem('card_name', myName);
      } catch {}
      $('login').hidden = true;
      $('game').hidden = false;
    } else if (msg.type === 'state') {
      applyState(msg.data);
    } else if (msg.type === 'error') {
      toast(msg.data);
      if (String(msg.data).includes('无法加入') || String(msg.data).includes('房间已满')) {
        try { sessionStorage.removeItem('card_playerId'); } catch {}
        myId = null;
        $('login').hidden = false;
        $('game').hidden = true;
      }
    }
  };

  ws.onclose = () => {
    if (!myId) return;
    reconnectCount++;
    if (reconnectCount > 4) {
      $('offline').hidden = false;
      return;
    }
    toast(`连接断开，重连中…（${reconnectCount}/4）`);
    reconnectTimer = setTimeout(connect, 1200 * reconnectCount);
  };
}

function send(type, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

// 调试入口
window.__game = { send, getState: () => state };

/* ---------------- 状态处理 ---------------- */
function applyState(s) {
  const prev = state;
  const prevHandKey = prev ? prev.myHand.map(c => c.id).sort().join(',') : '';
  state = s;
  window.__state = s;   // 便于调试

  // 手牌变了才清空选择，避免别人提交时把我选的牌清掉
  const nowHandKey = s.myHand.map(c => c.id).sort().join(',');
  if (nowHandKey !== prevHandKey) {
    selected.clear();
    asMap = {};
  }

  // 我的回合结束了（出过牌 / 被跳过）→ 选中的牌自动放回去
  const wasMine = prev && prev.phase === 'PLAYING' && prev.turn === prev.mySeat;
  const isMine = s.phase === 'PLAYING' && s.turn === s.mySeat;
  if (wasMine && !isMine) {
    selected.clear();
    asMap = {};
  }

  // 新一局开头：中间弹一下"打几 · 谁的场"
  if (!prev || prev.roundNo !== s.roundNo) {
    showRoundBanner(s);
  }

  // 新一局或手牌变化大时重置顺序
  const key = s.myHand.map(c => c.id).join(',');
  if (s.roundNo !== lastRoundNo || key !== lastHandKey) {
    if (s.roundNo !== lastRoundNo) {
      handOrder = defaultSort(s.myHand).map(c => c.id);
      selected.clear();
      asMap = {};
    } else {
      syncHandOrder();
    }
    lastRoundNo = s.roundNo;
    lastHandKey = key;
  }

  render();

  if (s.phase === 'DECLARE') startDeclareTick();
  else stopDeclareTick();
}

let bannerTimer = null;

function showRoundBanner(s) {
  if (!s || s.phase === 'WAITING' || s.phase === 'TEAM') return;
  const el = $('roundBanner');
  if (!el) return;
  const lv = (typeof VALUE_TO_LABEL !== 'undefined' && VALUE_TO_LABEL[s.currentLevel]) || '';
  const team = s.fieldTeam === 0 ? 'A' : 'B';
  el.textContent = `打 ${lv} · ${team} 队场`;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, 2900);
}

function defaultSort(cards) {
  return cards.slice().sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? -1 : 1;
    if (a.joker && b.joker) return b.rank.localeCompare(a.rank);
    if (a.value !== b.value) return b.value - a.value;
    return a.suit.localeCompare(b.suit);
  });
}

function syncHandOrder() {
  const ids = state.myHand.map(c => c.id);
  const kept = handOrder.filter(id => ids.includes(id));
  for (const c of defaultSort(state.myHand)) {
    if (!kept.includes(c.id)) kept.push(c.id);
  }
  handOrder = kept.length === ids.length ? kept : defaultSort(state.myHand).map(c => c.id);
}

/* ---------------- 渲染 ---------------- */
function relativeSeat(seat) {
  return (seat - state.mySeat + 4) % 4;
}

function isLevelCard(card) {
  return !card.joker && card.value === state.currentLevel;
}

function makeCard(card, mini = false) {
  const el = document.createElement('div');
  const isRed = card.suit === 'H' || card.suit === 'D';
  el.className = (mini ? 'mini' : 'card') + (isRed ? ' red' : '') + (card.joker ? ' joker' : '');

  if (mini) {
    if (card.joker) {
      el.textContent = card.as ? `王→${VALUE_TO_LABEL[card.as]}` : card.rank;
    } else {
      el.textContent = ({ S:'♠', H:'♥', D:'♦', C:'♣' }[card.suit]) + card.rank;
    }
    return el;
  }

  if (card.joker) {
    el.innerHTML = `<span class="rank">${card.rank === '大王' ? '大王' : '小王'}</span>`;
  } else {
    const suit = { S:'♠', H:'♥', D:'♦', C:'♣' }[card.suit];
    // 点数在上、花色在下，和真实扑克牌一样，重叠时也能看清
    el.innerHTML = `<span class="rank">${card.rank}</span><span class="suit">${suit}</span>`;
  }
  if (isLevelCard(card)) el.style.border = '2px solid #fbbf24';

  const as = asMap[card.id];
  if (as) {
    const badge = document.createElement('span');
    badge.className = 'asbadge';
    badge.textContent = '当' + VALUE_TO_LABEL[as];
    el.appendChild(badge);
  }
  return el;
}

function render() {
  try {
    renderCore();
  } catch (e) {
    // 渲染出错也不能把整个界面搞白
    console.error('渲染异常', e);
  }
}

function renderCore() {
  if (!state) return;

  const lvName = VALUE_TO_LABEL[state.currentLevel] || '?';
  $('roundInfo').textContent = `第 ${state.roundNo} 局`;
  $('levelInfo').textContent = `打 ${lvName} · ${state.fieldTeam === 0 ? 'A' : 'B'} 队场`;

  // 座位
  const seatMap = { 1: 'seat1', 2: 'seat2', 3: 'seat3' };
  const posName = { 1: 'left', 2: 'top', 3: 'right' };
  for (const p of state.players) {
    const rel = relativeSeat(p.seat);
    if (rel === 0) continue;
    const box = $(seatMap[rel]);
    if (!box) continue;
    const sameTeam = p.seat % 2 === state.mySeat % 2;
    const finished = state.finishOrder.includes(p.seat);
    const isSticker = (state.stickSeats || []).includes(p.seat);
    box.className = 'seat seat-' + posName[rel]
      + (state.turn === p.seat && state.phase === 'PLAYING' ? ' active' : '')
      + ((finished || p.out) ? ' finished' : '')
      + (p.count > 0 && p.count <= 3 ? ' low-cards' : '')
      + (p.count === 0 ? ' bust' : '');
    box.innerHTML = `
      <div class="avatar" data-seat="${p.seat}">${escapeHtml((p.name || '?').slice(0, 1))}</div>
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="tag ${sameTeam ? '' : 'opp'}">${sameTeam ? '队友' : '对手'}</div>
      <div class="count">${p.out ? '本局退出' : `剩 ${p.count} 张`}</div>
      ${isSticker ? '<div class="stick-badge">立棍</div>' : ''}
      ${finished ? `<div class="finish-rank">第${state.finishOrder.indexOf(p.seat) + 1}名</div>` : ''}
      <div class="played" id="played${rel}"></div>
    `;

    const av = box.querySelector('.avatar');
    if (av) {
      av.addEventListener('click', (e) => {
        e.stopPropagation();
        openProfile(p.seat, av);
      });
    }
  }

  // 我的信息
  const teamEl = $('myTeam');
  if (state.myTeam === 0 || state.myTeam === 1) {
    teamEl.textContent = state.myTeam === 0 ? 'A队' : 'B队';
    teamEl.className = 'team-badge team-' + state.myTeam;
  } else {
    teamEl.textContent = '—';
    teamEl.className = 'team-badge team-none';
  }

  const me = state.players.find(p => p.seat === state.mySeat);
  if (me) {
    $('myName').textContent = me.name;
    const myRank = state.finishOrder.indexOf(state.mySeat);
    let tag = '';
    if (myRank >= 0) tag = `已出完（第${myRank + 1}名）`;
    else if (me.out) tag = '本局退出';
    else if (state.phase === 'PLAYING' && state.turn === state.mySeat) tag = '轮到你了';
    if ((state.stickSeats || []).includes(state.mySeat)) tag += ' · 立棍中';
    $('myTag').textContent = tag;
  }

  // 场上牌
  const lp = $('lastPlay');
  lp.innerHTML = '';
  $('centerMsg').textContent = '';

  if (state.lastPlay) {
    const who = state.players.find(p => p.seat === state.lastPlay.seat);
    const isCha = !!state.lastPlay.isCha;

    // 箭头指向出牌的人
    const rel = relativeSeat(state.lastPlay.seat);
    const arrow = rel === 0 ? '↓' : rel === 1 ? '←' : rel === 2 ? '↑' : '→';
    const dirClass = rel === 0 ? 'to-self' : rel === 1 ? 'to-left' : rel === 2 ? 'to-top' : 'to-right';

    const label = document.createElement('div');
    label.className = 'center-msg' + (isCha ? ' cha-msg' : '');
    label.innerHTML = `<span class='arrow ${dirClass}'>${arrow}</span>${who ? escapeHtml(who.name) : '?'} ${isCha ? '差 · 谁都不能管' : '出'}`;
    lp.appendChild(label);

    const row = document.createElement('div');
    row.className = 'mini-row';
    for (const c of state.lastPlay.cards) row.appendChild(makeCard(c, true));
    lp.appendChild(row);
  } else if (state.phase === 'PLAYING' && state.turn === state.mySeat) {
    $('centerMsg').textContent = '你先出牌';
  } else if (state.phase === 'WAITING') {
    $('centerMsg').textContent = `等待玩家 ${state.players.length}/4`;
  }

  if (state.phase === 'ROUND_END' && state.lastResult) {
    const r = state.lastResult;
    $('centerMsg').textContent =
      `${r.winTeam === 0 ? 'A' : 'B'} 队获胜，升 ${r.up} 级（${VALUE_TO_LABEL[r.before]} → ${VALUE_TO_LABEL[r.after]}）`;
  } else if (state.phase === 'GAME_OVER' && state.lastResult) {
    $('centerMsg').textContent =
      `${state.lastResult.winTeam === 0 ? 'A' : 'B'} 队获胜，游戏结束`;
  }

  renderHand();

  // 轮到你提示
  const tip = $('turnTip');
  const gwMine = state.phase === 'GIVE_WIND' && state.giveWind
    && state.giveWind.seats.includes(state.mySeat)
    && !state.giveWind.myChoice;

  if (state.phase === 'PLAYING' && state.turn === state.mySeat) {
    tip.textContent = (state.lastPlay && !state.lastPlay.isCha)
      ? '轮到你出牌'
      : '轮到你出牌（自由出）';
    tip.className = 'turn-tip';
    tip.hidden = false;
  } else if (gwMine) {
    tip.textContent = '轮到你选择：管 还是 不管';
    tip.className = 'turn-tip wind';
    tip.hidden = false;
  } else {
    tip.hidden = true;
  }

  // 轮次变化时震动一下
  const turnKey = `${state.phase}:${state.turn}:${state.roundNo}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    if (state.phase === 'PLAYING' && state.turn === state.mySeat && navigator.vibrate) {
      navigator.vibrate(90);
    }
  }

  // 按钮
  const isMyTurn = state.phase === 'PLAYING' && state.turn === state.mySeat;
  const jokersOk = [...selected].every(id => {
    const c = state.myHand.find(x => x.id === id);
    return !c || !c.joker || asMap[id];
  });
  $('btnPlay').textContent = '出牌';
  $('btnPlay').disabled = !isMyTurn || selected.size === 0 || !jokersOk;
  $('btnPass').disabled = !isMyTurn || !state.lastPlay || state.lastPlay.seat === state.mySeat;

  const inWind = state.phase === 'GIVE_WIND' || state.phase === 'GIVE_WIND_CHOOSE';
  const inTeam = state.phase === 'TEAM';
  const showNext = state.phase === 'ROUND_END';
  $('btnNext').hidden = !showNext;
  $('btnPlay').hidden = showNext || inWind || inTeam;
  $('btnPass').hidden = showNext || inWind || inTeam;
  $('btnSort').hidden = showNext || inWind || inTeam;
  if (showNext || inWind || inTeam) $('btnCha').hidden = true;

  // 有人喊差：全场红闪 + 震动
  if (state.lastPlay && state.lastPlay.isCha && state.lastPlayAt && state.lastPlayAt !== lastChaAt) {
    lastChaAt = state.lastPlayAt;
    const who = state.players.find(p => p.seat === state.lastPlay.seat);
    const gameEl = $('game');
    gameEl.classList.add('cha-flash');
    setTimeout(() => gameEl.classList.remove('cha-flash'), 850);
    if (navigator.vibrate) navigator.vibrate([70, 50, 140]);
    if (who) toast(`${who.name} 喊差！谁都不能管`);
  }

  if (state.lastWindFx && state.lastWindFx.at !== lastWindFxAt) {
    lastWindFxAt = state.lastWindFx.at;
    playWindFx(state.lastWindFx);
  }

  if (state.lastReact && state.lastReact.at !== lastReactAt) {
    lastReactAt = state.lastReact.at;
    showReact(state.lastReact);
  }

  updateCha();
  renderTeam();
  renderWind();
  renderDeclare();
  renderLog();
  checkChat();
}


function renderPlayed() {
  ['played1', 'played2', 'played3', 'myPlayed'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = '';
  });
  if (!state || !state.trickHistory) return;

  const latest = {};
  for (const h of state.trickHistory) latest[h.seat] = h;

  for (const seatStr of Object.keys(latest)) {
    const seat = Number(seatStr);
    const h = latest[seat];
    const rel = relativeSeat(seat);
    const el = rel === 0 ? $('myPlayed') : $('played' + rel);
    if (!el) continue;
    for (const c of h.cards) {
      const card = makeCard(c, true);
      if (h.isCha) card.classList.add('cha-mini');
      el.appendChild(card);
    }
  }
}

function renderHand() {
  const hand = $('hand');
  hand.innerHTML = '';
  const map = new Map(state.myHand.map(c => [c.id, c]));
  for (const id of handOrder) {
    const c = map.get(id);
    if (!c) continue;
    const el = makeCard(c);
    el.dataset.id = String(c.id);
    if (selected.has(c.id)) el.classList.add('sel');
    hand.appendChild(el);
  }
}

function renderLog() {
  const list = $('logList');
  if (!list || !state) return;
  list.innerHTML = '';
  for (const line of state.log || []) {
    const d = document.createElement('div');
    d.textContent = line;
    list.appendChild(d);
  }
}

/* ---------------- 差 ---------------- */
let chaTick = null;

function updateCha() {
  const btn = $('btnCha');
  if (!btn) return;
  if (!state || state.phase !== 'PLAYING' || !state.canCha) {
    btn.hidden = true;
    return;
  }
  const left = 5000 - (Date.now() - (state.lastPlayAt || 0));
  if (left <= 0) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = `差 ${(left / 1000).toFixed(1)}`;
}

function startChaTick() {
  if (chaTick) return;
  chaTick = setInterval(updateCha, 200);
}

$('btnCha').addEventListener('click', () => {
  $('btnCha').hidden = true;
  send('cha', {});
});

/* ---------------- 快捷语 ---------------- */
const QUICK_SAYS = [
  '快点啊，我等的花都谢了',
  '天上天下唯我独尊',
  '给你机会你不中用啊',
  '你的牌打得太好了',
  '不要走，决战到天亮',
  '不好意思，我先跑了',
  '手气不错啊',
  '这牌没法打了',
  '稳住，我们能赢',
  '出得漂亮',
  '该你啦',
  '我服了',
  '别磨叽',
  '好牌！',
  '😂 笑死',
  '🤣 乐',
  '😭 捂脸哭',
  '🤝 握个手',
  '🫳 摸摸头',
  '🙏 服了服了',
];

let lastChatAt = 0;

function initChat() {
  const grid = $('chatGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const text of QUICK_SAYS) {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', () => {
      send('chat', { text });
      $('chatPanel').hidden = true;
    });
    grid.appendChild(b);
  }
}

function showBubble(seat, text) {
  if (!state) return;
  let target = null;
  let below = false;

  if (seat === state.mySeat) {
    target = $('myName') ? $('myName').parentElement : null;
  } else {
    const rel = relativeSeat(seat);
    const id = rel === 2 ? 'seat2' : rel === 1 ? 'seat1' : 'seat3';
    target = $(id);
    below = rel === 2;
  }
  if (!target) return;

  const rect = target.getBoundingClientRect();
  const b = document.createElement('div');
  b.className = 'bubble' + (below ? ' below' : '');
  b.textContent = text;
  b.style.left = (rect.left + rect.width / 2) + 'px';
  b.style.top = (below ? rect.bottom + 10 : rect.top - 34) + 'px';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 3200);
}

function checkChat() {
  const c = state && state.lastChat;
  if (!c || c.at === lastChatAt) return;
  lastChatAt = c.at;
  showBubble(c.seat, c.text);
}

$('btnReload').addEventListener('click', () => location.reload());

$('btnSay').addEventListener('click', () => { $('chatPanel').hidden = false; });
$('btnChatClose').addEventListener('click', () => { $('chatPanel').hidden = true; });

/* ---------------- 组队 ---------------- */
function renderTeam() {
  const panel = $('teamPanel');
  if (!state || state.phase !== 'TEAM') { panel.hidden = true; return; }
  panel.hidden = false;

  const done = state.teamPicksDone || [];
  const askers = state.teamAskers || [];
  const mine = done.includes(state.mySeat);

  if (mine) {
    $('teamSub').textContent = '已选择，等其他人…';
  } else if (askers.length) {
    const names = askers
      .map(s => (state.players.find(x => x.seat === s) || {}).name)
      .filter(Boolean);
    $('teamSub').textContent = `${names.join('、')} 邀请你组队，挑一个`;
  } else {
    $('teamSub').textContent = '选一个人，邀请他组队';
  }

  $('btnTeamSkip').hidden = mine;

  const others = state.players.filter(p => p.seat !== state.mySeat);
  $('teamList').innerHTML = others.map(p => {
    const picked = done.includes(p.seat);
    const invitedMe = askers.includes(p.seat);
    let txt;
    if (invitedMe && !mine) txt = '邀请你 · 点我接受';
    else if (mine) txt = picked ? '已选择' : '等待中';
    else txt = picked ? '已选择' : '点我邀请';

    const cls = invitedMe && !mine ? 'ask' : (picked ? 'done' : '');
    return `<div class="wind-item${invitedMe && !mine ? ' invited' : ''}" data-seat="${p.seat}" style="cursor:${mine ? 'default' : 'pointer'}">
      <div class="who">${escapeHtml(p.name)}</div>
      <div class="state ${cls}">${txt}</div>
    </div>`;
  }).join('');

  if (!mine) {
    $('teamList').querySelectorAll('.wind-item').forEach(el => {
      el.addEventListener('click', () => {
        send('team', { targetSeat: Number(el.dataset.seat) });
      });
    });
  }
}

$('btnTeamSkip').addEventListener('click', () => send('team', { skip: true }));

$('btnExit').addEventListener('click', () => {
  if (!confirm('确定退出房间吗？')) return;
  try { sessionStorage.removeItem('card_playerId'); } catch {}
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  setTimeout(() => location.reload(), 120);
});

/* ---------------- 给风 ---------------- */
let revealShownAt = 0;
let windTick = null;

function renderWind() {
  const panel = $('windPanel');
  if (!state) { panel.hidden = true; return; }

  const gw = state.giveWind;
  const cs = state.chooseState;
  const rv = state.lastReveal;

  // 揭晓结果
  if (!gw && !cs && rv && rv.at !== revealShownAt) {
    revealShownAt = rv.at;
    panel.hidden = false;
    $('windTitle').textContent = '给风结果';
    $('windSub').textContent = rv.result;
    $('windTarget').innerHTML = '';
    $('windList').innerHTML = rv.items.map(it => `
      <div class="wind-item">
        <div class="who">${escapeHtml(it.name)}
          <span class="tag ${it.isMate ? 'mate' : 'opp'}">${it.isMate ? '队友' : '对手'}</span>
        </div>
        <div class="state done">${escapeHtml(it.text)}</div>
      </div>`).join('');
    $('windTimer').textContent = '';
    $('windActions').hidden = true;
    $('windChoose').hidden = true;
    $('btnWindClose').hidden = false;
    return;
  }

  if (!gw && !cs) { panel.hidden = true; return; }

  panel.hidden = false;
  $('btnWindClose').hidden = true;

  // 两名对手决定谁出
  if (cs) {
    $('windTitle').textContent = '谁 出';
    $('windSub').textContent = '你们俩都管住了，谁先出？';
    $('windTarget').innerHTML = '';
    $('windList').innerHTML = '';
    $('windTimer').textContent = '';
    $('windActions').hidden = true;

    const mine = cs.candidates.includes(state.mySeat);
    $('windChoose').hidden = !mine;
    if (mine) {
      const picked = cs.picks.includes(state.mySeat);
      $('btnChooseMe').hidden = picked;
      $('btnChooseNot').hidden = picked;
      if (picked) $('windTimer').textContent = '已选择，等对方…';
    }
    return;
  }

  // 给风选择
  const trigger = state.players.find(p => p.seat === gw.triggerSeat);
  $('windTitle').textContent = '给 风';
  $('windSub').textContent = `${trigger ? trigger.name : '?'} 出完了，三个人同时决定管不管`;
  $('windTarget').innerHTML = '';
  for (const c of gw.targetCards) $('windTarget').appendChild(makeCard(c, true));

  $('windList').innerHTML = gw.seats.map(s => {
    const p = state.players.find(x => x.seat === s);
    const isMate = (s % 2) === (gw.triggerSeat % 2);
    const done = gw.submitted.includes(s);
    return `<div class="wind-item">
      <div class="who">${escapeHtml(p ? p.name : '?')}
        <span class="tag ${isMate ? 'mate' : 'opp'}">${isMate ? '队友' : '对手'}</span>
      </div>
      <div class="state ${done ? 'done' : ''}">${done ? '已选择' : '犹豫中…'}</div>
    </div>`;
  }).join('');

  const meIn = gw.seats.includes(state.mySeat);
  const chosen = !!gw.myChoice;
  $('windChoose').hidden = true;

  if (meIn && !chosen) {
    $('windActions').hidden = false;
    $('btnWindCha').hidden = !gw.canChaWind;
    $('btnWindPlay').disabled = selected.size === 0;
    const left = Math.max(0, Math.ceil((gw.endsAt - Date.now()) / 1000));
    $('windTimer').textContent = left + 's';
  } else {
    $('windActions').hidden = true;
    $('windTimer').textContent = meIn ? '已选择，等其他人…' : '';
  }
}

function startWindTick() {
  if (windTick) return;
  windTick = setInterval(() => {
    if (!state) return;
    if (state.phase === 'GIVE_WIND' && state.giveWind) {
      const meIn = state.giveWind.seats.includes(state.mySeat);
      if (meIn && !state.giveWind.myChoice) {
        const left = Math.max(0, Math.ceil((state.giveWind.endsAt - Date.now()) / 1000));
        $('windTimer').textContent = left + 's';
      }
    }
  }, 300);
}

$('btnWindPass').addEventListener('click', () => send('wind', { action: 'pass' }));
$('btnWindCha').addEventListener('click', () => send('wind', { action: 'cha' }));
$('btnWindPlay').addEventListener('click', () => {
  if (selected.size === 0) return;
  send('wind', { action: 'play', cardIds: [...selected], asMap });
});
$('btnChooseMe').addEventListener('click', () => send('choose', { choice: 'me' }));
$('btnChooseNot').addEventListener('click', () => send('choose', { choice: 'not' }));
$('btnWindClose').addEventListener('click', () => { $('windPanel').hidden = true; });

/* ---------------- 立棍声明 ---------------- */
function renderDeclare() {
  const panel = $('declare');
  if (!state || state.phase !== 'DECLARE') { panel.hidden = true; return; }

  panel.hidden = false;
  const myChoice = state.declare ? state.declare[state.mySeat] : 'PENDING';
  const chosen = myChoice !== 'PENDING';

  $('btnStick').hidden = chosen;
  $('btnNoStick').hidden = chosen;

  const stickers = state.stickSeats || [];
  const names = stickers.map(s => {
    const p = state.players.find(x => x.seat === s);
    return p ? p.name : `座位${s}`;
  });
  $('declareStatus').textContent = names.length
    ? `已立棍：${names.join('、')}`
    : '还没人立棍';
}

function startDeclareTick() {
  if (declareTick) return;
  updateDeclareTimer();
  declareTick = setInterval(updateDeclareTimer, 250);
}

function stopDeclareTick() {
  if (declareTick) { clearInterval(declareTick); declareTick = null; }
}

function updateDeclareTimer() {
  if (!state || state.phase !== 'DECLARE') { stopDeclareTick(); return; }
  const left = Math.max(0, Math.ceil((state.declareEndsAt - Date.now()) / 1000));
  $('declareTimer').textContent = left;
  $('declareTimer').style.color = left <= 10 ? '#f87171' : '#fbbf24';
}

$('btnStick').addEventListener('click', () => send('declare', { want: true }));
$('btnNoStick').addEventListener('click', () => send('declare', { want: false }));

/* ---------------- 手牌交互 ---------------- */
function canInteract() {
  if (!state) return false;
  if (state.phase === 'PLAYING') return state.turn === state.mySeat;
  if (state.phase === 'GIVE_WIND' && state.giveWind) {
    const gw = state.giveWind;
    return gw.seats.includes(state.mySeat) && !gw.myChoice;
  }
  return false;
}

function onCardClick(card) {
  if (!canInteract()) return;
  if (card.joker) {
    selected.add(card.id);
    openPicker(card);
    renderHand();
    updateButtons();
    return;
  }
  if (selected.has(card.id)) selected.delete(card.id);
  else selected.add(card.id);
  renderHand();
  updateButtons();
  renderWind();
}

function updateButtons() {
  if (!state) return;
  const isMyTurn = canInteract();
  const jokersOk = [...selected].every(id => {
    const c = state.myHand.find(x => x.id === id);
    return !c || !c.joker || asMap[id];
  });
  $('btnPlay').disabled = !isMyTurn || selected.size === 0 || !jokersOk;
  $('btnPass').disabled = !isMyTurn || !state.lastPlay || state.lastPlay.seat === state.mySeat;
}

function openPicker(card) {
  pickerTarget = card.id;
  const grid = $('pickerGrid');
  grid.innerHTML = '';
  for (let v = 3; v <= 15; v++) {
    const btn = document.createElement('button');
    btn.textContent = VALUE_TO_LABEL[v];
    if (v === state.currentLevel) btn.classList.add('lv');
    btn.addEventListener('click', () => {
      asMap[card.id] = v;
      $('picker').hidden = true;
      pickerTarget = null;
      renderHand();
      updateButtons();
      renderWind();
    });
    grid.appendChild(btn);
  }
  $('picker').hidden = false;
}

$('pickerCancel').addEventListener('click', () => {
  $('picker').hidden = true;
  if (pickerTarget) selected.delete(pickerTarget);
  pickerTarget = null;
  renderHand();
  updateButtons();
});

/* ---------------- 拖拽排序 ---------------- */
const handEl = $('hand');

handEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.card');
  if (!el || !el.dataset.id) return;
  drag = {
    id: Number(el.dataset.id),
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    el,
  };
});

handEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 10) return;

  // 拖动过程中只改视觉，不动 DOM，避免每帧重建造成卡顿
  if (!drag.moved) {
    drag.moved = true;
    drag.el.classList.add('dragging');
  }
  drag.lastX = e.clientX;
  drag.el.style.transform = `translate(${dx}px, -22px) scale(1.06)`;
});

function endDrag(e) {
  if (!drag) return;

  if (!drag.moved) {
    const card = state.myHand.find(c => c.id === drag.id);
    if (card) onCardClick(card);
    drag = null;
    return;
  }

  // 松手时才真正重排
  const x = (e && e.clientX) || drag.lastX || drag.startX;
  const others = [...handEl.querySelectorAll('.card')].filter(el => el !== drag.el);
  let insertAt = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) { insertAt = i; break; }
  }

  const from = handOrder.indexOf(drag.id);
  if (from >= 0) {
    handOrder.splice(from, 1);
    handOrder.splice(Math.min(insertAt, handOrder.length), 0, drag.id);
  }

  drag.el.style.transform = '';
  drag.el.classList.remove('dragging');
  drag = null;
  renderHand();
}

handEl.addEventListener('pointerup', endDrag);
handEl.addEventListener('pointercancel', endDrag);
handEl.addEventListener('pointerleave', () => { if (drag && !drag.moved) {} });

/* ---------------- 按钮 ---------------- */
$('btnPlay').addEventListener('click', () => {
  if (!state || selected.size === 0) return;
  $('btnPlay').disabled = true;
  $('btnPlay').textContent = '发送中…';
  send('play', { cardIds: [...selected], asMap });
});

$('btnPass').addEventListener('click', () => send('pass', {}));
$('btnNext').addEventListener('click', () => send('nextRound', {}));

$('btnSort').addEventListener('click', () => {
  if (!state) return;
  handOrder = defaultSort(state.myHand).map(c => c.id);
  renderHand();
  toast('已整理');
});

$('btnLog').addEventListener('click', () => { $('logPanel').hidden = false; });
$('btnLogClose').addEventListener('click', () => { $('logPanel').hidden = true; });

$('btnRules').addEventListener('click', () => { $('rulesPanel').hidden = false; });
$('btnRulesClose').addEventListener('click', () => { $('rulesPanel').hidden = true; });

/* ---------------- 工具 ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let pcSeat = -1;

function openProfile(seat, anchor) {
  const p = state && state.players.find(x => x.seat === seat);
  if (!p) return;
  pcSeat = seat;
  $('pcName').textContent = p.name;
  $('pcReal').textContent = (p.realName && p.realName !== p.name) ? `真名：${p.realName}` : '（没填真名）';
  const card = $('profileCard');
  card.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = 168;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  card.style.left = left + 'px';
  card.style.top = (r.bottom + 8) + 'px';
}

$('pcLike').addEventListener('click', () => {
  if (pcSeat >= 0) send('react', { targetSeat: pcSeat, kind: 'like' });
  $('profileCard').hidden = true;
});
$('pcEgg').addEventListener('click', () => {
  if (pcSeat >= 0) send('react', { targetSeat: pcSeat, kind: 'egg' });
  $('profileCard').hidden = true;
});

document.addEventListener('pointerdown', (e) => {
  const card = $('profileCard');
  if (!card || card.hidden) return;
  if (card.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.avatar')) return;
  card.hidden = true;
}, true);

let lastReactAt = 0;


let lastWindFxAt = 0;

function seatElOf(seat) {
  if (!state) return null;
  const rel = relativeSeat(seat);
  if (rel === 0) return $('myName') ? $('myName').parentElement : null;
  return $(rel === 2 ? 'seat2' : rel === 1 ? 'seat1' : 'seat3');
}

function playWindFx(fx) {
  if (!fx || !state) return;
  const a = seatElOf(fx.from);
  const b = seatElOf(fx.to);
  if (!b) return;

  if (fx.stolen) {
    b.classList.add('wind-stolen');
    setTimeout(() => b.classList.remove('wind-stolen'), 1000);
    toast('风被抢走了！', 1600);
    return;
  }

  if (!a) return;

  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const x1 = ra.left + ra.width / 2, y1 = ra.top + ra.height / 2;
  const x2 = rb.left + rb.width / 2, y2 = rb.top + rb.height / 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wind-svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const cx = (x1 + x2) / 2;
  const cy = Math.min(y1, y2) - 70;
  path.setAttribute('d', `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
  svg.appendChild(path);
  document.body.appendChild(svg);

  try {
    const len = path.getTotalLength();
    for (let i = 0; i < 5; i++) {
      const pt = path.getPointAtLength((len * (i + 1)) / 6);
      const leaf = document.createElement('div');
      leaf.className = 'wind-leaf';
      leaf.textContent = '🍃';
      leaf.style.left = pt.x + 'px';
      leaf.style.top = pt.y + 'px';
      leaf.style.animationDelay = (i * 0.08) + 's';
      document.body.appendChild(leaf);
      setTimeout(() => leaf.remove(), 1600);
    }
  } catch (e) {}

  b.classList.add('wind-hit');
  setTimeout(() => b.classList.remove('wind-hit'), 1000);
  setTimeout(() => svg.remove(), 1200);
}

function seatEle(seat) {
  const rel = relativeSeat(seat);
  if (rel === 0) return $('myName') ? $('myName').parentElement : null;
  return $(rel === 2 ? 'seat2' : rel === 1 ? 'seat1' : 'seat3');
}

function showReact(r) {
  if (!r || !state) return;
  const target = seatEle(r.to);
  if (!target) return;

  if (r.type === 'like') {
    const rect = target.getBoundingClientRect();
    const span = document.createElement('div');
    span.className = 'react-pop';
    span.textContent = '👍';
    span.style.left = (rect.left + rect.width / 2) + 'px';
    span.style.top = (rect.top + 6) + 'px';
    document.body.appendChild(span);
    setTimeout(() => span.remove(), 1400);
    return;
  }

  // 扔鸡蛋：从扔的人飞出去，砸中目标后破裂
  const from = seatEle(r.from) || target;
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const x1 = a.left + a.width / 2, y1 = a.top + a.height / 2;
  const x2 = b.left + b.width / 2, y2 = b.top + b.height / 2;

  const egg = document.createElement('div');
  egg.className = 'egg-fly';
  egg.textContent = '🥚';
  egg.style.left = x1 + 'px';
  egg.style.top = y1 + 'px';
  egg.style.setProperty('--dx', (x2 - x1) + 'px');
  egg.style.setProperty('--dy', (y2 - y1) + 'px');
  document.body.appendChild(egg);

  setTimeout(() => {
    egg.remove();
    splatAt(x2, y2);
    target.classList.add('egg-hit');
    setTimeout(() => target.classList.remove('egg-hit'), 700);
  }, 640);
}

function splatAt(x, y) {
  const s = document.createElement('div');
  s.className = 'egg-splat';
  s.style.left = x + 'px';
  s.style.top = y + 'px';
  for (let i = 0; i < 6; i++) {
    const d = document.createElement('i');
    d.style.setProperty('--a', (i * 60) + 'deg');
    s.appendChild(d);
  }
  document.body.appendChild(s);
  setTimeout(() => s.remove(), 900);
}

/* ---------------- 退出房间 ---------------- */
$('btnExit').addEventListener('click', () => { $('leaveBox').hidden = false; });
$('leaveNo').addEventListener('click', () => { $('leaveBox').hidden = true; });
$('leaveYes').addEventListener('click', () => {
  $('leaveBox').hidden = true;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'leave', data: {} }));
});

/* ---------------- 登录 ---------------- */
$('btnJoin').addEventListener('click', () => {
  myRoom = ($('inRoom').value || 'main').trim() || 'main';
  myName = ($('inName').value || '').trim() || ('玩家' + Math.floor(Math.random() * 90 + 10));
  myRealName = ($('inReal').value || '').trim() || myName;
  try { localStorage.setItem('card_real', myRealName); } catch {}
  connect();
});

$('inName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

(function init() {
  const savedName = localStorage.getItem('card_name');
  if (savedName) $('inName').value = savedName;
  const savedReal = localStorage.getItem('card_real');
  if (savedReal) $('inReal').value = savedReal;
  const savedRoom = localStorage.getItem('card_room');
  if (savedRoom) $('inRoom').value = savedRoom;

  // 链接直进房间：?room=main&name=小明
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('inRoom').value = params.get('room');
  if (params.get('name')) {
    myName = params.get('name').slice(0, 12);
    myRoom = (params.get('room') || 'main').slice(0, 20);
    connect();
    return;
  }

  // 刷新页面自动重连（同一标签页）
  const sid = sessionStorage.getItem('card_playerId');
  if (sid && savedRoom && savedName) {
    myId = sid;
    myRoom = savedRoom;
    myName = savedName;
    connect();
  }
})();

startChaTick();
startWindTick();
initChat();
