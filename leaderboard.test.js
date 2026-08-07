import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeaderboardStore } from "./leaderboard.js";

test("registra una partida una sola vez y conserva el rating total", () => {
  const board = new LeaderboardStore({ season: "test" });
  const players = [{ id: "a", name: "Alba" }, { id: "b", name: "Bruno" }, { id: "c", name: "Ciro" }];
  assert.equal(board.recordMatch({ matchId: "m1", players, winnerId: "a", abandonedIds: ["c"] }), true);
  assert.equal(board.recordMatch({ matchId: "m1", players, winnerId: "a" }), false);
  const snapshot = board.snapshot();
  assert.equal(snapshot.entries.length, 3);
  assert.equal(snapshot.entries[0].name, "Alba");
  assert.equal(snapshot.entries[0].wins, 1);
  assert.equal(snapshot.entries.find((entry) => entry.name === "Ciro").abandons, 1);
  assert.equal(snapshot.entries.reduce((sum, entry) => sum + entry.rating, 0), 3000);
});

test("rechaza nombres duplicados y limita la salida pública", () => {
  const board = new LeaderboardStore({ season: "test" });
  assert.equal(board.recordMatch({ matchId: "bad", players: [{ id: "a", name: "Nora" }, { id: "b", name: "nora" }], winnerId: "a" }), false);
  for (let index = 0; index < 5; index++) {
    board.recordMatch({ matchId: `m${index}`, players: [{ id: `a${index}`, name: `A${index}` }, { id: `b${index}`, name: `B${index}` }], winnerId: `a${index}` });
  }
  assert.equal(board.snapshot(3).entries.length, 3);
});

test("rechaza resultados incompletos o con identidades ambiguas", () => {
  const board = new LeaderboardStore({ season: "test" });
  assert.equal(board.recordMatch({ matchId: "sin-ganador", players: [{ id: "a", name: "A" }, { id: "b", name: "B" }], winnerId: "x" }), false);
  assert.equal(board.recordMatch({ matchId: "id-duplicado", players: [{ id: "a", name: "A" }, { id: "a", name: "B" }], winnerId: "a" }), false);
  assert.deepEqual(board.snapshot().entries, []);
});

test("persiste la temporada y la protección contra duplicados", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "holdem-leaderboard-"));
  const filePath = path.join(directory, "state", "leaderboard.json");
  try {
    const players = [{ id: "a", name: "Alba" }, { id: "b", name: "Bruno" }];
    const first = new LeaderboardStore({ season: "test", filePath });
    assert.equal(first.recordMatch({ matchId: "persistente", players, winnerId: "a" }), true);
    const restored = new LeaderboardStore({ season: "test", filePath });
    assert.equal(restored.snapshot().entries[0].name, "Alba");
    assert.equal(restored.recordMatch({ matchId: "persistente", players, winnerId: "a" }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
