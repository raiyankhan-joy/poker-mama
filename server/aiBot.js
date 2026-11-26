'use strict';

const crypto = require('crypto');
const { evaluateBestHand } = require('./handEvaluator');
const { detectDraws } = require('./equityEngine');

const BOT_NAMES = [
  'Rafiq Pro',
  'Nadia Ace',
  'Tariq King',
  'Zara Bluff',
  'Imran Shark',
  'Sadia Royal',
  'Kamal Flush'
];

// Lively, fun real-life friendly poker personalities
const BOT_STYLES = ['action', 'balanced', 'bluffer', 'caller'];

function pickBotName(existingNames) {
  const available = BOT_NAMES.filter((n) => !existingNames.includes(n));
  if (available.length > 0) {
    return available[crypto.randomInt(0, available.length)];
  }
  return `Bot #${existingNames.length + 1}`;
}

function getBotStyle(botId) {
  let hash = 0;
  for (let i = 0; i < botId.length; i++) {
    hash = (hash * 31 + botId.charCodeAt(i)) | 0;
  }
  return BOT_STYLES[Math.abs(hash) % BOT_STYLES.length];
}

/**
 * Classifies a 2-card Pre-Flop hand into tiers (4 = Premium .. 0 = Weak).
 */
function classifyPreFlopHand(holeCards) {
  const [c1, c2] = [...holeCards].sort((a, b) => b.rank - a.rank);
  const r1 = c1.rank;
  const r2 = c2.rank;
  const suited = c1.suit === c2.suit;
  const gap = r1 - r2;

  if (r1 === r2) {
    if (r1 >= 10) return 4;
    if (r1 >= 6) return 3;
    return 2;
  }
  if (r1 === 14 && r2 >= 11) return 4;
  if (r1 === 14 && r2 >= 8) return 3;
  if (r1 === 14 || (r1 >= 12 && r2 >= 10)) return 3;
  if ((r1 >= 11 && r2 >= 9) || (suited && gap <= 2)) return 2;
  if (r1 >= 10 || suited || gap <= 2) return 1;
  return 0;
}

/**
 * Fun, lively, human-like friendly poker AI:
 * - Loves seeing the Flop (almost never folds Pre-Flop to normal bets so hands stay exciting!)
 * - Plays Flop & Turn with real draws, pairs, occasional bluffs, and smooth raises
 * - Delivers exciting River showdowns instead of folding everything early
 */
function decideBotAction(game, botPlayer) {
  const valid = game.getValidActions(botPlayer.id);
  if (!valid.isTurn) return null;

  const style = getBotStyle(botPlayer.id);
  const rand = crypto.randomInt(0, 100); // 0..99
  const maxInc = valid.maxRaiseIncrement || 3;
  const raisesThisStreet = game.streetRaiseCount || 0;
  const isPreFlop = game.communityCards.length === 0;
  const isFlop = game.communityCards.length === 3;
  const isTurn = game.communityCards.length === 4;
  const isRiver = game.communityCards.length === 5;
  const toCall = valid.callAmount;
  const remainingInHand = game.getPlayersInHand().length;

  const makeRaise = (inc) => {
    const clampedInc = Math.max(1, Math.min(maxInc, inc));
    const target = Math.min(valid.maxRaiseTo, Math.max(valid.minRaiseTo, game.currentBet + clampedInc));
    return { action: 'raise', amount: target };
  };

  // ==================== PRE-FLOP: KEEP THE TABLE LIVELY! ====================
  if (isPreFlop) {
    const tier = classifyPreFlopHand(botPlayer.holeCards);

    if (valid.canCheck) {
      if (tier === 4 && valid.canRaise) {
        return makeRaise(rand < 55 ? 2 : 3);
      }
      if (tier === 3 && valid.canRaise && rand < 55) {
        return makeRaise(rand < 65 ? 1 : 2);
      }
      if (tier === 2 && valid.canRaise && rand < (style === 'action' ? 40 : 20)) {
        return makeRaise(1);
      }
      return { action: 'check' };
    }

    // Facing a Pre-Flop bet: humans in a fun friendly game LOVE seeing the Flop!
    if (tier >= 3) {
      if (valid.canRaise && raisesThisStreet < 2 && rand < (tier === 4 ? 50 : 25)) {
        return makeRaise(rand < 65 ? 1 : 2);
      }
      return { action: 'call' };
    }

    if (tier === 2) {
      if (toCall <= 6 || rand < 85) return { action: 'call' };
      return { action: 'fold' };
    }

    // Even with Tier 1 / Tier 0, call normal Pre-Flop bets (1-3 coins) to see the Flop!
    // Never kill a hand on Pre-Flop when only 2 players are left and the bet is normal!
    if (remainingInHand <= 2 && toCall <= 4) {
      return { action: 'call' };
    }
    if (toCall <= 2) {
      return rand < 90 ? { action: 'call' } : { action: 'fold' };
    }
    if (toCall <= 3) {
      return rand < (tier === 1 ? 80 : 65) ? { action: 'call' } : { action: 'fold' };
    }
    // Only fold trash on heavy Pre-Flop re-raises (4+ coins)
    if (toCall <= 5 && tier === 1 && rand < 50) {
      return { action: 'call' };
    }
    return { action: 'fold' };
  }

  // ==================== POST-FLOP (FLOP, TURN, RIVER) ====================
  const ev = evaluateBestHand([...botPlayer.holeCards, ...game.communityCards]);
  const category = ev ? ev.category : 0;
  const draws = detectDraws(botPlayer.holeCards, game.communityCards);
  const hasStrongDraw = draws.some((d) => d.outs >= 8);
  const hasAnyDraw = draws.length > 0;

  const boardRanks = game.communityCards.map((c) => c.rank);
  const highestBoardRank = Math.max(...boardRanks);
  const holeRanks = botPlayer.holeCards.map((c) => c.rank);
  const isPocketPair = holeRanks[0] === holeRanks[1];
  const hasOvercard = holeRanks[0] > highestBoardRank || holeRanks[1] > highestBoardRank;

  let pairQuality = 0; // 0=board pair only, 1=mid/low pair, 2=top pair/overpair
  if (category === 1 && ev) {
    const pairRank = ev.tiebreakers[0];
    if (holeRanks.includes(pairRank)) {
      pairQuality = pairRank >= highestBoardRank || (isPocketPair && pairRank >= 9) ? 2 : 1;
    }
  }

  // --- CASE A: Free to Check ---
  if (valid.canCheck) {
    // Monster (Straight, Flush, Full House, Quads, Straight Flush)
    if (category >= 4) {
      if (isFlop && style === 'bluffer' && rand < 30) return { action: 'check' }; // Slow-play trap!
      if (valid.canRaise) {
        const inc = isRiver ? Math.min(maxInc, 4 + (rand % 3)) : Math.min(maxInc, 2 + (rand % 2));
        return makeRaise(inc);
      }
      return { action: 'check' };
    }

    // Two Pairs / Three of a Kind
    if (category >= 2) {
      if (valid.canRaise && rand < 82) {
        const inc = isRiver ? Math.min(maxInc, 3 + (rand % 2)) : Math.min(maxInc, 2 + (rand % 2));
        return makeRaise(inc);
      }
      return { action: 'check' };
    }

    // Top Pair / Overpair
    if (pairQuality === 2) {
      if (valid.canRaise && rand < 68) {
        return makeRaise(rand < 60 ? 1 : 2);
      }
      return { action: 'check' };
    }

    // Middle / Low Pair -> mix of check and small +1/+2 value bet
    if (pairQuality === 1) {
      if (valid.canRaise && rand < 35) return makeRaise(1);
      return { action: 'check' };
    }

    // Draws -> fun semi-bluff bet!
    if (hasStrongDraw && valid.canRaise && rand < 45) {
      return makeRaise(rand < 65 ? 1 : 2);
    }

    // Fun occasional bluff on Flop/Turn/River so players have real mind-games!
    if (valid.canRaise && rand < (style === 'bluffer' ? 28 : 14)) {
      return makeRaise(isRiver ? Math.min(maxInc, 2 + (rand % 2)) : 1);
    }

    return { action: 'check' };
  }

  // --- CASE B: Facing a Bet / Raise ---
  if (valid.canCall) {
    // Monster (Straight+) -> NEVER fold, raise or call!
    if (category >= 4) {
      if (valid.canRaise && raisesThisStreet < 2 && rand < 70) {
        return makeRaise(isRiver ? Math.min(maxInc, 3 + (rand % 3)) : Math.min(maxInc, 2 + (rand % 2)));
      }
      return { action: 'call' };
    }

    // Two Pairs / Trips -> NEVER fold, raise or call!
    if (category >= 2) {
      if (valid.canRaise && raisesThisStreet < 2 && rand < 48) {
        return makeRaise(Math.min(maxInc, 2 + (rand % 2)));
      }
      return { action: 'call' };
    }

    // Top Pair -> Always Call normal bets, sometimes Raise +1/+2!
    if (pairQuality === 2) {
      if (valid.canRaise && raisesThisStreet < 1 && rand < 25) {
        return makeRaise(1);
      }
      return { action: 'call' };
    }

    // Middle / Low Pair -> Call on Flop/Turn almost always, and call reasonable River bets for fun Showdown!
    if (pairQuality === 1) {
      if (!isRiver) {
        return toCall <= 5 || rand < 75 ? { action: 'call' } : { action: 'fold' };
      }
      return toCall <= 4 || rand < 65 ? { action: 'call' } : { action: 'fold' };
    }

    // Chasing Flush/Straight Draws on Flop & Turn -> Always Call normal bets!
    if (hasStrongDraw && !isRiver) {
      if (valid.canRaise && raisesThisStreet < 1 && rand < 20) {
        return makeRaise(1);
      }
      return { action: 'call' };
    }
    if (hasAnyDraw && !isRiver && toCall <= 4) {
      return { action: 'call' };
    }

    // On Flop with Overcards (A/K/Q high) -> float/call small bets to see the Turn!
    if (isFlop && hasOvercard && toCall <= 3 && rand < 75) {
      return { action: 'call' };
    }
    if (isTurn && hasOvercard && toCall <= 2 && rand < 55) {
      return { action: 'call' };
    }

    // River hero-call / bluff-catch against tiny bets
    if (toCall <= 2 && rand < (style === 'caller' ? 65 : 40)) {
      return { action: 'call' };
    }

    // Rare bold bluff-raise on Flop/Turn when holding nothing
    if (!isRiver && valid.canRaise && raisesThisStreet === 0 && style === 'bluffer' && rand < 12) {
      return makeRaise(2);
    }

    return { action: 'fold' };
  }

  return { action: 'fold' };
}

module.exports = {
  pickBotName,
  decideBotAction
};
