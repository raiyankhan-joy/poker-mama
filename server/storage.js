'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function computeTierAndLevel(xp) {
  const safeXp = Math.max(0, Number(xp) || 0);
  const level = Math.floor(safeXp / 120) + 1;
  const nextLevelXp = level * 120;
  const currentLevelXp = safeXp - (level - 1) * 120;
  const progressPct = Math.min(100, Math.round((currentLevelXp / 120) * 100));

  let tier = { name: 'Bronze', icon: '🥉', color: '#cd7f32' };
  if (level >= 15) tier = { name: 'Royal VIP', icon: '👑', color: '#f5c542' };
  else if (level >= 10) tier = { name: 'Platinum', icon: '💎', color: '#38bdf8' };
  else if (level >= 6) tier = { name: 'Gold', icon: '🥇', color: '#fbbf24' };
  else if (level >= 3) tier = { name: 'Silver', icon: '🥈', color: '#cbd5e1' };

  return { level, xp: safeXp, nextLevelXp, progressPct, tier };
}

class StatsStorage {
  constructor() {
    this.data = {
      totalHandsPlayed: 0,
      players: {}
    };
    this._saveTimer = null;
    this.persistenceMode = UPSTASH_URL && UPSTASH_TOKEN
      ? 'upstash-redis'
      : SUPABASE_URL && SUPABASE_KEY
      ? 'supabase'
      : process.env.DATA_DIR
      ? 'persistent-disk'
      : 'local-file';

    this._loadLocal();
    this._loadCloud();
  }

  _mergeStats(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    this.data.totalHandsPlayed = Math.max(
      this.data.totalHandsPlayed,
      Number(parsed.totalHandsPlayed) || 0
    );
    const incoming = parsed.players || {};
    for (const [key, rec] of Object.entries(incoming)) {
      const existing = this.data.players[key];
      if (!existing || (rec.xp || 0) > (existing.xp || 0) || (rec.handsPlayed || 0) > (existing.handsPlayed || 0)) {
        this.data.players[key] = rec;
      }
    }
  }

  _loadLocal() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf8');
        this._mergeStats(JSON.parse(raw));
      }
    } catch (_) {
      // Start fresh if file is corrupted
    }
  }

  async _loadCloud() {
    try {
      if (this.persistenceMode === 'upstash-redis') {
        const resp = await fetch(`${UPSTASH_URL}/get/pooker:stats`, {
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        if (!resp.ok) return;
        const json = await resp.json();
        if (json && json.result) {
          const parsed = typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
          this._mergeStats(parsed);
        }
      } else if (this.persistenceMode === 'supabase') {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/pooker_state?id=eq.global_stats&select=payload`, {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`
          }
        });
        if (!resp.ok) return;
        const rows = await resp.json();
        if (Array.isArray(rows) && rows[0] && rows[0].payload) {
          this._mergeStats(rows[0].payload);
        }
      }
    } catch (_) {
      // Fallback gracefully to local file if cloud is unreachable
    }
  }

  async flushNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    const serialized = JSON.stringify(this.data, null, 2);
    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const tmpFile = `${STATS_FILE}.tmp`;
      await fs.promises.writeFile(tmpFile, serialized, 'utf8');
      await fs.promises.rename(tmpFile, STATS_FILE);
    } catch (_) {
      // Non-fatal local disk error
    }

    try {
      if (this.persistenceMode === 'upstash-redis') {
        await fetch(`${UPSTASH_URL}/set/pooker:stats`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(this.data)
        });
      } else if (this.persistenceMode === 'supabase') {
        await fetch(`${SUPABASE_URL}/rest/v1/pooker_state`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify({ id: 'global_stats', payload: this.data })
        });
      }
    } catch (_) {
      // Non-fatal cloud sync error
    }
  }

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushNow();
    }, 600);
  }

  _ensureAchievement(rec, id, label) {
    if (!Array.isArray(rec.achievements)) rec.achievements = [];
    if (!rec.achievements.some((a) => a.id === id)) {
      rec.achievements.push({ id, label });
    }
  }

  /**
   * Records a completed hand's outcome, XP, streaks, and achievements for human players.
   */
  recordHand(players, winners) {
    this.data.totalHandsPlayed += 1;
    const winnerMap = new Map();
    for (const w of winners || []) {
      winnerMap.set(w.playerId, w);
    }

    const now = new Date().toISOString();
    for (const p of players) {
      if (p.eliminated || p.isBot) continue;
      const key = p.name.trim().toLowerCase();
      if (!key) continue;

      if (!this.data.players[key]) {
        this.data.players[key] = {
          name: p.name,
          handsPlayed: 0,
          handsWon: 0,
          biggestPot: 0,
          totalWon: 0,
          xp: 0,
          currentStreak: 0,
          bestStreak: 0,
          achievements: [],
          lastPlayed: now
        };
      }

      const rec = this.data.players[key];
      rec.name = p.name;
      rec.handsPlayed += 1;
      rec.xp = (rec.xp || 0) + 10; // Base XP for playing a hand
      rec.lastPlayed = now;

      const winObj = winnerMap.get(p.id);
      if (winObj && winObj.amount > 0) {
        rec.handsWon += 1;
        rec.totalWon += winObj.amount;
        rec.biggestPot = Math.max(rec.biggestPot, winObj.amount);
        rec.currentStreak = (rec.currentStreak || 0) + 1;
        rec.bestStreak = Math.max(rec.bestStreak || 0, rec.currentStreak);
        rec.xp += 35;

        // Bonus XP & Achievements
        this._ensureAchievement(rec, 'first_win', '🎯 First Victory');
        if (rec.currentStreak >= 3) {
          this._ensureAchievement(rec, 'hot_streak', '🔥 3-Win Hot Streak');
          rec.xp += 25;
        }
        if (winObj.amount >= 50) {
          this._ensureAchievement(rec, 'high_roller', '💰 High Roller (50+ Pot)');
          rec.xp += 20;
        }
        const hn = (winObj.handName || '').toLowerCase();
        if (hn.includes('straight') || hn.includes('flush')) {
          this._ensureAchievement(rec, 'straight_flush', '💎 Straight / Flush Master');
          rec.xp += 40;
        }
        if (hn.includes('full house') || hn.includes('four of a kind') || hn.includes('royal')) {
          this._ensureAchievement(rec, 'royal_club', '👑 Royal Club Monster');
          rec.xp += 100;
        }
      } else {
        rec.currentStreak = 0;
      }
    }

    this._save();
  }

  getProfile(name) {
    const key = String(name || '').trim().toLowerCase();
    const rec = this.data.players[key];
    if (!rec) {
      return {
        name: name || 'Player',
        handsPlayed: 0,
        handsWon: 0,
        winRate: 0,
        biggestPot: 0,
        totalWon: 0,
        bestStreak: 0,
        achievements: [],
        ...computeTierAndLevel(0)
      };
    }
    return {
      ...rec,
      winRate: rec.handsPlayed > 0 ? Math.round((rec.handsWon / rec.handsPlayed) * 100) : 0,
      ...computeTierAndLevel(rec.xp || 0)
    };
  }

  getLeaderboard(limit = 20) {
    return Object.values(this.data.players)
      .map((p) => ({
        ...p,
        winRate: p.handsPlayed > 0 ? Math.round((p.handsWon / p.handsPlayed) * 100) : 0,
        ...computeTierAndLevel(p.xp || 0)
      }))
      .sort((a, b) => {
        if (b.xp !== a.xp) return b.xp - a.xp;
        return b.totalWon - a.totalWon;
      })
      .slice(0, limit);
  }
}

module.exports = { StatsStorage, computeTierAndLevel };
