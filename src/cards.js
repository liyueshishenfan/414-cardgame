// 牌的表示与工具
// 点数数值：3-10 为 3-10；J=11 Q=12 K=13 A=14 2=15；大小王为配牌，value=0

const SUITS = ['S', 'H', 'D', 'C']; // 黑桃 红桃 方块 梅花
const RANK_LIST = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const VALUE_MAP = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15,
};
const VALUE_TO_RANK = {};
for (const r of RANK_LIST) VALUE_TO_RANK[VALUE_MAP[r]] = r;

// 等级牌在比较时视为 16（比 2 大）
const LEVEL_VALUE = 16;

function createDeck() {
  const deck = [];
  let id = 0;
  for (const suit of SUITS) {
    for (const rank of RANK_LIST) {
      deck.push({ id: id++, rank, suit, value: VALUE_MAP[rank], joker: false });
    }
  }
  deck.push({ id: id++, rank: '小王', suit: 'JOKER', value: 0, joker: true });
  deck.push({ id: id++, rank: '大王', suit: 'JOKER', value: 0, joker: true });
  return deck;
}

function shuffle(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 某张牌用于"比大小"时的数值
function cmpValue(card, level) {
  if (card.joker) return card.as || 0;
  return card.value === level ? LEVEL_VALUE : card.value;
}

// 牌面显示
function cardText(card) {
  if (card.joker) return card.rank; // 小王 / 大王
  const suitSymbol = { S: '♠', H: '♥', D: '♦', C: '♣' }[card.suit];
  return suitSymbol + card.rank;
}

// 排序：按值降序，王放最后
function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? -1 : 1;
    if (a.joker && b.joker) return b.rank.localeCompare(a.rank);
    if (a.value !== b.value) return b.value - a.value;
    return a.suit.localeCompare(b.suit);
  });
}

module.exports = {
  SUITS, RANK_LIST, VALUE_MAP, VALUE_TO_RANK, LEVEL_VALUE,
  createDeck, shuffle, cmpValue, cardText, sortHand,
};
