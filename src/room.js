// 房间与对局状态机
const { createDeck, shuffle, sortHand, VALUE_TO_RANK } = require('./cards');
const { analyze, canBeat, PATTERN_NAME } = require('./patterns');

const TEAM_OF = (seat) => seat % 2;          // 0,2 一队；1,3 一队
const MATE_OF = (seat) => (seat + 2) % 4;    // 对家座位
const NEXT_SEAT = (seat) => (seat + 1) % 4;

// 等级序列：3..14 对应 3,4,5,6,7,8,9,10,J,Q,K,A
const LEVEL_MIN = 3;
const LEVEL_MAX = 14;
const CHA_WINDOW = 12000;  // 差的有效窗口：出牌后 12 秒

function levelName(v) {
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[v] || String(v);
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = [];          // {id, name, seat, hand, connected, ready}
    this.phase = 'WAITING';     // WAITING | PLAYING | ROUND_END | GAME_OVER
    this.level = { 0: 3, 1: 3 }; // 各队等级
    this.stage = { 0: null, 1: null };   // 特殊阶段
    this.fieldTeam = 0;         // 当前打哪个队的场
    this.dealerSeat = 0;
    this.turn = 0;
    this.lastPlay = null;       // {seat, cards, play}
    this.passed = new Set();
    this.finishOrder = [];      // 出完牌的座位顺序
    this.roundNo = 0;
    this.log = [];              // 对局日志
    this.lastResult = null;     // 上局结算信息
    this.firstRound = true;     // 是否第一局（决定先手与场）

    // 立棍
    this.declare = {};          // seat -> 'PENDING' | 'STICK' | 'PASS'
    this.declareEndsAt = 0;     // 声明截止时间戳
    this.stickMode = null;      // null | 'SOLO'(1打2) | 'DUEL'(1v1)
    this.stickSeats = [];       // 立棍者座位，按点击顺序
    this.outSeats = new Set();  // 本局不参与的座位（立棍者的队友）
    this.declareTimer = null;
    this.stickName = '';        // 最近一次立棍公告
    this.seq = 0;               // 状态版本号，每次动作递增
    this.trickHistory = [];     // 本墩出牌记录，用于「差」的插入判定

    // 给风
    // 队伍：默认对家一队，可在组队阶段自由调整
    this.teamMap = { 0: 0, 1: 1, 2: 0, 3: 1 };
    this.teamPicks = {};        // seat -> 想组队的座位（-1 表示跳过）
    this.teamTimer = null;
    this.teamResult = null;
    this.lastChat = null;       // 最近一条快捷语
    this.lastReact = null;      // 最近一次点赞/扔鸡蛋
    this.lastWindFx = null;     // 最近一次「给风送到队友」特效

    this.giveWind = null;       // { triggerSeat, lastPlay, choices, endsAt, seats }
    this.gwTimer = null;
    this.chooseState = null;    // 对手两人决定谁出
    this.lastReveal = null;     // 上一次给风的揭晓结果
  }

  // ---------- 队伍 ----------
  teamOf(seat) {
    const t = this.teamMap[seat];
    return t === undefined ? seat % 2 : t;
  }

  mateOf(seat) {
    const t = this.teamOf(seat);
    for (const s of [0, 1, 2, 3]) {
      if (s !== seat && this.teamOf(s) === t) return s;
    }
    return -1;
  }

  // ---------- 玩家管理 ----------
  addPlayer(id, name, realName) {
    if (this.players.length >= 4) return null;
    const usedSeats = new Set(this.players.map(p => p.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;
    const p = { id, name: name || `玩家${seat + 1}`, realName: (realName || name || '').slice(0, 12), seat, hand: [], connected: true, ready: false };
    this.players.push(p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.find(x => x.id === id);
    if (!p) return;
    if (this.phase === 'WAITING') {
      this.players = this.players.filter(x => x.id !== id);
    } else {
      p.connected = false;
    }
  }

  // 真删除，不管牌局有没有在打（用于长时间掉线的腾位）
  kickPlayer(id) {
    const before = this.players.length;
    this.players = this.players.filter(x => x.id !== id);
    return this.players.length < before;
  }

  getPlayer(id) { return this.players.find(p => p.id === id); }
  getBySeat(seat) { return this.players.find(p => p.seat === seat); }

  setReady(id, v) {
    const p = this.getPlayer(id);
    if (p) p.ready = v;
  }

  allReady() {
    return this.players.length === 4 && this.players.every(p => p.ready);
  }

  // ---------- 组队 ----------
  beginTeamStage() {
    if (this.players.length !== 4) return false;
    this.phase = 'TEAM';
    this.teamPicks = {};
    this.teamMap = { 0: 0, 1: 1, 2: 0, 3: 1 };
    this.teamResult = null;
    this.addLog('组队阶段：选一个你想搭档的人，或者直接跳过（默认对家一队）');
    if (this.teamTimer) clearTimeout(this.teamTimer);
    this.teamTimer = setTimeout(() => this.resolveTeams(), 30000);
    return true;
  }

  submitTeamPick(playerId, targetSeat, skip) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'TEAM') return { ok: false, msg: '现在不是组队阶段' };
    if (this.teamPicks[p.seat] !== undefined) return { ok: false, msg: '你已经选过了' };

    if (skip) {
      this.teamPicks[p.seat] = -1;
    } else {
      if (targetSeat === p.seat) return { ok: false, msg: '不能选自己' };
      if (!this.getBySeat(targetSeat)) return { ok: false, msg: '那个人不在' };
      this.teamPicks[p.seat] = targetSeat;
    }

    this.seq++;
    if (this.players.every(x => this.teamPicks[x.seat] !== undefined)) {
      this.resolveTeams();
    }
    return { ok: true };
  }

  resolveTeams() {
    if (this.phase !== 'TEAM') return;
    if (this.teamTimer) { clearTimeout(this.teamTimer); this.teamTimer = null; }

    const seats = [0, 1, 2, 3].filter(s => this.getBySeat(s));
    const picks = this.teamPicks;

    // 1. 互选优先成队
    const paired = [];
    for (const a of seats) {
      const b = picks[a];
      if (b >= 0 && picks[b] === a && !paired.includes(a) && !paired.includes(b)) {
        paired.push(a, b);
      }
    }

    // 2. 剩下的按顺序补齐
    const rest = seats.filter(s => !paired.includes(s));
    while (rest.length >= 2) {
      const a = rest.shift();
      let idx = rest.findIndex(s => picks[s] === a);
      if (idx < 0) idx = 0;
      const b = rest.splice(idx, 1)[0];
      paired.push(a, b);
    }

    const allSkip = this.players.every(x => this.teamPicks[x.seat] === -1);

    if (paired.length >= 4) {
      // 把两支队摆成对家：第一队占 0 和 2，队友必须隔一个座
      const first = paired[0];
      const want = (first + 2) % 4;
      if (paired[1] !== want) {
        const pa = this.getBySeat(paired[1]);
        const pb = this.getBySeat(want);
        if (pa && pb) {
          pa.seat = want;
          pb.seat = paired[1];
          this.addLog(`为了让队友坐到对面，${pa.name} 和 ${pb.name} 换了位置`);
        }
      }
    }

    this.teamMap = { 0: 0, 1: 1, 2: 0, 3: 1 };

    this.teamResult = {
      map: this.teamMap,
      text: allSkip ? '默认对家一队' : `${this.teamNames(0)} VS ${this.teamNames(1)}`,
    };
    this.addLog(`组队结果：${this.teamResult.text}`);

    this.phase = 'WAITING';
    this.startGame();
  }

  say(playerId, text) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    const t = String(text || '').trim().slice(0, 40);
    if (!t) return { ok: false, msg: '说点什么吧' };

    this.lastChat = { seat: p.seat, name: p.name, text: t, at: Date.now() };
    this.addLog(`${p.name}：${t}`);
    this.seq++;
    return { ok: true };
  }

  react(playerId, targetSeat, type) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    const t = this.getBySeat(targetSeat);
    if (!t) return { ok: false, msg: '对方不在' };
    if (p.seat === targetSeat) return { ok: false, msg: '不能对自己' };

    const kind = type === 'egg' ? 'egg' : 'like';
    this.lastReact = {
      from: p.seat, fromName: p.name,
      to: targetSeat, toName: t.name,
      type: kind, at: Date.now(),
    };
    this.addLog(kind === 'egg'
      ? `${p.name} 朝 ${t.name} 扔了个鸡蛋`
      : `${p.name} 给 ${t.name} 点了个赞`);
    this.seq++;
    return { ok: true };
  }

  teamNames(teamId) {
    return [0, 1, 2, 3]
      .filter(s => this.teamMap[s] === teamId)
      .map(s => (this.getBySeat(s) ? this.getBySeat(s).name : ''))
      .filter(Boolean)
      .join(' + ');
  }

  // ---------- 开局 ----------
  // 遣散房间：任何人点一下，所有人都被请出房间
  dismissRoom(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };

    const byName = p.name;
    const ids = this.players.map(x => x.id);

    this.players = [];
    this.phase = 'WAITING';
    this.level = { 0: 3, 1: 3 };
    this.stage = { 0: null, 1: null };   // 特殊阶段
    this.roundNo = 0;
    this.firstRound = true;
    this.stickMode = null;
    this.stickSeats = [];
    this.finishOrder = [];
    this.passed.clear();
    this.lastPlay = null;
    this.trickHistory = [];
    this.lastReveal = null;
    this.lastChat = null;
    this.lastReact = null;
    this.lastWindFx = null;
    this.giveWind = null;
    this.chooseState = null;
    this.outSeats = new Set();
    this.teamPick = { 0: -1, 1: -1, 2: -1, 3: -1 };
    this.dealerSeat = 0;
    this.seq++;

    return { ok: true, ids, byName };
  }

  // 任何人都有权重开：全场清空，回到起点重新组队发牌
  restartGame(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.players.length < 4) return { ok: false, msg: '还没坐满四个人' };

    for (const x of this.players) {
      x.hand = [];
      x.out = false;
      x.ready = false;
    }
    this.level = { 0: 3, 1: 3 };
    this.stage = { 0: null, 1: null };   // 特殊阶段
    this.roundNo = 0;
    this.firstRound = true;
    this.stickMode = null;
    this.stickSeats = [];
    this.finishOrder = [];
    this.passed.clear();
    this.lastPlay = null;
    this.trickHistory = [];
    this.lastReveal = null;
    this.lastReact = null;
    this.lastWindFx = null;
    this.giveWind = null;
    this.chooseState = null;
    this.teamMap = { 0: 0, 1: 1, 2: 0, 3: 1 };
    this.teamPick = { 0: -1, 1: -1, 2: -1, 3: -1 };
    this.dealerSeat = 0;
    this.outSeats = new Set();
    this.winnerTeam = -1;
    this.seq++;

    this.addLog(`${p.name} 重开了游戏，全部回到起点`);

    this.phase = 'TEAM';
    this.teamPick = { 0: -1, 1: -1, 2: -1, 3: -1 };
    this.teamNames = ['A', 'B'];
    return { ok: true, restarted: true, byName: p.name };
  }

  // 逢 3、J、A 必打：必须打完所有名次，立棍也不能提前结算
  // 这局该不该结束了：三人出完，或者同一队两人都出完（胜负已定）
  canSettle() {
    const activeCount = 4 - this.outSeats.size;
    if (this.finishOrder.length >= activeCount - 1) return true;
    const t0 = this.finishOrder.filter(s => this.teamOf(s) === 0).length;
    const t1 = this.finishOrder.filter(s => this.teamOf(s) === 1).length;
    return t0 >= 2 || t1 >= 2;
  }

  isMustFinish() {
    return this.currentLevel === 3 || this.currentLevel === 11 || this.currentLevel === LEVEL_MAX;
  }

  startGame() {
    if (this.players.length !== 4) return false;
    this.level = { 0: 3, 1: 3 };
    this.stage = { 0: null, 1: null };   // 特殊阶段
    this.roundNo = 0;
    this.firstRound = true;
    this.phase = 'PLAYING';
    this.startRound();
    return true;
  }

  startRound() {
    this.roundNo++;
    // 发牌（先按上家切的位置重组牌堆）
    let deck = shuffle(createDeck());
    if (this.cutIndex > 0) {
      deck = deck.slice(this.cutIndex).concat(deck.slice(0, this.cutIndex));
    }
    this.cutIndex = 0;
    for (const p of this.players) p.hand = [];
    for (let i = 0; i < 54; i++) {
      const seat = (this.dealerSeat + i) % 4;
      const p = this.getBySeat(seat);
      p.hand.push(deck[i]);
    }
    for (const p of this.players) p.hand = sortHand(p.hand);

    this.finishOrder = [];
    this.passed.clear();
    this.lastPlay = null;
    this.trickHistory = [];
    this.clearWindState();
    this.lastReveal = null;

    if (this.firstRound) {
      // 第一局：持红桃 2 者先出；打持红桃 3 者所属队伍的场
      const h2 = this.getBySeat(0) && this.players.find(p => p.hand.some(c => c.rank === '2' && c.suit === 'H'));
      const h3 = this.players.find(p => p.hand.some(c => c.rank === '3' && c.suit === 'H'));
      this.turn = h2 ? h2.seat : this.dealerSeat;
      this.fieldTeam = h3 ? this.teamOf(h3.seat) : 0;
      this.firstRound = false;
    } else {
      // 后续：庄先出，打庄的场
      this.turn = this.dealerSeat;
      this.fieldTeam = this.teamOf(this.dealerSeat);
    }

    this.currentLevel = this.level[this.fieldTeam];
    this.addLog(`第 ${this.roundNo} 局开始，打 ${levelName(this.currentLevel)}（${this.fieldTeam === 0 ? 'A' : 'B'} 队场）`);
    this.beginDeclare();
  }

  // ---------- 立棍声明 ----------
  beginDeclare() {
    this.declare = {};
    for (const p of this.players) this.declare[p.seat] = 'PENDING';
    this.declareEndsAt = Date.now() + 60000;
    this.stickMode = null;
    this.stickSeats = [];
    this.outSeats = new Set();
    this.stickName = '';
    this.phase = 'DECLARE';
    if (this.declareTimer) clearTimeout(this.declareTimer);
    this.declareTimer = setTimeout(() => this.finishDeclare(), 60000);
  }

  declareStick(playerId, want) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'DECLARE') return { ok: false, msg: '现在不是立棍时间' };
    if (this.declare[p.seat] !== 'PENDING') return { ok: false, msg: '你已经选过了' };

    if (!want) {
      this.declare[p.seat] = 'PASS';
      if (this.stickRequest && this.stickRequest.mateSeat === p.seat) {
        this.stickRequest = null;
      }
      this.checkAllChosen();
      return { ok: true };
    }

    // 想立棍：必须队友点头
    const mateSeat = this.mateOf(p.seat);
    const mate = this.getBySeat(mateSeat);
    if (!mate) return { ok: false, msg: '队友不在，立不了棍' };
    if (this.stickRequest) return { ok: false, msg: '已经有一个申请在等回复' };

    this.stickRequest = { seat: p.seat, name: p.name, mateSeat, at: Date.now() };
    this.addLog(`${p.name} 想立棍，等 ${mate.name} 点头`);
    this.seq++;
    return { ok: true, requested: true };
  }

  // 队友回应立棍申请
  answerStick(playerId, agree) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'DECLARE') return { ok: false, msg: '现在不是立棍时间' };

    const req = this.stickRequest;
    if (!req || req.mateSeat !== p.seat) return { ok: false, msg: '没有待处理的申请' };

    if (agree) {
      this.declare[req.seat] = 'STICK';
      this.stickSeats.push(req.seat);
      this.stickName = req.name;
      this.declare[p.seat] = 'STICK_MATE';
      this.addLog(`${p.name} 点头了，${req.name} 立棍！`);
    } else {
      this.declare[req.seat] = 'PASS';
      this.declare[p.seat] = 'PASS';
      this.addLog(`${p.name} 没同意，这把不立棍`);
    }
    this.stickRequest = null;
    this.checkAllChosen();
    this.seq++;
    return { ok: true, agree };
  }

  checkAllChosen() {
    if (this.phase !== 'DECLARE') return;
    if (this.stickRequest) return;
    const allChosen = this.players.every(x => this.declare[x.seat] !== 'PENDING');
    if (allChosen) this.finishDeclare();
  }

  finishDeclare() {
    if (this.phase !== 'DECLARE') return;
    if (this.declareTimer) { clearTimeout(this.declareTimer); this.declareTimer = null; }
    this.stickRequest = null;

    const stickers = this.stickSeats.slice();

    if (stickers.length === 0) {
      this.stickMode = null;
      this.addLog('无人立棍，正常开打');
    } else if (stickers.length === 1) {
      const s = stickers[0];
      this.stickMode = 'SOLO';
      const mateSeat = this.mateOf(s);
      this.outSeats.add(mateSeat);
      const mate = this.getBySeat(mateSeat);
      if (mate) mate.hand = [];
      this.turn = s;
      this.addLog(`${this.getBySeat(s).name} 一打二，${mate ? mate.name : '队友'} 本局不参与`);
    } else {
      const [first, second] = stickers;
      this.stickMode = 'DUEL';
      for (const s of stickers) {
        const mateSeat = this.mateOf(s);
        this.outSeats.add(mateSeat);
        const mate = this.getBySeat(mateSeat);
        if (mate) mate.hand = [];
      }
      this.turn = second; // 后立者先出
      this.addLog(`${this.getBySeat(first).name} 与 ${this.getBySeat(second).name} 单挑，后立者先出`);
    }

    this.lastPlay = null;
    this.passed.clear();
    this.phase = 'PLAYING';
    this.declareEndsAt = 0;
  }

  // ---------- 出牌 ----------
  play(playerId, cardIds, asMap) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'PLAYING') return { ok: false, msg: '当前不是打牌阶段' };
    if (p.seat !== this.turn) return { ok: false, msg: '还没轮到你' };
    if (!cardIds || cardIds.length === 0) return { ok: false, msg: '请选择要出的牌' };

    // 取牌并校验
    const cards = [];
    for (const cid of cardIds) {
      const idx = p.hand.findIndex(c => c.id === cid);
      if (idx < 0) return { ok: false, msg: '牌不在手上' };
      cards.push(p.hand[idx]);
    }

    // 配牌必须指定变身
    const asMapSafe = asMap || {};
    for (const c of cards) {
      if (c.joker) {
        const as = asMapSafe[c.id];
        if (!as || as < 3 || as > 15) return { ok: false, msg: '配牌需要指定变成哪张牌' };
        c.as = as;
      }
    }

    // 牌型判定
    const play = analyze(cards, this.currentLevel);
    if (!play) return { ok: false, msg: '这不是合法牌型' };

    // 管牌校验：自己出的牌不用管；被差锁死的牌谁都不用管
    if (this.lastPlay && this.lastPlay.seat !== p.seat && !this.lastPlay.locked) {
      if (!canBeat(play, this.lastPlay.play)) {
        return { ok: false, msg: `管不上（当前是 ${PATTERN_NAME[this.lastPlay.play.pattern]}）` };
      }
    }

    // 执行出牌
    for (const c of cards) {
      const idx = p.hand.findIndex(x => x.id === c.id);
      p.hand.splice(idx, 1);
    }

    // 复原配牌的 as（手牌里不保留临时状态）
    const shown = cards.map(c => ({ ...c }));

    this.seq++;
    this.trickHistory.push({ seat: p.seat, cards: shown, at: Date.now(), isCha: false });
    this.lastPlay = { seat: p.seat, cards: shown, play };
    this.passed.clear();
    this.addLog(`${p.name} 出了 ${shown.map(c => c.joker ? `${c.rank}(当${c.as})` : c.rank).join(' ')}`);

    // 是否出完
    if (p.hand.length === 0) {
      this.finishOrder.push(p.seat);
      this.addLog(`${p.name} 出完了（第 ${this.finishOrder.length} 名）`);
      // 立棍者第一个出完
      if (this.stickMode === 'SOLO' && p.seat === this.stickSeats[0]) {
        if (this.isMustFinish()) {
          // 必打局：立棍归立棍，但名次得排完，剩下两人继续争第三
          this.addLog(`这是必打局（打 ${levelName(this.currentLevel)}），${p.name} 虽已立棍出完，剩下两位继续争第三`);
          this.advanceTurn();
          return { ok: true, continued: true };
        }
        this.settleRound();
        return { ok: true, roundEnd: true };
      }

      if (this.canSettle()) {
        this.settleRound();
        return { ok: true, roundEnd: true };
      }
      // 第一个人出完 → 进入给风
      if (this.finishOrder.length === 1) {
        const started = this.startGiveWind(p.seat);
        if (started) return { ok: true, giveWind: true };
      }
    }

    this.advanceTurn();
    return { ok: true };
  }

  pass(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'PLAYING') return { ok: false, msg: '当前不是打牌阶段' };
    if (p.seat !== this.turn) return { ok: false, msg: '还没轮到你' };
    if (!this.lastPlay) return { ok: false, msg: '你是本轮先手，必须出牌' };
    if (this.lastPlay.seat === p.seat) return { ok: false, msg: '你是本轮先手，必须出牌' };

    this.seq++;
    this.passed.add(p.seat);
    this.addLog(`${p.name} 过了`);
    this.advanceTurn();
    return { ok: true };
  }

  // ---------- 差 ----------
  // 找出该座位"能差"的目标（最近一手、5 秒内、别人出的单张、手里有同点天然对子）
  getChaTarget(seat) {
    const p = this.getBySeat(seat);
    if (!p || this.phase !== 'PLAYING') return null;
    const now = Date.now();

    for (let i = this.trickHistory.length - 1; i >= 0; i--) {
      const h = this.trickHistory[i];
      if (h.locked) continue;                     // 被差锁死的牌不能再被差
      if (now - h.at > CHA_WINDOW) continue;
      if (h.seat === seat) continue;              // 不能差自己
      if (h.cards.length !== 1) continue;         // 只能差单张

      const card = h.cards[0];
      const v = card.joker ? card.as : card.value;
      if (!v) continue;
      if (v === this.currentLevel) continue;      // 等级牌对子按炸弹算，不能差

      const same = p.hand.filter(c => !c.joker && c.value === v);
      if (same.length >= 2) {
        return { index: i, value: v, history: h };
      }
    }
    return null;
  }

  chaTrick(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'PLAYING') return { ok: false, msg: '现在不能差' };

    const target = this.getChaTarget(p.seat);
    if (!target) return { ok: false, msg: '不能差（需要同点数天然对子，且在被出后 5 秒内）' };

    // 1. 把目标之后出的牌全部退回，并公开
    for (let k = this.trickHistory.length - 1; k > target.index; k--) {
      const later = this.trickHistory[k];
      const lp = this.getBySeat(later.seat);
      if (lp) {
        lp.hand.push(...later.cards);
        lp.hand = sortHand(lp.hand);
        this.addLog(`${lp.name} 出的牌被差退回（${later.cards.map(c => c.joker ? c.rank : c.rank).join(' ')}）`);
      }
    }

    // 2. 差者打出对子
    const v = target.value;
    const pair = p.hand.filter(c => !c.joker && c.value === v).slice(0, 2);
    for (const c of pair) {
      const idx = p.hand.findIndex(x => x.id === c.id);
      p.hand.splice(idx, 1);
    }

    const shown = pair.map(c => ({ ...c }));
    const play = analyze(pair, this.currentLevel);

    this.seq++;
    // 差出去的牌锁死：留在场上，但谁都不能管，直接轮到差的人继续出
    this.trickHistory = [{ seat: p.seat, cards: shown, at: Date.now(), isCha: true, locked: true }];
    this.lastPlay = { seat: p.seat, cards: shown, play, locked: true };
    this.passed.clear();
    this.addLog(`${p.name} 喊差！打出对 ${VALUE_TO_RANK[v] || v}，这手牌锁死，谁都不能管`);

    // 3. 出完检查
    if (p.hand.length === 0) {
      this.finishOrder.push(p.seat);
      this.addLog(`${p.name} 出完了（第 ${this.finishOrder.length} 名）`);
      if (this.canSettle()) {
        this.settleRound();
        return { ok: true, roundEnd: true };
      }
    }

    // 4. 差者接着出（场上已清空，自由出牌）
    this.turn = p.seat;
    if (p.hand.length === 0) {
      this.advanceTurn();
    }
    this.turnAt = Date.now();
    return { ok: true };
  }

  // ---------- 超时托管 ----------
  // 轮到某人却一直不动（掉线、卡住），帮他把这一手过掉，避免全桌僵死
  autoPlay() {
    if (this.phase !== 'PLAYING') return false;
    const p = this.getBySeat(this.turn);
    if (!p || p.hand.length === 0) return false;

    // 锁死的牌、自己出的牌，都算自由出
    const mustFollow = this.lastPlay && this.lastPlay.seat !== p.seat && !this.lastPlay.locked;

    if (mustFollow) {
      this.passed.add(p.seat);
      this.addLog(`${p.name} 超时，自动过牌`);
      this.seq++;
      this.advanceTurn();
    } else {
      const normal = p.hand.filter(c => !c.joker).sort((a, b) => a.value - b.value);
      const card = normal[0] || p.hand[0];
      if (card.joker) card.as = 4;
      const idx = p.hand.findIndex(x => x.id === card.id);
      if (idx < 0) return false;
      p.hand.splice(idx, 1);

      const shown = [{ ...card }];
      const play = analyze(shown, this.currentLevel);
      if (!play) return false;

      this.seq++;
      this.trickHistory.push({ seat: p.seat, cards: shown, at: Date.now(), isCha: false });
      this.lastPlay = { seat: p.seat, cards: shown, play };
      this.passed.clear();
      this.addLog(`${p.name} 超时，自动出 ${card.rank}`);

      if (p.hand.length === 0) {
        this.finishOrder.push(p.seat);
        this.addLog(`${p.name} 出完了（第 ${this.finishOrder.length} 名）`);
        if (this.stickMode === 'SOLO' && p.seat === this.stickSeats[0]) {
          if (this.isMustFinish()) {
            this.addLog(`必打局，${p.name} 立棍出完，剩下两人继续争第三`);
            this.advanceTurn();
            return true;
          }
          this.settleRound();
          return true;
        }
        if (this.canSettle()) {
          this.settleRound();
          return true;
        }
        if (this.finishOrder.length === 1 && this.startGiveWind(p.seat)) {
          return true;
        }
      }
      this.advanceTurn();
    }

    this.turnAt = Date.now();
    return true;
  }

  // ---------- 给风 ----------
  startGiveWind(triggerSeat) {
    const activeSeats = [0, 1, 2, 3].filter(
      s => !this.finishOrder.includes(s) && !this.outSeats.has(s)
    );
    const mateSeat = this.mateOf(triggerSeat);
    if (activeSeats.length !== 3 || !activeSeats.includes(mateSeat)) return false;

    const trigger = this.getBySeat(triggerSeat);
    this.phase = 'GIVE_WIND';
    this.giveWind = {
      triggerSeat,
      lastPlay: this.lastPlay,
      choices: {},
      seats: activeSeats,
      endsAt: Date.now() + 15000,
    };
    this.lastReveal = null;
    this.addLog(`${trigger.name} 出完了，进入给风：剩下三人同时选择`);
    if (this.gwTimer) clearTimeout(this.gwTimer);
    this.gwTimer = setTimeout(() => this.finishGiveWind(), 15000);
    return true;
  }

  submitWind(playerId, action, cardIds, asMap) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'GIVE_WIND' || !this.giveWind) return { ok: false, msg: '现在不是给风阶段' };
    if (!this.giveWind.seats.includes(p.seat)) return { ok: false, msg: '你不参与这次给风' };
    if (this.giveWind.choices[p.seat]) return { ok: false, msg: '你已经选过了' };

    const mateSeat = this.mateOf(this.giveWind.triggerSeat);

    if (action === 'pass') {
      this.giveWind.choices[p.seat] = { action: 'pass' };
    } else if (action === 'play') {
      if (!cardIds || !cardIds.length) return { ok: false, msg: '请选择要出的牌' };
      const cards = [];
      for (const cid of cardIds) {
        const idx = p.hand.findIndex(c => c.id === cid);
        if (idx < 0) return { ok: false, msg: '牌不在手上' };
        cards.push(p.hand[idx]);
      }
      for (const c of cards) {
        if (c.joker) {
          const as = asMap && asMap[c.id];
          if (!as || as < 3 || as > 15) return { ok: false, msg: '配牌需要指定变成哪张牌' };
          c.as = as;
        }
      }
      const play = analyze(cards, this.currentLevel);
      if (!play) return { ok: false, msg: '这不是合法牌型' };
      if (!canBeat(play, this.giveWind.lastPlay.play)) {
        return { ok: false, msg: '管不上他最后出的那张牌' };
      }
      this.giveWind.choices[p.seat] = {
        action: 'play',
        cards: cards.map(c => ({ ...c })),
        play,
      };
    } else if (action === 'cha') {
      if (p.seat === mateSeat) return { ok: false, msg: '队友不需要差' };
      const target = this.giveWind.lastPlay;
      if (!target || target.cards.length !== 1) return { ok: false, msg: '对象不是单张，不能差' };
      const c0 = target.cards[0];
      const v = c0.joker ? c0.as : c0.value;
      if (!v || v === this.currentLevel) return { ok: false, msg: '等级牌不能差' };
      const pair = p.hand.filter(c => !c.joker && c.value === v);
      if (pair.length < 2) return { ok: false, msg: '你没有同点数的两张天然牌' };
      this.giveWind.choices[p.seat] = {
        action: 'cha',
        cards: [pair[0], pair[1]].map(c => ({ ...c })),
      };
    } else {
      return { ok: false, msg: '未知操作' };
    }

    this.seq++;
    if (this.giveWind.seats.every(s => this.giveWind.choices[s])) {
      this.finishGiveWind();
    }
    return { ok: true };
  }

  finishGiveWind() {
    if (this.phase !== 'GIVE_WIND' || !this.giveWind) return;
    if (this.gwTimer) { clearTimeout(this.gwTimer); this.gwTimer = null; }

    const { triggerSeat, seats, choices } = this.giveWind;
    for (const s of seats) {
      if (!choices[s]) choices[s] = { action: 'pass' };
    }

    const mateSeat = this.mateOf(triggerSeat);
    const oppSeats = seats.filter(s => s !== mateSeat);

    const reveal = {
      triggerSeat,
      at: Date.now(),
      items: seats.map(s => {
        const pl = this.getBySeat(s);
        const c = choices[s];
        return {
          seat: s,
          name: pl ? pl.name : '?',
          isMate: s === mateSeat,
          action: c.action,
          text: c.action === 'pass' ? '不管'
            : c.action === 'cha' ? '差！'
            : '管（' + c.cards.map(x => x.rank).join(' ') + '）',
        };
      }),
      result: '',
    };

    // 1. 对手用差，优先级最高
    const chaOpp = oppSeats.find(s => choices[s].action === 'cha');
    if (chaOpp) {
      reveal.result = `${this.getBySeat(chaOpp).name} 用差拦截成功`;
      this.lastReveal = reveal;
      this.addLog(`给风结果：${reveal.result}`);
      this.executeWindCha(chaOpp);
      return;
    }

    // 2. 队友管住，优先给队友
    if (choices[mateSeat].action === 'play') {
      reveal.result = '队友接住了风，接着往下打';
      this.lastReveal = reveal;
      this.lastWindFx = { from: triggerSeat, to: mateSeat, at: Date.now() };
      this.addLog(`给风结果：${reveal.result}`);
      this.executeWindPlay(mateSeat, choices[mateSeat]);
      return;
    }

    // 3. 对手管住
    const oppPlays = oppSeats.filter(s => choices[s].action === 'play');
    if (oppPlays.length === 1) {
      reveal.result = `${this.getBySeat(oppPlays[0]).name} 拦截成功`;
      this.lastReveal = reveal;
      this.lastWindFx = { from: triggerSeat, to: oppPlays[0], at: Date.now(), stolen: true };
      this.addLog(`给风结果：${reveal.result}`);
      this.executeWindPlay(oppPlays[0], choices[oppPlays[0]]);
      return;
    }
    if (oppPlays.length === 2) {
      reveal.result = '两名对手都管住了，由他们决定谁出';
      this.lastReveal = reveal;
      this.giveWind = null;
      this.phase = 'GIVE_WIND_CHOOSE';
      this.chooseState = { candidates: oppPlays, picks: {}, triggerSeat, choices };
      this.addLog('两名对手都管住了，等他们决定谁出');
      // 兜底：两人都不点，60 秒后按顺序让第一个出
      setTimeout(() => {
        if (this.phase === 'GIVE_WIND_CHOOSE' && this.chooseState) this.finishChoose();
      }, 60000);
      return;
    }

    // 4. 无人管，队友自由出牌
    reveal.result = '没人管，队友自由出牌';
    this.lastReveal = reveal;
    this.lastWindFx = { from: triggerSeat, to: mateSeat, at: Date.now() };
    this.addLog(`给风结果：${reveal.result}`);
    this.giveWind = null;
    this.phase = 'PLAYING';
    this.turn = mateSeat;
    this.lastPlay = null;
    this.trickHistory = [];
    this.passed.clear();
    this.seq++;
  }

  executeWindPlay(seat, choice) {
    const p = this.getBySeat(seat);
    for (const c of choice.cards) {
      const idx = p.hand.findIndex(x => x.id === c.id);
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    const shown = choice.cards.map(c => ({ ...c }));

    this.seq++;
    this.trickHistory = [{ seat, cards: shown, at: Date.now(), isCha: false }];
    this.lastPlay = { seat, cards: shown, play: choice.play };
    this.passed.clear();
    this.giveWind = null;
    this.phase = 'PLAYING';
    this.addLog(`${p.name} 接风，出了 ${shown.map(c => c.rank).join(' ')}`);

    if (p.hand.length === 0) {
      this.finishOrder.push(seat);
      if (this.canSettle()) {
        this.settleRound();
        return;
      }
    }

    this.turn = seat;
    this.advanceTurn();
  }

  executeWindCha(seat) {
    const p = this.getBySeat(seat);
    const lp = this.giveWind.lastPlay;
    const c0 = lp.cards[0];
    const v = c0.joker ? c0.as : c0.value;
    const pair = p.hand.filter(c => !c.joker && c.value === v).slice(0, 2);

    for (const c of pair) {
      const idx = p.hand.findIndex(x => x.id === c.id);
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    const shown = pair.map(c => ({ ...c }));
    const play = analyze(shown, this.currentLevel);

    this.seq++;
    this.trickHistory = [{ seat, cards: shown, at: Date.now(), isCha: true, locked: true }];
    this.lastPlay = { seat, cards: shown, play, locked: true };
    this.passed.clear();
    this.giveWind = null;
    this.phase = 'PLAYING';
    this.addLog(`${p.name} 用差拦截，打出对 ${VALUE_TO_RANK[v] || v}，锁死，他继续出`);

    if (p.hand.length === 0) {
      this.finishOrder.push(seat);
      if (this.canSettle()) {
        this.settleRound();
        return;
      }
    }

    this.turn = seat;
    if (p.hand.length === 0) this.advanceTurn();
  }

  chooseWind(playerId, choice) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.phase !== 'GIVE_WIND_CHOOSE' || !this.chooseState) {
      return { ok: false, msg: '现在不是选择阶段' };
    }
    if (!this.chooseState.candidates.includes(p.seat)) return { ok: false, msg: '你不参与选择' };
    if (this.chooseState.picks[p.seat]) return { ok: false, msg: '你已经选过了' };

    this.chooseState.picks[p.seat] = {
      choice: choice === 'me' ? 'me' : 'not',
      at: Date.now(),
    };
    this.seq++;

    if (this.chooseState.candidates.every(s => this.chooseState.picks[s])) {
      this.finishChoose();
    }
    return { ok: true };
  }

  finishChoose() {
    const { candidates, picks, choices, triggerSeat } = this.chooseState;
    let chosen = null;
    let earliest = Infinity;
    for (const s of candidates) {
      const pk = picks[s];
      if (pk && pk.choice === 'me' && pk.at < earliest) {
        earliest = pk.at;
        chosen = s;
      }
    }
    if (chosen === null) chosen = candidates[0];

    this.chooseState = null;
    this.lastWindFx = { from: triggerSeat, to: chosen, at: Date.now(), stolen: true };
    this.addLog(`${this.getBySeat(chosen).name} 来出`);
    this.executeWindPlay(chosen, choices[chosen]);
  }

  advanceTurn() {
    const active = [0, 1, 2, 3].filter(s => !this.finishOrder.includes(s) && !this.outSeats.has(s));
    if (active.length <= 1) return;

    // 顺时针找下一个仍在场的座位
    let next = this.turn;
    do { next = NEXT_SEAT(next); } while (!active.includes(next));

    if (!this.lastPlay) {
      this.turn = next;
      return;
    }

    // 差锁死的牌：不用谁去管，直接清场往下走
    if (this.lastPlay.locked) {
      this.lastPlay = null;
      this.passed.clear();
      this.turn = next;
      return;
    }

    const lpSeat = this.lastPlay.seat;

    // 一圈转回出牌者 → 清空，由他自由出牌
    if (next === lpSeat && active.includes(lpSeat)) {
      this.lastPlay = null;
      this.passed.clear();
      this.trickHistory = [];
      this.turn = next;
      return;
    }

    // 出牌者已出完/退出：其余在场玩家都过了 → 由下家自由出牌
    if (!active.includes(lpSeat)) {
      const others = active.filter(s => s !== lpSeat);
      const allPassed = others.every(s => this.passed.has(s));
      if (allPassed) {
        this.lastPlay = null;
        this.passed.clear();
        this.trickHistory = [];
        this.turn = next;
        return;
      }
    }

    this.turn = next;
  }

  // ---------- 结算 ----------
  clearWindState() {
    if (this.gwTimer) { clearTimeout(this.gwTimer); this.gwTimer = null; }
    this.giveWind = null;
    this.chooseState = null;
  }

  settleRound() {
    this.clearWindState();
    if (this.stickMode) return this.settleStickRound();

    const first = this.finishOrder[0];
    const winTeam = this.teamOf(first);
    const loseTeam = 1 - winTeam;
    const mate = this.mateOf(first);
    const mateRank = this.finishOrder.indexOf(mate) + 1; // 2/3/4

    const bigWin = mateRank === 2;
    const smallWin = mateRank === 3;

    const before = this.level[winTeam];
    let after = before;
    let winStage = this.stage[winTeam];

    let loseAfter = this.level[loseTeam];
    let loseStage = this.stage[loseTeam];
    const loseBefore = loseAfter;

    let gameOver = false;
    let note = '';

    // ---------- 赢方 ----------
    if (winStage === 'DEAD') {
      note = '已钉死在 3，升不上去了';
    } else if (winStage === 'A') {
      if (bigWin) {
        gameOver = true;
        note = 'A 局大赢，赢下整场';
      } else {
        note = 'A 局没拿到大赢，留在 A';
      }
    } else if (winStage === 'J_FALLBACK') {
      if (bigWin) {
        after = 14; winStage = 'A';
        note = '回退局大赢，回到 A';
      } else {
        note = '没拿到大赢，留在 J';
      }
    } else if (winStage === 'THREE_SPECIAL') {
      if (bigWin) {
        after = 11; winStage = 'J_FALLBACK';
        note = '特殊 3 大赢，回到 J';
      } else {
        note = '没拿到大赢，留在 3';
      }
    } else {
      // 正常场：3~10、Q、K
      const up = bigWin ? 2 : smallWin ? 1 : 0;
      let target = before + up;
      if (before < 11 && target > 11) target = 11; // 不能跳过 J
      if (target > 14) target = 14;                // 封顶 A
      after = target;
      if (after === 14) winStage = 'A';
      note = up > 0 ? `升 ${up} 级` : '平局，不升级';
    }

    // ---------- 输方 ----------
    if (loseAfter === 14) {
      loseAfter = 11; loseStage = 'J_FALLBACK';
      note += '；对方从 A 退到 J';
    } else if (loseAfter === 11) {
      loseAfter = 3; loseStage = 'THREE_SPECIAL';
      note += '；对方从 J 退到 3';
    } else if (loseStage === 'THREE_SPECIAL') {
      loseStage = 'DEAD';
      note += '；对方钉死在 3';
    }

    this.level[winTeam] = after;
    this.stage[winTeam] = winStage;
    this.level[loseTeam] = loseAfter;
    this.stage[loseTeam] = loseStage;

    this.lastResult = {
      winTeam,
      loseTeam,
      firstSeat: first,
      finishOrder: this.finishOrder.slice(),
      up: after - before,
      before,
      after,
      loseBefore,
      loseAfter,
      bigWin,
      smallWin,
      mateRank,
      gameOver,
      note,
    };

    const rankName = bigWin ? '大赢' : smallWin ? '小赢' : '平局';
    this.addLog(`本局结束：${winTeam === 0 ? 'A' : 'B'} 队${rankName}，${note}`);

    if (gameOver) {
      this.phase = 'GAME_OVER';
    } else {
      this.phase = 'ROUND_END';
      this.dealerSeat = first; // 谁第一个出完，下一局打谁的场
    }
  }

  // 立棍/单挑局结算：赢家升 4 级
  settleStickRound() {
    const first = this.finishOrder[0];
    let upTeam, note;

    if (this.stickMode === 'SOLO') {
      const solo = this.stickSeats[0];
      const soloWin = first === solo;
      upTeam = soloWin ? this.teamOf(solo) : 1 - this.teamOf(solo);
      note = soloWin ? '立棍获胜，升 4 级' : '立棍失败，对方升 4 级';
    } else {
      upTeam = this.teamOf(first);
      note = '单挑获胜，升 4 级';
    }

    const before = this.level[upTeam];
    const gameOver = before === LEVEL_MAX;
    const after = gameOver ? LEVEL_MAX : Math.min(before + 4, LEVEL_MAX);
    this.level[upTeam] = after;

    this.lastResult = {
      winTeam: upTeam,
      firstSeat: first,
      finishOrder: this.finishOrder.slice(),
      up: gameOver ? 0 : 4,
      before,
      after,
      gameOver,
      note: gameOver ? 'A 局获胜，游戏结束' : note,
      stickMode: this.stickMode,
    };

    this.addLog(`本局结束（${this.stickMode === 'SOLO' ? '立棍' : '单挑'}）：${upTeam === 0 ? 'A' : 'B'} 队升 4 级（${levelName(before)} → ${levelName(after)}）`);

    if (gameOver) {
      this.phase = 'GAME_OVER';
    } else {
      this.phase = 'ROUND_END';
      this.dealerSeat = first;
    }
  }

  nextRound() {
    if (this.phase !== 'ROUND_END') return false;
    // 进入上牌（切牌）阶段：庄的上家来切
    this.phase = 'CUT';
    this.cutSeat = (this.dealerSeat + 3) % 4;
    this.cutIndex = 0;
    const cutter = this.getBySeat(this.cutSeat);
    this.addLog(`${cutter ? cutter.name : '上家'} 上牌（20 秒不切就随机切）`);
    if (this.cutTimer) clearTimeout(this.cutTimer);
    this.cutTimer = setTimeout(() => {
      if (this.phase === 'CUT') {
        this.doCut(this.cutSeat, 1 + Math.floor(Math.random() * 52));
      }
    }, 20000);
    this.seq++;
    return true;
  }

  // 上家切牌
  doCut(seat, index) {
    if (this.phase !== 'CUT') return { ok: false, msg: '现在不是上牌时间' };
    if (seat !== this.cutSeat) return { ok: false, msg: '这一把不是你上牌' };
    if (this.cutTimer) { clearTimeout(this.cutTimer); this.cutTimer = null; }
    this.cutIndex = Math.max(1, Math.min(53, Number(index) || 1));
    const p = this.getBySeat(seat);
    this.addLog(`${p ? p.name : '上家'} 上牌：切在第 ${this.cutIndex} 张`);
    this.phase = 'PLAYING';
    this.startRound();
    return { ok: true };
  }

  // ---------- 日志 ----------
  addLog(text) {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  // ---------- 状态广播 ----------
  stateFor(playerId) {
    const me = this.getPlayer(playerId);
    const seat = me ? me.seat : -1;

    // 给风阶段：我能不能用差
    let canChaWind = false;
    if (this.giveWind && seat >= 0) {
      const gw = this.giveWind;
      const mateSeat = this.mateOf(gw.triggerSeat);
      if (seat !== mateSeat && gw.seats.includes(seat) && !gw.choices[seat]) {
        const lp = gw.lastPlay;
        if (lp && lp.cards.length === 1) {
          const c0 = lp.cards[0];
          const v = c0.joker ? c0.as : c0.value;
          if (v && v !== this.currentLevel) {
            const pp = this.getBySeat(seat);
            if (pp && pp.hand.filter(c => !c.joker && c.value === v).length >= 2) {
              canChaWind = true;
            }
          }
        }
      }
    }

    return {
      roomId: this.id,
      seq: this.seq,
      phase: this.phase,
      mySeat: seat,
      myHand: me ? me.hand : [],
      myTeam: seat >= 0 ? this.teamOf(seat) : -1,
      teamMap: this.teamMap,
      teamPicksDone: Object.keys(this.teamPicks).map(Number),
      teamAskers: Object.entries(this.teamPicks)
        .filter(([s, t]) => Number(t) === seat)
        .map(([s]) => Number(s)),
      teamResult: this.teamResult,
      lastChat: this.lastChat,
      lastReact: this.lastReact,
      lastWindFx: this.lastWindFx,
      cutSeat: this.phase === 'CUT' ? this.cutSeat : null,
      stickRequest: this.stickRequest ? { seat: this.stickRequest.seat, name: this.stickRequest.name, mateSeat: this.stickRequest.mateSeat } : null,
      trickHistory: this.trickHistory.slice(-10).map(h => ({ seat: h.seat, cards: h.cards, isCha: !!h.isCha })),
      players: this.players.map(p => ({
        seat: p.seat,
        name: p.name,
        realName: p.realName || p.name,
        count: p.hand.length,
        connected: p.connected,
        ready: p.ready,
        out: this.outSeats.has(p.seat),
      })),
      level: this.level,
      currentLevel: this.currentLevel,
      fieldTeam: this.fieldTeam,
      turn: this.turn,
      dealerSeat: this.dealerSeat,
      lastPlay: this.lastPlay
        ? {
            seat: this.lastPlay.seat,
            cards: this.lastPlay.cards,
            pattern: this.lastPlay.play.pattern,
            isCha: !!this.lastPlay.locked,
          }
        : null,
      lastPlayAt: this.trickHistory.length
        ? this.trickHistory[this.trickHistory.length - 1].at
        : 0,
      canCha: !!this.getChaTarget(seat),
      giveWind: this.giveWind
        ? {
            triggerSeat: this.giveWind.triggerSeat,
            seats: this.giveWind.seats,
            submitted: Object.keys(this.giveWind.choices).map(Number),
            myChoice: this.giveWind.choices[seat] ? this.giveWind.choices[seat].action : null,
            endsAt: this.giveWind.endsAt,
            targetCards: this.giveWind.lastPlay ? this.giveWind.lastPlay.cards : [],
            canChaWind,
          }
        : null,
      chooseState: this.chooseState
        ? {
            candidates: this.chooseState.candidates,
            picks: Object.keys(this.chooseState.picks).map(Number),
          }
        : null,
      lastReveal: this.lastReveal,
      passed: Array.from(this.passed),
      finishOrder: this.finishOrder,
      roundNo: this.roundNo,
      declare: this.declare,
      declareEndsAt: this.declareEndsAt,
      stickMode: this.stickMode,
      stickSeats: this.stickSeats,
      outSeats: Array.from(this.outSeats),
      stickName: this.stickName,
      log: this.log.slice(-12),
      lastResult: this.lastResult,
    };
  }
}

module.exports = { Room, TEAM_OF, MATE_OF, levelName };
