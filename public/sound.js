'use strict';

class PokerSound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voiceEnabled = false;
    this.musicEnabled = false;
    this._musicPlaying = false;
    this._musicTimer = null;
    this._chordStep = 0;

    this._selectedVoice = null;
    this._speechQueue = [];
    this._pendingNext = null;
    this._speakDelayTimer = null;
    this._speaking = false;
    this._currentPriority = 0;
    this._voiceChatActive = false;

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const loadVoices = () => {
        const voices = window.speechSynthesis.getVoices() || [];
        // Prioritize soft, fresh, natural female voices on macOS / Chrome / Windows
        const preferredPatterns = [
          /samantha/i,
          /ava\b/i,
          /zoe\b/i,
          /allison/i,
          /google us english/i,
          /google uk english female/i,
          /karen/i,
          /tessa/i,
          /victoria/i,
          /moira/i,
          /zira/i,
          /aria/i,
          /jenny/i,
          /female/i
        ];
        for (const pat of preferredPatterns) {
          const found = voices.find((v) => pat.test(v.name) && /^en/i.test(v.lang));
          if (found) {
            this._selectedVoice = found;
            return;
          }
        }
        this._selectedVoice = voices.find((v) => /^en(-|_)/i.test(v.lang)) || voices[0] || null;
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    // Unlock Web Audio & start soft lounge background music on first user gesture
    if (typeof window !== 'undefined') {
      const unlock = () => {
        this._ensureCtx();
        if (this.musicEnabled && !this._musicPlaying) {
          this.startBackgroundMusic();
        }
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      };
      window.addEventListener('pointerdown', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });
    }
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setVoiceChatDucking(active) {
    this._voiceChatActive = Boolean(active);
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  toggleVoice() {
    this.voiceEnabled = !this.voiceEnabled;
    if (!this.voiceEnabled && 'speechSynthesis' in window) {
      this._speechQueue = [];
      this._pendingNext = null;
      this._speaking = false;
      this._currentPriority = 0;
      if (this._speakDelayTimer) {
        clearTimeout(this._speakDelayTimer);
        this._speakDelayTimer = null;
      }
      window.speechSynthesis.cancel();
    }
    return this.voiceEnabled;
  }

  toggleMusic() {
    this.musicEnabled = false;
    this.stopBackgroundMusic();
    return false;
  }

  /**
   * Background lounge music disabled.
   */
  startBackgroundMusic() {
    this.musicEnabled = false;
    this._musicPlaying = false;
    return;
    const ctx = this._ensureCtx();
    if (!ctx) return;

    this._musicPlaying = true;
    // Warm jazzy chord frequencies (Hz)
    const chords = [
      [261.63, 329.63, 392.0, 493.88], // Cmaj7
      [220.0, 261.63, 329.63, 392.0],  // Am7
      [293.66, 349.23, 440.0, 523.25], // Dm7
      [196.0, 246.94, 293.66, 349.23]  // G7
    ];

    const playChord = () => {
      if (!this._musicPlaying || !this.musicEnabled) return;
      const audioCtx = this._ensureCtx();
      if (!audioCtx) return;

      const now = audioCtx.currentTime;
      const chord = chords[this._chordStep % chords.length];
      this._chordStep += 1;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(750, now);

      // Smoothly duck background music when Voice Chat or Dealer Narrator is active
      const peakGain = this._voiceChatActive ? 0.008 : this._speaking ? 0.014 : 0.03;

      const masterGain = audioCtx.createGain();
      masterGain.gain.setValueAtTime(0.0001, now);
      masterGain.gain.linearRampToValueAtTime(peakGain, now + 0.6);
      masterGain.gain.exponentialRampToValueAtTime(peakGain * 0.4, now + 2.8);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.5);

      filter.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      chord.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        osc.type = idx === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.06);
        osc.connect(filter);
        osc.start(now + idx * 0.06);
        osc.stop(now + 3.6);
      });
    };

    playChord();
    this._musicTimer = setInterval(playChord, 3600);
  }

  stopBackgroundMusic() {
    this._musicPlaying = false;
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      this._musicTimer = null;
    }
  }

  /**
   * Converts a raw Table Log string into a short, crystal-clear casino dealer callout
   * so voice stays 100% synced with fast gameplay.
   */
  _formatDealerCallout(raw) {
    if (!raw) return null;
    const text = String(raw)
      .replace(/[\u{1F300}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/---+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;

    const lower = text.toLowerCase();

    // Skip noisy system/bookkeeping lines that slow down narration
    if (
      lower.includes('board fee') && !lower.includes('hand #') && !lower.includes('round #') ||
      lower.includes('blinds posted') ||
      lower.includes('joined') ||
      lower.includes('left the table') ||
      lower.includes('rebuy') ||
      lower.includes('shuffle')
    ) {
      return null;
    }

    // 1) Winner / Pot Award (Highest priority — never interrupt)
    const winMatch = text.match(/^(.+?)\s+wins?\s+(\d+)\s*coins?(?:\s+with\s+([^(]+))?/i);
    if (winMatch) {
      const name = winMatch[1].trim();
      const amt = winMatch[2];
      const hand = winMatch[3] ? winMatch[3].trim().replace(/[!.]+$/, '') : '';
      return {
        text: hand ? `${name} wins ${amt}, ${hand}!` : `${name} wins ${amt}!`,
        priority: 3
      };
    }

    // 2) Streets (short & punchy)
    if (/\bflop\b/i.test(text) && /dealt|cards|:/i.test(text)) {
      return { text: 'Flop.', priority: 2 };
    }
    if (/\bturn\b/i.test(text) && /dealt|card|:/i.test(text)) {
      return { text: 'Turn.', priority: 2 };
    }
    if (/\briver\b/i.test(text) && /dealt|card|:/i.test(text)) {
      return { text: 'River.', priority: 2 };
    }
    if (/showdown/i.test(text)) {
      return { text: 'Showdown!', priority: 2 };
    }

    // 3) New Round / Hand Started
    const handMatch = text.match(/(?:Hand|Round)\s*#(\d+)/i);
    if (handMatch && /start|dealt|board fee/i.test(lower)) {
      return { text: `Round ${handMatch[1]}.`, priority: 2 };
    }

    // 4) Player Actions (concise & instant)
    const timeoutMatch = text.match(/^(.+?)\s+timed out.*auto-(check|fold)/i);
    if (timeoutMatch) {
      return { text: `${timeoutMatch[1].trim()} ${timeoutMatch[2] === 'check' ? 'checks' : 'folds'}.`, priority: 1 };
    }

    const allInMatch = text.match(/^(.+?)\s+(?:went\s+|goes\s+)?all[- ]?in/i);
    if (allInMatch) {
      return { text: `${allInMatch[1].trim()}, all in!`, priority: 2 };
    }

    const raiseMatch = text.match(/^(.+?)\s+raised?(?:\s+(?:by|to))?\s*\+?(\d+)/i);
    if (raiseMatch) {
      return { text: `${raiseMatch[1].trim()} raises to ${raiseMatch[2]}.`, priority: 1 };
    }

    const betMatch = text.match(/^(.+?)\s+bet\s+(\d+)/i);
    if (betMatch) {
      return { text: `${betMatch[1].trim()} bets ${betMatch[2]}.`, priority: 1 };
    }

    const callMatch = text.match(/^(.+?)\s+called?\s+(\d+)/i);
    if (callMatch) {
      return { text: `${callMatch[1].trim()} calls ${callMatch[2]}.`, priority: 1 };
    }

    const checkMatch = text.match(/^(.+?)\s+checked/i);
    if (checkMatch) {
      return { text: `${checkMatch[1].trim()} checks.`, priority: 1 };
    }

    const foldMatch = text.match(/^(.+?)\s+folded/i);
    if (foldMatch) {
      return { text: `${foldMatch[1].trim()} folds.`, priority: 1 };
    }

    return null;
  }

  /**
   * Picks the most relevant live callout from a batch of new log lines
   * so voice never falls behind fast gameplay.
   */
  narrateBatch(rawMessages) {
    if (!this.voiceEnabled || !Array.isArray(rawMessages) || rawMessages.length === 0) return;
    let best = null;
    for (const raw of rawMessages) {
      const item = this._formatDealerCallout(raw);
      if (!item) continue;
      if (!best || item.priority >= best.priority) {
        best = item;
      }
    }
    if (best) {
      this._speakLive(best.text, best.priority);
    }
  }

  /**
   * Single-line entry point (backwards compatible).
   */
  narrateLog(rawMessage) {
    this.narrateBatch([rawMessage]);
  }

  /**
   * Direct voice utterance (e.g., for toggles or quick callouts).
   */
  speak(text, cancelPrevious = true) {
    if (!this.voiceEnabled || !text || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }
    this._speakLive(text, cancelPrevious ? 3 : 1);
  }

  _speakLive(text, priority = 1) {
    if (!this.voiceEnabled || !text || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    // Never interrupt an active Winner announcement with normal actions
    if (this._speaking && this._currentPriority >= 3 && priority < 3) {
      return;
    }

    // Silky-smooth flow: if a short action is already mid-word and another normal action arrives,
    // let the current word finish cleanly (~0.5s) and immediately play ONLY the latest action (no backlog, no clipping!)
    if (this._speaking && priority === 1 && this._currentPriority === 1) {
      this._pendingNext = { text, priority };
      return;
    }

    this._pendingNext = null;
    this._dispatchUtterance(text, priority, this._speaking);
  }

  _dispatchUtterance(text, priority, needsCancel = false) {
    if (this._speechSafetyTimer) {
      clearTimeout(this._speechSafetyTimer);
      this._speechSafetyTimer = null;
    }
    if (this._speakDelayTimer) {
      clearTimeout(this._speakDelayTimer);
      this._speakDelayTimer = null;
    }

    this._speaking = true;
    this._currentPriority = priority;

    const launch = () => {
      if (!this.voiceEnabled) {
        this._speaking = false;
        this._currentPriority = 0;
        return;
      }
      try {
        const utter = new SpeechSynthesisUtterance(text);
        if (this._selectedVoice) {
          utter.voice = this._selectedVoice;
        }
        utter.lang = 'en-US';
        // Silky-smooth, clear, natural casino dealer cadence
        utter.pitch = 1.04;
        utter.rate = 1.16;
        utter.volume = 0.92;

        const finish = () => {
          if (this._speechSafetyTimer) {
            clearTimeout(this._speechSafetyTimer);
            this._speechSafetyTimer = null;
          }
          const queued = this._pendingNext;
          this._pendingNext = null;
          if (queued && this.voiceEnabled) {
            this._dispatchUtterance(queued.text, queued.priority, false);
          } else {
            this._speaking = false;
            this._currentPriority = 0;
          }
        };

        utter.onend = finish;
        utter.onerror = finish;
        this._speechSafetyTimer = setTimeout(finish, 2600);

        window.speechSynthesis.speak(utter);
      } catch (_) {
        this._speaking = false;
        this._currentPriority = 0;
      }
    };

    if (needsCancel) {
      try {
        window.speechSynthesis.cancel();
      } catch (_) {}
      // 35ms micro-debounce prevents Chrome/Safari audio crackle or dropped utterances after cancel()
      this._speakDelayTimer = setTimeout(launch, 35);
    } else {
      launch();
    }
  }

  playDeal() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const bufferSize = ctx.sampleRate * 0.09;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(600, now + 0.09);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  playChip() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [2200, 3100].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.035);
      gain.gain.setValueAtTime(0.12, now + idx * 0.035);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.035 + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.035);
      osc.stop(now + idx * 0.035 + 0.085);
    });
  }

  playCheck() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.08].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(210, now + offset);
      osc.frequency.exponentialRampToValueAtTime(85, now + offset + 0.06);
      gain.gain.setValueAtTime(0.22, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.065);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.07);
    });
  }

  playFold() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.14);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  playWin() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.09);
      gain.gain.setValueAtTime(0.14, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.3);
    });
  }

  playEmote() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(980, now + 0.09);
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  playYourTurn() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.075);
      gain.gain.setValueAtTime(0.1, now + i * 0.075);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.075 + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.075);
      osc.stop(now + i * 0.075 + 0.17);
    });
  }

  playTick() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1050, now);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  playAllIn() {
    if (this.muted) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Deep dramatic bass hit + crisp chip cascade
    const bass = ctx.createOscillator();
    const bassGain = ctx.createGain();
    bass.type = 'sawtooth';
    bass.frequency.setValueAtTime(140, now);
    bass.frequency.exponentialRampToValueAtTime(52, now + 0.38);
    bassGain.gain.setValueAtTime(0.16, now);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    bass.connect(bassGain);
    bassGain.connect(ctx.destination);
    bass.start(now);
    bass.stop(now + 0.44);
  }
}

window.pokerSound = new PokerSound();
