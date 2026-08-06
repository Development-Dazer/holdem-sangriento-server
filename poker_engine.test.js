import test from "node:test";
import assert from "node:assert/strict";
import { PokerEngine, evaluate, calculateSidePots } from "./poker_engine.js";

const players = (count = 4) => Array.from({ length: count }, (_, index) => ({
  id: `p${index}`, name: `Jugador ${index + 1}`, character: ["El Tramposo", "El Contador", "El Psicólogo", "El Médico"][index]
}));
const card = (rank, suit) => ({ rank, suit });

test("reparte 52 cartas únicas sin exponer cartas privadas", () => {
  const engine = new PokerEngine(players(), { randomInt: () => 0 });
  engine.startHand();
  const allCards = [...engine.deck, ...engine.players.flatMap((player) => player.cards)];
  assert.equal(allCards.length, 52);
  assert.equal(new Set(allCards.map((entry) => `${entry.rank}${entry.suit}`)).size, 52);
  assert.equal("cards" in engine.publicState().players[0], false);
  assert.equal(engine.privateState("p0").yourCards.length, 2);
  assert.equal(engine.privateState("p0").revealedCards, undefined);
});

test("rota dealer, ciegas y primer turno correctamente", () => {
  const engine = new PokerEngine(players(), { randomInt: () => 0 });
  engine.startHand();
  assert.deepEqual([engine.dealer, engine.smallBlindSeat, engine.bigBlindSeat, engine.turnSeat], [0, 1, 2, 3]);
  engine.players[3].folded = true;
  engine.players[0].folded = true;
  engine.finishByFold();
  engine.startHand();
  assert.deepEqual([engine.dealer, engine.smallBlindSeat, engine.bigBlindSeat], [1, 2, 3]);
});

test("heads-up usa dealer como ciega pequeña y primer actor preflop", () => {
  const engine = new PokerEngine(players(2), { randomInt: () => 0 });
  engine.startHand();
  assert.equal(engine.smallBlindSeat, engine.dealer);
  assert.equal(engine.bigBlindSeat, engine.nextLiving(engine.dealer));
  assert.equal(engine.turnSeat, engine.dealer);
});

test("un All-in corto no reabre el derecho a subir", () => {
  const engine = new PokerEngine(players(3), { randomInt: () => 0 });
  engine.startHand();
  engine.turnSeat = 0;
  engine.currentBet = 100;
  engine.minimumRaise = 100;
  engine.players[0].bet = 100;
  engine.players[1].bet = 100;
  engine.players[2].bet = 100;
  engine.players[1].chips = 50;
  engine.actedSinceFullRaise = new Set([0]);
  engine.actionQueue = [1, 2];
  engine.act("p0", "check");
  assert.equal(engine.turnSeat, 1);
  engine.act("p1", "all_in");
  assert.equal(engine.currentBet, 150);
  assert.equal(engine.turnSeat, 2);
  engine.act("p2", "call");
  assert.equal(engine.turnSeat, 0);
  assert.deepEqual(engine.legalActions(0).sort(), ["call", "fold"].sort());
});

test("rechaza acciones fuera de turno y cantidades ilegales", () => {
  const engine = new PokerEngine(players(), { randomInt: () => 0 });
  engine.startHand();
  assert.throws(() => engine.act("p0", "call"), /turno/);
  assert.throws(() => engine.act("p3", "raise", -1), /Cantidad/);
  assert.throws(() => engine.act("p3", "raise", engine.currentBet + 1), /mínima/);
});

test("evalúa categorías y escalera baja", () => {
  assert.equal(evaluate([card(10,"S"),card(11,"S"),card(12,"S"),card(13,"S"),card(14,"S")])[0], 8);
  assert.deepEqual(evaluate([card(14,"S"),card(2,"H"),card(3,"D"),card(4,"C"),card(5,"S")]), [4, 5]);
  assert.equal(evaluate([card(9,"S"),card(9,"H"),card(9,"D"),card(9,"C"),card(14,"S")])[0], 7);
});

test("distribuye correctamente pozo principal y lateral", () => {
  const engine = new PokerEngine(players(), { randomInt: () => 0 });
  engine.community = [card(2,"S"),card(4,"H"),card(6,"D"),card(8,"C"),card(10,"S")];
  engine.players[0].cards = [card(14,"H"),card(14,"D")];
  engine.players[1].cards = [card(13,"H"),card(13,"D")];
  engine.players[2].cards = [card(12,"H"),card(12,"D")];
  engine.players[3].cards = [card(11,"H"),card(11,"D")];
  [50, 100, 100, 100].forEach((amount, seat) => engine.players[seat].handBet = amount);
  engine.players[3].folded = true;
  const payouts = calculateSidePots(engine.players, [0, 1, 2], engine.community);
  assert.deepEqual(payouts, { 0: 200, 1: 150, 2: 0 });
});
