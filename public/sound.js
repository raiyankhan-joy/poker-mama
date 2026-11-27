'use strict';

// Ultra-lightweight silent stub (0 KB AudioContext/TTS overhead on mobile startup)
class PokerSound {
  constructor() {
    this.muted = true;
    this.voiceEnabled = false;
    this.musicEnabled = false;
  }
  toggleMute() { return true; }
  toggleVoice() { return false; }
  toggleMusic() { return false; }
  setVoiceChatDucking() {}
  narrateBatch() {}
  narrateLog() {}
  speak() {}
  playDeal() {}
  playChip() {}
  playCheck() {}
  playFold() {}
  playWin() {}
  playAllIn() {}
  playYourTurn() {}
  playTick() {}
  playEmote() {}
}

if (typeof window !== 'undefined') {
  window.pokerSound = new PokerSound();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PokerSound };
}
