'use strict';

const assert = require('assert');
const { CryptoDeck } = require('../server/cryptoDeck');
const { evaluateBestHand, compareEvaluations } = require('../server/handEvaluator');
const { PokerGame, PHASES } = require('../server/pokerEngine');

function card(rank, suit) {
  return { rank, suit, label: String(rank), symbol: suit, code: `${rank}${suit}` };
}

console.log('Running POOKER automated verification tests...\n');

// 1. Test CSPRNG Deck integrity & randomness
{
  const deck1 = new CryptoDeck();
  const deck2 = new CryptoDeck();

  assert.strictEqual(deck1.remaining, 52, 'Deck must have 52 cards');
  const codes1 = deck1.cards.map((c) => c.code);
  const unique1 = new Set(codes1);
  assert.strictEqual(unique1.size, 52, 'All 52 cards must be unique');

  const codes2 = deck2.cards.map((c) => c.code);
  assert.notStrictEqual(codes1.join(','), codes2.join(','), 'Two CSPRNG shuffles must differ');
  assert.strictEqual(deck1.commitmentHash.length, 64, 'SHA-256 commitment hash must be 64 hex chars');
  console.log('✓ Test 1 passed: CSPRNG Fisher-Yates + Riffle deck integrity & randomness');
}

// 2. Test Hand Evaluator hierarchy & tie-breakers
{
  const royalFlush = evaluateBestHand([
    card(14, 'S'), card(13, 'S'), card(12, 'S'), card(11, 'S'), card(10, 'S'), card(2, 'H'), card(3, 'D')
  ]);
  const wheelStraightFlush = evaluateBestHand([
    card(14, 'H'), card(2, 'H'), card(3, 'H'), card(4, 'H'), card(5, 'H'), card(13, 'C'), card(9, 'D')
  ]);
  const fourKind = evaluateBestHand([
    card(9, 'S'), card(9, 'H'), card(9, 'D'), card(9, 'C'), card(14, 'S'), card(4, 'H'), card(2, 'D')
  ]);
  const fullHouse = evaluateBestHand([
    card(13, 'S'), card(13, 'H'), card(13, 'D'), card(8, 'C'), card(8, 'S'), card(2, 'H'), card(3, 'D')
  ]);
  const flush = evaluateBestHand([
    card(14, 'D'), card(10, 'D'), card(8, 'D'), card(5, 'D'), card(2, 'D'), card(13, 'S'), card(12, 'C')
  ]);
  const wheelStraight = evaluateBestHand([
    card(14, 'S'), card(2, 'H'), card(3, 'D'), card(4, 'C'), card(5, 'S'), card(11, 'H'), card(9, 'D')
  ]);
  const trips = evaluateBestHand([
    card(7, 'S'), card(7, 'H'), card(7, 'D'), card(14, 'C'), card(10, 'S'), card(4, 'H'), card(2, 'D')
  ]);
  const twoPair = evaluateBestHand([
    card(12, 'S'), card(12, 'H'), card(6, 'D'), card(6, 'C'), card(14, 'S'), card(3, 'H'), card(2, 'D')
  ]);
  const onePair = evaluateBestHand([
    card(11, 'S'), card(11, 'H'), card(14, 'D'), card(9, 'C'), card(4, 'S'), card(3, 'H'), card(2, 'D')
  ]);
  const highCard = evaluateBestHand([
    card(14, 'S'), card(12, 'H'), card(9, 'D'), card(6, 'C'), card(3, 'S'), card(2, 'H'), card(7, 'D')
  ]);

  const ordered = [
    royalFlush, wheelStraightFlush, fourKind, fullHouse, flush,
    wheelStraight, trips, twoPair, onePair, highCard
  ];

  for (let i = 0; i < ordered.length - 1; i++) {
    assert(
      compareEvaluations(ordered[i], ordered[i + 1]) > 0,
      `${ordered[i].name} must beat ${ordered[i + 1].name}`
    );
  }

  // Exact tie check
  const tieA = evaluateBestHand([card(14, 'S'), card(13, 'H'), card(10, 'D'), card(8, 'C'), card(5, 'S')]);
  const tieB = evaluateBestHand([card(14, 'H'), card(13, 'S'), card(10, 'C'), card(8, 'D'), card(5, 'H')]);
  assert.strictEqual(compareEvaluations(tieA, tieB), 0, 'Identical rank hands must tie');
  console.log('✓ Test 2 passed: Complete 7-card Texas Hold\'em hand evaluator & tie-breakers');
}

// 3. Test Poker Engine: Board Fee (1 coin), 2 cards, strict privacy, Raise/Call/Check/Showdown
{
  const game = new PokerGame('TEST01', { maxPlayers: 3, startingCoins: 50 });
  game.addPlayer({ id: 'p1', name: 'Alice' });
  game.addPlayer({ id: 'p2', name: 'Bob' });
  game.addPlayer({ id: 'p3', name: 'Charlie' });

  game.startHand();

  assert.strictEqual(game.phase, PHASES.PREFLOP);
  assert.strictEqual(game.pot, 3, 'Board fee of 1 coin x 3 players = 3 coins in pot');
  for (const p of game.players) {
    assert.strictEqual(p.coins, 49, 'Each player starts with 50 - 1 board fee = 49 coins');
    assert.strictEqual(p.holeCards.length, 2, 'Each player receives exactly 2 private cards');
  }

  // Strict privacy check: p1 cannot see p2 or p3 cards
  const viewForP1 = game.getStateForPlayer('p1');
  const p1View = viewForP1.players.find((p) => p.id === 'p1');
  const p2View = viewForP1.players.find((p) => p.id === 'p2');
  const p3View = viewForP1.players.find((p) => p.id === 'p3');
  assert.strictEqual(p1View.holeCards.length, 2, 'Player must see their own 2 cards');
  assert.strictEqual(p2View.holeCards, null, 'Player must NEVER see opponent cards before showdown');
  assert.strictEqual(p3View.holeCards, null, 'Player must NEVER see opponent cards before showdown');

  // Pre-flop: attempting a huge raise (50) is clamped to realistic Pre-Flop max (+3), next calls 3, next folds
  const actor1 = game.players[game.currentTurnIndex];
  assert.strictEqual(game.handleAction(actor1.id, 'raise', 50).ok, true);
  assert.strictEqual(game.currentBet, 3, 'Pre-Flop raise must be capped at realistic +3 max');
  const actor2 = game.players[game.currentTurnIndex];
  assert.strictEqual(game.handleAction(actor2.id, 'call').ok, true);
  const actor3 = game.players[game.currentTurnIndex];
  assert.strictEqual(game.handleAction(actor3.id, 'fold').ok, true);

  assert.strictEqual(game.phase, PHASES.FLOP, 'Should advance to FLOP');
  assert.strictEqual(game.communityCards.length, 3, 'FLOP must deal 3 community cards');
  assert.strictEqual(game.pot, 9, 'Pot = 3 (ante) + 3 + 3 = 9');

  // Check through Flop, Turn, River to Showdown
  for (const expectedPhase of [PHASES.TURN, PHASES.RIVER, PHASES.SHOWDOWN]) {
    const a = game.players[game.currentTurnIndex];
    assert.strictEqual(game.handleAction(a.id, 'check').ok, true);
    const b = game.players[game.currentTurnIndex];
    assert.strictEqual(game.handleAction(b.id, 'check').ok, true);
    assert.strictEqual(game.phase, expectedPhase, `Should advance to ${expectedPhase}`);
  }

  // Total coins conserved: 3 * 50 = 150
  const totalCoins = game.players.reduce((sum, p) => sum + p.coins, 0);
  assert.strictEqual(totalCoins, 150, 'Total coins across all players must be conserved');
  assert(game.lastWinners.length >= 1, 'Showdown must determine winner(s)');
  console.log('✓ Test 3 passed: Board fee, strict privacy, Raise/Call/Check/Fold, and Showdown pot payout');
}

// 4. Test Win by Fold + Optional Show Cards
{
  const game = new PokerGame('TEST02', { maxPlayers: 2, startingCoins: 20 });
  game.addPlayer({ id: 'p1', name: 'Alice' });
  game.addPlayer({ id: 'p2', name: 'Bob' });
  game.startHand();

  const first = game.players[game.currentTurnIndex];
  const other = game.players.find((p) => p.id !== first.id);
  game.handleAction(first.id, 'fold');

  assert.strictEqual(game.phase, PHASES.SHOWDOWN);
  assert.strictEqual(other.coins, 21, 'Winner takes 2-coin pot (19 + 2 = 21)');

  // Before showing, loser still cannot see winner's cards
  const viewBeforeShow = game.getStateForPlayer(first.id);
  assert.strictEqual(viewBeforeShow.players.find((p) => p.id === other.id).holeCards, null);

  // Winner chooses to show cards
  assert.strictEqual(game.handleAction(other.id, 'show').ok, true);
  const viewAfterShow = game.getStateForPlayer(first.id);
  assert.strictEqual(viewAfterShow.players.find((p) => p.id === other.id).holeCards.length, 2);
  console.log('✓ Test 4 passed: Fold win & optional Show Cards mechanic');
}

console.log('\n🎉 All POOKER tests passed successfully!\n');

// 5. Test Provably Fair SHA-256 Proof Verification
{
  const crypto = require('crypto');
  const game = new PokerGame('TEST05', { maxPlayers: 2, startingCoins: 50 });
  game.addPlayer({ id: 'p1', name: 'Alice' });
  game.addPlayer({ id: 'p2', name: 'Bob' });
  game.startHand();

  // Proof must NOT be exposed while hand is in progress
  assert.strictEqual(game.getStateForPlayer('p1').shuffleProof, null, 'Proof must stay hidden mid-hand');

  // End hand by fold
  const active = game.players[game.currentTurnIndex];
  game.handleAction(active.id, 'fold');

  const proof = game.getStateForPlayer('p1').shuffleProof;
  assert(proof && proof.salt && proof.deckOrder.length === 52, 'Proof must be published at showdown');
  const recomputed = crypto
    .createHash('sha256')
    .update(`${proof.deckOrder.join(',')}|${proof.salt}`)
    .digest('hex');
  assert.strictEqual(recomputed, proof.commitmentHash, 'Recomputed SHA-256 must match commitment hash');
  console.log('✓ Test 5 passed: Provably Fair SHA-256 shuffle commitment & verification proof');
}

// 6. Test Animated All-In Runout, Side Pots & Coin Conservation
{
  const game = new PokerGame('TEST06', { maxPlayers: 3, startingCoins: 100 });
  game.addPlayer({ id: 'p1', name: 'ShortStack' });
  game.addPlayer({ id: 'p2', name: 'Deep1' });
  game.addPlayer({ id: 'p3', name: 'Deep2' });
  // Give p1 only 10 coins to force a side pot
  game.players[0].coins = 10;
  game.players[0].totalBuyIn = 10;

  game.startHand({ animatedRunout: true });
  // Everyone goes all-in
  while (game.currentTurnIndex >= 0) {
    const actor = game.players[game.currentTurnIndex];
    game.handleAction(actor.id, 'allin', 0, { animatedRunout: true });
  }

  assert.strictEqual(game.allInRunoutPending, true, 'All-In runout should be pending');
  const breakdown = game.getPotBreakdown();
  assert(breakdown.length >= 2, 'Should compute Main Pot + Side Pot');

  // Step through Flop -> Turn -> River -> Showdown
  let steps = 0;
  while (game.allInRunoutPending) {
    game.stepAllInRunout();
    steps++;
  }
  assert.strictEqual(steps, 4, 'Should take 4 steps: Flop, Turn, River, Showdown');
  assert.strictEqual(game.phase, PHASES.SHOWDOWN);
  const totalCoins = game.players.reduce((s, p) => s + p.coins, 0);
  assert.strictEqual(totalCoins, 210, 'Total coins (10 + 100 + 100 = 210) must be strictly conserved');
  console.log('✓ Test 6 passed: Animated All-In runout, Side Pot breakdown & strict coin conservation');
}

// 7. Test Turn Timeout (Auto-Check / Auto-Fold) & Rebuy
{
  const game = new PokerGame('TEST07', { maxPlayers: 2, startingCoins: 20, useBlinds: true });
  game.addPlayer({ id: 'p1', name: 'Alice' });
  game.addPlayer({ id: 'p2', name: 'Bob' });
  game.startHand();

  // Facing BB, timeout should auto-fold
  const timeoutRes = game.handleTurnTimeout();
  assert.strictEqual(timeoutRes.action, 'fold', 'Timeout facing a bet must auto-fold');
  assert.strictEqual(game.phase, PHASES.SHOWDOWN);

  // Test Rebuy when player has 0 coins
  game.players[0].coins = 0;
  game.players[0].eliminated = true;
  assert.strictEqual(game.rebuyPlayer(game.players[0].id).ok, true, 'Eliminated player should be able to rebuy');
  assert.strictEqual(game.players[0].coins, 20, 'Rebuy restores startingCoins');
  console.log('✓ Test 7 passed: Blinds + Board Fee, Turn Timeout auto-fold & Rebuy mechanic');
}

// 8. Test WPF Kicker Tie-Breakers, Wheel vs 6-High Straight, and Dead-Money Pot Conservation
{
  // Same Two Pairs (Jacks & 9s), Ace kicker beats King kicker
  const board = [card(11, 'S'), card(11, 'H'), card(9, 'D'), card(9, 'C'), card(2, 'S')];
  const pA = evaluateBestHand([card(14, 'H'), card(3, 'C'), ...board]);
  const pB = evaluateBestHand([card(13, 'D'), card(4, 'S'), ...board]);
  assert(compareEvaluations(pA, pB) > 0, 'Two Pairs with Ace kicker must beat Two Pairs with King kicker');

  // 6-high straight beats A-2-3-4-5 (5-high wheel straight)
  const sixHigh = evaluateBestHand([card(6, 'S'), card(5, 'H'), card(4, 'D'), card(3, 'C'), card(2, 'S')]);
  const wheel = evaluateBestHand([card(14, 'S'), card(5, 'H'), card(4, 'D'), card(3, 'C'), card(2, 'S')]);
  assert(compareEvaluations(sixHigh, wheel) > 0, '6-High Straight must beat 5-High Wheel Straight');

  // Dead-money side-pot bug regression test: folded player bet MORE than max contender
  const game = new PokerGame('TEST08', { maxPlayers: 3, startingCoins: 50 });
  game.addPlayer({ id: 'p1', name: 'FoldedBigBet' });
  game.addPlayer({ id: 'p2', name: 'AllInShort' });
  game.addPlayer({ id: 'p3', name: 'Contender' });
  game.startHand();
  // Simulate p1 betting 25 then folding/disconnecting while p2 & p3 have 10 each
  game.players[0].totalHandBet = 25;
  game.players[0].coins = 25;
  game.players[0].folded = true;
  game.players[1].totalHandBet = 10;
  game.players[1].coins = 40;
  game.players[2].totalHandBet = 10;
  game.players[2].coins = 40;
  game.pot = 45;
  game.communityCards = board;
  game._resolveShowdown();
  const totalAfter = game.players.reduce((s, p) => s + p.coins, 0);
  assert.strictEqual(totalAfter, 150, 'All 150 coins including dead money from folded big bet must be strictly conserved');
  console.log('✓ Test 8 passed: WPF kicker tie-breakers, Wheel Straight order & dead-money pot conservation');
}

// 9. Test Monte Carlo Equity Engine, Pot Odds & Hand History
{
  const { calculateEquity, calculatePotOdds } = require('../server/equityEngine');

  // Pocket Aces pre-flop vs 1 opponent should have strong equity (> 70%)
  const aa = [card(14, 'S'), card(14, 'H')];
  const aaEq = calculateEquity(aa, [], 1, 300);
  assert(aaEq.equityPct >= 70, `Pocket Aces equity should be >= 70%, got ${aaEq.equityPct}%`);

  // Made Royal Flush on the river should have 100% equity!
  const rfHole = [card(14, 'S'), card(13, 'S')];
  const rfBoard = [card(12, 'S'), card(11, 'S'), card(10, 'S'), card(2, 'H'), card(7, 'D')];
  const rfEq = calculateEquity(rfHole, rfBoard, 3, 150);
  assert.strictEqual(rfEq.equityPct, 100, `Nuts Royal Flush on river must have 100% equity, got ${rfEq.equityPct}%`);

  // Pot Odds: calling 10 into a pot of 30 => 10 / 40 = 25%
  assert.strictEqual(calculatePotOdds(10, 30), 25, 'Pot odds for calling 10 into 30 must be 25%');

  // Hand History recording
  const game = new PokerGame('TEST09', { maxPlayers: 2, startingCoins: 50 });
  game.addPlayer({ id: 'p1', name: 'Alice' });
  game.addPlayer({ id: 'p2', name: 'Bob' });
  game.startHand();
  game.handleAction(game.players[game.currentTurnIndex].id, 'fold');
  assert.strictEqual(game.handHistory.length, 1, 'Completed round must be recorded in handHistory');
  console.log('✓ Test 9 passed: Monte Carlo Equity Engine, Pot Odds & Hand History');
}
