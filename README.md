# ♠️ ♥️ POOKER — Real-Life Online Texas Hold'em Poker ♦️ ♣️

A real-time, online multiplayer **Texas Hold'em Poker** game built with pure Node.js (zero external dependencies), RFC 6455 WebSockets, and a **Cryptographically Secure (CSPRNG) Shuffle Engine**.

## Key Features
- **Unpredictable Real-Life Shuffle (`server/cryptoDeck.js`)**:
  - Uses Node.js `crypto.randomInt()` (OS cryptographic entropy) with **Fisher-Yates Shuffle + Casino Riffle & Cut + Final Fisher-Yates Pass** and burn cards before Flop, Turn, and River.
  - **Server-Authoritative Privacy**: Opponents' 2 private cards are never transmitted to your browser until Showdown (or optional Show).
  - Generates a **SHA-256 Fair-Shuffle Commitment Hash** every round.
- **Configurable Lobby Setup**:
  - Choose **Number of Players** (`2` to `8`).
  - Choose **Starting Coins** per player (presets `50 / 100 / 250 / 500 / 1000` or any custom amount).
  - **1 Coin Board Fee (Ante)** collected automatically per round.
- **Complete Texas Hold'em Rules**:
  - 2 private hole cards + 5 community cards (**Pre-Flop**, **Flop**, **Turn**, **River**, **Showdown**).
  - Actions: **Check**, **Call**, **Raise / Bet** (slider + `Min`, `2x`, `Pot`, `All-In`), **Fold**, and **Show Cards**.
  - Accurate 7-card hand evaluation (Royal Flush down to High Card), side-pot calculation for All-Ins, and split-pot support for ties.
- **Play Online with Friends OR Solo vs Smart AI Bots**:
  - Create an online room and share the 6-character Room Code, or play immediately against AI bots!

## How to Run
```bash
npm start
```
Then open `http://localhost:3000` in your browser! (Open multiple tabs or share your local/deployed URL with friends to play online together.)

## Run Automated Tests
```bash
npm test
```
