'use strict';

const { CryptoDeck } = require('./cryptoDeck');
const { evaluateBestHand, compareEvaluations } = require('./handEvaluator');
const { calculateEquity, calculatePotOdds, detectDraws } = require('./equityEngine');

const PHASES = {
  LOBBY: 'LOBBY',
  PREFLOP: 'PREFLOP',
  FLOP: 'FLOP',
  TURN: 'TURN',
  RIVER: 'RIVER',
  SHOWDOWN: 'SHOWDOWN',
  GAME_OVER: 'GAME_OVER'
};

class PokerGame {
  constructor(roomId, options = {}) {
    this.roomId = roomId;
    this.maxPlayers = Math.min(22, Math.max(2, Number(options.maxPlayers) || 4));
    this.startingCoins = Math.max(10, Number(options.startingCoins) || 100);
    this.boardFee = 1; // 1 coin board fee (ante) per round
    this.useBlinds = Boolean(options.useBlinds);
    this.isPublic = options.isPublic !== false;
    this.smallBlind = 1;
    this.bigBlind = 2;
    this.turnDurationMs = Number(options.turnDurationMs) || 30000;
    this.allowRebuy = options.allowRebuy !== false;
    this.onHandComplete = typeof options.onHandComplete === 'function' ? options.onHandComplete : null;

    this.players = [];
    this.phase = PHASES.LOBBY;
    this.handNumber = 0;
    this.dealerIndex = -1;
    this.smallBlindIndex = -1;
    this.bigBlindIndex = -1;
    this.currentTurnIndex = -1;
    this.turnExpiresAt = null;
    this.allInRunoutPending = false;

    this.deck = null;
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = 1;
    this.streetRaiseCount = 0;

    this.lastWinners = [];
    this.actionLog = [];
    this.handHistory = [];
    this.shuffleMeta = null;
    this.shuffleProof = null;
    this.champion = null;
    this._equityCache = new Map();

    // Peer-to-peer Coin Loan & Negotiation + Unanimous End Game Settlement
    this.loanRequests = [];
    this.loanLedger = [];
    this.endGameVote = null;
    this.finalSettlement = null;
  }

  addLog(message) {
    this.actionLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      time: new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      message
    });
    if (this.actionLog.length > 60) {
      this.actionLog.shift();
    }
  }

  addPlayer({ id, name, isBot = false, avatar = null }) {
    if (this.phase !== PHASES.LOBBY) {
      return { error: 'Game has already started.' };
    }
    if (this.players.length >= this.maxPlayers) {
      return { error: 'Table is full.' };
    }
    if (this.players.some((p) => p.id === id)) {
      return { error: 'Player already in room.' };
    }

    const seat = this.players.length;
    const player = {
      id,
      name: (name || `Player ${seat + 1}`).trim().slice(0, 18),
      isBot,
      avatar: avatar || this._pickAvatar(seat),
      seat,
      coins: this.startingCoins,
      totalBuyIn: this.startingCoins,
      loanGiven: 0,
      loanTaken: 0,
      holeCards: [],
      roundBet: 0,
      totalHandBet: 0,
      folded: false,
      allIn: false,
      eliminated: false,
      hasActed: false,
      lastAction: '',
      showCards: false,
      connected: true,
      winStreak: 0,
      stats: {
        handsPlayed: 0,
        handsWon: 0,
        biggestPot: 0
      }
    };

    this.players.push(player);
    this.addLog(`${player.name} joined the table (${this.startingCoins} coins).`);
    return { player };
  }

  rebuyPlayer(playerId) {
    if (!this.allowRebuy) return { error: 'Rebuy is disabled at this table.' };
    if (this.phase !== PHASES.SHOWDOWN && this.phase !== PHASES.GAME_OVER) {
      return { error: 'Rebuy is only available between rounds.' };
    }
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return { error: 'Player not found.' };
    if (p.coins > 0) return { error: 'You still have coins remaining.' };

    p.coins = this.startingCoins;
    p.totalBuyIn += this.startingCoins;
    p.eliminated = false;
    p.folded = false;
    p.allIn = false;
    p.winStreak = 0;
    p.lastAction = `Rebuy +${this.startingCoins}`;
    if (this.phase === PHASES.GAME_OVER) {
      this.phase = PHASES.SHOWDOWN;
      this.champion = null;
    }
    this.addLog(`🪙 ${p.name} rebought ${this.startingCoins} coins!`);
    return { ok: true };
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return false;

    const player = this.players[idx];
    if (this.phase === PHASES.LOBBY) {
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => {
        p.seat = i;
      });
      this.addLog(`${player.name} left the lobby.`);
      return true;
    }

    // Mid-game disconnect: mark disconnected & fold if it's their turn
    player.connected = false;
    this.addLog(`${player.name} disconnected.`);
    if (!player.folded && !player.eliminated) {
      if (this.currentTurnIndex === idx) {
        this.handleAction(playerId, 'fold', 0, { animatedRunout: true });
      } else {
        player.folded = true;
        player.lastAction = 'Folded (Left)';
        this._checkImmediateWinOrAdvance({ animatedRunout: true });
      }
    }

    // If an End Game vote is active, prune disconnected player and auto-finalize if all remaining humans agreed
    if (this.endGameVote && this.phase !== PHASES.GAME_OVER) {
      this.endGameVote.requiredIds = this.endGameVote.requiredIds.filter((id) => {
        const pl = this.players.find((p) => p.id === id);
        return pl && !pl.isBot && pl.connected;
      });
      if (this.endGameVote.requiredIds.length === 0) {
        this.endGameVote = null;
      } else {
        const allAgreed = this.endGameVote.requiredIds.every(
          (id) => this.endGameVote.votes[id] === 'ACCEPT'
        );
        if (allAgreed) {
          this.finalizeMatchSettlement('All Remaining Players Agreed to End Game');
        }
      }
    }
    return true;
  }

  _pickAvatar(seat) {
    const avatars = ['♠️', '♥️', '♦️', '♣️', '👑', '🦊', '🦁', '🦅'];
    return avatars[seat % avatars.length];
  }

  getActivePlayers() {
    return this.players.filter((p) => !p.eliminated && p.coins >= 0);
  }

  getPlayersInHand() {
    return this.players.filter((p) => !p.eliminated && !p.folded);
  }

  canStartGame() {
    return this.phase === PHASES.LOBBY && this.players.length >= 2;
  }

  /**
   * Starts a new hand/round.
   * @param {object} opts { animatedRunout?: boolean }
   */
  startHand(opts = {}) {
    // Eliminate players with 0 coins
    for (const p of this.players) {
      if (p.coins <= 0) {
        p.eliminated = true;
      }
    }

    const fundedPlayers = this.players.filter((p) => !p.eliminated && p.coins > 0);
    if (fundedPlayers.length < 2) {
      this.phase = PHASES.GAME_OVER;
      this.turnExpiresAt = null;
      this.allInRunoutPending = false;
      this.endGameVote = null;
      this.finalSettlement = this.buildFinalSettlement('Last Player Standing');
      this.champion = fundedPlayers[0]
        ? { id: fundedPlayers[0].id, name: fundedPlayers[0].name, coins: fundedPlayers[0].coins }
        : this.finalSettlement.players[0]
        ? { id: this.finalSettlement.players[0].id, name: this.finalSettlement.players[0].name, coins: this.finalSettlement.players[0].finalAdjustedCoins }
        : null;
      if (this.champion) {
        this.addLog(`🏆 ${this.champion.name} wins the entire table with ${this.champion.coins} coins!`);
      }
      return { gameOver: true, champion: this.champion };
    }

    this.finalSettlement = null;
    this.handNumber += 1;
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = 1;
    this.streetRaiseCount = 0;
    this.lastWinners = [];
    this.shuffleProof = null;
    this.allInRunoutPending = false;
    this._equityCache.clear();

    // Rotate dealer clockwise to next non-eliminated player
    this.dealerIndex = this._nextEligibleIndex(this.dealerIndex, (p) => !p.eliminated);
    this.smallBlindIndex = -1;
    this.bigBlindIndex = -1;

    // Fresh CSPRNG-shuffled deck
    this.deck = new CryptoDeck();
    this.shuffleMeta = {
      shuffleId: this.deck.shuffleId,
      commitmentHash: this.deck.commitmentHash.slice(0, 16)
    };

    // Reset per-hand player state & collect 1-coin Board Fee (Ante)
    for (const p of this.players) {
      p.holeCards = [];
      p.roundBet = 0;
      p.totalHandBet = 0;
      p.folded = p.eliminated;
      p.allIn = false;
      p.hasActed = false;
      p.lastAction = '';
      p.showCards = false;

      if (!p.eliminated) {
        p.stats.handsPlayed += 1;
        const fee = Math.min(this.boardFee, p.coins);
        p.coins -= fee;
        p.totalHandBet += fee;
        this.pot += fee;
        if (p.coins === 0) {
          p.allIn = true;
          p.lastAction = `Board Fee ${fee} (All-In)`;
        } else {
          p.lastAction = `Board Fee ${fee}`;
        }
      }
    }

    // Optional real casino Blinds (Small Blind & Big Blind) on top of 1-coin Board Fee
    let firstToActStart = this.dealerIndex;
    if (this.useBlinds && fundedPlayers.length >= 2) {
      const sbIdx =
        fundedPlayers.length === 2
          ? this.dealerIndex
          : this._nextEligibleIndex(this.dealerIndex, (p) => !p.eliminated);
      const bbIdx = this._nextEligibleIndex(sbIdx, (p) => !p.eliminated);
      this.smallBlindIndex = sbIdx;
      this.bigBlindIndex = bbIdx;

      const sbPlayer = this.players[sbIdx];
      if (sbPlayer && sbPlayer.coins > 0) {
        const sbPay = Math.min(this.smallBlind, sbPlayer.coins);
        sbPlayer.coins -= sbPay;
        sbPlayer.roundBet += sbPay;
        sbPlayer.totalHandBet += sbPay;
        this.pot += sbPay;
        if (sbPlayer.coins === 0) sbPlayer.allIn = true;
        sbPlayer.lastAction = `SB ${sbPay}`;
      }

      const bbPlayer = this.players[bbIdx];
      if (bbPlayer && bbPlayer.coins > 0) {
        const bbPay = Math.min(this.bigBlind, bbPlayer.coins);
        bbPlayer.coins -= bbPay;
        bbPlayer.roundBet += bbPay;
        bbPlayer.totalHandBet += bbPay;
        this.pot += bbPay;
        if (bbPlayer.coins === 0) bbPlayer.allIn = true;
        bbPlayer.lastAction = `BB ${bbPay}`;
      }

      this.currentBet = Math.max(sbPlayer?.roundBet || 0, bbPlayer?.roundBet || 0);
      this.minRaise = this.bigBlind;
      firstToActStart = bbIdx;
    }

    // Deal 2 private random hole cards to each active player (1 card per pass, like real poker)
    for (let cardRound = 0; cardRound < 2; cardRound++) {
      let idx = this.dealerIndex;
      for (let i = 0; i < this.players.length; i++) {
        idx = (idx + 1) % this.players.length;
        const p = this.players[idx];
        if (!p.eliminated) {
          p.holeCards.push(this.deck.dealOne());
        }
      }
    }

    this.phase = PHASES.PREFLOP;
    this.addLog(
      `--- Round #${this.handNumber} --- Board Fee: ${this.boardFee} coin${
        this.useBlinds ? ` + Blinds ${this.smallBlind}/${this.bigBlind}` : ''
      }. 2 cards dealt.`
    );

    // Check if fewer than 2 players can still bet (everyone all-in on ante/blinds)
    const canActPlayers = this.players.filter((p) => !p.eliminated && !p.folded && !p.allIn);
    if (canActPlayers.length <= 1) {
      for (const p of this.getPlayersInHand()) {
        p.showCards = true;
      }
      if (opts.animatedRunout) {
        this.allInRunoutPending = true;
        this.currentTurnIndex = -1;
        this.turnExpiresAt = null;
      } else {
        this._runOutToShowdown();
      }
      return { started: true, allInRunout: this.allInRunoutPending };
    }

    // First to act
    this.currentTurnIndex = this._nextEligibleIndex(
      firstToActStart,
      (p) => !p.eliminated && !p.folded && !p.allIn
    );
    this._resetTurnTimer();

    return { started: true };
  }

  _resetTurnTimer() {
    if (this.currentTurnIndex >= 0) {
      this.turnExpiresAt = Date.now() + this.turnDurationMs;
    } else {
      this.turnExpiresAt = null;
    }
  }

  /**
   * Auto-handles turn timeout: Checks if free, otherwise Folds.
   */
  handleTurnTimeout(opts = { animatedRunout: true }) {
    if (this.currentTurnIndex < 0) return null;
    const active = this.players[this.currentTurnIndex];
    if (!active) return null;
    const valid = this.getValidActions(active.id);
    const autoAction = valid.canCheck ? 'check' : 'fold';
    this.addLog(`⏱️ ${active.name} timed out — auto-${autoAction}.`);
    this.handleAction(active.id, autoAction, 0, opts);
    return { playerId: active.id, playerName: active.name, action: autoAction };
  }

  /**
   * Returns valid actions for the given player if it is their turn.
   */
  getValidActions(playerId) {
    if (
      this.phase === PHASES.LOBBY ||
      this.phase === PHASES.SHOWDOWN ||
      this.phase === PHASES.GAME_OVER ||
      this.allInRunoutPending
    ) {
      const p = this.players.find((pl) => pl.id === playerId);
      const canShowAfterFold =
        this.phase === PHASES.SHOWDOWN &&
        p &&
        !p.folded &&
        !p.showCards &&
        p.holeCards.length === 2;
      const canRebuy =
        this.allowRebuy &&
        (this.phase === PHASES.SHOWDOWN || this.phase === PHASES.GAME_OVER) &&
        p &&
        p.coins === 0;

      return {
        isTurn: false,
        canCheck: false,
        canCall: false,
        callAmount: 0,
        canRaise: false,
        minRaiseTo: 0,
        maxRaiseTo: 0,
        canFold: false,
        canShowCards: Boolean(canShowAfterFold),
        canRebuy: Boolean(canRebuy)
      };
    }

    const currentPlayer = this.players[this.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== playerId) {
      return {
        isTurn: false,
        canCheck: false,
        canCall: false,
        callAmount: 0,
        canRaise: false,
        minRaiseTo: 0,
        maxRaiseTo: 0,
        canFold: false,
        canShowCards: false,
        canRebuy: false
      };
    }

    const toCall = Math.max(0, this.currentBet - currentPlayer.roundBet);
    const canCheck = toCall === 0;
    const canCall = toCall > 0 && currentPlayer.coins > 0;
    const callAmount = Math.min(toCall, currentPlayer.coins);

    const maxRaiseIncrement = this.getMaxRaiseIncrement();
    const stackMax = currentPlayer.roundBet + currentPlayer.coins;
    const maxRaiseTo = Math.min(stackMax, this.currentBet + maxRaiseIncrement);
    const minRaiseTo = Math.min(maxRaiseTo, this.currentBet + 1);
    const canRaise = currentPlayer.coins > toCall && maxRaiseTo > this.currentBet;

    return {
      isTurn: true,
      canCheck,
      canCall,
      callAmount,
      canRaise,
      minRaiseTo,
      maxRaiseTo,
      maxRaiseIncrement,
      canFold: true,
      canShowCards: false,
      canRebuy: false
    };
  }

  /**
   * Realistic street-based max raise increment for 1-coin board fee poker:
   * Pre-Flop: +1..+3 | Flop: +1..+4 | Turn: +1..+5 | River: +1..+6
   */
  getMaxRaiseIncrement() {
    if (this.phase === PHASES.PREFLOP) return 3;
    if (this.phase === PHASES.FLOP) return 4;
    if (this.phase === PHASES.TURN) return 5;
    if (this.phase === PHASES.RIVER) return 6;
    return 3;
  }

  /**
   * Processes a player's betting action: check, call, raise, fold, allin, or show.
   */
  handleAction(playerId, action, amount = 0, opts = {}) {
    const playerIdx = this.players.findIndex((p) => p.id === playerId);
    if (playerIdx === -1) return { error: 'Player not found.' };
    const player = this.players[playerIdx];

    // Optional "show" cards after winning by fold
    if (action === 'show') {
      if (this.phase === PHASES.SHOWDOWN && !player.folded && player.holeCards.length === 2) {
        player.showCards = true;
        this.addLog(`👁️ ${player.name} showed their cards!`);
        return { ok: true };
      }
      return { error: 'Cannot show cards right now.' };
    }

    if (
      this.phase === PHASES.LOBBY ||
      this.phase === PHASES.SHOWDOWN ||
      this.phase === PHASES.GAME_OVER ||
      this.allInRunoutPending
    ) {
      return { error: 'No active betting round.' };
    }

    if (playerIdx !== this.currentTurnIndex) {
      return { error: 'Not your turn.' };
    }

    const toCall = Math.max(0, this.currentBet - player.roundBet);
    let spokenText = '';

    if (action === 'fold') {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = 'Fold';
      spokenText = 'Fold';
      this.addLog(`${player.name} folded.`);
    } else if (action === 'check') {
      if (toCall > 0) {
        return { error: 'Cannot check when there is an active bet. Call, Raise, or Fold.' };
      }
      player.hasActed = true;
      player.lastAction = 'Check';
      spokenText = 'Check';
      this.addLog(`${player.name} checked.`);
    } else if (action === 'call') {
      if (toCall === 0) {
        player.hasActed = true;
        player.lastAction = 'Check';
        spokenText = 'Check';
        this.addLog(`${player.name} checked.`);
      } else {
        const pay = Math.min(toCall, player.coins);
        player.coins -= pay;
        player.roundBet += pay;
        player.totalHandBet += pay;
        this.pot += pay;
        player.hasActed = true;
        if (player.coins === 0) {
          player.allIn = true;
          player.lastAction = `Call ${pay} (All-In)`;
          spokenText = `Call ${pay}, All in!`;
          this.addLog(`${player.name} called ${pay} (All-In!).`);
        } else {
          player.lastAction = `Call ${pay}`;
          spokenText = `Call ${pay}`;
          this.addLog(`${player.name} called ${pay}.`);
        }
      }
    } else if (action === 'raise' || action === 'allin') {
      const stackMax = player.roundBet + player.coins;
      const streetMax = Math.min(stackMax, this.currentBet + this.getMaxRaiseIncrement());
      const maxBet = action === 'allin' ? stackMax : streetMax;
      let targetBet = action === 'allin' ? stackMax : Math.floor(Number(amount) || 0);

      const minBet = Math.min(maxBet, this.currentBet + 1);
      if (targetBet < minBet) {
        targetBet = minBet;
      }
      if (targetBet > maxBet) {
        targetBet = maxBet;
      }

      const added = targetBet - player.roundBet;
      if (added <= 0) {
        return { error: 'Invalid raise amount.' };
      }

      const isRaising = targetBet > this.currentBet;
      const raiseDelta = targetBet - this.currentBet;

      player.coins -= added;
      player.roundBet = targetBet;
      player.totalHandBet += added;
      this.pot += added;
      player.hasActed = true;

      if (isRaising) {
        this.streetRaiseCount += 1;
        if (raiseDelta >= this.minRaise) {
          this.minRaise = raiseDelta;
        }
        const wasZero = this.currentBet === 0;
        this.currentBet = targetBet;
        for (const other of this.players) {
          if (other.id !== player.id && !other.folded && !other.eliminated && !other.allIn) {
            other.hasActed = false;
          }
        }
        if (player.coins === 0) {
          player.allIn = true;
          player.lastAction = `All-In (${targetBet})`;
          spokenText = 'All in!';
          this.addLog(`🔥 ${player.name} went ALL-IN to ${targetBet}!`);
        } else {
          player.lastAction = wasZero ? `Bet ${targetBet}` : `Raise to ${targetBet}`;
          spokenText = wasZero ? `Bet ${targetBet}` : `Raise to ${targetBet}`;
          this.addLog(`${player.name} ${wasZero ? 'bet' : 'raised to'} ${targetBet}.`);
        }
      } else {
        if (player.coins === 0) {
          player.allIn = true;
          player.lastAction = `All-In (${targetBet})`;
          spokenText = 'All in!';
          this.addLog(`🔥 ${player.name} went ALL-IN for ${added}.`);
        } else {
          player.lastAction = `Call ${added}`;
          spokenText = `Call ${added}`;
          this.addLog(`${player.name} called ${added}.`);
        }
      }
    } else {
      return { error: `Unknown action: ${action}` };
    }

    this._checkImmediateWinOrAdvance(opts);
    return { ok: true, allInRunout: this.allInRunoutPending, spokenText };
  }

  _checkImmediateWinOrAdvance(opts = {}) {
    const remaining = this.getPlayersInHand();

    // Everyone else folded -> instant win without forced card reveal
    if (remaining.length === 1) {
      const winner = remaining[0];
      const wonAmount = this.pot;
      winner.coins += wonAmount;
      winner.stats.handsWon += 1;
      winner.stats.biggestPot = Math.max(winner.stats.biggestPot, wonAmount);

      for (const p of this.players) {
        p.roundBet = 0;
        p.winStreak = p.id === winner.id ? (p.winStreak || 0) + 1 : 0;
      }
      this.currentBet = 0;
      this.streetRaiseCount = 0;

      this.lastWinners = [
        {
          playerId: winner.id,
          name: winner.name,
          amount: wonAmount,
          handName: 'Won by Fold',
          detail: 'All other players folded',
          bestFive: []
        }
      ];
      this.addLog(`🏆 ${winner.name} wins ${wonAmount} coins (all others folded).`);
      this.pot = 0;
      this.phase = PHASES.SHOWDOWN;
      this.currentTurnIndex = -1;
      this.turnExpiresAt = null;
      this.shuffleProof = this.deck ? this.deck.getProof() : null;
      this._recordHandHistory();
      return;
    }

    // Check if betting round is complete
    const playersAbleToAct = remaining.filter((p) => !p.allIn);
    const allMatchedAndActed = playersAbleToAct.every(
      (p) => p.hasActed && p.roundBet === this.currentBet
    );

    if (allMatchedAndActed) {
      if (playersAbleToAct.length <= 1) {
        // Reveal all remaining players' cards immediately like televised real poker during an All-In runout!
        for (const p of remaining) {
          p.showCards = true;
        }
        if (opts.animatedRunout && this.communityCards.length < 5) {
          this.allInRunoutPending = true;
          this.currentTurnIndex = -1;
          this.turnExpiresAt = null;
        } else {
          this._runOutToShowdown();
        }
      } else {
        this._advancePhase();
      }
      return;
    }

    // Move turn to next eligible player
    this.currentTurnIndex = this._nextEligibleIndex(
      this.currentTurnIndex,
      (p) => !p.eliminated && !p.folded && !p.allIn
    );
    this._resetTurnTimer();
  }

  /**
   * Advances one dramatic street during an animated All-In runout.
   * Returns true if more streets remain, false when Showdown is reached.
   */
  stepAllInRunout() {
    if (!this.allInRunoutPending) return false;

    for (const p of this.players) {
      p.roundBet = 0;
    }
    this.currentBet = 0;

    if (this.communityCards.length === 0) {
      this.deck.burn();
      this.communityCards.push(...this.deck.deal(3));
      this.phase = PHASES.FLOP;
      this.addLog(`All-In Flop: ${this.communityCards.map((c) => c.label + c.symbol).join(' ')}`);
      return true;
    } else if (this.communityCards.length === 3) {
      this.deck.burn();
      this.communityCards.push(this.deck.dealOne());
      this.phase = PHASES.TURN;
      const c = this.communityCards[3];
      this.addLog(`All-In Turn: ${c.label + c.symbol}`);
      return true;
    } else if (this.communityCards.length === 4) {
      this.deck.burn();
      this.communityCards.push(this.deck.dealOne());
      this.phase = PHASES.RIVER;
      const c = this.communityCards[4];
      this.addLog(`All-In River: ${c.label + c.symbol}`);
      return true;
    } else {
      this.allInRunoutPending = false;
      this._resolveShowdown();
      return false;
    }
  }

  _advancePhase() {
    // Reset per-street betting
    this.currentBet = 0;
    this.streetRaiseCount = 0;
    this.minRaise = this.useBlinds ? this.bigBlind : 1;
    for (const p of this.players) {
      p.roundBet = 0;
      p.hasActed = false;
      if (!p.folded && !p.eliminated && !p.allIn) {
        p.lastAction = '';
      }
    }

    if (this.phase === PHASES.PREFLOP) {
      this.deck.burn();
      this.communityCards.push(...this.deck.deal(3));
      this.phase = PHASES.FLOP;
      this.addLog(`Flop dealt: ${this.communityCards.map((c) => c.label + c.symbol).join(' ')}`);
    } else if (this.phase === PHASES.FLOP) {
      this.deck.burn();
      this.communityCards.push(this.deck.dealOne());
      this.phase = PHASES.TURN;
      const turnCard = this.communityCards[3];
      this.addLog(`Turn dealt: ${turnCard.label + turnCard.symbol}`);
    } else if (this.phase === PHASES.TURN) {
      this.deck.burn();
      this.communityCards.push(this.deck.dealOne());
      this.phase = PHASES.RIVER;
      const riverCard = this.communityCards[4];
      this.addLog(`River dealt: ${riverCard.label + riverCard.symbol}`);
    } else if (this.phase === PHASES.RIVER) {
      this._resolveShowdown();
      return;
    }

    // First to act post-flop is left of dealer
    this.currentTurnIndex = this._nextEligibleIndex(
      this.dealerIndex,
      (p) => !p.eliminated && !p.folded && !p.allIn
    );
    this._resetTurnTimer();
  }

  _runOutToShowdown() {
    while (this.communityCards.length < 5) {
      this.deck.burn();
      if (this.communityCards.length === 0) {
        this.communityCards.push(...this.deck.deal(3));
      } else {
        this.communityCards.push(this.deck.dealOne());
      }
    }
    this.allInRunoutPending = false;
    this._resolveShowdown();
  }

  /**
   * Computes live Main Pot + Side Pots breakdown for display.
   */
  getPotBreakdown() {
    const contributors = this.players.filter((p) => p.totalHandBet > 0);
    if (contributors.length === 0 || this.pot <= 0) return [];

    const contenders = this.getPlayersInHand();
    const betLevels = [...new Set(contributors.map((p) => p.totalHandBet))].sort((a, b) => a - b);
    const pots = [];
    let prevLevel = 0;

    for (const level of betLevels) {
      const slice = level - prevLevel;
      let potSlice = 0;
      for (const p of contributors) {
        if (p.totalHandBet >= level) {
          potSlice += slice;
        }
      }
      prevLevel = level;
      if (potSlice <= 0) continue;

      const eligibleIds = contenders.filter((p) => p.totalHandBet >= level).map((p) => p.id);
      if (
        pots.length > 0 &&
        pots[pots.length - 1].eligibleKey === eligibleIds.join(',')
      ) {
        pots[pots.length - 1].amount += potSlice;
      } else {
        pots.push({
          label: pots.length === 0 ? 'Main Pot' : `Side Pot ${pots.length}`,
          amount: potSlice,
          eligibleKey: eligibleIds.join(',')
        });
      }
    }

    return pots.map(({ label, amount }) => ({ label, amount }));
  }

  /**
   * Computes main + side pots and distributes winnings accurately at Showdown.
   */
  _resolveShowdown() {
    this.phase = PHASES.SHOWDOWN;
    this.currentTurnIndex = -1;
    this.turnExpiresAt = null;
    this.allInRunoutPending = false;
    this.currentBet = 0;
    this.streetRaiseCount = 0;
    for (const p of this.players) {
      p.roundBet = 0;
    }
    this.shuffleProof = this.deck ? this.deck.getProof() : null;

    const contenders = this.getPlayersInHand();
    const evaluations = new Map();
    for (const p of contenders) {
      p.showCards = true;
      evaluations.set(p.id, evaluateBestHand([...p.holeCards, ...this.communityCards]));
    }

    // Build airtight side-pot layers from contender bet levels (dead money from folded players is ALWAYS preserved!)
    const contributors = this.players.filter((p) => p.totalHandBet > 0);
    const contenderLevels = [...new Set(contenders.map((p) => p.totalHandBet))].sort((a, b) => a - b);
    const maxContenderLevel = contenderLevels[contenderLevels.length - 1] || 0;

    const winTotals = new Map();
    let prevLevel = 0;

    for (let li = 0; li < contenderLevels.length; li++) {
      const level = contenderLevels[li];
      const isHighestLevel = li === contenderLevels.length - 1;
      let potSlice = 0;

      for (const p of contributors) {
        if (p.totalHandBet > prevLevel) {
          if (isHighestLevel && p.folded && p.totalHandBet > maxContenderLevel) {
            // Any dead money above max contender bet from a folded/disconnected player stays in the highest pot
            potSlice += p.totalHandBet - prevLevel;
          } else {
            potSlice += Math.min(p.totalHandBet, level) - prevLevel;
          }
        }
      }

      prevLevel = level;
      if (potSlice <= 0) continue;

      const eligible = contenders.filter((p) => p.totalHandBet >= level);
      if (eligible.length === 0) continue;

      let bestEval = null;
      let sliceWinners = [];
      for (const p of eligible) {
        const ev = evaluations.get(p.id);
        if (!bestEval) {
          bestEval = ev;
          sliceWinners = [p];
        } else {
          const cmp = compareEvaluations(ev, bestEval);
          if (cmp > 0) {
            bestEval = ev;
            sliceWinners = [p];
          } else if (cmp === 0) {
            sliceWinners.push(p);
          }
        }
      }

      const share = Math.floor(potSlice / sliceWinners.length);
      let remainder = potSlice % sliceWinners.length;

      // Odd chip rule: clockwise from left of dealer
      const orderedWinners = [...sliceWinners].sort((a, b) => {
        const da = (a.seat - this.dealerIndex - 1 + this.players.length) % this.players.length;
        const db = (b.seat - this.dealerIndex - 1 + this.players.length) % this.players.length;
        return da - db;
      });

      for (const w of orderedWinners) {
        const bonus = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;
        const payout = share + bonus;
        w.coins += payout;
        winTotals.set(w.id, (winTotals.get(w.id) || 0) + payout);
      }
    }

    // Build full contender ranking (1st -> last) for crystal-clear showdown comparison
    const rankedContenders = [...contenders]
      .sort((a, b) => compareEvaluations(evaluations.get(b.id), evaluations.get(a.id)))
      .map((p) => {
        const ev = evaluations.get(p.id);
        return {
          playerId: p.id,
          name: p.name,
          handName: ev.name,
          detail: ev.detail,
          bestFiveLabels: ev.bestFive.map((c) => `${c.label}${c.symbol}`),
          wonAmount: winTotals.get(p.id) || 0
        };
      });

    this.lastWinners = [];
    const isSplit = winTotals.size > 1 && contenderLevels.length === 1;
    for (const pl of this.players) {
      if (winTotals.has(pl.id)) {
        pl.winStreak = (pl.winStreak || 0) + 1;
      } else {
        pl.winStreak = 0;
      }
    }
    for (const [winnerId, amount] of winTotals.entries()) {
      const p = this.players.find((pl) => pl.id === winnerId);
      const ev = evaluations.get(winnerId);
      p.stats.handsWon += 1;
      p.stats.biggestPot = Math.max(p.stats.biggestPot, amount);
      this.lastWinners.push({
        playerId: winnerId,
        name: p.name,
        amount,
        handName: ev.name,
        detail: ev.detail,
        isSplitPot: isSplit,
        bestFive: ev.bestFive.map((c) => c.code),
        keyCards: ev.keyCards ? ev.keyCards.map((c) => c.code) : ev.bestFive.map((c) => c.code),
        bestFiveLabels: ev.bestFive.map((c) => `${c.label}${c.symbol}`),
        ranking: rankedContenders
      });
      this.addLog(`🏆 ${p.name} wins ${amount} coins with ${ev.detail} [${ev.bestFive.map((c) => c.label + c.symbol).join(' ')}]!`);
    }

    this.pot = 0;
    this._recordHandHistory();
  }

  _recordHandHistory() {
    const entry = {
      handNumber: this.handNumber,
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      board: this.communityCards.map((c) => `${c.label}${c.symbol}`),
      winners: this.lastWinners.map((w) => ({
        name: w.name,
        amount: w.amount,
        handName: w.handName,
        detail: w.detail
      })),
      shuffleId: this.shuffleMeta ? this.shuffleMeta.shuffleId : null
    };
    this.handHistory.push(entry);
    if (this.handHistory.length > 30) {
      this.handHistory.shift();
    }
    if (this.onHandComplete) {
      try {
        this.onHandComplete(this.players, this.lastWinners);
      } catch (_) {
        // non-fatal stats hook error
      }
    }
  }

  _nextEligibleIndex(startIdx, predicate) {
    const n = this.players.length;
    if (n === 0) return -1;
    for (let offset = 1; offset <= n; offset++) {
      const idx = (startIdx + offset + n) % n;
      if (predicate(this.players[idx])) {
        return idx;
      }
    }
    return -1;
  }

  /**
   * Produces a privacy-safe view of the game state for a specific player.
   * NEVER leaks other players' hidden hole cards!
   */
  getStateForPlayer(viewerId) {
    const viewer = this.players.find((p) => p.id === viewerId);
    const validActions = this.getValidActions(viewerId);
    let viewerHandHint = null;
    let viewerAnalytics = null;

    if (viewer && !viewer.folded && viewer.holeCards.length === 2) {
      const ev = evaluateBestHand([...viewer.holeCards, ...this.communityCards]);
      if (ev) {
        const keySet = new Set((ev.keyCards || ev.bestFive || []).map((c) => c.code));
        viewerHandHint = {
          name: ev.name,
          detail: ev.detail,
          category: ev.category,
          rankPosition: 10 - ev.category, // #1 Royal Flush .. #10 High Card
          bestFive: (ev.bestFive || []).map((c) => ({
            label: c.label,
            symbol: c.symbol,
            suit: c.suit,
            code: c.code,
            isKey: keySet.has(c.code)
          }))
        };
      }

      if (
        this.phase !== PHASES.LOBBY &&
        this.phase !== PHASES.SHOWDOWN &&
        this.phase !== PHASES.GAME_OVER
      ) {
        const oppCount = Math.max(
          1,
          this.getPlayersInHand().filter((p) => p.id !== viewerId).length
        );
        const cacheKey = `${this.handNumber}:${this.communityCards.length}:${oppCount}:${viewerId}`;
        let eq = this._equityCache.get(cacheKey);
        if (!eq) {
          if (this._equityCache.size > 64) this._equityCache.clear();
          eq = calculateEquity(viewer.holeCards, this.communityCards, oppCount, oppCount >= 4 ? 35 : 45);
          this._equityCache.set(cacheKey, eq);
        }
        const potOddsPct = validActions.canCall
          ? calculatePotOdds(validActions.callAmount, this.pot)
          : 0;
        const draws = detectDraws(viewer.holeCards, this.communityCards);
        viewerAnalytics = {
          equityPct: eq.equityPct,
          winPct: eq.winPct,
          tiePct: eq.tiePct,
          potOddsPct,
          draws
        };
      }
    }

    const playersView = this.players.map((p, idx) => {
      const revealCards =
        p.id === viewerId ||
        p.showCards ||
        (this.phase === PHASES.SHOWDOWN && !p.folded && this.getPlayersInHand().length > 1);

      let showdownHand = null;
      if (revealCards && p.holeCards.length === 2 && this.communityCards.length >= 3 && !p.folded) {
        const ev = evaluateBestHand([...p.holeCards, ...this.communityCards]);
        if (ev) {
          showdownHand = { name: ev.name, detail: ev.detail };
        }
      }

      return {
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        avatar: p.avatar,
        seat: p.seat,
        coins: p.coins,
        totalBuyIn: p.totalBuyIn,
        loanGiven: p.loanGiven || 0,
        loanTaken: p.loanTaken || 0,
        loanBalance: (p.loanGiven || 0) - (p.loanTaken || 0),
        netProfit: p.coins + ((p.loanGiven || 0) - (p.loanTaken || 0)) - p.totalBuyIn,
        roundBet: p.roundBet,
        totalHandBet: p.totalHandBet,
        folded: p.folded,
        allIn: p.allIn,
        eliminated: p.eliminated,
        lastAction: p.lastAction,
        connected: p.connected,
        winStreak: p.winStreak || 0,
        isDealer: idx === this.dealerIndex,
        isSmallBlind: idx === this.smallBlindIndex,
        isBigBlind: idx === this.bigBlindIndex,
        isCurrentTurn: idx === this.currentTurnIndex,
        cardCount: p.holeCards.length,
        holeCards: revealCards ? p.holeCards : null,
        showdownHand,
        stats: p.stats
      };
    });

    const activeLoanRequests = this.loanRequests.filter(
      (r) => r.status === 'PENDING_LENDER' || r.status === 'COUNTER_OFFERED'
    );

    return {
      roomId: this.roomId,
      isPublic: this.isPublic,
      maxPlayers: this.maxPlayers,
      startingCoins: this.startingCoins,
      boardFee: this.boardFee,
      useBlinds: this.useBlinds,
      phase: this.phase,
      handNumber: this.handNumber,
      pot: this.pot,
      sidePots: this.getPotBreakdown(),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      turnExpiresAt: this.turnExpiresAt,
      turnDurationMs: this.turnDurationMs,
      serverNow: Date.now(),
      allInRunoutPending: this.allInRunoutPending,
      communityCards: this.communityCards,
      players: playersView,
      validActions,
      viewerHandHint,
      viewerAnalytics,
      lastWinners: this.lastWinners,
      actionLog: this.actionLog.slice(-15),
      handHistory: this.handHistory.slice(-10),
      shuffleMeta: this.shuffleMeta,
      shuffleProof: this.shuffleProof,
      champion: this.champion,
      loanRequests: activeLoanRequests,
      loanLedger: this.loanLedger.slice(-25),
      endGameVote: this.endGameVote,
      finalSettlement: this.finalSettlement
    };
  }

  // ================= PEER-TO-PEER COIN LOAN & NEGOTIATION =================
  createLoanRequest(requesterId, lenderId, amount, note = '') {
    if (this.phase === PHASES.LOBBY) {
      return { error: 'Start the game first to request coins.' };
    }
    if (this.phase === PHASES.GAME_OVER && this.finalSettlement) {
      return { error: 'Game has already ended.' };
    }
    if (requesterId === lenderId) {
      return { error: 'You cannot request coins from yourself.' };
    }
    const requester = this.players.find((p) => p.id === requesterId);
    const lender = this.players.find((p) => p.id === lenderId);
    if (!requester || !lender) {
      return { error: 'Player not found at this table.' };
    }
    const reqAmt = Math.floor(Number(amount) || 0);
    if (reqAmt < 1) {
      return { error: 'Loan amount must be at least 1 coin.' };
    }
    if (lender.coins < reqAmt) {
      return { error: `${lender.name} only has ${lender.coins} coins available.` };
    }

    const existing = this.loanRequests.find(
      (r) =>
        r.requesterId === requesterId &&
        r.lenderId === lenderId &&
        (r.status === 'PENDING_LENDER' || r.status === 'COUNTER_OFFERED')
    );
    if (existing) {
      return { error: `You already have an active loan negotiation with ${lender.name}.` };
    }

    const req = {
      id: `loan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      requesterId: requester.id,
      requesterName: requester.name,
      requesterAvatar: requester.avatar,
      lenderId: lender.id,
      lenderName: lender.name,
      lenderAvatar: lender.avatar,
      requestedAmount: reqAmt,
      currentOfferAmount: reqAmt,
      lastActorId: requester.id,
      note: String(note || '').trim().slice(0, 60),
      status: 'PENDING_LENDER',
      createdAt: Date.now()
    };

    this.loanRequests.push(req);
    if (this.loanRequests.length > 30) {
      this.loanRequests = this.loanRequests.filter(
        (r) => r.status === 'PENDING_LENDER' || r.status === 'COUNTER_OFFERED'
      );
    }
    this.addLog(`🤝 ${requester.name} requested a ${reqAmt}-coin loan from ${lender.name}.`);
    return { ok: true, request: req };
  }

  respondLoanRequest(actorId, requestId, decision, counterAmount = 0) {
    const req = this.loanRequests.find((r) => r.id === requestId);
    if (!req) return { error: 'Loan request not found.' };
    if (req.status !== 'PENDING_LENDER' && req.status !== 'COUNTER_OFFERED') {
      return { error: 'This loan request is already closed.' };
    }

    const requester = this.players.find((p) => p.id === req.requesterId);
    const lender = this.players.find((p) => p.id === req.lenderId);
    if (!requester || !lender) return { error: 'Player no longer at table.' };

    const isLender = actorId === req.lenderId;
    const isRequester = actorId === req.requesterId;
    if (!isLender && !isRequester) {
      return { error: 'You are not part of this loan request.' };
    }

    if (decision === 'reject') {
      req.status = 'REJECTED';
      const who = isLender ? lender.name : requester.name;
      this.addLog(`❌ ${who} declined the ${req.currentOfferAmount}-coin loan.`);
      return { ok: true, status: 'REJECTED', request: req };
    }

    if (decision === 'counter') {
      if (req.status === 'PENDING_LENDER' && !isLender) {
        return { error: `Waiting for ${lender.name} to respond.` };
      }
      if (req.status === 'COUNTER_OFFERED' && !isRequester) {
        return { error: `Waiting for ${requester.name} to respond.` };
      }
      const amt = Math.floor(Number(counterAmount) || 0);
      if (amt < 1) return { error: 'Counter-offer must be at least 1 coin.' };
      if (amt > lender.coins) {
        return { error: `${lender.name} only has ${lender.coins} coins available.` };
      }
      req.currentOfferAmount = amt;
      req.lastActorId = actorId;
      req.status = isLender ? 'COUNTER_OFFERED' : 'PENDING_LENDER';
      const actorName = isLender ? lender.name : requester.name;
      const otherName = isLender ? requester.name : lender.name;
      this.addLog(`💬 ${actorName} negotiated: offered ${amt} coins to ${otherName}.`);
      return { ok: true, status: req.status, request: req };
    }

    if (decision === 'accept') {
      if (req.status === 'PENDING_LENDER' && !isLender) {
        return { error: `Waiting for ${lender.name} to accept or negotiate.` };
      }
      if (req.status === 'COUNTER_OFFERED' && !isRequester) {
        return { error: `Waiting for ${requester.name} to accept your offer.` };
      }
      const finalAmt = req.currentOfferAmount;
      const inActiveHand =
        this.phase !== PHASES.LOBBY &&
        this.phase !== PHASES.SHOWDOWN &&
        this.phase !== PHASES.GAME_OVER &&
        !lender.folded &&
        !lender.eliminated &&
        !lender.allIn;
      const maxLendableNow = inActiveHand ? Math.max(0, lender.coins - 1) : lender.coins;
      if (maxLendableNow < finalAmt) {
        return {
          error: inActiveHand
            ? `${lender.name} can lend up to ${maxLendableNow} coins during an active hand (or wait until Showdown).`
            : `${lender.name} no longer has ${finalAmt} coins available.`
        };
      }

      // Execute airtight coin transfer + loan ledger accounting
      lender.coins -= finalAmt;
      requester.coins += finalAmt;
      lender.loanGiven = (lender.loanGiven || 0) + finalAmt;
      requester.loanTaken = (requester.loanTaken || 0) + finalAmt;

      if (requester.eliminated && requester.coins > 0) {
        requester.eliminated = false;
      }

      req.status = 'ACCEPTED';
      const ledgerEntry = {
        id: req.id,
        fromId: lender.id,
        fromName: lender.name,
        toId: requester.id,
        toName: requester.name,
        amount: finalAmt,
        time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
      };
      this.loanLedger.push(ledgerEntry);
      this.addLog(`✅ Loan Deal! ${lender.name} lent ${finalAmt} coins to ${requester.name}.`);
      return { ok: true, status: 'ACCEPTED', request: req, ledgerEntry };
    }

    return { error: 'Unknown loan action.' };
  }

  // ================= UNANIMOUS END GAME VOTE & FINAL SETTLEMENT =================
  initiateEndGameVote(initiatorId) {
    if (this.phase === PHASES.LOBBY) {
      return { error: 'Game has not started yet.' };
    }
    if (this.phase === PHASES.GAME_OVER) {
      return { error: 'Game is already finished.' };
    }
    const initiator = this.players.find((p) => p.id === initiatorId);
    if (!initiator) return { error: 'Player not found.' };

    const requiredHumans = this.players
      .filter((p) => !p.isBot && p.connected)
      .map((p) => p.id);

    if (requiredHumans.length <= 1) {
      // Only 1 human player at the table (Solo vs AI) -> finalize immediately!
      this.finalizeMatchSettlement(`${initiator.name} Ended the Match`);
      return { ok: true, ended: true, settlement: this.finalSettlement };
    }

    this.endGameVote = {
      initiatorId: initiator.id,
      initiatorName: initiator.name,
      requiredIds: requiredHumans,
      votes: { [initiator.id]: 'ACCEPT' },
      createdAt: Date.now()
    };
    this.addLog(`🏁 ${initiator.name} proposed to End Game & Settle all loans (1/${requiredHumans.length} agreed).`);
    return { ok: true, ended: false, vote: this.endGameVote };
  }

  castEndGameVote(playerId, accept) {
    if (!this.endGameVote) {
      return { error: 'No active End Game vote.' };
    }
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'Player not found.' };

    if (!accept) {
      this.endGameVote = null;
      this.addLog(`🎲 ${player.name} declined End Game — match continues!`);
      return { ok: true, cancelled: true, byName: player.name };
    }

    this.endGameVote.votes[playerId] = 'ACCEPT';
    const activeRequired = this.endGameVote.requiredIds.filter((id) => {
      const pl = this.players.find((p) => p.id === id);
      return pl && !pl.isBot && pl.connected;
    });
    const acceptedCount = activeRequired.filter((id) => this.endGameVote.votes[id] === 'ACCEPT').length;

    if (acceptedCount >= activeRequired.length) {
      this.finalizeMatchSettlement('All Players Agreed to End Game');
      return { ok: true, ended: true, settlement: this.finalSettlement };
    }

    this.addLog(`✅ ${player.name} agreed to End Game (${acceptedCount}/${activeRequired.length}).`);
    return { ok: true, ended: false, vote: this.endGameVote };
  }

  buildFinalSettlement(reason = 'Match Complete') {
    // Consolidate net bilateral debts (who owes whom)
    const pairNet = new Map(); // "borrowerId|lenderId" -> net positive amount
    for (const entry of this.loanLedger) {
      const fwdKey = `${entry.toId}|${entry.fromId}`;
      const revKey = `${entry.fromId}|${entry.toId}`;
      if (pairNet.has(revKey)) {
        const cur = pairNet.get(revKey);
        if (cur.amount > entry.amount) {
          cur.amount -= entry.amount;
        } else if (cur.amount < entry.amount) {
          pairNet.delete(revKey);
          pairNet.set(fwdKey, {
            debtorId: entry.toId,
            debtorName: entry.toName,
            creditorId: entry.fromId,
            creditorName: entry.fromName,
            amount: entry.amount - cur.amount
          });
        } else {
          pairNet.delete(revKey);
        }
      } else {
        const cur = pairNet.get(fwdKey);
        if (cur) {
          cur.amount += entry.amount;
        } else {
          pairNet.set(fwdKey, {
            debtorId: entry.toId,
            debtorName: entry.toName,
            creditorId: entry.fromId,
            creditorName: entry.fromName,
            amount: entry.amount
          });
        }
      }
    }

    const playersSummary = this.players
      .map((p) => {
        const loanGiven = p.loanGiven || 0;
        const loanTaken = p.loanTaken || 0;
        const loanBalance = loanGiven - loanTaken; // + for lender, - for borrower
        const finalAdjustedCoins = p.coins + loanBalance;
        const finalNetProfit = finalAdjustedCoins - p.totalBuyIn;
        return {
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          isBot: p.isBot,
          totalBuyIn: p.totalBuyIn,
          tableCoins: p.coins,
          loanGiven,
          loanTaken,
          loanBalance,
          finalAdjustedCoins,
          finalNetProfit,
          handsWon: p.stats?.handsWon || 0
        };
      })
      .sort((a, b) => {
        if (b.finalNetProfit !== a.finalNetProfit) return b.finalNetProfit - a.finalNetProfit;
        return b.finalAdjustedCoins - a.finalAdjustedCoins;
      });

    return {
      reason,
      endedAt: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      totalHands: this.handNumber,
      totalLoansCount: this.loanLedger.length,
      players: playersSummary,
      debts: [...pairNet.values()].filter((d) => d.amount > 0)
    };
  }

  finalizeMatchSettlement(reason = 'All Players Agreed to End Game') {
    // If ending mid-hand, refund current hand's un-awarded pot cleanly back to contributors
    if (this.pot > 0 && this.phase !== PHASES.SHOWDOWN && this.phase !== PHASES.GAME_OVER) {
      for (const p of this.players) {
        if (p.totalHandBet > 0) {
          p.coins += p.totalHandBet;
          p.totalHandBet = 0;
          p.roundBet = 0;
        }
      }
      this.pot = 0;
      this.currentBet = 0;
    }

    this.phase = PHASES.GAME_OVER;
    this.currentTurnIndex = -1;
    this.turnExpiresAt = null;
    this.allInRunoutPending = false;
    this.endGameVote = null;
    this.finalSettlement = this.buildFinalSettlement(reason);

    const top = this.finalSettlement.players[0];
    this.champion = top
      ? { id: top.id, name: top.name, coins: top.finalAdjustedCoins }
      : null;

    this.addLog(`🏁 Game Ended (${reason})! Final Settlement calculated.`);
    return this.finalSettlement;
  }
}

module.exports = {
  PokerGame,
  PHASES
};
