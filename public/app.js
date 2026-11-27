'use strict';

(() => {
  // ================= STATE =================
  let ws = null;
  let myId = null;
  let hostId = null;
  let currentState = null;
  let selectedPlayers = 4;
  let selectedCoins = 100;
  let selectedAvatar = '😎';
  let isSpectatorMode = false;
  let unreadChatCount = 0;
  let toastTimer = null;
  let lastPhase = null;
  let lastHandNumber = 0;
  let lastPot = 0;
  let wasMyTurn = false;
  let lastRaiseTurnKey = '';
  let seenCardKeys = new Set();
  let seenLogIds = new Set();
  let pendingAction = false;
  let serverClockOffset = 0;
  let activeEmotes = new Map(); // playerId -> { text, expiresAt }

  // ================= DOM REFS =================
  const $ = (id) => document.getElementById(id);

  const lobbyScreen = $('lobby-screen');
  const gameScreen = $('game-screen');
  const toastEl = $('toast');

  // Lobby inputs
  const playerNameInput = $('player-name-input');
  const customCoinsInput = $('custom-coins-input');
  const useBlindsCheckbox = $('use-blinds-checkbox');
  const roomCodeInput = $('room-code-input');

  // Top bar
  const displayRoomCode = $('display-room-code');
  const displayRound = $('display-round');
  const displayPhase = $('display-phase');
  const shuffleHashBadge = $('shuffle-hash-badge');
  const btnVoiceChat = $('btn-voice-chat');
  const btnVoiceMute = $('btn-voice-mute');
  const btnVoicePtt = $('btn-voice-ptt');
  const floatingPttBtn = $('floating-ptt-btn');
  const voiceAudioContainer = $('voice-audio-container');

  // Table
  const displayPot = $('display-pot');
  const displayCurrentBet = $('display-current-bet');
  const sidePotsBar = $('side-pots-bar');
  const communityCardsEl = $('community-cards');
  const seatsLayer = $('seats-layer');

  // Overlays
  const waitingOverlay = $('waiting-overlay');
  const overlayRoomCode = $('overlay-room-code');
  const overlayPlayerCount = $('overlay-player-count');
  const overlayStartingCoins = $('overlay-starting-coins');
  const hostLobbyControls = $('host-lobby-controls');
  const nonHostWaitMsg = $('non-host-wait-msg');

  const showdownBanner = $('showdown-banner');
  const winnerTitle = $('winner-title');
  const winnerDetail = $('winner-detail');
  const btnShowCards = $('btn-show-cards');
  const btnRebuy = $('btn-rebuy');
  const btnNextHand = $('btn-next-hand');

  const gameoverOverlay = $('gameover-overlay');
  const championName = $('champion-name');
  const championCoins = $('champion-coins');
  const btnGameoverRebuy = $('btn-gameover-rebuy');
  const btnRestartGame = $('btn-restart-game');

  // Betting dock
  const strengthValue = $('strength-value');
  const strengthBarFill = $('strength-bar-fill');
  const myCoinsDisplay = $('my-coins-display');
  const myNetDisplay = $('my-net-display');
  const turnStatusText = $('turn-status-text');
  const btnFold = $('btn-fold');
  const btnCheckCall = $('btn-check-call');
  const checkCallTitle = $('check-call-title');
  const checkCallSub = $('check-call-sub');
  const raiseSlider = $('raise-slider');
  const raiseNumber = $('raise-number');
  const btnRaise = $('btn-raise');
  const raiseBtnTitle = $('raise-btn-title');
  const raiseBtnSub = $('raise-btn-sub');
  const quickBetButtons = document.querySelectorAll('.q-btn');

  // Side drawer & modals
  const sideDrawer = $('side-drawer');
  const actionLogList = $('action-log-list');
  const chatMessages = $('chat-messages');
  const chatForm = $('chat-form');
  const chatInput = $('chat-input');
  const rulesModal = $('rules-modal');
  const statsModal = $('stats-modal');
  const statsTableBody = $('stats-table-body');
  const fairModal = $('fair-modal');
  const fairModalBody = $('fair-modal-body');

  // ================= TOAST =================
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 3000);
  }

  // ================= WEBSOCKET =================
  function connectWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      // Connected cleanly
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (msg.type === 'connected') {
        myId = msg.clientId;
      } else if (msg.type === 'session_expired') {
        leaveVoiceChat(false);
        voicePeersMap.clear();
        currentState = null;
        pendingAction = false;
        lastPhase = null;
        lastHandNumber = 0;
        lastPot = 0;
        wasMyTurn = false;
        lastRaiseTurnKey = '';
        seenCardKeys.clear();
        seenLogIds.clear();
        gameScreen.classList.add('hidden');
        lobbyScreen.classList.remove('hidden');
        syncLobbyHistoryUrl();
        showToast(`ℹ️ ${msg.message || 'Session refreshed. Please start or join a table.'}`);
      } else if (msg.type === 'error') {
        pendingAction = false;
        showToast(`⚠️ ${msg.message}`);
      } else if (msg.type === 'left_room') {
        leaveVoiceChat(false);
        voicePeersMap.clear();
        currentState = null;
        pendingAction = false;
        lastPhase = null;
        lastHandNumber = 0;
        lastPot = 0;
        wasMyTurn = false;
        lastRaiseTurnKey = '';
        seenCardKeys.clear();
        seenLogIds.clear();
        gameScreen.classList.add('hidden');
        lobbyScreen.classList.remove('hidden');
        syncLobbyHistoryUrl();
      } else if (msg.type === 'game_state') {
        pendingAction = false;
        hostId = msg.hostId;
        myId = msg.myId;
        isSpectatorMode = Boolean(msg.isSpectator);
        const wasInLobby = gameScreen.classList.contains('hidden');
        currentState = msg.state;
        if (currentState.serverNow) {
          serverClockOffset = currentState.serverNow - Date.now();
        }
        lobbyScreen.classList.add('hidden');
        gameScreen.classList.remove('hidden');
        if (wasInLobby) {
          pushGameHistoryState(currentState.roomId);
        }
        renderGameState(currentState);
      } else if (msg.type === 'pong_latency') {
        const rtt = Math.max(1, Date.now() - (Number(msg.ts) || Date.now()));
        const pingEl = $('display-ping');
        const pingPill = $('ping-pill');
        if (pingEl && pingPill) {
          pingEl.textContent = `${rtt}ms`;
          const dot = rtt < 80 ? '🟢' : rtt < 180 ? '🟡' : '🔴';
          pingPill.firstChild.textContent = `${dot} `;
        }
      } else if (msg.type === 'action_sfx') {
        playActionSound(msg.action);
      } else if (msg.type === 'chat_message') {
        window.pokerSound?.playEmote();
        appendChatMessage(msg);
        if (sideDrawer.classList.contains('closed')) {
          unreadChatCount += 1;
          const toggleBtn = $('btn-toggle-drawer');
          if (toggleBtn) {
            toggleBtn.textContent = `💬 ${unreadChatCount}`;
            toggleBtn.classList.add('has-unread');
          }
        }
      } else if (msg.type === 'player_emote') {
        triggerEmoteBubble(msg.playerId, msg.text, msg.playerId !== myId);
      } else if (msg.type === 'voice_state') {
        handleVoiceState(msg.peers || []);
      } else if (msg.type === 'voice_joined') {
        handleVoiceJoined(msg.peers || []);
      } else if (msg.type === 'voice_user_joined') {
        if (voiceJoined && msg.playerId && msg.playerId !== myId) {
          scheduleRelayFallback(msg.playerId);
        }
        showToast(`🎙️ ${msg.name || 'Player'} joined Voice Chat`);
      } else if (msg.type === 'voice_user_left') {
        closePeerConnection(msg.playerId);
      } else if (msg.type === 'voice_signal') {
        handleVoiceSignal(msg.fromId, msg.data);
      } else if (msg.type === 'voice_audio') {
        handleRelayVoiceAudio(msg.fromId, msg.sr, msg.d);
      } else if (msg.type === 'loan_notify') {
        window.pokerSound?.playEmote();
        showToast(msg.message);
      }
    });

    ws.addEventListener('close', () => {
      leaveVoiceChat(false);
      voicePeersMap.clear();
      showToast('Connection lost. Reconnecting...');
      setTimeout(connectWS, 2000);
    });
  }

  function triggerEmoteBubble(playerId, text, playSound = true) {
    if (!playerId || !text) return;
    if (playSound) window.pokerSound?.playEmote();
    const expiresAt = Date.now() + 3400;
    activeEmotes.set(playerId, { text, expiresAt });

    // Patch DOM directly for 60 FPS zero-flicker emotes (never resets raise slider!)
    const seatEl = seatsLayer?.querySelector(`.seat-node[data-player-id="${CSS.escape(playerId)}"]`);
    if (seatEl) {
      let bubble = seatEl.querySelector('.seat-emote-bubble');
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'seat-emote-bubble';
        seatEl.prepend(bubble);
      }
      bubble.textContent = text;
    }

    setTimeout(() => {
      const item = activeEmotes.get(playerId);
      if (item && item.expiresAt === expiresAt) {
        activeEmotes.delete(playerId);
        const el = seatsLayer?.querySelector(`.seat-node[data-player-id="${CSS.escape(playerId)}"] .seat-emote-bubble`);
        if (el) el.remove();
      }
    }, 3450);
  }

  function send(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showToast('Connecting to server... please try again.');
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function playActionSound(action) {
    if (!window.pokerSound) return;
    if (action === 'deal') window.pokerSound.playDeal();
    else if (action === 'check') window.pokerSound.playCheck();
    else if (action === 'fold') window.pokerSound.playFold();
    else if (action === 'allin') {
      window.pokerSound.playAllIn();
      window.pokerSound.playChip();
    } else if (action === 'call' || action === 'raise') {
      window.pokerSound.playChip();
    }
  }

  // ================= ULTRA-LIGHTWEIGHT 4Hz TURN TIMER (ZERO 60FPS REFLOW LAG!) =================
  let lastRenderedTurnSec = -1;
  setInterval(() => {
    if (gameScreen.classList.contains('hidden')) return;
    if (currentState && currentState.turnExpiresAt) {
      const now = Date.now() + serverClockOffset;
      const remaining = Math.max(0, currentState.turnExpiresAt - now);
      const pct = Math.min(100, (remaining / (currentState.turnDurationMs || 30000)) * 100);
      const secs = Math.ceil(remaining / 1000);

      const fillEl = seatsLayer?.querySelector('.turn-timer-fill');
      if (fillEl) {
        fillEl.style.width = `${pct.toFixed(1)}%`;
        fillEl.classList.toggle('urgent', secs <= 8);
      }

      if (currentState.validActions?.isTurn && secs !== lastRenderedTurnSec) {
        lastRenderedTurnSec = secs;
        turnStatusText.textContent = `✨ YOUR TURN (${secs}s) — Check, Call, Raise, or Fold`;
        if (secs > 0 && secs <= 5) {
          window.pokerSound?.playTick();
        }
      }
    } else {
      lastRenderedTurnSec = -1;
    }
  }, 250);

  // ================= LOBBY INTERACTIONS =================
  // Restore saved display name & avatar
  try {
    const savedName = localStorage.getItem('pooker_player_name');
    if (savedName) playerNameInput.value = savedName;
    const savedAvatar = localStorage.getItem('pooker_avatar');
    if (savedAvatar) selectedAvatar = savedAvatar;
  } catch (_) {}

  playerNameInput.addEventListener('input', () => {
    try {
      localStorage.setItem('pooker_player_name', playerNameInput.value.trim());
    } catch (_) {}
  });

  document.querySelectorAll('#avatar-picker .av-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.avatar === selectedAvatar);
    btn.addEventListener('click', () => {
      document.querySelectorAll('#avatar-picker .av-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedAvatar = btn.dataset.avatar || '😎';
      try {
        localStorage.setItem('pooker_avatar', selectedAvatar);
      } catch (_) {}
    });
  });

  // Auto-detect 1-click Invite Link (?room=ABCDEF)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = (urlParams.get('room') || '').trim().toUpperCase();
    if (inviteCode && inviteCode.length >= 4) {
      roomCodeInput.value = inviteCode;
      showToast(`🎉 Invited to Room ${inviteCode}! Click "Join" to enter the table.`);
    }
  } catch (_) {}

  const customPlayersInput = $('custom-players-input');

  document.querySelectorAll('#player-count-selector .sel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#player-count-selector .sel-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPlayers = Number(btn.dataset.players);
      if (customPlayersInput) customPlayersInput.value = selectedPlayers;
    });
  });

  customPlayersInput?.addEventListener('input', () => {
    const val = Math.floor(Number(customPlayersInput.value));
    if (val >= 2 && val <= 22) {
      selectedPlayers = val;
      document.querySelectorAll('#player-count-selector .sel-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.players) === selectedPlayers);
      });
    }
  });

  document.querySelectorAll('#coins-preset-selector .sel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#coins-preset-selector .sel-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCoins = Number(btn.dataset.coins);
      customCoinsInput.value = selectedCoins;
    });
  });

  customCoinsInput.addEventListener('input', () => {
    const val = Number(customCoinsInput.value);
    if (val >= 10) {
      selectedCoins = Math.floor(val);
      document.querySelectorAll('#coins-preset-selector .sel-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.coins) === selectedCoins);
      });
    }
  });

  function getSelectedMaxPlayers() {
    const raw = Math.floor(Number(customPlayersInput?.value) || selectedPlayers || 4);
    return Math.min(22, Math.max(2, raw));
  }

  function isTouchMobileDevice() {
    return (
      window.matchMedia?.('(pointer: coarse)').matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    );
  }

  async function enterMobileLandscapeFullscreen(force = false) {
    if (!force && !isTouchMobileDevice()) return;
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      } else if (!document.webkitFullscreenElement && el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch (_) {}
    try {
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        await screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (_) {}
  }

  $('btn-landscape-mode')?.addEventListener('click', async () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch (_) {}
      try {
        screen.orientation?.unlock?.();
      } catch (_) {}
    } else {
      await enterMobileLandscapeFullscreen(true);
    }
  });

  $('btn-create-solo').addEventListener('click', () => {
    enterMobileLandscapeFullscreen();
    const name = playerNameInput.value.trim() || 'Player 1';
    const coins = Math.max(10, Math.floor(Number(customCoinsInput.value) || selectedCoins));
    send({
      type: 'create_room',
      playerName: name,
      avatar: selectedAvatar,
      maxPlayers: getSelectedMaxPlayers(),
      startingCoins: coins,
      useBlinds: Boolean(useBlindsCheckbox?.checked),
      fillWithBots: true
    });
  });

  $('btn-create-online').addEventListener('click', () => {
    enterMobileLandscapeFullscreen();
    const name = playerNameInput.value.trim() || 'Player 1';
    const coins = Math.max(10, Math.floor(Number(customCoinsInput.value) || selectedCoins));
    send({
      type: 'create_room',
      playerName: name,
      avatar: selectedAvatar,
      maxPlayers: 22,
      startingCoins: coins,
      useBlinds: Boolean(useBlindsCheckbox?.checked),
      isPublic: true,
      fillWithBots: false
    });
  });

  $('btn-quick-match').addEventListener('click', () => {
    enterMobileLandscapeFullscreen();
    const name = playerNameInput.value.trim() || 'Player 1';
    const coins = Math.max(10, Math.floor(Number(customCoinsInput.value) || selectedCoins));
    send({
      type: 'quick_match',
      playerName: name,
      avatar: selectedAvatar,
      maxPlayers: getSelectedMaxPlayers(),
      startingCoins: coins,
      useBlinds: Boolean(useBlindsCheckbox?.checked)
    });
  });

  function extractRoomCode(raw) {
    const str = String(raw || '').trim();
    const urlMatch = str.match(/[?&]room=([A-Za-z0-9]{4,8})/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    return str.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  }

  function focusRoomCodeInput(reasonText) {
    if (roomCodeInput) {
      roomCodeInput.focus();
      roomCodeInput.classList.remove('pulse-attention');
      void roomCodeInput.offsetWidth;
      roomCodeInput.classList.add('pulse-attention');
    }
    showToast(reasonText);
  }

  $('btn-join-room').addEventListener('click', () => {
    const code = extractRoomCode(roomCodeInput.value);
    const name = playerNameInput.value.trim() || 'Player';
    if (!code || code.length < 4) {
      focusRoomCodeInput('🔒 Enter a valid Room Code to Join!');
      return;
    }
    enterMobileLandscapeFullscreen();
    roomCodeInput.value = code;
    send({ type: 'join_room', roomId: code, playerName: name, avatar: selectedAvatar });
  });

  $('btn-watch-room')?.addEventListener('click', () => {
    const code = extractRoomCode(roomCodeInput.value);
    const name = playerNameInput.value.trim() || 'Spectator';
    if (!code || code.length < 4) {
      focusRoomCodeInput('🔒 Enter a valid Room Code to Watch!');
      return;
    }
    enterMobileLandscapeFullscreen();
    roomCodeInput.value = code;
    send({ type: 'spectate_room', roomId: code, playerName: name });
  });

  roomCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btn-join-room')?.click();
    }
  });

  // Cleanly close WebSocket on reload / tab close so Online Player count updates immediately
  window.addEventListener('pagehide', () => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'pagehide');
    } catch (_) {}
  });

  // Live Public Tables Browser API (Privacy-Locked: Room Code required to Join or Watch!)
  let liveTableFilter = 'all';
  let lastLiveRoomsData = [];

  function renderSeatDots(count, max) {
    const safeMax = Math.min(8, Math.max(2, Number(max) || 4));
    const filled = Math.min(safeMax, Math.max(0, Number(count) || 0));
    let html = '<span class="seat-dots" aria-hidden="true">';
    for (let i = 0; i < safeMax; i++) {
      html += `<span class="seat-dot${i < filled ? ' filled' : ''}"></span>`;
    }
    html += '</span>';
    return html;
  }

  function renderLiveTablesList() {
    const listEl = $('live-tables-list');
    if (!listEl) return;

    const rooms = lastLiveRoomsData || [];
    const filtered = rooms.filter((r) => {
      if (liveTableFilter === 'open') return r.status === 'OPEN';
      if (liveTableFilter === 'live') return r.status === 'LIVE';
      return true;
    });

    if (filtered.length === 0) {
      const msg =
        rooms.length === 0
          ? 'No active tables right now.<br/>Create a room or enter a friend’s <strong>Room Code</strong> above!'
          : liveTableFilter === 'open'
            ? 'No open tables waiting right now.<br/>Switch to <strong>Live</strong> or create a new room!'
            : 'No live hands in progress right now.<br/>Create a room or enter a <strong>Room Code</strong> above!';
      listEl.innerHTML = `<div class="empty-tables-msg"><div class="empty-tables-icon">🃏</div><div>${msg}</div></div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((r) => {
        const isLive = r.status === 'LIVE';
        const statusBadge = isLive
          ? `<span class="table-status-badge live"><span class="status-dot live"></span>LIVE &bull; Rd #${r.handNumber || 1}</span>`
          : `<span class="table-status-badge open"><span class="status-dot open"></span>OPEN</span>`;
        const voiceBadge =
          r.voiceCount > 0
            ? `<span class="voice-live-tag" title="${r.voiceCount} player(s) in Voice Chat">🎙️ ${r.voiceCount}</span>`
            : '';
        const actionBtn = isLive
          ? `<button type="button" class="btn btn-watch-violet" data-require-code="watch">🔒 Watch</button>`
          : `<button type="button" class="btn btn-join-emerald" data-require-code="join">🔒 Join</button>`;
        const potChip =
          isLive && r.pot > 0 ? `<span class="table-meta-chip pot">Pot 🪙 ${r.pot}</span>` : '';
        const specChip =
          r.spectatorCount > 0 ? `<span class="table-meta-chip">👁️ ${r.spectatorCount}</span>` : '';
        return `
          <div class="live-table-row ${isLive ? 'is-live' : 'is-open'}">
            <div class="table-host-avatar" aria-hidden="true">${escapeHtml(r.hostAvatar || '🕶️')}</div>
            <div class="live-table-info">
              <div class="table-row-top">
                <strong class="table-title">${escapeHtml(r.hostName)}'s Table</strong>
                <span class="room-code-chip locked" title="Room Code required from host">🔒 Code Only</span>
                ${statusBadge}
                ${voiceBadge}
              </div>
              <div class="table-row-meta">
                <span class="table-seats-meta" title="${r.playersCount} of ${r.maxPlayers} seats filled">${renderSeatDots(r.playersCount, r.maxPlayers)}<span>${r.playersCount}/${r.maxPlayers}</span></span>
                <span class="table-meta-chip gold">🪙 ${r.startingCoins}</span>
                <span class="table-meta-chip">Fee ${r.boardFee}</span>
                ${potChip}
                ${specChip}
              </div>
            </div>
            ${actionBtn}
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('[data-require-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.requireCode;
        const msg =
          mode === 'watch'
            ? '🔒 Enter the Room Code above & click Watch to spectate!'
            : '🔒 Enter the Room Code above & click Join to sit at this table!';
        focusRoomCodeInput(msg);
      });
    });
  }

  async function fetchLiveRooms() {
    const listEl = $('live-tables-list');
    const onlineTextEl = $('lobby-online-text');
    if (!listEl) return;
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      lastLiveRoomsData = Array.isArray(data.rooms) ? data.rooms : [];
      if (onlineTextEl) {
        const count = lastLiveRoomsData.length;
        onlineTextEl.textContent = `${data.onlinePlayers || 1} Online • ${count} ${count === 1 ? 'Table' : 'Tables'}`;
      }
      renderLiveTablesList();
    } catch (_) {
      // ignore transient network errors
    }
  }

  $('table-filter-tabs')?.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      liveTableFilter = tab.dataset.filter || 'all';
      $('table-filter-tabs')
        ?.querySelectorAll('.filter-tab')
        .forEach((t) => t.classList.toggle('active', t === tab));
      renderLiveTablesList();
    });
  });

  $('btn-refresh-rooms')?.addEventListener('click', () => {
    const btn = $('btn-refresh-rooms');
    if (btn) {
      btn.classList.remove('spinning');
      void btn.offsetWidth;
      btn.classList.add('spinning');
    }
    fetchLiveRooms();
  });
  fetchLiveRooms();
  setInterval(() => {
    if (!lobbyScreen.classList.contains('hidden')) {
      fetchLiveRooms();
    }
  }, 6000);

  // Global Persistent Leaderboard API
  const leaderboardModal = $('leaderboard-modal');
  const leaderboardTableBody = $('leaderboard-table-body');

  $('btn-global-leaderboard')?.addEventListener('click', async () => {
    leaderboardModal.classList.remove('hidden');
    leaderboardTableBody.innerHTML = '<tr><td colspan="6">Loading global rankings...</td></tr>';
    try {
      const res = await fetch('/api/leaderboard');
      const data = await res.json();
      if (!data.leaderboard || data.leaderboard.length === 0) {
        leaderboardTableBody.innerHTML =
          '<tr><td colspan="6" style="color:var(--text-muted);">No hands recorded yet. Play a round to rank on the leaderboard!</td></tr>';
        return;
      }
      leaderboardTableBody.innerHTML = data.leaderboard
        .map(
          (p, i) => `
          <tr>
            <td><strong>#${i + 1}</strong></td>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td style="color:var(--gold); font-weight:800;">🪙 ${p.totalWon}</td>
            <td>${p.handsWon} / ${p.handsPlayed}</td>
            <td style="color:#34d399; font-weight:700;">${p.winRate}%</td>
            <td>🪙 ${p.biggestPot}</td>
          </tr>
        `
        )
        .join('');
    } catch (_) {
      leaderboardTableBody.innerHTML = '<tr><td colspan="6">Could not load leaderboard.</td></tr>';
    }
  });
  $('btn-close-leaderboard')?.addEventListener('click', () => leaderboardModal.classList.add('hidden'));
  leaderboardModal?.addEventListener('click', (e) => {
    if (e.target === leaderboardModal) leaderboardModal.classList.add('hidden');
  });

  // ================= TABLE INTERACTIONS =================
  function copyInviteLink() {
    if (!currentState) return;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(currentState.roomId)}`;
    navigator.clipboard?.writeText(inviteUrl).catch(() => {});
    showToast(`🔗 Invite Link copied! Share with friends to join Room ${currentState.roomId}.`);
  }

  $('room-badge').addEventListener('click', copyInviteLink);
  $('btn-copy-invite')?.addEventListener('click', copyInviteLink);

  $('btn-add-bot').addEventListener('click', () => send({ type: 'add_bot' }));
  $('btn-remove-bot').addEventListener('click', () => send({ type: 'remove_bot' }));
  $('btn-start-game').addEventListener('click', () => send({ type: 'start_game' }));

  document.querySelectorAll('#wait-players-presets .wait-player-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const count = Number(btn.dataset.players);
      if (count >= 2 && count <= 22) {
        send({ type: 'update_max_players', maxPlayers: count });
      }
    });
  });

  function submitWaitCustomPlayers() {
    const input = $('wait-custom-players');
    const count = Math.floor(Number(input?.value));
    if (!Number.isFinite(count) || count < 2 || count > 22) {
      showToast('⚠️ Enter players between 2 and 22.');
      return;
    }
    send({ type: 'update_max_players', maxPlayers: count });
  }

  $('btn-wait-set-players')?.addEventListener('click', submitWaitCustomPlayers);
  $('wait-custom-players')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitWaitCustomPlayers();
    }
  });

  document.querySelectorAll('#wait-coins-presets .wait-coin-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amount = Number(btn.dataset.coins);
      if (amount >= 10) {
        send({ type: 'update_starting_coins', startingCoins: amount });
      }
    });
  });

  function submitWaitCustomCoins() {
    const input = $('wait-custom-coins');
    const amount = Math.floor(Number(input?.value));
    if (!Number.isFinite(amount) || amount < 10 || amount > 100000) {
      showToast('⚠️ Enter coins between 10 and 100,000.');
      return;
    }
    send({ type: 'update_starting_coins', startingCoins: amount });
  }

  $('btn-wait-set-coins')?.addEventListener('click', submitWaitCustomCoins);
  $('wait-custom-coins')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitWaitCustomCoins();
    }
  });
  $('btn-next-hand').addEventListener('click', () => send({ type: 'next_hand' }));
  $('btn-show-cards').addEventListener('click', () => send({ type: 'player_action', action: 'show' }));
  $('btn-rebuy').addEventListener('click', () => send({ type: 'rebuy' }));
  $('btn-gameover-rebuy').addEventListener('click', () => send({ type: 'rebuy' }));
  $('btn-restart-game').addEventListener('click', () => send({ type: 'restart_game' }));
  $('btn-leave').addEventListener('click', () => send({ type: 'leave_room' }));
  $('btn-gameover-leave').addEventListener('click', () => send({ type: 'leave_room' }));

  // Quick Emotes
  document.querySelectorAll('.emote-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.emote;
      if (!text) return;
      if (myId) triggerEmoteBubble(myId, text, true);
      send({ type: 'emote', text });
    });
  });

  // Modals: Rules, Stats
  $('btn-rules').addEventListener('click', () => rulesModal.classList.remove('hidden'));
  $('btn-close-rules').addEventListener('click', () => rulesModal.classList.add('hidden'));
  rulesModal.addEventListener('click', (e) => {
    if (e.target === rulesModal) rulesModal.classList.add('hidden');
  });

  $('btn-stats').addEventListener('click', () => {
    statsModal.classList.remove('hidden');
    if (currentState) renderStatsModal(currentState);
  });
  $('btn-close-stats').addEventListener('click', () => statsModal.classList.add('hidden'));
  statsModal.addEventListener('click', (e) => {
    if (e.target === statsModal) statsModal.classList.add('hidden');
  });

  shuffleHashBadge?.addEventListener('click', () => {
    if (currentState) renderFairModal(currentState);
    fairModal?.classList.remove('hidden');
  });
  $('btn-close-fair')?.addEventListener('click', () => fairModal?.classList.add('hidden'));
  fairModal?.addEventListener('click', (e) => {
    if (e.target === fairModal) fairModal.classList.add('hidden');
  });

  // Side drawer
  $('btn-toggle-drawer').addEventListener('click', () => {
    sideDrawer.classList.toggle('closed');
    if (!sideDrawer.classList.contains('closed')) {
      unreadChatCount = 0;
      const toggleBtn = $('btn-toggle-drawer');
      if (toggleBtn) {
        toggleBtn.textContent = '💬';
        toggleBtn.classList.remove('has-unread');
      }
    }
  });
  $('btn-close-drawer').addEventListener('click', () => sideDrawer.classList.add('closed'));

  document.querySelectorAll('.d-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.d-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      $('tab-log').classList.toggle('hidden', target !== 'log');
      $('tab-history').classList.toggle('hidden', target !== 'history');
      $('tab-chat').classList.toggle('hidden', target !== 'chat');
    });
  });

  document.querySelectorAll('#quick-chat-bar .qc-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.msg;
      if (text) send({ type: 'chat', text });
    });
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    chatInput.value = '';
  });

  function lockButtonsDuringAction() {
    pendingAction = true;
    btnFold.disabled = true;
    btnCheckCall.disabled = true;
    btnRaise.disabled = true;
  }

  // Betting Controls
  btnFold.addEventListener('click', () => {
    if (pendingAction) return;
    lockButtonsDuringAction();
    send({ type: 'player_action', action: 'fold' });
  });

  btnCheckCall.addEventListener('click', () => {
    if (pendingAction || !currentState || !currentState.validActions) return;
    if (currentState.validActions.canCheck) {
      lockButtonsDuringAction();
      send({ type: 'player_action', action: 'check' });
    } else if (currentState.validActions.canCall) {
      lockButtonsDuringAction();
      send({ type: 'player_action', action: 'call' });
    }
  });

  const btnRaiseMinus = $('btn-raise-minus');
  const btnRaisePlus = $('btn-raise-plus');

  function syncRaiseLabel(val) {
    if (!currentState || !currentState.validActions) return;
    const v = currentState.validActions;
    const clamped = Math.min(v.maxRaiseTo, Math.max(v.minRaiseTo, Math.floor(val)));
    raiseSlider.value = clamped;
    raiseNumber.value = clamped;

    const me = currentState.players.find((p) => p.id === myId);
    const fullStack = me ? me.roundBet + me.coins : v.maxRaiseTo;
    const isAllIn = clamped >= fullStack;
    const isBet = currentState.currentBet === 0;
    const raiseBy = Math.max(1, clamped - currentState.currentBet);

    if (isAllIn) {
      raiseBtnTitle.textContent = 'ALL-IN';
      raiseBtnSub.textContent = `Total ${clamped} 🪙 [R]`;
    } else if (isBet) {
      raiseBtnTitle.textContent = `BET ${clamped} 🪙`;
      raiseBtnSub.textContent = `Start Bet [R]`;
    } else {
      raiseBtnTitle.textContent = `RAISE +${raiseBy}`;
      raiseBtnSub.textContent = `Total ${clamped} 🪙 [R]`;
    }
  }

  btnRaiseMinus.addEventListener('click', () => {
    if (!currentState || !currentState.validActions.canRaise) return;
    syncRaiseLabel(Number(raiseNumber.value) - 1);
  });

  btnRaisePlus.addEventListener('click', () => {
    if (!currentState || !currentState.validActions.canRaise) return;
    syncRaiseLabel(Number(raiseNumber.value) + 1);
  });

  raiseSlider.addEventListener('input', () => syncRaiseLabel(Number(raiseSlider.value)));
  raiseNumber.addEventListener('input', () => {
    const val = Number(raiseNumber.value);
    if (!isNaN(val)) syncRaiseLabel(val);
  });

  quickBetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!currentState || !currentState.validActions.canRaise) return;
      const v = currentState.validActions;
      const type = btn.dataset.q;
      let target = v.minRaiseTo;
      if (type === '+1') target = currentState.currentBet + 1;
      else if (type === '+2') target = currentState.currentBet + 2;
      else if (type === '+3') target = currentState.currentBet + 3;
      else if (type === 'max') target = v.maxRaiseTo;
      syncRaiseLabel(target);
    });
  });

  btnRaise.addEventListener('click', () => {
    if (pendingAction || !currentState || !currentState.validActions.canRaise) return;
    const amount = Number(raiseNumber.value);
    const me = currentState.players.find((p) => p.id === myId);
    const fullStack = me ? me.roundBet + me.coins : currentState.validActions.maxRaiseTo;
    const isAllIn = amount >= fullStack;
    lockButtonsDuringAction();
    send({
      type: 'player_action',
      action: isAllIn ? 'allin' : 'raise',
      amount
    });
  });

  // Keyboard Shortcuts (disabled when typing in inputs)
  document.addEventListener('keydown', (e) => {
    if (!currentState || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === 'f' && !btnFold.disabled) btnFold.click();
    else if (key === 'c' && !btnCheckCall.disabled) btnCheckCall.click();
    else if (key === 'r' && !btnRaise.disabled) btnRaise.click();
    else if ((key === 'enter' || e.code === 'Space') && currentState.phase === 'SHOWDOWN') {
      e.preventDefault();
      btnNextHand.click();
    }
  });

  // ================= RENDERING =================
  function createCardHTML(card, isSmall = false, winningCodes = [], cardKey = '') {
    const isRed = card.suit === 'H' || card.suit === 'D';
    const isWin = winningCodes.includes(card.code);
    let isNew = false;
    if (cardKey && !seenCardKeys.has(cardKey)) {
      seenCardKeys.add(cardKey);
      isNew = true;
    }
    return `
      <div class="playing-card ${isSmall ? 'small' : ''} ${isRed ? 'red' : ''} ${isWin ? 'winning-card' : ''} ${isNew ? 'newly-dealt' : ''}">
        <div class="card-corner">
          <span class="card-rank">${card.label}</span>
          <span class="card-suit-sm">${card.symbol}</span>
        </div>
        <div class="card-center-suit">${card.symbol}</div>
      </div>
    `;
  }

  function chipColorForAmount(amount) {
    if (amount >= 100) return 'gold';
    if (amount >= 25) return 'green';
    if (amount >= 5) return 'red';
    return 'blue';
  }

  function getSeatPositions(count) {
    const layouts = {
      2: [
        { x: 50, y: 97 },
        { x: 50, y: 3 }
      ],
      3: [
        { x: 50, y: 97 },
        { x: 14, y: 24 },
        { x: 86, y: 24 }
      ],
      4: [
        { x: 50, y: 97 },
        { x: 4, y: 50 },
        { x: 50, y: 3 },
        { x: 96, y: 50 }
      ],
      5: [
        { x: 50, y: 97 },
        { x: 6, y: 62 },
        { x: 24, y: 6 },
        { x: 76, y: 6 },
        { x: 94, y: 62 }
      ],
      6: [
        { x: 50, y: 97 },
        { x: 7, y: 68 },
        { x: 7, y: 28 },
        { x: 50, y: 3 },
        { x: 93, y: 28 },
        { x: 93, y: 68 }
      ],
      7: [
        { x: 50, y: 97 },
        { x: 9, y: 74 },
        { x: 4, y: 36 },
        { x: 28, y: 5 },
        { x: 72, y: 5 },
        { x: 96, y: 36 },
        { x: 91, y: 74 }
      ],
      8: [
        { x: 50, y: 97 },
        { x: 14, y: 84 },
        { x: 3, y: 48 },
        { x: 16, y: 12 },
        { x: 50, y: 3 },
        { x: 84, y: 12 },
        { x: 97, y: 48 },
        { x: 86, y: 84 }
      ]
    };
    if (layouts[count]) return layouts[count];
    const dynamic = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.PI / 2 + (i * 2 * Math.PI) / count;
      const x = Math.round((50 + 47 * Math.cos(angle)) * 10) / 10;
      const y = Math.round((50 + 47 * Math.sin(angle)) * 10) / 10;
      dynamic.push({ x, y });
    }
    return dynamic;
  }

  function renderGameState(state) {
    if (state.handNumber !== lastHandNumber) {
      lastHandNumber = state.handNumber;
      lastPot = 0;
      seenCardKeys.clear();
    }

    const isMyTurnNow = Boolean(state.validActions?.isTurn);
    if (isMyTurnNow && !wasMyTurn) {
      window.pokerSound?.playYourTurn();
    }
    wasMyTurn = isMyTurnNow;

    if (state.phase === 'SHOWDOWN' && lastPhase !== 'SHOWDOWN') {
      window.pokerSound?.playWin();
      if (state.lastWinners && state.lastWinners.some((w) => w.playerId === myId)) {
        triggerWinConfetti();
      }
      fetchMyProfile();
    }
    lastPhase = state.phase;

    displayRoomCode.textContent = state.roomId;
    displayRound.textContent = state.handNumber;
    displayPhase.textContent = state.allInRunoutPending ? 'ALL-IN RUNOUT' : state.phase;

    const specPill = $('spectator-pill');
    const specCountEl = $('display-spectators');
    if (specPill && specCountEl) {
      const sc = state.spectatorCount || 0;
      specCountEl.textContent = sc;
      specPill.classList.toggle('hidden', sc <= 0);
    }

    if (state.shuffleMeta && shuffleHashBadge) {
      shuffleHashBadge.textContent = `🔒 Fair #${state.shuffleMeta.shuffleId}`;
    }

    if (state.pot > lastPot && state.pot > 0) {
      const potBox = displayPot.closest('.pot-display');
      if (potBox) {
        potBox.classList.remove('pot-bump');
        void potBox.offsetWidth;
        potBox.classList.add('pot-bump');
      }
    }
    lastPot = state.pot;
    displayPot.textContent = state.pot;

    const pokerTableEl = document.querySelector('.poker-table');
    if (pokerTableEl) {
      const highStakes =
        Boolean(state.allInRunoutPending) ||
        state.pot >= Math.max(12, Math.floor((state.startingCoins || 100) * 0.25));
      pokerTableEl.classList.toggle('high-stakes-glow', highStakes);
    }

    if (state.phase === 'SHOWDOWN' || state.phase === 'LOBBY' || state.phase === 'GAME_OVER' || state.currentBet === 0) {
      displayCurrentBet.classList.add('hidden');
    } else {
      displayCurrentBet.classList.remove('hidden');
      displayCurrentBet.textContent = `Current Bet: ${state.currentBet} 🪙`;
    }

    // Side Pots display
    if (state.sidePots && state.sidePots.length > 1) {
      sidePotsBar.classList.remove('hidden');
      sidePotsBar.innerHTML = state.sidePots
        .map((sp) => `<span class="side-pot-pill">${escapeHtml(sp.label)}: ${sp.amount} 🪙</span>`)
        .join('');
    } else {
      sidePotsBar.classList.add('hidden');
    }

    const winningCodes = [];
    const winnerIds = new Set();
    const winnerPayouts = new Map();
    for (const w of state.lastWinners || []) {
      winnerIds.add(w.playerId);
      winnerPayouts.set(w.playerId, (winnerPayouts.get(w.playerId) || 0) + (w.amount || 0));
      if (w.bestFive) winningCodes.push(...w.bestFive);
    }

    // Community Cards (memoized so board never repaints unnecessarily on every bet!)
    const commSig = `${state.handNumber}|${(state.communityCards || []).map((c) => c.code).join(',')}|${winningCodes.join(',')}`;
    if (commSig !== communityCardsEl.dataset.sig) {
      communityCardsEl.dataset.sig = commSig;
      let commHtml = '';
      for (let i = 0; i < 5; i++) {
        if (state.communityCards[i]) {
          const c = state.communityCards[i];
          commHtml += createCardHTML(c, false, winningCodes, `h${state.handNumber}-comm-${i}-${c.code}`);
        } else {
          commHtml += '<div class="card-slot empty"></div>';
        }
      }
      communityCardsEl.innerHTML = commHtml;
    }

    // Rotate players so my seat is bottom-center
    const myIndex = state.players.findIndex((p) => p.id === myId);
    const orderedPlayers =
      myIndex >= 0
        ? [...state.players.slice(myIndex), ...state.players.slice(0, myIndex)]
        : [...state.players];

    const positions = getSeatPositions(Math.max(2, orderedPlayers.length));

    seatsLayer.innerHTML = orderedPlayers
      .map((p, idx) => {
        const pos = positions[idx] || { x: 50, y: 50 };
        const isMe = p.id === myId;
        const isWinner = winnerIds.has(p.id);
        const wonAmt = winnerPayouts.get(p.id) || 0;
        const emoteObj = activeEmotes.get(p.id);
        const emoteHtml =
          emoteObj && Date.now() < emoteObj.expiresAt
            ? `<div class="seat-emote-bubble">${escapeHtml(emoteObj.text)}</div>`
            : '';

        const payoutHtml =
          isWinner && wonAmt > 0 && state.phase === 'SHOWDOWN'
            ? `<div class="seat-win-payout">+${wonAmt} 🪙</div>`
            : '';

        const streakHtml =
          p.winStreak >= 2 && !p.eliminated
            ? `<span class="seat-streak-badge" title="${p.winStreak} Wins in a Row!">🔥${p.winStreak}x</span>`
            : '';

        let cardsHtml = '';
        if (p.cardCount > 0 && !p.eliminated) {
          if (p.holeCards && p.holeCards.length > 0) {
            cardsHtml = p.holeCards
              .map((c, ci) => createCardHTML(c, !isMe, winningCodes, `h${state.handNumber}-${p.id}-${ci}-${c.code}`))
              .join('');
          } else {
            cardsHtml = '<div class="card-back"></div><div class="card-back"></div>';
          }
        }

        let actionClass = '';
        const lowerAct = (p.lastAction || '').toLowerCase();
        if (lowerAct.includes('fold')) actionClass = 'act-fold';
        else if (lowerAct.includes('raise') || lowerAct.includes('bet') || lowerAct.includes('all-in')) actionClass = 'act-raise';
        else if (lowerAct.includes('call')) actionClass = 'act-call';
        else if (lowerAct.includes('check')) actionClass = 'act-check';

        const betChipHtml =
          p.roundBet > 0
            ? `<div class="seat-bet-chip"><span class="chip-dot ${chipColorForAmount(p.roundBet)}"></span> ${p.roundBet}</div>`
            : '';

        const blindBadge = p.isSmallBlind
          ? '<div class="blind-chip sb">SB</div>'
          : p.isBigBlind
          ? '<div class="blind-chip bb">BB</div>'
          : '';

        const thinkingHtml =
          p.isCurrentTurn && !isMe
            ? '<div class="thinking-dots">Thinking <span></span><span></span><span></span></div>'
            : '';

        const timerBarHtml =
          p.isCurrentTurn && state.turnExpiresAt
            ? '<div class="turn-timer-track"><div class="turn-timer-fill" style="width: 100%"></div></div>'
            : '';

        const voiceInfo = voicePeersMap.get(p.id);
        const isSpeaking = speakingPeers.has(p.id) && voiceInfo && !voiceInfo.muted;
        const voiceBadgeHtml = voiceInfo
          ? `<span class="seat-voice-badge ${voiceInfo.muted ? 'muted' : 'live'}" title="${voiceInfo.muted ? 'Voice Chat (Muted)' : 'Voice Chat Live'}">${voiceInfo.muted ? '🔇' : '🎙️'}</span>`
          : '';

        const loanBal = p.loanBalance || 0;
        const loanPillHtml =
          loanBal !== 0
            ? `<div class="seat-loan-pill ${loanBal > 0 ? 'pos' : 'neg'}" title="${loanBal > 0 ? 'Lent to others (+)' : 'Borrowed from others (-)'}">🤝 ${loanBal > 0 ? `+${loanBal}` : loanBal}</div>`
            : '';

        return `
          <div class="seat-node ${isMe ? 'is-me' : ''} ${p.isCurrentTurn ? 'active-turn' : ''} ${p.folded ? 'folded' : ''} ${p.eliminated ? 'eliminated' : ''} ${isWinner ? 'winner' : ''} ${isSpeaking ? 'voice-speaking' : ''}"
               data-player-id="${escapeHtml(p.id)}"
               style="left: ${pos.x}%; top: ${pos.y}%;">
            ${emoteHtml}
            ${payoutHtml}
            ${idx === 0 ? betChipHtml : ''}
            <div class="seat-cards">${cardsHtml}</div>
            <div class="seat-box">
              ${p.isDealer ? '<div class="dealer-chip" title="Dealer">D</div>' : ''}
              ${blindBadge}
              <div class="seat-name-row">
                <span>${escapeHtml(p.avatar)}</span>
                <span>${escapeHtml(p.name)}${isMe ? ' (You)' : ''}</span>
                ${streakHtml}
                ${voiceBadgeHtml}
              </div>
              <div class="seat-coins">🪙 ${p.coins}</div>
              ${loanPillHtml}
              ${thinkingHtml || (p.lastAction ? `<div class="seat-action-tag ${actionClass}">${escapeHtml(p.lastAction)}</div>` : '')}
              ${p.showdownHand && state.phase === 'SHOWDOWN' ? `<div class="showdown-hand-pill">${escapeHtml(p.showdownHand.name)}</div>` : ''}
              ${timerBarHtml}
            </div>
            ${idx !== 0 ? betChipHtml : ''}
          </div>
        `;
      })
      .join('');

    const isHost = myId === hostId;

    // 1) Lobby Waiting Overlay
    if (state.phase === 'LOBBY') {
      waitingOverlay.classList.remove('hidden');
      overlayRoomCode.textContent = state.roomId;
      overlayPlayerCount.textContent =
        state.maxPlayers >= 22 ? `${state.players.length} Joined` : `${state.players.length}/${state.maxPlayers}`;
      overlayStartingCoins.textContent = state.startingCoins;
      hostLobbyControls.classList.toggle('hidden', !isHost);
      $('host-coins-editor')?.classList.toggle('hidden', !isHost);
      nonHostWaitMsg.classList.toggle('hidden', isHost);
      $('btn-start-game').disabled = state.players.length < 2;
      $('btn-add-bot').disabled = state.players.length >= state.maxPlayers;
      $('btn-remove-bot').disabled = !state.players.some((p) => p.isBot);

      if (isHost) {
        const waitCustomInput = $('wait-custom-coins');
        if (waitCustomInput && document.activeElement !== waitCustomInput) {
          waitCustomInput.value = state.startingCoins;
        }
        document.querySelectorAll('#wait-coins-presets .wait-coin-btn').forEach((btn) => {
          btn.classList.toggle('active', Number(btn.dataset.coins) === Number(state.startingCoins));
        });
      }
    } else {
      waitingOverlay.classList.add('hidden');
    }

    // 2) Showdown Banner
    if (state.phase === 'SHOWDOWN' && state.lastWinners && state.lastWinners.length > 0) {
      showdownBanner.classList.remove('hidden');
      const primary = state.lastWinners[0];
      const prefix = primary.isSplitPot ? '🤝 SPLIT POT: ' : '🏆 ';
      const wText = state.lastWinners.map((w) => `${w.name} (+${w.amount} 🪙)`).join(' & ');
      winnerTitle.textContent = `${prefix}${wText}`;

      let detailHtml = `<div><strong>${escapeHtml(primary.detail || primary.handName)}</strong></div>`;
      if (primary.bestFiveLabels && primary.bestFiveLabels.length > 0) {
        detailHtml += `<div style="font-size:0.76rem; color:#fde68a; margin-top:2px;">Best 5: ${escapeHtml(primary.bestFiveLabels.join('  '))}</div>`;
      }
      if (primary.ranking && primary.ranking.length > 1) {
        detailHtml += '<div style="margin-top:6px; text-align:left; font-size:0.74rem; border-top:1px solid rgba(255,255,255,0.12); padding-top:5px;">';
        primary.ranking.forEach((r, idx) => {
          const badge = r.wonAmount > 0 ? `🏆` : `#${idx + 1}`;
          detailHtml += `<div style="margin-bottom:2px;">${badge} <strong>${escapeHtml(r.name)}</strong>: ${escapeHtml(r.detail)}</div>`;
        });
        detailHtml += '</div>';
      }
      winnerDetail.innerHTML = detailHtml;

      btnShowCards.classList.toggle('hidden', !state.validActions.canShowCards);
      btnRebuy.classList.toggle('hidden', !state.validActions.canRebuy);
    } else {
      showdownBanner.classList.add('hidden');
    }

    // 3) Game Over & Final Settlement Overlay
    if (state.phase === 'GAME_OVER') {
      gameoverOverlay.classList.remove('hidden');
      const settlement = state.finalSettlement;
      championName.textContent = state.champion
        ? `🏆 ${state.champion.name} — Table Champion!`
        : '🏁 Final Match Settlement';
      championCoins.textContent = settlement
        ? `${settlement.reason} • ${settlement.totalHands} Round(s) • ${settlement.totalLoansCount} Loan(s) Settled`
        : state.champion
        ? `Table Champion with 🪙 ${state.champion.coins} coins!`
        : '';

      const settleWrap = $('final-settlement-wrap');
      if (settleWrap && settlement && Array.isArray(settlement.players)) {
        const rowsHtml = settlement.players
          .map((p, idx) => {
            const loanStr =
              p.loanBalance > 0
                ? `<span class="pos">+${p.loanBalance}</span>`
                : p.loanBalance < 0
                ? `<span class="neg">${p.loanBalance}</span>`
                : '0';
            const netStr =
              p.finalNetProfit > 0
                ? `<span class="pos">+${p.finalNetProfit}</span>`
                : p.finalNetProfit < 0
                ? `<span class="neg">${p.finalNetProfit}</span>`
                : '0';
            return `
              <tr>
                <td>#${idx + 1}</td>
                <td><strong>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</strong></td>
                <td>${p.totalBuyIn}</td>
                <td>${p.tableCoins}</td>
                <td>${loanStr}</td>
                <td style="color:var(--gold); font-weight:800;">🪙 ${p.finalAdjustedCoins}</td>
                <td style="font-weight:800;">${netStr}</td>
              </tr>
            `;
          })
          .join('');

        const debtsHtml =
          settlement.debts && settlement.debts.length > 0
            ? `<div class="settlement-debts">
                <div class="settlement-debts-title">🤝 Loan Repayment Summary</div>
                ${settlement.debts
                  .map(
                    (d) =>
                      `<div class="debt-row"><span>${escapeHtml(d.debtorName)}</span> <span class="debt-arrow">owes →</span> <span>${escapeHtml(d.creditorName)}</span> <strong class="debt-amt">${d.amount} 🪙</strong></div>`
                  )
                  .join('')}
              </div>`
            : '<div class="settlement-no-debts">✅ No outstanding loans between players.</div>';

        settleWrap.innerHTML = `
          <div class="stats-table-wrap settlement-table-wrap">
            <table class="stats-table settlement-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Buy-In</th>
                  <th>Table</th>
                  <th>Loan (+/-)</th>
                  <th>Final</th>
                  <th>Net P/L</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          ${debtsHtml}
        `;
      } else if (settleWrap) {
        settleWrap.innerHTML = '';
      }

      btnRestartGame.classList.toggle('hidden', !isHost);
      btnGameoverRebuy.classList.toggle('hidden', !state.validActions.canRebuy);
    } else {
      gameoverOverlay.classList.add('hidden');
    }

    // Bottom Dock: My Info & Hand Strength Meter
    const me = state.players.find((p) => p.id === myId);
    myCoinsDisplay.textContent = `🪙 ${me ? me.coins : 0}`;
    if (me) {
      const net = me.netProfit || 0;
      myNetDisplay.textContent = `Net: ${net >= 0 ? '+' : ''}${net}`;
      myNetDisplay.className = `net-tag ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}`;
    }

    const equityReadout = $('equity-readout');
    const handRankPill = $('hand-rank-pill');
    const handMiniCards = $('hand-mini-cards');
    const handDrawsRow = $('hand-draws-row');

    if (state.viewerHandHint) {
      strengthValue.textContent = state.viewerHandHint.detail;

      if (state.viewerHandHint.rankPosition) {
        handRankPill.textContent = `Rank #${state.viewerHandHint.rankPosition}/10`;
        handRankPill.classList.remove('hidden');
      } else {
        handRankPill.classList.add('hidden');
      }

      if (state.viewerHandHint.bestFive && state.viewerHandHint.bestFive.length > 0) {
        handMiniCards.innerHTML = state.viewerHandHint.bestFive
          .map((c) => {
            const isRed = c.suit === 'H' || c.suit === 'D';
            const cls = c.isKey ? 'is-key' : 'is-kicker';
            return `<span class="mini-card ${isRed ? 'red' : ''} ${cls}" title="${c.isKey ? 'Active Hand Card' : 'Kicker Card'}">${escapeHtml(c.label)}${escapeHtml(c.symbol)}</span>`;
          })
          .join('');
      } else {
        handMiniCards.innerHTML = '';
      }

      if (state.viewerAnalytics) {
        const eq = state.viewerAnalytics.equityPct;
        const tie = state.viewerAnalytics.tiePct || 0;
        const po = state.viewerAnalytics.potOddsPct;
        equityReadout.textContent =
          po > 0
            ? `Win: ${eq}%${tie > 0 ? ` • Tie: ${tie}%` : ''} • Pot Odds: ${po}% (${eq >= po ? '+EV' : 'Tight'})`
            : `Win Equity: ${eq}%${tie > 0 ? ` • Tie: ${tie}%` : ''}`;
        strengthBarFill.style.width = `${Math.max(8, eq)}%`;

        const draws = state.viewerAnalytics.draws || [];
        if (draws.length > 0) {
          handDrawsRow.classList.remove('hidden');
          handDrawsRow.innerHTML = draws
            .map((d) => `<span class="draw-pill">🎯 ${escapeHtml(d.name)} (${d.outs} outs)</span>`)
            .join('');
        } else {
          handDrawsRow.classList.add('hidden');
          handDrawsRow.innerHTML = '';
        }
      } else {
        equityReadout.textContent = state.phase === 'SHOWDOWN' ? 'Showdown Complete' : '—';
        handDrawsRow.classList.add('hidden');
        const pct = Math.min(100, Math.max(12, ((state.viewerHandHint.category || 0) + 1) * 10));
        strengthBarFill.style.width = `${pct}%`;
      }
    } else {
      strengthValue.textContent = '—';
      handRankPill.classList.add('hidden');
      handMiniCards.innerHTML = '';
      handDrawsRow.classList.add('hidden');
      equityReadout.textContent = 'Win: —';
      strengthBarFill.style.width = '0%';
    }

    renderBettingControls(state);
    processPreActionQueue(state);
    renderLoanAndVoteUI(state);
    renderActionLog(state.actionLog || []);
    renderHandHistory(state.handHistory || []);
  }

  function renderBettingControls(state) {
    const v = state.validActions;
    const activePlayer = state.players.find((p) => p.isCurrentTurn);

    if (state.phase === 'LOBBY') {
      turnStatusText.textContent = 'Table Lobby — Waiting to start...';
      turnStatusText.classList.remove('your-turn');
    } else if (state.allInRunoutPending) {
      turnStatusText.textContent = '🔥 ALL-IN! Dealing remaining community cards...';
      turnStatusText.classList.add('your-turn');
    } else if (state.phase === 'SHOWDOWN') {
      turnStatusText.textContent = 'Round complete! Press Enter or click "Next Round".';
      turnStatusText.classList.remove('your-turn');
    } else if (state.phase === 'GAME_OVER') {
      turnStatusText.textContent = 'Match finished!';
      turnStatusText.classList.remove('your-turn');
    } else if (v.isTurn) {
      turnStatusText.textContent = '✨ YOUR TURN — Check, Call, Raise, or Fold';
      turnStatusText.classList.add('your-turn');
    } else if (activePlayer) {
      turnStatusText.textContent = `Waiting for ${activePlayer.name}...`;
      turnStatusText.classList.remove('your-turn');
    } else {
      turnStatusText.textContent = '';
      turnStatusText.classList.remove('your-turn');
    }

    btnFold.disabled = !v.isTurn || !v.canFold;

    const mePlayer = state.players.find((p) => p.id === myId);
    if (v.isTurn && v.canCheck) {
      btnCheckCall.disabled = false;
      btnCheckCall.classList.remove('act-call');
      btnCheckCall.classList.add('act-check');
      checkCallTitle.textContent = 'CHECK';
      checkCallSub.textContent = 'Pass Free [C]';
    } else if (v.isTurn && v.canCall) {
      btnCheckCall.disabled = false;
      btnCheckCall.classList.remove('act-check');
      btnCheckCall.classList.add('act-call');
      const isShortAllIn = mePlayer && v.callAmount >= mePlayer.coins;
      checkCallTitle.textContent = isShortAllIn ? `CALL ${v.callAmount} (ALL-IN)` : `CALL ${v.callAmount} 🪙`;
      checkCallSub.textContent =
        mePlayer && mePlayer.roundBet > 0
          ? `Match ${state.currentBet} 🪙 [C]`
          : `Match Bet [C]`;
    } else {
      btnCheckCall.disabled = true;
      checkCallTitle.textContent = 'CHECK / CALL';
      checkCallSub.textContent = '—';
    }

    const canRaiseNow = Boolean(v.isTurn && v.canRaise);
    btnRaise.disabled = !canRaiseNow;
    btnRaiseMinus.disabled = !canRaiseNow;
    btnRaisePlus.disabled = !canRaiseNow;
    raiseSlider.disabled = !canRaiseNow;
    raiseNumber.disabled = !canRaiseNow;
    quickBetButtons.forEach((b) => {
      b.disabled = !canRaiseNow;
    });

    const btnQuickMax = $('btn-quick-max');
    const raiseTurnKey = `${state.handNumber}:${state.phase}:${state.currentBet}:${canRaiseNow}`;
    if (canRaiseNow) {
      raiseSlider.min = v.minRaiseTo;
      raiseSlider.max = v.maxRaiseTo;
      raiseNumber.min = v.minRaiseTo;
      raiseNumber.max = v.maxRaiseTo;
      if (btnQuickMax) {
        const inc = Math.max(1, v.maxRaiseTo - state.currentBet);
        btnQuickMax.textContent = `Max (+${inc})`;
      }
      if (raiseTurnKey !== lastRaiseTurnKey) {
        lastRaiseTurnKey = raiseTurnKey;
        syncRaiseLabel(v.minRaiseTo);
      } else {
        const preserved = Math.min(v.maxRaiseTo, Math.max(v.minRaiseTo, Number(raiseNumber.value) || v.minRaiseTo));
        syncRaiseLabel(preserved);
      }
    } else {
      lastRaiseTurnKey = '';
      raiseBtnTitle.textContent = 'RAISE';
      raiseBtnSub.textContent = '—';
      if (btnQuickMax) btnQuickMax.textContent = 'Max';
    }
  }

  function renderStatsModal(state) {
    if (!statsModal || statsModal.classList.contains('hidden')) return;
    const sorted = [...state.players].sort((a, b) => b.coins - a.coins);
    statsTableBody.innerHTML = sorted
      .map((p) => {
        const net = p.netProfit || 0;
        const netClass = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
        return `
          <tr>
            <td><strong>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</strong>${p.id === myId ? ' (You)' : ''}</td>
            <td style="color: var(--gold); font-weight: 800;">🪙 ${p.coins}</td>
            <td class="net-tag ${netClass}">${net >= 0 ? '+' : ''}${net}</td>
            <td>${p.stats?.handsPlayed || 0}</td>
            <td>${p.stats?.handsWon || 0}</td>
            <td>🪙 ${p.stats?.biggestPot || 0}</td>
          </tr>
        `;
      })
      .join('');
  }

  function renderFairModal(state) {
    if (!fairModalBody || !fairModal || fairModal.classList.contains('hidden')) return;
    if (!state.shuffleMeta) {
      fairModalBody.innerHTML = '<p>No hand dealt yet. Start a round to see the CSPRNG commitment hash.</p>';
      return;
    }

    if (state.shuffleProof) {
      fairModalBody.innerHTML = `
        <p>This hand is complete. Below is the full cryptographic proof verifying that the 52-card deck was shuffled with OS CSPRNG before dealing and <strong>never altered</strong>:</p>
        <div class="proof-box">
          <div class="proof-label">Shuffle ID</div>
          ${escapeHtml(state.shuffleProof.shuffleId)}
        </div>
        <div class="proof-box">
          <div class="proof-label">SHA-256 Commitment Hash (Published Before Deal)</div>
          ${escapeHtml(state.shuffleProof.commitmentHash)}
        </div>
        <div class="proof-box">
          <div class="proof-label">256-Bit Secret Salt (Revealed at Showdown)</div>
          ${escapeHtml(state.shuffleProof.salt)}
        </div>
        <div class="proof-box">
          <div class="proof-label">Exact 52-Card Deck Order (SHA-256 of deckOrder + "|" + salt == Hash)</div>
          ${escapeHtml(state.shuffleProof.deckOrder.join(', '))}
        </div>
        <button id="btn-verify-proof-api" class="btn btn-emerald">🔍 Verify Cryptographic SHA-256 Proof</button>
        <div id="verify-proof-result"></div>
      `;

      $('btn-verify-proof-api')?.addEventListener('click', async () => {
        const resEl = $('verify-proof-result');
        resEl.innerHTML = 'Verifying...';
        try {
          const resp = await fetch('/api/verify-shuffle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.shuffleProof)
          });
          const data = await resp.json();
          if (data.verified) {
            resEl.innerHTML = `<div class="verify-ok">✅ MATHEMATICALLY VERIFIED! All ${data.uniqueCardCount} cards are unique and SHA-256 matches 100%.</div>`;
          } else {
            resEl.innerHTML = `<div class="verify-fail">❌ Verification failed: ${escapeHtml(data.error || 'Hash mismatch')}</div>`;
          }
        } catch (_) {
          resEl.innerHTML = '<div class="verify-fail">❌ Network error verifying proof.</div>';
        }
      });
    } else {
      fairModalBody.innerHTML = `
        <p>Hand #${state.handNumber} is currently <strong>IN PROGRESS</strong>. To keep cards strictly secret, only the SHA-256 commitment prefix is shown now. The full salt &amp; deck order will unlock automatically at <strong>Showdown</strong>!</p>
        <div class="proof-box">
          <div class="proof-label">Shuffle ID</div>
          ${escapeHtml(state.shuffleMeta.shuffleId)}
        </div>
        <div class="proof-box">
          <div class="proof-label">SHA-256 Commitment Prefix</div>
          ${escapeHtml(state.shuffleMeta.commitmentHash)}...
        </div>
      `;
    }
  }

  let lastRenderedLogSig = '';
  function renderActionLog(logs) {
    for (const item of logs) {
      if (!seenLogIds.has(item.id)) {
        seenLogIds.add(item.id);
      }
    }

    const lastId = logs.length > 0 ? logs[logs.length - 1].id : '';
    const sig = `${logs.length}:${lastId}`;
    if (sig === lastRenderedLogSig) return;
    lastRenderedLogSig = sig;

    actionLogList.innerHTML = logs
      .map(
        (item) =>
          `<div class="log-item"><span class="log-time">[${escapeHtml(item.time)}]</span>${escapeHtml(item.message)}</div>`
      )
      .join('');
    actionLogList.scrollTop = actionLogList.scrollHeight;
  }

  let lastRenderedHistoryLen = -1;
  function renderHandHistory(history) {
    const el = $('hand-history-list');
    if (!el) return;
    const len = history ? history.length : 0;
    if (len === lastRenderedHistoryLen) return;
    lastRenderedHistoryLen = len;
    if (len === 0) {
      el.innerHTML = '<div class="log-item" style="color:var(--text-muted);">Completed rounds will appear here.</div>';
      return;
    }
    el.innerHTML = [...history]
      .reverse()
      .map((h) => {
        const wStr = h.winners
          .map((w) => `🏆 <strong>${escapeHtml(w.name)}</strong> (+${w.amount} 🪙 — ${escapeHtml(w.handName)})`)
          .join('<br/>');
        const boardStr = h.board && h.board.length > 0 ? `Board: ${escapeHtml(h.board.join(' '))}` : 'Ended Pre-Flop';
        return `
          <div class="log-item">
            <div style="display:flex; justify-content:space-between; color:var(--gold); font-weight:700; margin-bottom:3px;">
              <span>Round #${h.handNumber}</span>
              <span style="color:var(--text-muted); font-weight:400;">${escapeHtml(h.time)}</span>
            </div>
            <div style="font-size:0.76rem; color:#93c5fd; margin-bottom:3px;">${boardStr}</div>
            <div>${wStr}</div>
          </div>
        `;
      })
      .join('');
  }

  function appendChatMessage(msg) {
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.innerHTML = `<span class="chat-sender">${escapeHtml(msg.avatar || '💬')} ${escapeHtml(msg.sender)}:</span> ${escapeHtml(msg.text)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ================= AAA CASINO THEMES =================
  const THEMES = [
    { id: 'emerald', label: 'Emerald Monte Carlo', cls: '' },
    { id: 'vegas', label: 'Royal Vegas Blue', cls: 'theme-vegas' },
    { id: 'crimson', label: 'Crimson VIP Lounge', cls: 'theme-crimson' }
  ];
  let currentThemeIdx = 0;

  function applyTheme(idx) {
    currentThemeIdx = idx % THEMES.length;
    const t = THEMES[currentThemeIdx];
    document.body.classList.remove('theme-vegas', 'theme-crimson');
    if (t.cls) document.body.classList.add(t.cls);
    try {
      localStorage.setItem('pooker_theme', t.id);
    } catch (_) {}
  }

  try {
    const saved = localStorage.getItem('pooker_theme');
    const foundIdx = THEMES.findIndex((t) => t.id === saved);
    if (foundIdx >= 0) applyTheme(foundIdx);
  } catch (_) {}

  $('btn-theme')?.addEventListener('click', () => {
    applyTheme((currentThemeIdx + 1) % THEMES.length);
    showToast(`🎨 Table Theme: ${THEMES[currentThemeIdx].label}`);
  });

  // ================= PLAYER PROFILE & XP LOADER =================
  async function fetchMyProfile() {
    const name = playerNameInput.value.trim() || 'Player 1';
    const tierEl = $('profile-tier-text');
    const fillEl = $('profile-xp-fill');
    const pillEl = $('lobby-profile-pill');
    if (!tierEl || !fillEl) return;
    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(name)}`);
      const { profile } = await res.json();
      if (!profile) return;
      tierEl.textContent = `${profile.tier.icon} ${profile.tier.name} • Lv ${profile.level}`;
      fillEl.style.width = `${profile.progressPct}%`;
      const achText =
        profile.achievements && profile.achievements.length > 0
          ? ` | Badges: ${profile.achievements.map((a) => a.label).join(', ')}`
          : '';
      pillEl.title = `XP: ${profile.xp}/${profile.nextLevelXp} • Wins: ${profile.handsWon}/${profile.handsPlayed} (${profile.winRate}%)${achText}`;
    } catch (_) {
      // ignore network error
    }
  }

  playerNameInput?.addEventListener('change', fetchMyProfile);
  fetchMyProfile();

  // ================= WINNER CONFETTI CELEBRATION =================
  function triggerWinConfetti() {
    const layer = $('confetti-layer');
    if (!layer) return;
    const icons = ['🪙', '✨', '🏆', '♠️', '♥️', '♦️', '♣️'];
    for (let i = 0; i < 20; i++) {
      const el = document.createElement('span');
      el.className = 'confetti-piece';
      el.textContent = icons[i % icons.length];
      const angle = (Math.PI * 2 * i) / 20 + (Math.random() - 0.5) * 0.35;
      const dist = 120 + Math.random() * 190;
      const tx = `${Math.round(Math.cos(angle) * dist)}px`;
      const ty = `${Math.round(Math.sin(angle) * dist - 40)}px`;
      const rot = `${Math.round((Math.random() - 0.5) * 360)}deg`;
      el.style.setProperty('--tx', tx);
      el.style.setProperty('--ty', ty);
      el.style.setProperty('--rot', rot);
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1400);
    }
  }

  // ================= PRE-ACTION QUEUE =================
  const preCheckFold = $('pre-check-fold');
  const preCallAny = $('pre-call-any');
  const preActionBar = $('pre-action-bar');

  preCheckFold?.addEventListener('change', () => {
    if (preCheckFold.checked && preCallAny) preCallAny.checked = false;
  });
  preCallAny?.addEventListener('change', () => {
    if (preCallAny.checked && preCheckFold) preCheckFold.checked = false;
  });

  function clearPreActions() {
    if (preCheckFold) preCheckFold.checked = false;
    if (preCallAny) preCallAny.checked = false;
  }

  function processPreActionQueue(state) {
    if (!preActionBar) return;
    const me = state.players.find((p) => p.id === myId);
    const activePlay =
      state.phase !== 'LOBBY' &&
      state.phase !== 'SHOWDOWN' &&
      state.phase !== 'GAME_OVER' &&
      !state.allInRunoutPending &&
      me &&
      !me.folded &&
      !me.eliminated &&
      !me.allIn;

    if (!activePlay) {
      preActionBar.classList.add('hidden');
      clearPreActions();
      return;
    }

    const v = state.validActions;
    if (!v.isTurn) {
      preActionBar.classList.remove('hidden');
      return;
    }

    // It's our turn -> execute queued pre-action if selected!
    preActionBar.classList.add('hidden');
    if (preCheckFold?.checked && !pendingAction) {
      clearPreActions();
      setTimeout(() => {
        if (!currentState?.validActions?.isTurn || pendingAction) return;
        if (currentState.validActions.canCheck) btnCheckCall.click();
        else btnFold.click();
      }, 220);
    } else if (preCallAny?.checked && !pendingAction) {
      clearPreActions();
      setTimeout(() => {
        if (!currentState?.validActions?.isTurn || pendingAction) return;
        if (currentState.validActions.canCheck || currentState.validActions.canCall) {
          btnCheckCall.click();
        }
      }, 220);
    }
  }

  // ================= LIVE ONLINE VOICE CHAT (WebRTC P2P) =================
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  let voiceJoined = false;
  let voiceMuted = false;
  let localAudioStream = null;
  const peerConnections = new Map(); // peerId -> RTCPeerConnection
  const remoteAudioEls = new Map(); // peerId -> HTMLAudioElement
  const pendingIceCandidates = new Map(); // peerId -> RTCIceCandidateInit[]
  const voicePeersMap = new Map(); // playerId -> { muted: boolean }
  const speakingPeers = new Set(); // playerId
  let voiceAudioCtx = null;
  const peerAnalysers = new Map(); // playerId -> { analyser, dataArray, source }
  let speakingPollTimer = null;

  function updateVoiceChatButtons() {
    if (!btnVoiceChat || !btnVoiceMute) return;
    if (voiceJoined) {
      const peerCount = voicePeersMap.size;
      btnVoiceChat.textContent = `📞 Leave Voice${peerCount > 0 ? ` (${peerCount})` : ''}`;
      btnVoiceChat.classList.add('voice-active');
      btnVoiceMute.classList.remove('hidden');
      btnVoiceMute.textContent = voiceMuted ? '🔇 Muted' : '🎤 Mic On';
      btnVoiceMute.classList.toggle('muted-off', voiceMuted);
      btnVoicePtt?.classList.remove('hidden');
      floatingPttBtn?.classList.remove('hidden');
    } else {
      const peerCount = voicePeersMap.size;
      btnVoiceChat.textContent = peerCount > 0 ? `🎙️ Join Voice (${peerCount})` : '🎙️ Voice Chat';
      btnVoiceChat.classList.remove('voice-active');
      btnVoiceMute.classList.add('hidden');
      btnVoicePtt?.classList.add('hidden');
      floatingPttBtn?.classList.add('hidden');
    }
  }

  function handleVoiceState(peers) {
    voicePeersMap.clear();
    for (const p of peers) {
      voicePeersMap.set(p.id, { muted: Boolean(p.muted) });
      if (voiceJoined && p.id && p.id !== myId) {
        const pc = peerConnections.get(p.id);
        if (!pc || pc.connectionState !== 'connected') {
          scheduleRelayFallback(p.id);
        }
      }
    }
    updateVoiceChatButtons();
    if (currentState) renderGameState(currentState);
  }

  function ensureVoiceAudioCtx() {
    if (!voiceAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) voiceAudioCtx = new Ctx();
    }
    if (voiceAudioCtx && voiceAudioCtx.state === 'suspended') {
      voiceAudioCtx.resume().catch(() => {});
    }
    return voiceAudioCtx;
  }

  function attachSpeakingAnalyser(peerId, stream) {
    try {
      const ctx = ensureVoiceAudioCtx();
      if (!ctx) return;
      detachSpeakingAnalyser(peerId);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      peerAnalysers.set(peerId, { analyser, dataArray, source });
      startSpeakingPoll();
    } catch (_) {
      // Ignore Web Audio analyser errors on restricted browsers
    }
  }

  function detachSpeakingAnalyser(peerId) {
    const entry = peerAnalysers.get(peerId);
    if (entry) {
      try {
        entry.source.disconnect();
      } catch (_) {}
      peerAnalysers.delete(peerId);
    }
    speakingPeers.delete(peerId);
  }

  function startSpeakingPoll() {
    if (speakingPollTimer) return;
    speakingPollTimer = setInterval(() => {
      if (peerAnalysers.size === 0) {
        clearInterval(speakingPollTimer);
        speakingPollTimer = null;
        return;
      }
      for (const [peerId, entry] of peerAnalysers.entries()) {
        const info = voicePeersMap.get(peerId);
        let isSpeaking = false;
        if (info && !info.muted) {
          entry.analyser.getByteFrequencyData(entry.dataArray);
          let sum = 0;
          for (let i = 0; i < entry.dataArray.length; i++) sum += entry.dataArray[i];
          const avg = sum / entry.dataArray.length;
          isSpeaking = avg > 14;
        }
        const wasSpeaking = speakingPeers.has(peerId);
        if (isSpeaking !== wasSpeaking) {
          if (isSpeaking) speakingPeers.add(peerId);
          else speakingPeers.delete(peerId);
          const seatEl = seatsLayer?.querySelector(`.seat-node[data-player-id="${CSS.escape(peerId)}"]`);
          if (seatEl) seatEl.classList.toggle('voice-speaking', isSpeaking);
        }
      }
    }, 120);
  }

  let turnRelayActive = false;
  const peerRelayNeeded = new Set(); // peerIds whose WebRTC P2P is not connected -> use WS Voice Relay!
  const peerRelayTimers = new Map(); // peerId -> fallback timeout
  const relayPlayHeads = new Map(); // peerId -> next AudioContext playback time
  const relaySpeakingTimers = new Map(); // peerId -> glow timeout
  let relayCaptureNodes = null;
  let relayOutBus = null;
  let lastRemoteRelayPlayAt = 0;

  function encodeMuLawBase64(floatSamples, inRate, outRate = 12000, adaptiveState = null) {
    const ratio = Math.max(1, inRate / outRate);
    const outLen = Math.floor(floatSamples.length / ratio);
    if (outLen <= 0) return null;
    const bytes = new Uint8Array(outLen);
    const MU = 255;
    const LOG_1_MU = Math.log(1 + MU);
    let sumSq = 0;

    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(floatSamples.length, Math.floor((i + 1) * ratio));
      let acc = 0;
      const count = Math.max(1, end - start);
      for (let j = start; j < end; j++) acc += floatSamples[j];
      const x = Math.max(-1, Math.min(1, acc / count));
      sumSq += x * x;
      const sign = x < 0 ? 0x80 : 0;
      const mag = Math.log(1 + MU * Math.abs(x)) / LOG_1_MU;
      bytes[i] = sign | (Math.min(127, Math.floor(mag * 127.99)) & 0x7f);
    }

    const rms = Math.sqrt(sumSq / outLen);
    const nowMs = Date.now();
    const remotePlaying = nowMs < lastRemoteRelayPlayAt + 220;

    if (adaptiveState) {
      if (!adaptiveState.gateOpen && !remotePlaying && rms < 0.02) {
        adaptiveState.noiseFloor = adaptiveState.noiseFloor * 0.92 + rms * 0.08;
      }
      const baseThresh = Math.max(0.0025, Math.min(0.015, adaptiveState.noiseFloor * 1.8));
      const thresh = remotePlaying ? Math.max(0.018, baseThresh * 2.2) : baseThresh;
      if (rms >= thresh) {
        adaptiveState.gateOpen = true;
        adaptiveState.holdUntil = nowMs + 340;
      } else if (adaptiveState.gateOpen && nowMs > adaptiveState.holdUntil) {
        adaptiveState.gateOpen = false;
      }
      if (!adaptiveState.gateOpen) return null;
    } else if (rms < 0.0025) {
      return null;
    }

    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function decodeMuLawBase64(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Float32Array(len);
    const MU = 255;
    for (let i = 0; i < len; i++) {
      const b = bin.charCodeAt(i);
      const sign = b & 0x80 ? -1 : 1;
      const mag = (b & 0x7f) / 127;
      out[i] = sign * ((Math.pow(1 + MU, mag) - 1) / MU);
    }
    // 4ms cosine fade-in & fade-out eliminates clicks/pops between chunks
    const fadeSamples = Math.min(48, Math.floor(len / 4));
    for (let i = 0; i < fadeSamples; i++) {
      const gain = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
      out[i] *= gain;
      out[len - 1 - i] *= gain;
    }
    return out;
  }

  function getRelayOutputBus(ctx) {
    if (relayOutBus && relayOutBus.ctx === ctx) return relayOutBus.input;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 140;
    hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.1;
    const gain = ctx.createGain();
    gain.gain.value = 0.85;
    hp.connect(lp);
    lp.connect(comp);
    comp.connect(gain);
    gain.connect(ctx.destination);
    relayOutBus = { ctx, input: hp, hp, lp, comp, gain };
    return hp;
  }

  function primeVoiceAudioCtx() {
    const ctx = ensureVoiceAudioCtx();
    if (!ctx) return null;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      // Play 1 silent sample synchronously inside user click gesture to permanently unlock iOS/Android audio!
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (_) {}
    return ctx;
  }

  function startRelayCapture(stream) {
    stopRelayCapture();
    try {
      const ctx = ensureVoiceAudioCtx();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 130;
      highpass.Q.value = 0.7;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0.0;

      // Keep strong global ref so Chrome NEVER garbage-collects ScriptProcessor after 1-2s!
      window.__pokerRelayProc = processor;

      const adaptiveState = { noiseFloor: 0.002, gateOpen: false, holdUntil: 0 };

      processor.onaudioprocess = (ev) => {
        if (!voiceJoined || voiceMuted || peerRelayNeeded.size === 0) return;
        const targets = [...peerRelayNeeded].filter((id) => id !== myId && voicePeersMap.has(id));
        if (targets.length === 0) return;
        const input = ev.inputBuffer.getChannelData(0);
        // 16kHz wideband HD speech (same bandwidth as HD VoIP / WhatsApp!)
        const b64 = encodeMuLawBase64(input, ctx.sampleRate, 16000, adaptiveState);
        if (!b64) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'voice_audio', sr: 16000, d: b64, targets }));
        }
      };

      source.connect(highpass);
      highpass.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
      relayCaptureNodes = { source, highpass, processor, silentGain };
    } catch (_) {}
  }

  function stopRelayCapture() {
    window.__pokerRelayProc = null;
    if (relayCaptureNodes) {
      try {
        relayCaptureNodes.processor.onaudioprocess = null;
        relayCaptureNodes.source.disconnect();
        relayCaptureNodes.highpass.disconnect();
        relayCaptureNodes.processor.disconnect();
        relayCaptureNodes.silentGain.disconnect();
      } catch (_) {}
      relayCaptureNodes = null;
    }
    if (relayOutBus) {
      try {
        relayOutBus.hp?.disconnect();
        relayOutBus.lp?.disconnect();
        relayOutBus.comp?.disconnect();
        relayOutBus.gain?.disconnect();
      } catch (_) {}
      relayOutBus = null;
    }
    for (const t of peerRelayTimers.values()) clearTimeout(t);
    peerRelayTimers.clear();
    peerRelayNeeded.clear();
    relayPlayHeads.clear();
    for (const t of relaySpeakingTimers.values()) clearTimeout(t);
    relaySpeakingTimers.clear();
  }

  function handleRelayVoiceAudio(fromId, sampleRate, b64) {
    if (!voiceJoined || !fromId || fromId === myId || !b64) return;
    // If direct WebRTC P2P is already connected for this peer, don't double-play!
    const pc = peerConnections.get(fromId);
    if (pc && pc.connectionState === 'connected') return;

    peerRelayNeeded.add(fromId);
    lastRemoteRelayPlayAt = Date.now();

    try {
      const ctx = ensureVoiceAudioCtx();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const samples = decodeMuLawBase64(b64);
      if (samples.length === 0) return;
      const sr = Math.min(24000, Math.max(8000, Number(sampleRate) || 12000));
      const audioBuf = ctx.createBuffer(1, samples.length, sr);
      audioBuf.getChannelData(0).set(samples);

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(getRelayOutputBus(ctx));

      // Smooth 100ms jitter buffer prevents choppy dropouts on mobile 4G/WiFi
      const now = ctx.currentTime;
      let startAt = relayPlayHeads.get(fromId) || now + 0.1;
      if (startAt < now + 0.015 || startAt > now + 0.65) {
        startAt = now + 0.1;
      }
      src.start(startAt);
      relayPlayHeads.set(fromId, startAt + audioBuf.duration);

      const seatEl = seatsLayer?.querySelector(`.seat-node[data-player-id="${CSS.escape(fromId)}"]`);
      if (seatEl) seatEl.classList.add('voice-speaking');
      if (relaySpeakingTimers.has(fromId)) clearTimeout(relaySpeakingTimers.get(fromId));
      relaySpeakingTimers.set(
        fromId,
        setTimeout(() => {
          const el = seatsLayer?.querySelector(`.seat-node[data-player-id="${CSS.escape(fromId)}"]`);
          if (el) el.classList.remove('voice-speaking');
          relaySpeakingTimers.delete(fromId);
        }, 360)
      );
    } catch (_) {}
  }

  function scheduleRelayFallback(peerId) {
    // When a real TURN server is configured, WebRTC handles 100% of networks with WhatsApp-grade Hardware AEC!
    if (turnRelayActive) return;
    if (peerRelayTimers.has(peerId)) clearTimeout(peerRelayTimers.get(peerId));
    peerRelayTimers.set(
      peerId,
      setTimeout(() => {
        peerRelayTimers.delete(peerId);
        if (!voiceJoined || !voicePeersMap.has(peerId)) return;
        const pc = peerConnections.get(peerId);
        if (!pc || pc.connectionState !== 'connected') {
          peerRelayNeeded.add(peerId);
        }
      }, 1800)
    );
  }

  function unlockRemoteVoicePlayback() {
    ensureVoiceAudioCtx();
    for (const audioEl of remoteAudioEls.values()) {
      if (audioEl && audioEl.paused && audioEl.srcObject) {
        audioEl.play().catch(() => {});
      }
    }
  }
  document.addEventListener('pointerdown', unlockRemoteVoicePlayback, { passive: true });

  function createPeerConnection(peerId) {
    // Preserve any ICE candidates that arrived before the SDP offer!
    closePeerConnection(peerId, false);
    const pc = new RTCPeerConnection({
      iceServers: RTC_CONFIG.iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    peerConnections.set(peerId, pc);
    scheduleRelayFallback(peerId);

    if (localAudioStream) {
      for (const track of localAudioStream.getTracks()) {
        pc.addTrack(track, localAudioStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send({
          type: 'voice_signal',
          targetId: peerId,
          data: { candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      const remoteStream =
        (event.streams && event.streams[0]) ||
        (event.track ? new MediaStream([event.track]) : null);
      if (!remoteStream) return;
      let audioEl = remoteAudioEls.get(peerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.muted = false;
        audioEl.volume = 0.78;
        audioEl.dataset.peerId = peerId;
        voiceAudioContainer?.appendChild(audioEl);
        remoteAudioEls.set(peerId, audioEl);
      }
      audioEl.srcObject = remoteStream;
      audioEl.play().catch(() => {});
      attachSpeakingAnalyser(peerId, remoteStream);
    };

    let iceRestartAttempted = false;
    pc.onconnectionstatechange = async () => {
      if (pc.connectionState === 'connected') {
        iceRestartAttempted = false;
        peerRelayNeeded.delete(peerId);
        if (peerRelayTimers.has(peerId)) {
          clearTimeout(peerRelayTimers.get(peerId));
          peerRelayTimers.delete(peerId);
        }
        unlockRemoteVoicePlayback();
      } else if (pc.connectionState === 'failed') {
        // Try 1 seamless ICE restart (like WhatsApp) before falling back!
        if (!iceRestartAttempted && voiceJoined && typeof pc.restartIce === 'function') {
          iceRestartAttempted = true;
          try {
            const offer = await pc.createOffer({ iceRestart: true, offerToReceiveAudio: true });
            await pc.setLocalDescription(offer);
            send({ type: 'voice_signal', targetId: peerId, data: { sdp: pc.localDescription } });
            return;
          } catch (_) {}
        }
        if (!turnRelayActive && voiceJoined && voicePeersMap.has(peerId)) {
          peerRelayNeeded.add(peerId);
        }
        closePeerConnection(peerId, true, false);
      } else if (pc.connectionState === 'closed') {
        closePeerConnection(peerId, true, false);
      }
    };

    return pc;
  }

  function closePeerConnection(peerId, clearPendingIce = true, clearRelay = true) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.close();
      } catch (_) {}
      peerConnections.delete(peerId);
    }
    const audioEl = remoteAudioEls.get(peerId);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      remoteAudioEls.delete(peerId);
    }
    if (clearPendingIce) {
      pendingIceCandidates.delete(peerId);
    }
    if (clearRelay) {
      peerRelayNeeded.delete(peerId);
      if (peerRelayTimers.has(peerId)) {
        clearTimeout(peerRelayTimers.get(peerId));
        peerRelayTimers.delete(peerId);
      }
    }
    detachSpeakingAnalyser(peerId);
  }

  async function flushPendingIce(peerId, pc) {
    const queued = pendingIceCandidates.get(peerId);
    if (!queued || queued.length === 0) return;
    pendingIceCandidates.delete(peerId);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (_) {}
    }
  }

  async function handleVoiceJoined(existingPeerIds) {
    if (!voiceJoined) return;
    for (const peerId of existingPeerIds) {
      if (peerId === myId) continue;
      try {
        const pc = createPeerConnection(peerId);
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        send({
          type: 'voice_signal',
          targetId: peerId,
          data: { sdp: pc.localDescription }
        });
      } catch (err) {
        peerRelayNeeded.add(peerId);
        console.warn('Voice offer error (using relay):', err);
      }
    }
  }

  async function handleVoiceSignal(fromId, data) {
    if (!voiceJoined || !fromId || !data) return;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          // Glare protection: if both peers sent offers simultaneously, deterministic tie-break by ID
          const existingPc = peerConnections.get(fromId);
          if (existingPc && existingPc.signalingState === 'have-local-offer' && String(myId) > String(fromId)) {
            return;
          }
          const pc = createPeerConnection(fromId);
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await flushPendingIce(fromId, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({
            type: 'voice_signal',
            targetId: fromId,
            data: { sdp: pc.localDescription }
          });
        } else if (data.sdp.type === 'answer') {
          const pc = peerConnections.get(fromId);
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            await flushPendingIce(fromId, pc);
          }
        }
      } else if (data.candidate) {
        const pc = peerConnections.get(fromId);
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
          if (!pendingIceCandidates.has(fromId)) pendingIceCandidates.set(fromId, []);
          pendingIceCandidates.get(fromId).push(data.candidate);
        }
      }
    } catch (err) {
      peerRelayNeeded.add(fromId);
      console.warn('Voice signal error (using relay):', err);
    }
  }

  async function loadIceConfig() {
    try {
      const resp = await fetch('/api/ice-config');
      if (!resp.ok) return;
      const cfg = await resp.json();
      if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
        RTC_CONFIG.iceServers = cfg.iceServers;
        turnRelayActive = Boolean(cfg.turnActive);
      }
    } catch (_) {
      // Keep default STUN servers on fallback
    }
  }

  let voiceJoining = false;
  async function joinVoiceChat() {
    if (voiceJoined || voiceJoining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('⚠️ Voice Chat requires HTTPS (or localhost) and microphone support.');
      return;
    }
    voiceJoining = true;
    primeVoiceAudioCtx();
    try {
      // Direct hardware mic stream keeps Android/iOS/Chrome Hardware DSP AEC + Noise Suppression 100% active!
      localAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          googEchoCancellation: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
          googTypingNoiseDetection: true
        },
        video: false
      });
    } catch (_) {
      try {
        localAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
      } catch (err) {
        voiceJoining = false;
        showToast('⚠️ Microphone permission denied. Please allow mic access to use Voice Chat.');
        return;
      }
    }

    await loadIceConfig();

    voiceJoining = false;
    voiceJoined = true;
    voiceMuted = false;
    window.pokerSound?.setVoiceChatDucking(true);
    if (myId) attachSpeakingAnalyser(myId, localAudioStream);
    if (!turnRelayActive) startRelayCapture(localAudioStream);
    updateVoiceChatButtons();
    send({ type: 'voice_join' });
    showToast(turnRelayActive ? '🎙️ Connected to HD Voice Chat!' : '🎙️ Connected to Table Voice Chat!');
  }

  function leaveVoiceChat(notifyServer = true) {
    const wasJoined = voiceJoined;
    voiceJoined = false;
    voiceMuted = false;
    window.pokerSound?.setVoiceChatDucking(false);

    stopRelayCapture();
    for (const peerId of [...peerConnections.keys()]) {
      closePeerConnection(peerId, true, true);
    }
    if (myId) detachSpeakingAnalyser(myId);
    if (speakingPollTimer) {
      clearInterval(speakingPollTimer);
      speakingPollTimer = null;
    }
    speakingPeers.clear();

    if (localAudioStream) {
      for (const track of localAudioStream.getTracks()) {
        try {
          track.stop();
        } catch (_) {}
      }
      localAudioStream = null;
    }

    if (notifyServer && wasJoined) {
      send({ type: 'voice_leave' });
      showToast('📞 Left Table Voice Chat');
    }
    updateVoiceChatButtons();
  }

  function setMicMuted(muted) {
    if (!voiceJoined || !localAudioStream) return;
    voiceMuted = Boolean(muted);
    for (const track of localAudioStream.getAudioTracks()) {
      track.enabled = !voiceMuted;
    }
    if (voiceMuted && myId) speakingPeers.delete(myId);
    updateVoiceChatButtons();
    send({ type: 'voice_mute', muted: voiceMuted });
  }

  function toggleVoiceMute() {
    setMicMuted(!voiceMuted);
  }

  function setRemoteSpeakerVolume(vol) {
    for (const audioEl of remoteAudioEls.values()) {
      if (audioEl) audioEl.volume = vol;
    }
    if (relayOutBus && relayOutBus.gain) {
      try {
        relayOutBus.gain.gain.value = vol;
      } catch (_) {}
    }
  }

  let pttActive = false;
  function startPtt(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!voiceJoined || pttActive) return;
    pttActive = true;
    btnVoicePtt?.classList.add('ptt-live');
    if (btnVoicePtt) btnVoicePtt.textContent = '🔴 Talking...';
    floatingPttBtn?.classList.add('ptt-live');
    const lbl = floatingPttBtn?.querySelector('.ptt-lbl');
    if (lbl) lbl.textContent = 'LIVE';
    setRemoteSpeakerVolume(0.12); // Duck speaker while talking -> 0% echo!
    setMicMuted(false);
  }

  function stopPtt(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!pttActive) return;
    pttActive = false;
    btnVoicePtt?.classList.remove('ptt-live');
    if (btnVoicePtt) btnVoicePtt.textContent = '🗣️ Hold to Talk';
    floatingPttBtn?.classList.remove('ptt-live');
    const lbl = floatingPttBtn?.querySelector('.ptt-lbl');
    if (lbl) lbl.textContent = 'HOLD';
    setMicMuted(true);
    setRemoteSpeakerVolume(0.85);
  }

  btnVoicePtt?.addEventListener('pointerdown', startPtt);
  floatingPttBtn?.addEventListener('pointerdown', startPtt);
  window.addEventListener('pointerup', stopPtt);
  window.addEventListener('pointercancel', stopPtt);

  // Desktop Push-to-Talk hotkey: hold 'V' key to talk cleanly!
  window.addEventListener('keydown', (e) => {
    if (!voiceJoined || e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'v' || e.key === 'V') startPtt();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'v' || e.key === 'V') stopPtt();
  });

  btnVoiceChat?.addEventListener('click', () => {
    if (voiceJoined) leaveVoiceChat(true);
    else joinVoiceChat();
  });

  btnVoiceMute?.addEventListener('click', toggleVoiceMute);

  // ================= COIN LOAN, NEGOTIATION & UNANIMOUS END-GAME UI =================
  const loanModal = $('loan-modal');
  const btnLoanModal = $('btn-loan-modal');
  const btnEndGame = $('btn-end-game');
  const endGameVoteBanner = $('end-game-vote-banner');
  const loanAlertBanner = $('loan-alert-banner');

  btnLoanModal?.addEventListener('click', () => {
    if (!currentState) return;
    if (isSpectatorMode) {
      showToast('👁️ Spectators cannot request or lend coins.');
      return;
    }
    renderLoanAndVoteUI(currentState);
    loanModal?.classList.remove('hidden');
  });

  $('btn-close-loan')?.addEventListener('click', () => loanModal?.classList.add('hidden'));
  loanModal?.addEventListener('click', (e) => {
    if (e.target === loanModal) loanModal.classList.add('hidden');
  });

  document.querySelectorAll('.loan-q').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inp = $('loan-amount-input');
      if (inp) inp.value = btn.dataset.lamt || '20';
    });
  });

  $('loan-request-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const lenderId = $('loan-lender-select')?.value;
    const amount = Number($('loan-amount-input')?.value || 0);
    const note = ($('loan-note-input')?.value || '').trim();
    if (!lenderId || amount < 1) {
      showToast('⚠️ Select a player and valid coin amount.');
      return;
    }
    send({ type: 'loan_request', lenderId, amount, note });
    if ($('loan-note-input')) $('loan-note-input').value = '';
  });

  btnEndGame?.addEventListener('click', () => {
    if (!currentState) return;
    if (isSpectatorMode) {
      showToast('👁️ Only seated players can vote to end the game.');
      return;
    }
    if (currentState.phase === 'LOBBY') {
      showToast('ℹ️ Start the game first before ending it.');
      return;
    }
    if (currentState.phase === 'GAME_OVER') {
      gameoverOverlay.classList.remove('hidden');
      return;
    }
    if (currentState.endGameVote) {
      showToast('🏁 An End Game vote is already active above the table!');
      return;
    }
    send({ type: 'end_game_request' });
  });

  function renderLoanCardHtml(req, compact = false) {
    const isLender = req.lenderId === myId;
    const isRequester = req.requesterId === myId;
    const myTurnToRespond =
      (req.status === 'PENDING_LENDER' && isLender) ||
      (req.status === 'COUNTER_OFFERED' && isRequester);

    const headline =
      req.status === 'PENDING_LENDER'
        ? isLender
          ? `🤝 <strong>${escapeHtml(req.requesterName)}</strong> wants <strong>${req.currentOfferAmount} 🪙</strong> from you`
          : `⏳ Asked <strong>${escapeHtml(req.lenderName)}</strong> for <strong>${req.currentOfferAmount} 🪙</strong>`
        : isRequester
        ? `💬 <strong>${escapeHtml(req.lenderName)}</strong> counter-offered <strong>${req.currentOfferAmount} 🪙</strong> (asked ${req.requestedAmount})`
        : `⏳ You counter-offered <strong>${req.currentOfferAmount} 🪙</strong> to <strong>${escapeHtml(req.requesterName)}</strong>`;

    const noteHtml = req.note && !compact ? `<div class="loan-note">"${escapeHtml(req.note)}"</div>` : '';

    const actionsHtml = myTurnToRespond
      ? `
        <div class="loan-card-actions">
          <button type="button" class="btn btn-emerald loan-act-btn" data-loan-id="${escapeHtml(req.id)}" data-decision="accept">✅ Accept (${req.currentOfferAmount} 🪙)</button>
          <div class="loan-counter-group">
            <input type="number" class="loan-counter-input" min="1" max="100000" value="${req.currentOfferAmount}" data-counter-for="${escapeHtml(req.id)}" />
            <button type="button" class="btn btn-sapphire loan-act-btn" data-loan-id="${escapeHtml(req.id)}" data-decision="counter">💬 Negotiate</button>
          </div>
          <button type="button" class="btn btn-outline loan-act-btn" data-loan-id="${escapeHtml(req.id)}" data-decision="reject">❌ Decline</button>
        </div>
      `
      : `
        <div class="loan-card-actions">
          <span class="loan-wait-tag">Waiting for response...</span>
          ${isRequester || isLender ? `<button type="button" class="btn btn-outline loan-act-btn" data-loan-id="${escapeHtml(req.id)}" data-decision="reject" style="padding:4px 10px; font-size:0.74rem;">Cancel</button>` : ''}
        </div>
      `;

    return `
      <div class="loan-item-card ${myTurnToRespond ? 'needs-action' : ''}">
        <div class="loan-headline">${headline}</div>
        ${noteHtml}
        ${actionsHtml}
      </div>
    `;
  }

  function bindLoanActionButtons(container) {
    if (!container) return;
    container.querySelectorAll('.loan-act-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const requestId = btn.dataset.loanId;
        const decision = btn.dataset.decision;
        let counterAmount = 0;
        if (decision === 'counter') {
          const inp = container.querySelector(`.loan-counter-input[data-counter-for="${CSS.escape(requestId)}"]`);
          counterAmount = Number(inp?.value || 0);
          if (counterAmount < 1) {
            showToast('⚠️ Enter a valid negotiated coin amount (1+).');
            return;
          }
        }
        send({ type: 'loan_respond', requestId, decision, counterAmount });
      });
    });
  }

  function renderLoanAndVoteUI(state) {
    // 1) Update Top Bar Loan button notification badge
    const requests = state.loanRequests || [];
    const actionableForMe = requests.filter(
      (r) =>
        (r.status === 'PENDING_LENDER' && r.lenderId === myId) ||
        (r.status === 'COUNTER_OFFERED' && r.requesterId === myId)
    );
    if (btnLoanModal) {
      btnLoanModal.textContent = actionableForMe.length > 0 ? `🤝 Loan (${actionableForMe.length})` : '🤝 Loan';
      btnLoanModal.classList.toggle('has-unread', actionableForMe.length > 0);
    }

    // 2) Live Floating Incoming Loan / Counter-Offer Banner above table
    if (loanAlertBanner) {
      if (actionableForMe.length > 0 && !isSpectatorMode && state.phase !== 'GAME_OVER') {
        const topReq = actionableForMe[0];
        const sig = `${topReq.id}:${topReq.status}:${topReq.currentOfferAmount}`;
        const userTypingHere = loanAlertBanner.contains(document.activeElement);
        loanAlertBanner.classList.remove('hidden');
        if (loanAlertBanner.dataset.renderSig !== sig || !userTypingHere) {
          if (loanAlertBanner.dataset.renderSig !== sig) {
            loanAlertBanner.dataset.renderSig = sig;
            loanAlertBanner.innerHTML = renderLoanCardHtml(topReq, true);
            bindLoanActionButtons(loanAlertBanner);
          }
        }
      } else {
        loanAlertBanner.classList.add('hidden');
        loanAlertBanner.dataset.renderSig = '';
        loanAlertBanner.innerHTML = '';
      }
    }

    // 3) Live Unanimous End-Game Vote Banner above table
    if (endGameVoteBanner) {
      const vote = state.endGameVote;
      if (vote && state.phase !== 'GAME_OVER') {
        const required = vote.requiredIds || [];
        const acceptedCount = required.filter((id) => vote.votes && vote.votes[id] === 'ACCEPT').length;
        const myVoted = vote.votes && vote.votes[myId] === 'ACCEPT';
        const isVoter = required.includes(myId) && !isSpectatorMode;

        endGameVoteBanner.classList.remove('hidden');
        endGameVoteBanner.innerHTML = `
          <div class="vote-banner-row">
            <div class="vote-banner-text">
              🏁 <strong>${escapeHtml(vote.initiatorName)}</strong> wants to <strong>End Game &amp; Settle All Loans</strong>
              <span class="vote-count-pill">${acceptedCount}/${required.length} Agreed</span>
            </div>
            <div class="vote-banner-actions">
              ${
                isVoter && !myVoted
                  ? `<button type="button" id="btn-vote-end-accept" class="btn btn-emerald">✅ Accept &amp; End</button>
                     <button type="button" id="btn-vote-end-reject" class="btn btn-outline">❌ Keep Playing</button>`
                  : isVoter && myVoted
                  ? `<span class="loan-wait-tag">✅ You agreed — waiting for others...</span>
                     <button type="button" id="btn-vote-end-reject" class="btn btn-outline" style="padding:4px 10px; font-size:0.75rem;">Cancel Vote</button>`
                  : `<span class="loan-wait-tag">Players are voting to end the match...</span>`
              }
            </div>
          </div>
        `;
        $('btn-vote-end-accept')?.addEventListener('click', () => send({ type: 'end_game_vote', accept: true }));
        $('btn-vote-end-reject')?.addEventListener('click', () => send({ type: 'end_game_vote', accept: false }));
      } else {
        endGameVoteBanner.classList.add('hidden');
        endGameVoteBanner.innerHTML = '';
      }
    }

    // 4) Populate Loan Modal (Lender dropdown, active negotiations, and completed ledger)
    const lenderSelect = $('loan-lender-select');
    if (lenderSelect) {
      const prevVal = lenderSelect.value;
      const others = state.players.filter((p) => p.id !== myId && p.coins > 0);
      if (others.length === 0) {
        lenderSelect.innerHTML = '<option value="">No players with spare coins</option>';
      } else {
        lenderSelect.innerHTML = others
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}">${escapeHtml(p.avatar)} ${escapeHtml(p.name)} (🪙 ${p.coins})</option>`
          )
          .join('');
        if (others.some((p) => p.id === prevVal)) {
          lenderSelect.value = prevVal;
        }
      }
    }

    const activeList = $('loan-active-list');
    if (activeList) {
      const mine = requests.filter((r) => r.requesterId === myId || r.lenderId === myId);
      const listSig = mine.map((r) => `${r.id}:${r.status}:${r.currentOfferAmount}`).join('|');
      if (mine.length === 0) {
        if (activeList.dataset.renderSig !== 'EMPTY') {
          activeList.dataset.renderSig = 'EMPTY';
          activeList.innerHTML = '<div class="loan-empty">No active loan negotiations right now.</div>';
        }
      } else if (activeList.dataset.renderSig !== listSig) {
        activeList.dataset.renderSig = listSig;
        activeList.innerHTML = mine.map((r) => renderLoanCardHtml(r, false)).join('');
        bindLoanActionButtons(activeList);
      }
    }

    const ledgerList = $('loan-ledger-list');
    if (ledgerList) {
      const ledger = state.loanLedger || [];
      if (ledger.length === 0) {
        ledgerList.innerHTML = '<div class="loan-empty">No completed loans yet.</div>';
      } else {
        ledgerList.innerHTML = [...ledger]
          .reverse()
          .map(
            (l) => `
            <div class="ledger-row">
              <span>[${escapeHtml(l.time)}] <strong>${escapeHtml(l.fromName)}</strong> <span class="pos">(+${l.amount})</span> → <strong>${escapeHtml(l.toName)}</strong> <span class="neg">(-${l.amount})</span></span>
              <strong style="color:var(--gold);">🪙 ${l.amount}</strong>
            </div>
          `
          )
          .join('');
      }
    }
  }

  // ================= BROWSER BACK BUTTON (SPA HISTORY NAVIGATION) =================
  let historyInGame = false;

  function pushGameHistoryState(roomId) {
    try {
      if (!historyInGame) {
        history.pushState({ screen: 'game', roomId }, '', `#table-${encodeURIComponent(roomId || '')}`);
        historyInGame = true;
      }
    } catch (_) {}
  }

  function syncLobbyHistoryUrl() {
    try {
      if (historyInGame || window.location.hash.startsWith('#table-')) {
        historyInGame = false;
        history.replaceState({ screen: 'lobby' }, '', window.location.pathname);
      }
    } catch (_) {}
  }

  window.addEventListener('popstate', () => {
    // Pressing browser Back while inside a game table cleanly returns to the Lobby!
    if (!gameScreen.classList.contains('hidden')) {
      historyInGame = false;
      send({ type: 'leave_room' });
      leaveVoiceChat(false);
      voicePeersMap.clear();
      currentState = null;
      pendingAction = false;
      gameScreen.classList.add('hidden');
      lobbyScreen.classList.remove('hidden');
      showToast('Returned to Lobby');
    }
  });

  // Live Server Latency (Ping) & Presence Heartbeat every 5 seconds
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!gameScreen.classList.contains('hidden')) {
        ws.send(JSON.stringify({ type: 'ping_latency', ts: Date.now() }));
      } else {
        ws.send(JSON.stringify({ type: 'hb' }));
      }
    }
  }, 5000);

  // Boot WebSocket connection
  connectWS();
})();
