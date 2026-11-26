'use strict';

const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

/**
 * Cryptographically Secure Deck using Node.js CSPRNG (crypto.randomInt).
 * Uses Fisher-Yates shuffle + simulated casino riffle/cut + final Fisher-Yates pass.
 * Guarantees uniform distribution across all 52! permutations with zero modulo bias.
 */
class CryptoDeck {
  constructor() {
    this.cards = [];
    this.burned = [];
    this.shuffleId = null;
    this.commitmentHash = null;
    this._salt = null;
    this.resetAndShuffle();
  }

  /**
   * Build a fresh 52-card deck and shuffle using OS cryptographic entropy.
   */
  resetAndShuffle() {
    this.cards = [];
    this.burned = [];

    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({
          rank,
          suit,
          label: RANK_LABELS[rank],
          symbol: SUIT_SYMBOLS[suit],
          code: `${RANK_LABELS[rank]}${suit}`
        });
      }
    }

    // Pass 1: CSPRNG Fisher-Yates shuffle
    this._fisherYatesCSPRNG(this.cards);

    // Pass 2: Real-life casino riffle + cut with cryptographic randomness
    this._casinoRiffleAndCut(this.cards);

    // Pass 3: Final CSPRNG Fisher-Yates shuffle for mathematical uniformity
    this._fisherYatesCSPRNG(this.cards);

    // Provably-fair commitment hash (deck order + 256-bit random salt)
    this._salt = crypto.randomBytes(32).toString('hex');
    this.shuffleId = crypto.randomBytes(6).toString('hex').toUpperCase();
    this._initialOrder = this.cards.map((c) => c.code);
    const deckSignature = this._initialOrder.join(',');
    this.commitmentHash = crypto
      .createHash('sha256')
      .update(`${deckSignature}|${this._salt}`)
      .digest('hex');
  }

  /**
   * Returns provably-fair verification proof (ONLY call after hand ends at Showdown).
   */
  getProof() {
    return {
      shuffleId: this.shuffleId,
      commitmentHash: this.commitmentHash,
      salt: this._salt,
      deckOrder: this._initialOrder
    };
  }

  /**
   * Unbiased Fisher-Yates (Durstenfeld/Knuth) shuffle using crypto.randomInt.
   */
  _fisherYatesCSPRNG(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  /**
   * Simulates a physical casino riffle shuffle and deck cut using CSPRNG.
   */
  _casinoRiffleAndCut(arr) {
    const mid = Math.floor(arr.length / 2) + crypto.randomInt(-3, 4);
    const left = arr.slice(0, mid);
    const right = arr.slice(mid);
    const merged = [];

    let l = 0;
    let r = 0;
    while (l < left.length || r < right.length) {
      if (l >= left.length) {
        merged.push(right[r++]);
      } else if (r >= right.length) {
        merged.push(left[l++]);
      } else {
        // Weighted by remaining pile sizes like a real riffle (Gilbert-Shannon-Reeds model)
        const total = (left.length - l) + (right.length - r);
        const pick = crypto.randomInt(0, total);
        if (pick < left.length - l) {
          merged.push(left[l++]);
        } else {
          merged.push(right[r++]);
        }
      }
    }

    // Random cut between card 10 and 42
    const cutPoint = crypto.randomInt(10, arr.length - 10);
    const cutDeck = merged.slice(cutPoint).concat(merged.slice(0, cutPoint));
    for (let i = 0; i < arr.length; i++) {
      arr[i] = cutDeck[i];
    }
  }

  /**
   * Deal one card from the top of the deck.
   */
  dealOne() {
    if (this.cards.length === 0) {
      throw new Error('Deck is empty');
    }
    return this.cards.pop();
  }

  /**
   * Deal N cards from the top of the deck.
   */
  deal(count = 1) {
    const dealt = [];
    for (let i = 0; i < count; i++) {
      dealt.push(this.dealOne());
    }
    return dealt;
  }

  /**
   * Burn the top card (standard casino practice before Flop, Turn, River).
   */
  burn() {
    if (this.cards.length > 0) {
      this.burned.push(this.cards.pop());
    }
  }

  get remaining() {
    return this.cards.length;
  }
}

module.exports = {
  CryptoDeck,
  SUITS,
  SUIT_SYMBOLS,
  RANKS,
  RANK_LABELS
};
