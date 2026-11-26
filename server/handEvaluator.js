'use strict';

const HAND_NAMES = {
  9: 'Royal Flush',
  8: 'Straight Flush',
  7: 'Four of a Kind',
  6: 'Full House',
  5: 'Flush',
  4: 'Straight',
  3: 'Three of a Kind',
  2: 'Two Pairs',
  1: 'One Pair',
  0: 'High Card'
};

const RANK_TEXT = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace'
};

const RANK_SHORT = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

/**
 * Exact lexicographic comparison between two evaluated 5-card hands.
 * Returns > 0 if a > b, < 0 if a < b, 0 if exact tie (split pot).
 */
function compareEvaluations(a, b) {
  if (a.category !== b.category) {
    return a.category - b.category;
  }
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] || 0;
    const bv = b.tiebreakers[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Helper to order 5 cards by group frequency desc, then rank desc.
 */
function orderCardsByGroups(cards, groups) {
  const rankOrder = groups.map((g) => g[0]);
  return [...cards].sort((a, b) => {
    const ia = rankOrder.indexOf(a.rank);
    const ib = rankOrder.indexOf(b.rank);
    if (ia !== ib) return ia - ib;
    return b.rank - a.rank;
  });
}

/**
 * Evaluate a 5-card poker hand strictly following World Poker Federation (WPF) rules.
 */
function evaluateFive(cards) {
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map((c) => c.rank);
  const suits = sorted.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);

  // Check Straight (including A-2-3-4-5 Wheel Straight)
  let isStraight = false;
  let isWheel = false;
  let straightHigh = 0;
  const uniqueRanks = [...new Set(ranks)];
  if (uniqueRanks.length === 5) {
    if (ranks[0] - ranks[4] === 4) {
      isStraight = true;
      straightHigh = ranks[0];
    } else if (
      ranks[0] === 14 &&
      ranks[1] === 5 &&
      ranks[2] === 4 &&
      ranks[3] === 3 &&
      ranks[4] === 2
    ) {
      isStraight = true;
      isWheel = true;
      straightHigh = 5;
    }
  }

  // Order wheel straight as 5-4-3-2-A for display
  const straightCards = isWheel ? [...sorted.slice(1), sorted[0]] : sorted;

  // Count rank frequencies
  const freqMap = new Map();
  for (const r of ranks) {
    freqMap.set(r, (freqMap.get(r) || 0) + 1);
  }
  const groups = [...freqMap.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]; // higher count first
    return b[0] - a[0]; // higher rank first
  });

  // 1. Royal Flush (A-K-Q-J-10 same suit)
  if (isFlush && isStraight && straightHigh === 14) {
    return {
      category: 9,
      name: HAND_NAMES[9],
      detail: 'Royal Flush (A-K-Q-J-10)',
      tiebreakers: [14],
      bestFive: straightCards,
      keyCards: straightCards
    };
  }

  // 2. Straight Flush
  if (isFlush && isStraight) {
    return {
      category: 8,
      name: HAND_NAMES[8],
      detail: `Straight Flush (${RANK_TEXT[straightHigh]} High)`,
      tiebreakers: [straightHigh],
      bestFive: straightCards,
      keyCards: straightCards
    };
  }

  // 3. Four of a Kind
  if (groups[0][1] === 4) {
    const ordered = orderCardsByGroups(sorted, groups);
    return {
      category: 7,
      name: HAND_NAMES[7],
      detail: `Four of a Kind (${RANK_TEXT[groups[0][0]]}s, ${RANK_SHORT[groups[1][0]]} kicker)`,
      tiebreakers: [groups[0][0], groups[1][0]],
      bestFive: ordered,
      keyCards: ordered.slice(0, 4)
    };
  }

  // 4. Full House
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    const ordered = orderCardsByGroups(sorted, groups);
    return {
      category: 6,
      name: HAND_NAMES[6],
      detail: `Full House (${RANK_TEXT[groups[0][0]]}s full of ${RANK_TEXT[groups[1][0]]}s)`,
      tiebreakers: [groups[0][0], groups[1][0]],
      bestFive: ordered,
      keyCards: ordered
    };
  }

  // 5. Flush
  if (isFlush) {
    return {
      category: 5,
      name: HAND_NAMES[5],
      detail: `Flush (${RANK_TEXT[ranks[0]]} High)`,
      tiebreakers: ranks,
      bestFive: sorted,
      keyCards: sorted
    };
  }

  // 6. Straight
  if (isStraight) {
    return {
      category: 4,
      name: HAND_NAMES[4],
      detail: `Straight (${RANK_TEXT[straightHigh]} High)`,
      tiebreakers: [straightHigh],
      bestFive: straightCards,
      keyCards: straightCards
    };
  }

  // 7. Three of a Kind
  if (groups[0][1] === 3) {
    const ordered = orderCardsByGroups(sorted, groups);
    return {
      category: 3,
      name: HAND_NAMES[3],
      detail: `Three of a Kind (${RANK_TEXT[groups[0][0]]}s, ${RANK_SHORT[groups[1][0]]} ${RANK_SHORT[groups[2][0]]} kickers)`,
      tiebreakers: [groups[0][0], groups[1][0], groups[2][0]],
      bestFive: ordered,
      keyCards: ordered.slice(0, 3)
    };
  }

  // 8. Two Pairs
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const ordered = orderCardsByGroups(sorted, groups);
    return {
      category: 2,
      name: HAND_NAMES[2],
      detail: `Two Pairs (${RANK_TEXT[groups[0][0]]}s & ${RANK_TEXT[groups[1][0]]}s, ${RANK_SHORT[groups[2][0]]} kicker)`,
      tiebreakers: [groups[0][0], groups[1][0], groups[2][0]],
      bestFive: ordered,
      keyCards: ordered.slice(0, 4)
    };
  }

  // 9. One Pair
  if (groups[0][1] === 2) {
    const ordered = orderCardsByGroups(sorted, groups);
    return {
      category: 1,
      name: HAND_NAMES[1],
      detail: `One Pair (${RANK_TEXT[groups[0][0]]}s, ${RANK_SHORT[groups[1][0]]} kicker)`,
      tiebreakers: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]],
      bestFive: ordered,
      keyCards: ordered.slice(0, 2)
    };
  }

  // 10. High Card
  return {
    category: 0,
    name: HAND_NAMES[0],
    detail: `High Card (${RANK_TEXT[ranks[0]]}, ${RANK_SHORT[ranks[1]]} kicker)`,
    tiebreakers: ranks,
    bestFive: sorted,
    keyCards: sorted.slice(0, 1)
  };
}

/**
 * Evaluate the best 5-card hand from 2..7 cards (handles Pre-Flop preview & full 5-7 card showdown).
 */
function evaluateBestHand(cards) {
  if (!cards || cards.length === 0) return null;

  // Pre-flop helper (when only 2 hole cards are visible)
  if (cards.length < 5) {
    const sorted = [...cards].sort((a, b) => b.rank - a.rank);
    if (sorted.length === 2 && sorted[0].rank === sorted[1].rank) {
      return {
        category: 1,
        name: 'One Pair',
        detail: `Pocket Pair (${RANK_TEXT[sorted[0].rank]}s)`,
        tiebreakers: [sorted[0].rank],
        bestFive: sorted,
        keyCards: sorted
      };
    }
    return {
      category: 0,
      name: 'High Card',
      detail: `${RANK_TEXT[sorted[0].rank]} High`,
      tiebreakers: sorted.map((c) => c.rank),
      bestFive: sorted,
      keyCards: sorted.slice(0, 1)
    };
  }

  // Exhaustively evaluate all C(n, 5) combinations (exact for 5, 6, or 7 cards)
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const evalResult = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareEvaluations(evalResult, best) > 0) {
              best = evalResult;
            }
          }
        }
      }
    }
  }
  return best;
}

module.exports = {
  HAND_NAMES,
  evaluateFive,
  evaluateBestHand,
  compareEvaluations
};
