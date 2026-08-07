import fs from "node:fs";
import path from "node:path";

const INITIAL_RATING = 1000;
const K_FACTOR = 32;

function identityKey(name) {
  return String(name || "JUGADOR").trim().toLocaleLowerCase("es");
}

function emptyEntry(name) {
  return { key: identityKey(name), name: String(name), rating: INITIAL_RATING, matches: 0, wins: 0, abandons: 0 };
}

export class LeaderboardStore {
  constructor(options = {}) {
    this.filePath = String(options.filePath || "").trim();
    this.season = String(options.season || "preseason-1");
    this.entries = new Map();
    this.recordedMatches = new Set();
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed.season !== this.season || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries) {
        if (!entry || typeof entry.name !== "string") continue;
        const normalized = {
          key: identityKey(entry.name), name: entry.name.slice(0, 18),
          rating: Number.isFinite(entry.rating) ? Math.round(entry.rating) : INITIAL_RATING,
          matches: Math.max(0, Number(entry.matches) || 0), wins: Math.max(0, Number(entry.wins) || 0),
          abandons: Math.max(0, Number(entry.abandons) || 0)
        };
        this.entries.set(normalized.key, normalized);
      }
      for (const id of parsed.recordedMatches || []) this.recordedMatches.add(String(id));
    } catch (error) {
      console.warn(`Leaderboard ignorado: ${error instanceof Error ? error.message : "archivo inválido"}`);
    }
  }

  persist() {
    if (!this.filePath) return;
    try {
      const payload = JSON.stringify({ season: this.season, entries: [...this.entries.values()], recordedMatches: [...this.recordedMatches] });
      fs.mkdirSync(path.dirname(path.resolve(this.filePath)), { recursive: true });
      fs.writeFileSync(this.filePath, payload, "utf8");
    } catch (error) {
      console.warn(`No se pudo persistir la clasificación: ${error instanceof Error ? error.message : "error desconocido"}`);
    }
  }

  recordMatch({ matchId, players, winnerId, abandonedIds = [] }) {
    const id = String(matchId || "");
    if (!id || this.recordedMatches.has(id)) return false;
    if (!Array.isArray(players) || players.length < 2) return false;
    if (!players.every((player) => player && String(player.id || "") !== "" && String(player.name || "").trim() !== "")) return false;
    if (new Set(players.map((player) => String(player.id))).size !== players.length) return false;
    if (!players.some((player) => String(player.id) === String(winnerId))) return false;
    const uniqueKeys = new Set(players.map((player) => identityKey(player.name)));
    if (uniqueKeys.size !== players.length) return false;
    const ratingsBefore = new Map();
    for (const player of players) {
      const key = identityKey(player.name);
      if (!this.entries.has(key)) this.entries.set(key, emptyEntry(player.name));
      ratingsBefore.set(player.id, this.entries.get(key).rating);
    }
    const deltas = new Map(players.map((player) => [player.id, 0]));
    for (let left = 0; left < players.length; left++) {
      for (let right = left + 1; right < players.length; right++) {
        const a = players[left];
        const b = players[right];
        const actualA = a.id === winnerId ? 1 : b.id === winnerId ? 0 : 0.5;
        const expectedA = 1 / (1 + 10 ** ((ratingsBefore.get(b.id) - ratingsBefore.get(a.id)) / 400));
        const change = K_FACTOR * (actualA - expectedA);
        deltas.set(a.id, deltas.get(a.id) + change);
        deltas.set(b.id, deltas.get(b.id) - change);
      }
    }
    const abandoned = new Set(abandonedIds.map(String));
    for (const player of players) {
      const entry = this.entries.get(identityKey(player.name));
      entry.name = player.name;
      entry.rating = Math.max(100, Math.round(entry.rating + deltas.get(player.id)));
      entry.matches += 1;
      if (player.id === winnerId) entry.wins += 1;
      if (abandoned.has(String(player.id))) entry.abandons += 1;
    }
    this.recordedMatches.add(id);
    this.persist();
    return true;
  }

  snapshot(limit = 50) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const sorted = [...this.entries.values()].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.matches - b.matches || a.name.localeCompare(b.name));
    return {
      season: this.season,
      mode: "preseason",
      updatedAt: new Date().toISOString(),
      entries: sorted.slice(0, safeLimit).map((entry, index) => ({
        rank: index + 1, name: entry.name, rating: entry.rating, matches: entry.matches, wins: entry.wins,
        winRate: entry.matches > 0 ? Math.round((entry.wins / entry.matches) * 1000) / 10 : 0,
        abandons: entry.abandons
      }))
    };
  }
}
