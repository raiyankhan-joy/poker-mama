'use strict';

const crypto = require('crypto');
const { SUITS, RANKS, RANK_LABELS, SUIT_SYMBOLS } = require('./cryptoDeck');
const { evaluateBestHand, compareEvaluations } = require('./handEvaluator');

// Pre-build a template of all 52 card objects for fast Monte Carlo sampling
const FULL_DECK_TEMPLATE = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    FULL_DECK_TEMPLATE.push({
      rank,
      suit,
      label: RANK_LABELS[rank],
      symbol: SUIT_SYMBOLS[suit],
      code: `${RANK_LABELS[rank]}${suit}`
    });
  }
}

/**
 * Fast Monte Carlo Equity Calculator (strictly privacy-safe: uses ONLY hero's 2 cards + visible board).
 * Runs unbiased partial Fisher-Yates rollouts against `opponentCount` unknown hands.
 */
function calculateEquity(holeCards, communityCards, opponentCount = 1, iterations = 220) {
  if (!holeCards || holeCards.length < 2) {
    return { equityPct: 0, winPct: 0, tiePct: 0 };
  }

  const activeOpps = Math.max(1, Math.min(7, Number(opponentCount) || 1));
  const cardKey = (c) => `${c.rank}_${c.suit}`;
  const knownKeys = new Set([
    ...holeCards.map(cardKey),
    ...(communityCards || []).map(cardKey)
  ]);

  const unseen = FULL_DECK_TEMPLATE.filter((c) => !knownKeys.has(cardKey(c)));
  const boardNeeded = Math.max(0, 5 - (communityCards ? communityCards.length : 0));
  const cardsNeededPerRun = boardNeeded + activeOpps * 2;

  if (unseen.length < cardsNeededPerRun) {
    return { equityPct: 50, winPct: 50, tiePct: 0 };
  }

  let equitySum = 0;
  let pureWins = 0;
  let ties = 0;

  // Use a single crypto-seeded fast PRNG (xorshift32) for sub-3ms Monte Carlo rollouts
  let seed = crypto.randomBytes(4).readUInt32LE(0) || 0x9e3779b9;
  const nextRand = (max) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % max);
  };

  const pool = [...unseen];
  const n = pool.length;

  for (let iter = 0; iter < iterations; iter++) {
    // Partial Fisher-Yates for only the cards needed in this rollout
    for (let i = 0; i < cardsNeededPerRun; i++) {
      const j = i + nextRand(n - i);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }

    const simBoard = communityCards ? [...communityCards] : [];
    let cursor = 0;
    for (let b = 0; b < boardNeeded; b++) {
      simBoard.push(pool[cursor++]);
    }

    const heroEval = evaluateBestHand([...holeCards, ...simBoard]);
    let beaten = false;
    let tieCount = 0;

    for (let o = 0; o < activeOpps; o++) {
      const oppCard1 = pool[cursor++];
      const oppCard2 = pool[cursor++];
      const oppEval = evaluateBestHand([oppCard1, oppCard2, ...simBoard]);
      const cmp = compareEvaluations(oppEval, heroEval);
      if (cmp > 0) {
        beaten = true;
        break;
      } else if (cmp === 0) {
        tieCount += 1;
      }
    }

    if (!beaten) {
      if (tieCount === 0) {
        pureWins += 1;
        equitySum += 1;
      } else {
        ties += 1;
        equitySum += 1 / (tieCount + 1);
      }
    }
  }

  return {
    equityPct: Math.round((equitySum / iterations) * 100),
    winPct: Math.round((pureWins / iterations) * 100),
    tiePct: Math.round((ties / iterations) * 100)
  };
}

/**
 * Calculates Pot Odds percentage when facing a call.
 */
function calculatePotOdds(callAmount, pot) {
  if (!callAmount || callAmount <= 0) return 0;
  return Math.round((callAmount / (pot + callAmount)) * 100);
}

/**
 * Detects active Flush Draws and Straight Draws (with exact outs) on Flop or Turn.
 */
function detectDraws(holeCards, communityCards) {
  const draws = [];
  if (!holeCards || holeCards.length < 2 || !communityCards || communityCards.length < 3 || communityCards.length >= 5) {
    return draws;
  }

  const all = [...holeCards, ...communityCards];

  // 1) Flush Draw check (exactly 4 cards of same suit, and at least 1 in holeCards)
  const suitCounts = {};
  for (const c of all) {
    suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  }
  for (const [suit, count] of Object.entries(suitCounts)) {
    if (count === 4 && holeCards.some((h) => h.suit === suit)) {
      draws.push({ name: 'Flush Draw', outs: 9 });
      break;
    }
  }

  // 2) Straight Draw check (count how many unseen ranks complete a 5-card straight)
  const rankSet = new Set(all.map((c) => c.rank));
  const hasStraightAlready = (() => {
    const ext = rankSet.has(14) ? new Set([...rankSet, 1]) : rankSet;
    for (let high = 14; high >= 5; high--) {
      if (ext.has(high) && ext.has(high - 1) && ext.has(high - 2) && ext.has(high - 3) && ext.has(high - 4)) {
        return true;
      }
    }
    return false;
  })();

  if (!hasStraightAlready) {
    const boardRankSet = new Set(communityCards.map((c) => c.rank));
    const holeRankSet = new Set(holeCards.map((c) => c.rank));
    let straightOutRanks = 0;
    for (let candidate = 2; candidate <= 14; candidate++) {
      if (rankSet.has(candidate)) continue;
      const testSet = new Set([...rankSet, candidate]);
      if (testSet.has(14)) testSet.add(1);
      const boardTestSet = new Set([...boardRankSet, candidate]);
      if (boardTestSet.has(14)) boardTestSet.add(1);

      for (let high = 14; high >= 5; high--) {
        const makesFullStraight =
          testSet.has(high) &&
          testSet.has(high - 1) &&
          testSet.has(high - 2) &&
          testSet.has(high - 3) &&
          testSet.has(high - 4);
        if (!makesFullStraight) continue;

        // Ignore pure board-only straights that don't use any of the player's hole cards
        const boardMakesSameStraight =
          boardTestSet.has(high) &&
          boardTestSet.has(high - 1) &&
          boardTestSet.has(high - 2) &&
          boardTestSet.has(high - 3) &&
          boardTestSet.has(high - 4);
        const usesHoleCard =
          holeRankSet.has(high) ||
          holeRankSet.has(high - 1) ||
          holeRankSet.has(high - 2) ||
          holeRankSet.has(high - 3) ||
          (high === 5 ? holeRankSet.has(14) : holeRankSet.has(high - 4));

        if (!boardMakesSameStraight && usesHoleCard) {
          straightOutRanks += 1;
          break;
        }
      }
    }
    if (straightOutRanks >= 2) {
      draws.push({ name: 'Open Straight Draw', outs: straightOutRanks * 4 });
    } else if (straightOutRanks === 1) {
      draws.push({ name: 'Gutshot Straight Draw', outs: 4 });
    }
  }

  return draws;
}

module.exports = {
  calculateEquity,
  calculatePotOdds,
  detectDraws
};
