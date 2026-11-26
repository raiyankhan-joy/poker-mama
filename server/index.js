'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { WSServer } = require('./wsServer');
const { PokerGame, PHASES } = require('./pokerEngine');
const { pickBotName, decideBotAction } = require('./aiBot');
const { StatsStorage } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SERVER_START_TIME = Date.now();

const statsStorage = new StatsStorage();
// In-memory gzipped static asset cache for ultra-fast online page loads
const staticAssetCache = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Active rooms: roomId -> { game, hostId, clients: Map<playerId, WSClient>, botTimer, turnTimer, runoutTimer }
const rooms = new Map();
// Map socket clientId -> { roomId, playerId }
const socketSessionMap = new Map();
// Simple per-client rate limiter: clientId -> { count, resetAt }
const rateLimitMap = new Map();

function isRateLimited(clientId, msgType) {
  if (msgType === 'voice_signal' || msgType === 'ping_latency' || msgType === 'hb') return false;
  const now = Date.now();
  let entry = rateLimitMap.get(clientId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 1000 };
    rateLimitMap.set(clientId, entry);
  }
  entry.count += 1;
  return entry.count > 25;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastRoomState(room) {
  const spectatorCount = room.spectators ? room.spectators.size : 0;
  for (const [playerId, ws] of room.clients.entries()) {
    const state = room.game.getStateForPlayer(playerId);
    state.spectatorCount = spectatorCount;
    ws.sendJSON({
      type: 'game_state',
      hostId: room.hostId,
      myId: playerId,
      isSpectator: false,
      state
    });
  }
  if (room.spectators && room.spectators.size > 0) {
    const specState = room.game.getStateForPlayer(null);
    specState.spectatorCount = spectatorCount;
    for (const [specId, spec] of room.spectators.entries()) {
      spec.ws.sendJSON({
        type: 'game_state',
        hostId: room.hostId,
        myId: specId,
        isSpectator: true,
        state: specState
      });
    }
  }
}

function broadcastEvent(room, payload) {
  for (const ws of room.clients.values()) {
    ws.sendJSON(payload);
  }
  if (room.spectators) {
    for (const spec of room.spectators.values()) {
      spec.ws.sendJSON(payload);
    }
  }
}

function clearRoomTimers(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.runoutTimer) {
    clearTimeout(room.runoutTimer);
    room.runoutTimer = null;
  }
}

function scheduleNextStep(room) {
  clearRoomTimers(room);

  const game = room.game;

  // 1) Animated dramatic All-In runout (Flop -> Turn -> River -> Showdown)
  if (game.allInRunoutPending) {
    room.runoutTimer = setTimeout(() => {
      room.runoutTimer = null;
      if (!rooms.has(game.roomId)) return;
      const more = game.stepAllInRunout();
      broadcastEvent(room, { type: 'action_sfx', action: 'deal' });
      broadcastRoomState(room);
      if (more || game.allInRunoutPending) {
        scheduleNextStep(room);
      }
    }, 880);
    return;
  }

  if (
    game.phase === PHASES.LOBBY ||
    game.phase === PHASES.SHOWDOWN ||
    game.phase === PHASES.GAME_OVER
  ) {
    return;
  }

  const currentPlayer = game.players[game.currentTurnIndex];
  if (!currentPlayer) return;

  // 2) AI Bot turn (snappy, smooth pacing)
  if (currentPlayer.isBot) {
    const delay = 680 + crypto.randomInt(0, 400);
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!rooms.has(game.roomId)) return;
      const active = game.players[game.currentTurnIndex];
      if (!active || !active.isBot) return;

      const decision = decideBotAction(game, active);
      if (decision) {
        const res = game.handleAction(active.id, decision.action, decision.amount || 0, {
          animatedRunout: true
        });
        broadcastEvent(room, {
          type: 'action_sfx',
          action: decision.action,
          playerId: active.id,
          playerName: active.name,
          spokenText: res.spokenText || decision.action
        });
        broadcastRoomState(room);
        scheduleNextStep(room);
      }
    }, delay);
    return;
  }

  // 3) Human player 30s turn countdown timer
  const remainingMs = Math.max(1000, (game.turnExpiresAt || Date.now() + game.turnDurationMs) - Date.now());
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (!rooms.has(game.roomId)) return;
    const timeoutRes = game.handleTurnTimeout();
    if (timeoutRes) {
      broadcastEvent(room, {
        type: 'action_sfx',
        action: timeoutRes.action,
        playerId: timeoutRes.playerId,
        playerName: timeoutRes.playerName,
        spokenText: timeoutRes.action === 'check' ? 'Check' : 'Fold'
      });
      broadcastRoomState(room);
      scheduleNextStep(room);
    }
  }, remainingMs + 150);
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.clients.size === 0) {
    clearRoomTimers(room);
    if (room.spectators) {
      for (const [specId, spec] of room.spectators.entries()) {
        socketSessionMap.delete(specId);
        spec.ws.sendJSON({
          type: 'session_expired',
          message: 'Table closed because all players left.'
        });
      }
      room.spectators.clear();
    }
    rooms.delete(roomId);
  }
}

function getPublicRoomsList() {
  const list = [];
  for (const [roomId, room] of rooms.entries()) {
    const g = room.game;
    if (!g.isPublic) continue;
    const isOpen = g.phase === PHASES.LOBBY && g.players.length < g.maxPlayers;
    const isLive = g.phase !== PHASES.LOBBY && g.phase !== PHASES.GAME_OVER;
    if (!isOpen && !isLive) continue;

    const host = g.players.find((p) => p.id === room.hostId);
    list.push({
      codeRequired: true,
      status: isOpen ? 'OPEN' : 'LIVE',
      hostName: host ? host.name : 'Host',
      hostAvatar: host && host.avatar ? host.avatar : '🕶️',
      playersCount: g.players.length,
      maxPlayers: g.maxPlayers,
      startingCoins: g.startingCoins,
      boardFee: g.boardFee,
      useBlinds: g.useBlinds,
      handNumber: g.handNumber,
      pot: g.pot || 0,
      voiceCount: room.voicePeers ? room.voicePeers.size : 0,
      spectatorCount: room.spectators ? room.spectators.size : 0
    });
  }
  return list.sort((a, b) => (a.status === 'OPEN' ? -1 : 1) - (b.status === 'OPEN' ? -1 : 1));
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 32768) {
  return new Promise((resolve, reject) => {
    let body = '';
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      body += chunk.toString('utf8');
      if (body.length > maxBytes) {
        done = true;
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

// ================= WEBRTC STUN + TURN CONFIG (4G/5G NAT Traversal) =================
const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
let cachedIceServers = null;
let cachedIceExpiresAt = 0;

async function resolveIceServers() {
  const now = Date.now();
  if (cachedIceServers && now < cachedIceExpiresAt) {
    return cachedIceServers;
  }

  let servers = [...DEFAULT_STUN_SERVERS];
  let turnActive = false;

  // Option A: Full custom JSON array in env
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        servers = parsed;
        turnActive = parsed.some((s) => JSON.stringify(s.urls || '').includes('turn:'));
      }
    } catch (_) {}
  }

  // Option B: Standard TURN credentials (Cloudflare Calls, Coturn, Twilio, OpenRelay)
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
    turnActive = true;
  }

  // Option C: Metered.ca Free/Paid Dynamic TURN API
  if (process.env.METERED_APP_NAME && process.env.METERED_API_KEY) {
    try {
      const meteredUrl = `https://${process.env.METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`;
      const resp = await fetch(meteredUrl);
      if (resp.ok) {
        const list = await resp.json();
        if (Array.isArray(list) && list.length > 0) {
          servers = [...DEFAULT_STUN_SERVERS, ...list];
          turnActive = true;
        }
      }
    } catch (_) {
      // Fallback to STUN servers if Metered API is unreachable
    }
  }

  cachedIceServers = { iceServers: servers, turnActive };
  cachedIceExpiresAt = now + 10 * 60 * 1000; // Cache for 10 minutes
  return cachedIceServers;
}

// ================= HTTP + REST API SERVER =================
const httpServer = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const method = req.method || 'GET';

  // Production security headers (allows microphone for Voice Chat on same origin)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self)');

  // Optional HTTPS enforcement behind reverse proxies (Render, Railway, Cloudflare, Fly.io)
  if (
    process.env.FORCE_HTTPS === 'true' &&
    req.headers['x-forwarded-proto'] === 'http' &&
    req.headers.host &&
    urlPath !== '/api/health'
  ) {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url || '/'}` });
    res.end();
    return;
  }

  // 1) Health & System Diagnostics API (GET & HEAD for Render/Railway/UptimeRobot)
  if (urlPath === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    if (method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    return sendJSON(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      activeRooms: rooms.size,
      onlinePlayers: wss.clients.size,
      totalHandsPlayed: statsStorage.data.totalHandsPlayed,
      persistenceMode: statsStorage.persistenceMode,
      turnConfigured: Boolean(
        process.env.TURN_URL || process.env.METERED_API_KEY || process.env.ICE_SERVERS_JSON
      ),
      csprng: 'Node crypto.randomInt (OS Entropy)'
    });
  }

  // 1b) Dynamic WebRTC ICE (STUN + TURN) Config API for Voice Chat
  if (urlPath === '/api/ice-config' && method === 'GET') {
    const cfg = await resolveIceServers();
    return sendJSON(res, 200, cfg);
  }

  // 2) Live Public Tables API (for Online Browser & Matchmaking)
  if (urlPath === '/api/rooms' && method === 'GET') {
    return sendJSON(res, 200, {
      rooms: getPublicRoomsList(),
      onlinePlayers: wss.getUniqueOnlineCount()
    });
  }

  // 3) Global Persistent Leaderboard API
  if (urlPath === '/api/leaderboard' && method === 'GET') {
    return sendJSON(res, 200, {
      totalHandsPlayed: statsStorage.data.totalHandsPlayed,
      leaderboard: statsStorage.getLeaderboard(25)
    });
  }

  // 3b) Player Profile, XP, Casino Tier & Achievements API
  if (urlPath.startsWith('/api/profile/') && method === 'GET') {
    const playerName = decodeURIComponent(urlPath.replace('/api/profile/', '').trim());
    return sendJSON(res, 200, {
      profile: statsStorage.getProfile(playerName)
    });
  }

  // 4) Room Hand History API
  if (urlPath.startsWith('/api/history/') && method === 'GET') {
    const roomId = urlPath.replace('/api/history/', '').trim().toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      return sendJSON(res, 404, { error: 'Room not found' });
    }
    return sendJSON(res, 200, {
      roomId,
      handHistory: room.game.handHistory
    });
  }

  // 5) Cryptographic Provably-Fair Shuffle Verification API
  if (urlPath === '/api/verify-shuffle' && method === 'POST') {
    try {
      const { deckOrder, salt, commitmentHash } = await readJsonBody(req);
      if (!Array.isArray(deckOrder) || deckOrder.length !== 52 || !salt || !commitmentHash) {
        return sendJSON(res, 400, { verified: false, error: 'Missing deckOrder (52 cards), salt, or commitmentHash' });
      }
      const uniqueCards = new Set(deckOrder);
      const computedHash = crypto
        .createHash('sha256')
        .update(`${deckOrder.join(',')}|${salt}`)
        .digest('hex');

      const verified = uniqueCards.size === 52 && computedHash === commitmentHash;
      return sendJSON(res, 200, {
        verified,
        uniqueCardCount: uniqueCards.size,
        computedHash,
        commitmentHash
      });
    } catch (err) {
      return sendJSON(res, 400, { verified: false, error: err.message });
    }
  }

  // Static files from public/
  const safeRelPath = path
    .normalize(urlPath === '/' ? '/index.html' : urlPath)
    .replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safeRelPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    let cached = staticAssetCache.get(filePath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      const raw = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const gz = zlib.gzipSync(raw, { level: 6 });
      cached = { mtimeMs: stat.mtimeMs, raw, gz, mime };
      staticAssetCache.set(filePath, cached);
    }

    const acceptsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip) {
      res.writeHead(200, {
        'Content-Type': cached.mime,
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'Cache-Control': 'no-cache'
      });
      res.end(cached.gz);
    } else {
      res.writeHead(200, {
        'Content-Type': cached.mime,
        'Cache-Control': 'no-cache'
      });
      res.end(cached.raw);
    }
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// ================= WEBSOCKET SERVER =================
const wss = new WSServer(httpServer);

const ALLOWED_AVATARS = new Set(['😎', '🦊', '🦁', '🦅', '👑', '🐉', '🎩', '💎', '♠️', '♥️', '♦️', '♣️']);
function sanitizeAvatar(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return ALLOWED_AVATARS.has(trimmed) ? trimmed : null;
}

function createNewRoomForClient(client, opts) {
  leaveCurrentRoom(client);

  const maxPlayers = Math.min(8, Math.max(2, Number(opts.maxPlayers) || 4));
  const startingCoins = Math.max(10, Math.min(100000, Number(opts.startingCoins) || 100));
  const playerName = (opts.playerName || 'Player 1').trim().slice(0, 18) || 'Player 1';
  const fillWithBots = Boolean(opts.fillWithBots);
  const useBlinds = Boolean(opts.useBlinds);
  const isPublic = opts.isPublic !== false;

  const roomId = generateRoomCode();
  const playerId = client.id;
  const game = new PokerGame(roomId, {
    maxPlayers,
    startingCoins,
    useBlinds,
    isPublic,
    turnDurationMs: 30000,
    onHandComplete: (players, winners) => statsStorage.recordHand(players, winners)
  });
  const playerAvatar = sanitizeAvatar(opts.avatar);
  game.addPlayer({ id: playerId, name: playerName, isBot: false, avatar: playerAvatar });

  const room = {
    game,
    hostId: playerId,
    clients: new Map([[playerId, client]]),
    spectators: new Map(), // clientId -> { ws, name }
    voicePeers: new Map(), // playerId -> { muted: boolean }
    botTimer: null,
    turnTimer: null,
    runoutTimer: null
  };
  rooms.set(roomId, room);
  socketSessionMap.set(client.id, { roomId, playerId });

  if (fillWithBots) {
    while (game.players.length < game.maxPlayers) {
      const botId = `bot_${crypto.randomBytes(4).toString('hex')}`;
      const botName = pickBotName(game.players.map((p) => p.name));
      game.addPlayer({ id: botId, name: botName, isBot: true });
    }
    game.startHand({ animatedRunout: true });
    broadcastEvent(room, { type: 'action_sfx', action: 'deal' });
  }

  broadcastRoomState(room);
  client.sendJSON({ type: 'voice_state', peers: serializeVoicePeers(room) });
  scheduleNextStep(room);
  return room;
}

function serializeVoicePeers(room) {
  if (!room || !room.voicePeers) return [];
  const list = [];
  for (const [id, info] of room.voicePeers.entries()) {
    list.push({ id, muted: Boolean(info.muted) });
  }
  return list;
}

wss.on('connection', (client) => {
  client.sendJSON({ type: 'connected', clientId: client.id });

  client.on('message', (msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (isRateLimited(client.id, msg.type)) {
      client.sendJSON({ type: 'error', message: 'Too many requests. Please slow down.' });
      return;
    }

    switch (msg.type) {
      case 'hb':
        break;

      case 'ping_latency': {
        client.sendJSON({ type: 'pong_latency', ts: Number(msg.ts) || Date.now() });
        break;
      }

      case 'create_room': {
        createNewRoomForClient(client, msg);
        break;
      }

      case 'quick_match': {
        // Smart Matchmaking: find an open public table with matching coins first, else any open public table, else create one!
        const preferredCoins = Math.max(10, Number(msg.startingCoins) || 100);
        const preferredPlayers = Math.min(8, Math.max(2, Number(msg.maxPlayers) || 4));
        const playerName = (msg.playerName || 'Player').trim().slice(0, 18) || 'Player';
        const playerAvatar = sanitizeAvatar(msg.avatar);

        let matchedRoom = null;
        for (const room of rooms.values()) {
          const g = room.game;
          if (g.isPublic && g.phase === PHASES.LOBBY && g.players.length < g.maxPlayers) {
            if (g.startingCoins === preferredCoins) {
              matchedRoom = room;
              break;
            }
            if (!matchedRoom) matchedRoom = room;
          }
        }

        if (matchedRoom) {
          leaveCurrentRoom(client);
          const playerId = client.id;
          const res = matchedRoom.game.addPlayer({ id: playerId, name: playerName, isBot: false, avatar: playerAvatar });
          if (!res.error) {
            matchedRoom.clients.set(playerId, client);
            socketSessionMap.set(client.id, { roomId: matchedRoom.game.roomId, playerId });
            matchedRoom.game.addLog(`⚡ ${playerName} joined via Quick Match!`);
            // Auto-start if table is now full!
            if (matchedRoom.game.players.length >= matchedRoom.game.maxPlayers) {
              matchedRoom.game.startHand({ animatedRunout: true });
              broadcastEvent(matchedRoom, { type: 'action_sfx', action: 'deal' });
            }
            broadcastRoomState(matchedRoom);
            client.sendJSON({ type: 'voice_state', peers: serializeVoicePeers(matchedRoom) });
            scheduleNextStep(matchedRoom);
            break;
          }
        }

        // No open public room found -> create a new Public Matchmaking room
        createNewRoomForClient(client, {
          playerName,
          avatar: playerAvatar,
          maxPlayers: preferredPlayers,
          startingCoins: preferredCoins,
          useBlinds: Boolean(msg.useBlinds),
          isPublic: true,
          fillWithBots: false
        });
        break;
      }

      case 'spectate_room': {
        const roomId = String(msg.roomId || '').trim().toUpperCase();
        const viewerName = (msg.playerName || 'Spectator').trim().slice(0, 18) || 'Spectator';
        const room = rooms.get(roomId);
        if (!room) {
          client.sendJSON({ type: 'error', message: `Room "${roomId}" not found.` });
          return;
        }
        leaveCurrentRoom(client);
        if (!room.spectators) room.spectators = new Map();
        room.spectators.set(client.id, { ws: client, name: viewerName });
        socketSessionMap.set(client.id, { roomId, playerId: client.id, isSpectator: true });
        room.game.addLog(`👁️ ${viewerName} is watching the table.`);
        broadcastRoomState(room);
        client.sendJSON({ type: 'voice_state', peers: serializeVoicePeers(room) });
        break;
      }

      case 'join_room': {
        const roomId = String(msg.roomId || '').trim().toUpperCase();
        const playerName = (msg.playerName || 'Player').trim().slice(0, 18) || 'Player';
        const playerAvatar = sanitizeAvatar(msg.avatar);
        const room = rooms.get(roomId);

        if (!room) {
          client.sendJSON({ type: 'error', message: `Room "${roomId}" not found.` });
          return;
        }

        leaveCurrentRoom(client);
        const playerId = client.id;
        const result = room.game.addPlayer({ id: playerId, name: playerName, isBot: false, avatar: playerAvatar });
        if (result.error) {
          // If game already started or full, automatically let them watch as a live Spectator!
          if (room.game.phase !== PHASES.LOBBY) {
            if (!room.spectators) room.spectators = new Map();
            room.spectators.set(client.id, { ws: client, name: playerName });
            socketSessionMap.set(client.id, { roomId, playerId: client.id, isSpectator: true });
            room.game.addLog(`👁️ ${playerName} joined as a live spectator.`);
            broadcastRoomState(room);
            client.sendJSON({ type: 'voice_state', peers: serializeVoicePeers(room) });
            break;
          }
          client.sendJSON({ type: 'error', message: result.error });
          return;
        }

        room.clients.set(playerId, client);
        socketSessionMap.set(client.id, { roomId, playerId });
        broadcastRoomState(room);
        client.sendJSON({ type: 'voice_state', peers: serializeVoicePeers(room) });
        break;
      }

      case 'update_starting_coins': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.room.hostId !== ctx.playerId) {
          client.sendJSON({ type: 'error', message: 'Only the table host can change starting coins.' });
          return;
        }
        if (ctx.room.game.phase !== PHASES.LOBBY) {
          client.sendJSON({ type: 'error', message: 'Starting coins can only be changed before the game starts.' });
          return;
        }
        const nextCoins = Math.floor(Number(msg.startingCoins));
        if (!Number.isFinite(nextCoins) || nextCoins < 10 || nextCoins > 100000) {
          client.sendJSON({ type: 'error', message: 'Please enter starting coins between 10 and 100,000.' });
          return;
        }
        ctx.room.game.startingCoins = nextCoins;
        ctx.room.game.players.forEach((p) => {
          p.coins = nextCoins;
          p.totalBuyIn = nextCoins;
        });
        ctx.room.game.addLog(`🪙 Host set starting coins to ${nextCoins} 🪙.`);
        broadcastRoomState(ctx.room);
        break;
      }

      case 'add_bot': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.room.hostId !== ctx.playerId) {
          client.sendJSON({ type: 'error', message: 'Only the table host can add AI bots.' });
          return;
        }
        const botId = `bot_${crypto.randomBytes(4).toString('hex')}`;
        const botName = pickBotName(ctx.room.game.players.map((p) => p.name));
        const res = ctx.room.game.addPlayer({ id: botId, name: botName, isBot: true });
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        broadcastRoomState(ctx.room);
        break;
      }

      case 'remove_bot': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.room.hostId !== ctx.playerId) return;
        const bot = [...ctx.room.game.players].reverse().find((p) => p.isBot);
        if (bot) {
          ctx.room.game.removePlayer(bot.id);
          broadcastRoomState(ctx.room);
        }
        break;
      }

      case 'start_game': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.room.hostId !== ctx.playerId) {
          client.sendJSON({ type: 'error', message: 'Only the host can start the game.' });
          return;
        }
        if (!ctx.room.game.canStartGame()) {
          client.sendJSON({ type: 'error', message: 'Need at least 2 players to start.' });
          return;
        }
        ctx.room.game.startHand({ animatedRunout: true });
        broadcastEvent(ctx.room, { type: 'action_sfx', action: 'deal' });
        broadcastRoomState(ctx.room);
        scheduleNextStep(ctx.room);
        break;
      }

      case 'player_action': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        const { action, amount } = msg;
        const res = ctx.room.game.handleAction(ctx.playerId, action, amount, {
          animatedRunout: true
        });
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        const actor = ctx.room.game.players.find((p) => p.id === ctx.playerId);
        broadcastEvent(ctx.room, {
          type: 'action_sfx',
          action,
          playerId: ctx.playerId,
          playerName: actor ? actor.name : '',
          spokenText: res.spokenText || action
        });
        broadcastRoomState(ctx.room);
        scheduleNextStep(ctx.room);
        break;
      }

      case 'rebuy': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        const res = ctx.room.game.rebuyPlayer(ctx.playerId);
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        broadcastEvent(ctx.room, { type: 'action_sfx', action: 'call' });
        broadcastRoomState(ctx.room);
        break;
      }

      case 'next_hand': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.isSpectator) return;
        if (ctx.room.game.phase !== PHASES.SHOWDOWN) return;
        ctx.room.game.startHand({ animatedRunout: true });
        broadcastEvent(ctx.room, { type: 'action_sfx', action: 'deal' });
        broadcastRoomState(ctx.room);
        scheduleNextStep(ctx.room);
        break;
      }

      case 'restart_game': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.isSpectator || ctx.room.hostId !== ctx.playerId) return;
        clearRoomTimers(ctx.room);
        // Purge disconnected human players so ghost seats don't stall the rematch
        ctx.room.game.players = ctx.room.game.players.filter((p) => p.isBot || p.connected);
        ctx.room.game.players.forEach((p, i) => {
          p.seat = i;
          p.coins = ctx.room.game.startingCoins;
          p.totalBuyIn = ctx.room.game.startingCoins;
          p.loanGiven = 0;
          p.loanTaken = 0;
          p.eliminated = false;
          p.folded = false;
          p.allIn = false;
          p.winStreak = 0;
          p.holeCards = [];
          p.roundBet = 0;
          p.totalHandBet = 0;
          p.lastAction = '';
          p.stats = { handsPlayed: 0, handsWon: 0, biggestPot: 0 };
        });
        ctx.room.game.loanRequests = [];
        ctx.room.game.loanLedger = [];
        ctx.room.game.endGameVote = null;
        ctx.room.game.finalSettlement = null;
        ctx.room.game.handNumber = 0;
        ctx.room.game.champion = null;
        ctx.room.game.dealerIndex = -1;
        ctx.room.game.phase = PHASES.LOBBY;
        if (ctx.room.game.players.length >= 2) {
          ctx.room.game.startHand({ animatedRunout: true });
          broadcastEvent(ctx.room, { type: 'action_sfx', action: 'deal' });
        }
        broadcastRoomState(ctx.room);
        scheduleNextStep(ctx.room);
        break;
      }

      case 'emote': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Table session expired (server restarted). Returning to lobby.' });
          return;
        }
        if (ctx.isSpectator) return;
        const text = String(msg.text || '').trim().slice(0, 24);
        if (!text) return;
        broadcastEvent(ctx.room, {
          type: 'player_emote',
          playerId: ctx.playerId,
          text
        });

        // Playful AI bot reaction reply (60% chance) when playing with bots
        const activeBots = ctx.room.game.players.filter((p) => p.isBot && !p.eliminated);
        if (activeBots.length > 0 && crypto.randomInt(0, 100) < 60) {
          const responder = activeBots[crypto.randomInt(0, activeBots.length)];
          const replies = ['😎 Bring it!', '🔥 Let\'s play!', '😂 Haha GG', '👏 Nice!', '🤔 Hmm...'];
          const replyText = replies[crypto.randomInt(0, replies.length)];
          const roomIdSnap = ctx.roomId;
          setTimeout(() => {
            const liveRoom = rooms.get(roomIdSnap);
            if (!liveRoom) return;
            broadcastEvent(liveRoom, {
              type: 'player_emote',
              playerId: responder.id,
              text: replyText
            });
          }, 750 + crypto.randomInt(0, 450));
        }
        break;
      }

      case 'chat': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Table session expired (server restarted). Returning to lobby.' });
          return;
        }
        const text = String(msg.text || '').trim().slice(0, 140);
        if (!text) return;
        let sender = ctx.room.game.players.find((p) => p.id === ctx.playerId);
        if (!sender && ctx.isSpectator && ctx.room.spectators) {
          const spec = ctx.room.spectators.get(ctx.playerId);
          if (spec) sender = { name: `${spec.name} (Spectator)`, avatar: '👁️' };
        }
        if (!sender) return;
        const timeStr = new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit'
        });
        broadcastEvent(ctx.room, {
          type: 'chat_message',
          sender: sender.name,
          avatar: sender.avatar,
          text,
          time: timeStr
        });

        // Friendly AI bot reply when chatting in a bot table
        const bots = ctx.room.game.players.filter((p) => p.isBot && !p.eliminated);
        if (bots.length > 0 && ctx.room.clients.size === 1) {
          const bot = bots[crypto.randomInt(0, bots.length)];
          const lower = text.toLowerCase();
          let reply = 'Good luck at the table! ♠️';
          if (/\b(hi|hello|hey|salam|assalamu)\b/.test(lower)) reply = `Hey ${sender.name}! Ready to play? 😊`;
          else if (/\b(bluff|lie|fake)\b/.test(lower)) reply = 'Haha, you never know! 😎';
          else if (/\b(gg|nice|good|well)\b/.test(lower)) reply = 'Nice hand! Let\'s keep going 🔥';
          else if (/\b(all in|allin|raise)\b/.test(lower)) reply = 'Bold move! Let\'s see those cards 👀';

          const roomIdSnap = ctx.roomId;
          setTimeout(() => {
            const liveRoom = rooms.get(roomIdSnap);
            if (!liveRoom) return;
            broadcastEvent(liveRoom, {
              type: 'chat_message',
              sender: bot.name,
              avatar: bot.avatar,
              text: reply,
              time: new Date().toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit'
              })
            });
          }, 900 + crypto.randomInt(0, 500));
        }
        break;
      }

      case 'voice_join': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        const { room, playerId } = ctx;
        if (!room.voicePeers) room.voicePeers = new Map();
        const existingPeers = [...room.voicePeers.keys()].filter((id) => id !== playerId);
        room.voicePeers.set(playerId, { muted: false });

        // Tell joining client who is already in voice chat so it creates WebRTC offers to them
        client.sendJSON({ type: 'voice_joined', peers: existingPeers });

        const player = room.game.players.find((p) => p.id === playerId);
        const spec = room.spectators ? room.spectators.get(playerId) : null;
        const joinerName = player ? player.name : spec ? `${spec.name} (Spectator)` : 'Player';
        const peersPayload = serializeVoicePeers(room);
        broadcastEvent(room, { type: 'voice_state', peers: peersPayload });
        for (const [cid, ws] of room.clients.entries()) {
          if (cid !== playerId) {
            ws.sendJSON({ type: 'voice_user_joined', playerId, name: joinerName });
          }
        }
        if (room.spectators) {
          for (const [sid, s] of room.spectators.entries()) {
            if (sid !== playerId) {
              s.ws.sendJSON({ type: 'voice_user_joined', playerId, name: joinerName });
            }
          }
        }
        break;
      }

      case 'voice_leave': {
        const ctx = getSessionContext(client.id);
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (room.voicePeers && room.voicePeers.delete(playerId)) {
          broadcastEvent(room, { type: 'voice_user_left', playerId });
          broadcastEvent(room, { type: 'voice_state', peers: serializeVoicePeers(room) });
        }
        break;
      }

      case 'voice_mute': {
        const ctx = getSessionContext(client.id);
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (room.voicePeers && room.voicePeers.has(playerId)) {
          room.voicePeers.set(playerId, { muted: Boolean(msg.muted) });
          broadcastEvent(room, { type: 'voice_state', peers: serializeVoicePeers(room) });
        }
        break;
      }

      case 'voice_signal': {
        const ctx = getSessionContext(client.id);
        if (!ctx) return;
        const { room, playerId } = ctx;
        const targetId = String(msg.targetId || '');
        if (!targetId || targetId === playerId || !msg.data) return;
        const targetWs =
          room.clients.get(targetId) ||
          (room.spectators && room.spectators.get(targetId)?.ws);
        if (targetWs) {
          targetWs.sendJSON({
            type: 'voice_signal',
            fromId: playerId,
            data: msg.data
          });
        }
        break;
      }

      case 'loan_request': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.isSpectator) return;
        const res = ctx.room.game.createLoanRequest(ctx.playerId, msg.lenderId, msg.amount, msg.note);
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        broadcastEvent(ctx.room, {
          type: 'loan_notify',
          message: `🤝 ${res.request.requesterName} asked ${res.request.lenderName} for ${res.request.requestedAmount} 🪙 loan!`
        });
        broadcastRoomState(ctx.room);

        // If lender is an AI Bot, auto-respond with Accept or realistic Counter-Offer negotiation!
        const lender = ctx.room.game.players.find((p) => p.id === res.request.lenderId);
        if (lender && lender.isBot) {
          const roomIdSnap = ctx.roomId;
          const reqIdSnap = res.request.id;
          setTimeout(() => {
            const liveRoom = rooms.get(roomIdSnap);
            if (!liveRoom) return;
            const liveLender = liveRoom.game.players.find((p) => p.id === lender.id);
            if (!liveLender) return;
            const reqAmt = res.request.requestedAmount;
            let botRes;
            if (reqAmt <= Math.max(5, Math.floor(liveLender.coins * 0.25))) {
              botRes = liveRoom.game.respondLoanRequest(liveLender.id, reqIdSnap, 'accept');
              if (botRes.ok) {
                broadcastEvent(liveRoom, { type: 'action_sfx', action: 'call' });
                broadcastEvent(liveRoom, {
                  type: 'loan_notify',
                  message: `✅ ${liveLender.name} accepted & lent ${reqAmt} 🪙!`
                });
              }
            } else {
              const counterAmt = Math.max(1, Math.min(liveLender.coins, Math.floor(reqAmt * 0.65)));
              botRes = liveRoom.game.respondLoanRequest(liveLender.id, reqIdSnap, 'counter', counterAmt);
              if (botRes.ok) {
                broadcastEvent(liveRoom, {
                  type: 'loan_notify',
                  message: `💬 ${liveLender.name} counter-offered ${counterAmt} 🪙 instead of ${reqAmt} 🪙!`
                });
              }
            }
            broadcastRoomState(liveRoom);
          }, 1100);
        }
        break;
      }

      case 'loan_respond': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.isSpectator) return;
        const res = ctx.room.game.respondLoanRequest(
          ctx.playerId,
          String(msg.requestId || ''),
          String(msg.decision || ''),
          msg.counterAmount
        );
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        if (res.status === 'ACCEPTED') {
          broadcastEvent(ctx.room, { type: 'action_sfx', action: 'call' });
          broadcastEvent(ctx.room, {
            type: 'loan_notify',
            message: `✅ Loan Deal! ${res.ledgerEntry.fromName} lent ${res.ledgerEntry.amount} 🪙 to ${res.ledgerEntry.toName}.`
          });
        } else if (res.status === 'COUNTER_OFFERED' || res.status === 'PENDING_LENDER') {
          broadcastEvent(ctx.room, {
            type: 'loan_notify',
            message: `💬 Negotiation updated: new offer ${res.request.currentOfferAmount} 🪙!`
          });
          // If player countered back to an AI Bot lender, bot decides!
          const lender = ctx.room.game.players.find((p) => p.id === res.request.lenderId);
          if (res.status === 'PENDING_LENDER' && lender && lender.isBot) {
            const roomIdSnap = ctx.roomId;
            const reqIdSnap = res.request.id;
            setTimeout(() => {
              const liveRoom = rooms.get(roomIdSnap);
              if (!liveRoom) return;
              const liveLender = liveRoom.game.players.find((p) => p.id === lender.id);
              if (!liveLender) return;
              const okToLend = res.request.currentOfferAmount <= Math.max(10, Math.floor(liveLender.coins * 0.5));
              const botRes = liveRoom.game.respondLoanRequest(
                liveLender.id,
                reqIdSnap,
                okToLend ? 'accept' : 'reject'
              );
              if (botRes.ok) {
                if (okToLend) broadcastEvent(liveRoom, { type: 'action_sfx', action: 'call' });
                broadcastEvent(liveRoom, {
                  type: 'loan_notify',
                  message: okToLend
                    ? `✅ ${liveLender.name} accepted your negotiated offer of ${res.request.currentOfferAmount} 🪙!`
                    : `❌ ${liveLender.name} declined the negotiated offer.`
                });
                broadcastRoomState(liveRoom);
              }
            }, 950);
          }
        } else if (res.status === 'REJECTED') {
          broadcastEvent(ctx.room, {
            type: 'loan_notify',
            message: `❌ Loan request declined.`
          });
        }
        broadcastRoomState(ctx.room);
        break;
      }

      case 'end_game_request': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.isSpectator) return;
        const res = ctx.room.game.initiateEndGameVote(ctx.playerId);
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        if (res.ended) {
          clearRoomTimers(ctx.room);
        }
        broadcastRoomState(ctx.room);
        break;
      }

      case 'end_game_vote': {
        const ctx = getSessionContext(client.id);
        if (!ctx) {
          client.sendJSON({ type: 'session_expired', message: 'Session refreshed. Please join or create a table.' });
          return;
        }
        if (ctx.isSpectator) return;
        const res = ctx.room.game.castEndGameVote(ctx.playerId, Boolean(msg.accept));
        if (res.error) {
          client.sendJSON({ type: 'error', message: res.error });
          return;
        }
        if (res.ended) {
          clearRoomTimers(ctx.room);
        } else if (res.cancelled) {
          broadcastEvent(ctx.room, {
            type: 'loan_notify',
            message: `🎲 ${res.byName} wants to keep playing — End Game cancelled.`
          });
        }
        broadcastRoomState(ctx.room);
        break;
      }

      case 'leave_room': {
        leaveCurrentRoom(client);
        client.sendJSON({ type: 'left_room' });
        break;
      }

      default:
        break;
    }
  });

  client.on('close', () => {
    rateLimitMap.delete(client.id);
    leaveCurrentRoom(client);
  });
});

function getSessionContext(socketId) {
  const session = socketSessionMap.get(socketId);
  if (!session) return null;
  const room = rooms.get(session.roomId);
  if (!room) return null;
  return { room, roomId: session.roomId, playerId: session.playerId, isSpectator: Boolean(session.isSpectator) };
}

function leaveCurrentRoom(client) {
  const session = socketSessionMap.get(client.id);
  if (!session) return;
  socketSessionMap.delete(client.id);

  const { roomId, playerId, isSpectator } = session;
  const room = rooms.get(roomId);
  if (!room) return;

  const wasInVoice = room.voicePeers && room.voicePeers.delete(playerId);

  if (isSpectator) {
    if (room.spectators) room.spectators.delete(playerId);
    if (wasInVoice) {
      broadcastEvent(room, { type: 'voice_user_left', playerId });
      broadcastEvent(room, { type: 'voice_state', peers: serializeVoicePeers(room) });
    }
    broadcastRoomState(room);
    return;
  }
  room.clients.delete(playerId);
  room.game.removePlayer(playerId);

  if (room.hostId === playerId) {
    const nextHuman = [...room.clients.keys()][0];
    room.hostId = nextHuman || null;
  }

  if (room.clients.size === 0) {
    cleanupRoomIfEmpty(roomId);
  } else {
    if (wasInVoice) {
      broadcastEvent(room, { type: 'voice_user_left', playerId });
      broadcastEvent(room, { type: 'voice_state', peers: serializeVoicePeers(room) });
    }
    broadcastRoomState(room);
    scheduleNextStep(room);
  }
}

const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  console.log(`\n♠️ ♥️  POOKER Enterprise Server running at http://localhost:${PORT}  ♦️ ♣️`);
  console.log(`🔒 CSPRNG Cryptographic Shuffle + SHA-256 Verify API: ACTIVE`);
  console.log(`💾 Stats Persistence Mode: ${statsStorage.persistenceMode.toUpperCase()}`);
  console.log(`🎙️  WebRTC Voice Chat Signaling + ICE/TURN API: ACTIVE\n`);
});

async function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Saving stats and shutting down cleanly...`);
  try {
    await statsStorage.flushNow();
  } catch (_) {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('[Non-fatal unhandledRejection]', err && err.message ? err.message : err);
});
