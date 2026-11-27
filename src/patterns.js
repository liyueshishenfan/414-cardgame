// 牌型识别与大小比较
const { LEVEL_VALUE } = require('./cards');

const PATTERN = {
  SINGLE: 'SINGLE',           // 单张
  PAIR: 'PAIR',               // 对子
  STRAIGHT: 'STRAIGHT',       // 一级顺子
  STRAIGHT_PAIR: 'STRAIGHT_PAIR', // 二级顺子（连对）
  BOMB3: 'BOMB3',             // 三张炸弹
  BOMB4: 'BOMB4',             // 四张炸弹
  BOMB5: 'BOMB5',             // 五张炸弹
  LV2_FAKE: 'LV2_FAKE',       // 二张等级假牌
  LV2_REAL: 'LV2_REAL',       // 二张等级真牌
  LV3_FAKE: 'LV3_FAKE',       // 三张等级假牌
  LV3_REAL: 'LV3_REAL',       // 三张等级真牌
  LV4_FAKE: 'LV4_FAKE',       // 四张等级假牌（含王）
  LV4: 'LV4',                 // 四张等级真牌
};

// 权重：数值越大越强
const WEIGHT = {
  SINGLE: 0, PAIR: 0, STRAIGHT: 0,
  BOMB3: 1,
  LV2_FAKE: 2,
  LV2_REAL: 3,
  STRAIGHT_PAIR: 4,
  LV4_FAKE: 4.5,
  BOMB4: 5,
  LV3_FAKE: 6,
  LV3_REAL: 7,
  BOMB5: 8,
  LV4: 9,
};

const PATTERN_NAME = {
  SINGLE: '单张', PAIR: '对子', STRAIGHT: '顺子', STRAIGHT_PAIR: '连对',
  BOMB3: '三张炸弹', BOMB4: '四张炸弹', BOMB5: '五张炸弹',
  LV2_FAKE: '二张等级假牌', LV2_REAL: '二张等级真牌',
  LV3_FAKE: '三张等级假牌', LV3_REAL: '三张等级真牌',
  LV4_FAKE: '四张等级假牌',
  LV4: '四张等级牌',
};

/**
 * 识别牌型
 * @param {Array} cards 牌数组，配牌需带 as 字段（3-15）
 * @param {Number} level 当前等级点数（3-14）
 * @returns 牌型对象或 null
 */
function analyze(cards, level) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;

  // 有效点数
  const eff = cards.map(c => (c.joker ? c.as : c.value));
  if (eff.some(v => !v || v < 3 || v > 15)) return null;

  const hasJoker = cards.some(c => c.joker);

  const count = {};
  for (const v of eff) count[v] = (count[v] || 0) + 1;
  const keys = Object.keys(count).map(Number).sort((a, b) => a - b);

  // 1. 全部同点
  if (keys.length === 1) {
    const v = keys[0];
    const isLevel = v === level;
    const cmpV = isLevel ? LEVEL_VALUE : v;

    if (n === 1) {
      return { pattern: PATTERN.SINGLE, mainValue: cmpV, length: 1, isLevel };
    }
    if (n === 2) {
      if (isLevel) {
        return {
          pattern: hasJoker ? PATTERN.LV2_FAKE : PATTERN.LV2_REAL,
          mainValue: LEVEL_VALUE, length: 2, isLevel: true,
        };
      }
      return { pattern: PATTERN.PAIR, mainValue: cmpV, length: 2, isLevel: false };
    }
    if (n === 3) {
      if (isLevel) {
        return {
          pattern: hasJoker ? PATTERN.LV3_FAKE : PATTERN.LV3_REAL,
          mainValue: LEVEL_VALUE, length: 3, isLevel: true,
        };
      }
      return { pattern: PATTERN.BOMB3, mainValue: cmpV, length: 3, isLevel: false };
    }
    if (n === 4) {
      if (isLevel) {
        return {
          pattern: hasJoker ? PATTERN.LV4_FAKE : PATTERN.LV4,
          mainValue: LEVEL_VALUE, length: 4, isLevel: true,
        };
      }
      return { pattern: PATTERN.BOMB4, mainValue: cmpV, length: 4, isLevel: false };
    }
    if (n === 5) {
      return { pattern: PATTERN.BOMB5, mainValue: cmpV, length: 5, isLevel: isLevel };
    }
    return null;
  }

  // 2. 连对：每个点数恰好 2 张，且连续
  if (n >= 6 && n % 2 === 0) {
    const pairCount = n / 2;
    if (keys.length === pairCount && keys.every(k => count[k] === 2)) {
      let ok = true;
      for (let i = 1; i < keys.length; i++) {
        if (keys[i] !== keys[i - 1] + 1) { ok = false; break; }
      }
      if (ok && keys[keys.length - 1] <= 14) {
        return { pattern: PATTERN.STRAIGHT_PAIR, mainValue: keys[0], length: n, isLevel: false };
      }
    }
  }

  // 3. 顺子：每个点数 1 张，连续，>=3 张，不含 2
  if (n >= 3 && keys.length === n) {
    let ok = true;
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] !== keys[i - 1] + 1) { ok = false; break; }
    }
    if (ok && keys[keys.length - 1] <= 14) {
      return { pattern: PATTERN.STRAIGHT, mainValue: keys[0], length: n, isLevel: false };
    }
  }

  return null;
}

/**
 * 判断 play 能否管住 last
 * @param {Object} play 本手牌型
 * @param {Object} last 上一手牌型（null 表示自由出牌）
 */
function canBeat(play, last) {
  if (!last) return true;

  const wp = WEIGHT[play.pattern];
  const wl = WEIGHT[last.pattern];

  // 权重不同：大者胜
  if (wp !== wl) return wp > wl;

  // 权重相同必须是同牌型
  if (play.pattern !== last.pattern) return false;

  // 单张 / 对子：必须连续管（2 与等级牌例外）
  if (play.pattern === PATTERN.SINGLE || play.pattern === PATTERN.PAIR) {
    const pv = play.mainValue;
    const lv = last.mainValue;
    if (pv <= lv) return false;
    if (pv >= 15) return true;        // 2 或等级牌，无视连接规则
    return pv === lv + 1;             // 其余必须刚好大 1
  }

  // 顺子 / 连对：同长度，起点必须大 1
  if (play.pattern === PATTERN.STRAIGHT || play.pattern === PATTERN.STRAIGHT_PAIR) {
    if (play.length !== last.length) return false;
    return play.mainValue === last.mainValue + 1;
  }

  // 炸弹类：直接比大小
  return play.mainValue > last.mainValue;
}

// 是否炸弹类（可无视连接规则）
function isBomb(pattern) {
  return WEIGHT[pattern] >= 1;
}

module.exports = { PATTERN, WEIGHT, PATTERN_NAME, analyze, canBeat, isBomb };
