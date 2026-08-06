import crypto from "node:crypto";

export const STARTING_CHIPS = 500;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;

export class PokerEngine {
  constructor(players, options = {}) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4) throw new Error("Se requieren entre 2 y 4 jugadores.");
    this.randomInt = options.randomInt || ((maximum) => crypto.randomInt(maximum));
    this.players = players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      character: player.character,
      seat,
      chips: STARTING_CHIPS + (player.character === "El Prestamista" ? 75 : 0),
      cards: [], bet: 0, handBet: 0, folded: false, allIn: false, eliminated: false,
      favor: 0, favorUsed: false, abilityUsed: false
    }));
    this.handNumber = 0;
    this.dealer = -1;
    this.smallBlindSeat = -1;
    this.bigBlindSeat = -1;
    this.street = "idle";
    this.community = [];
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minimumRaise = BIG_BLIND;
    this.turnSeat = -1;
    this.actionQueue = [];
    this.actedSinceFullRaise = new Set();
    this.lastAggressor = -1;
    this.handComplete = true;
    this.lastResult = null;
  }

  livingSeats() { return this.players.filter((p) => !p.eliminated).map((p) => p.seat); }
  activeSeats() { return this.players.filter((p) => !p.eliminated && !p.folded).map((p) => p.seat); }
  canAct(seat) { const p = this.players[seat]; return Boolean(p && !p.eliminated && !p.folded && !p.allIn && p.chips > 0); }
  nextLiving(from) {
    for (let offset = 1; offset <= this.players.length; offset++) {
      const seat = (from + offset + this.players.length) % this.players.length;
      if (!this.players[seat].eliminated) return seat;
    }
    return from;
  }

  orderedFrom(first, predicate = () => true) {
    const result = [];
    for (let offset = 0; offset < this.players.length; offset++) {
      const seat = (first + offset) % this.players.length;
      if (predicate(seat)) result.push(seat);
    }
    return result;
  }

  startHand() {
    if (this.livingSeats().length < 2) throw new Error("La partida ya tiene ganador.");
    this.handNumber += 1;
    this.dealer = this.nextLiving(this.dealer);
    this.street = "preflop";
    this.community = [];
    this.deck = this.buildDeck();
    this.shuffle(this.deck);
    this.pot = 0;
    this.currentBet = BIG_BLIND;
    this.minimumRaise = BIG_BLIND;
    this.actionQueue = [];
    this.actedSinceFullRaise.clear();
    this.lastAggressor = -1;
    this.handComplete = false;
    this.lastResult = null;
    for (const player of this.players) {
      player.cards = [];
      player.bet = 0;
      player.handBet = 0;
      player.folded = player.eliminated;
      player.allIn = false;
      player.favorUsed = false;
      player.abilityUsed = false;
    }
    const living = this.livingSeats();
    if (living.length === 2) {
      this.smallBlindSeat = this.dealer;
      this.bigBlindSeat = this.nextLiving(this.dealer);
    } else {
      this.smallBlindSeat = this.nextLiving(this.dealer);
      this.bigBlindSeat = this.nextLiving(this.smallBlindSeat);
    }
    this.dealPrivateCards();
    this.commit(this.smallBlindSeat, SMALL_BLIND);
    this.commit(this.bigBlindSeat, BIG_BLIND);
    const first = this.nextLiving(this.bigBlindSeat);
    this.actionQueue = this.orderedFrom(first, (seat) => this.canAct(seat));
    this.advanceQueue();
    return this.publicState();
  }

  buildDeck() {
    const deck = [];
    for (const suit of ["C", "D", "H", "S"]) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
    return deck;
  }

  shuffle(deck) {
    for (let index = deck.length - 1; index > 0; index--) {
      const other = this.randomInt(index + 1);
      [deck[index], deck[other]] = [deck[other], deck[index]];
    }
  }

  draw() { const card = this.deck.pop(); if (!card) throw new Error("Mazo agotado."); return card; }
  burn() { this.draw(); }
  dealPrivateCards() {
    const first = this.nextLiving(this.dealer);
    for (let pass = 0; pass < 2; pass++) {
      let seat = first;
      for (let count = 0; count < this.livingSeats().length; count++) {
        this.players[seat].cards.push(this.draw());
        seat = this.nextLiving(seat);
      }
    }
  }

  commit(seat, requested) {
    const player = this.players[seat];
    const paid = Math.min(Math.max(0, requested), player.chips);
    player.chips -= paid;
    player.bet += paid;
    player.handBet += paid;
    this.pot += paid;
    if (player.chips === 0) player.allIn = true;
    return paid;
  }

  legalActions(seat = this.turnSeat) {
    if (!this.canAct(seat) || seat !== this.turnSeat) return [];
    const player = this.players[seat];
    const needed = Math.max(0, this.currentBet - player.bet);
    const actions = [needed === 0 ? "check" : "call", "fold"];
    if (!this.actedSinceFullRaise.has(seat) && player.chips > needed) actions.push("raise", "all_in");
    else if (player.chips <= needed) actions.push("all_in");
    return [...new Set(actions)];
  }

  act(playerId, action, amount = 0) {
    if (this.handComplete) throw new Error("No hay una mano activa.");
    const seat = this.players.findIndex((player) => player.id === playerId);
    if (seat !== this.turnSeat) throw new Error("No es tu turno.");
    if (!this.legalActions(seat).includes(action)) throw new Error("Acción no permitida.");
    const player = this.players[seat];
    const needed = Math.max(0, this.currentBet - player.bet);
    const event = { seat, playerId, action, paid: 0, target: player.bet };
    if (action === "fold") {
      player.folded = true;
      this.actedSinceFullRaise.add(seat);
    } else if (action === "check") {
      if (needed !== 0) throw new Error("No puedes pasar frente a una apuesta.");
      this.actedSinceFullRaise.add(seat);
    } else if (action === "call") {
      event.paid = this.commit(seat, needed);
      event.target = player.bet;
      this.actedSinceFullRaise.add(seat);
    } else {
      const maximum = player.bet + player.chips;
      const requestedTarget = action === "all_in" ? maximum : Number(amount);
      if (!Number.isSafeInteger(requestedTarget) || requestedTarget <= this.currentBet || requestedTarget > maximum) throw new Error("Cantidad de subida inválida.");
      const fullRaise = requestedTarget >= this.currentBet + this.minimumRaise;
      if (!fullRaise && action !== "all_in") throw new Error(`La subida mínima es ${this.currentBet + this.minimumRaise}.`);
      const previousBet = this.currentBet;
      event.paid = this.commit(seat, requestedTarget - player.bet);
      event.target = requestedTarget;
      event.fullRaise = fullRaise;
      this.currentBet = requestedTarget;
      this.lastAggressor = seat;
      if (fullRaise) {
        this.minimumRaise = requestedTarget - previousBet;
        this.actedSinceFullRaise.clear();
      }
      this.actionQueue = this.orderedFrom((seat + 1) % this.players.length, (candidate) => this.canAct(candidate) && this.players[candidate].bet < this.currentBet);
      this.actedSinceFullRaise.add(seat);
    }
    if (this.activeSeats().length === 1) this.finishByFold();
    else this.advanceQueue();
    return event;
  }

  advanceQueue() {
    if (this.handComplete) return;
    while (this.actionQueue.length && !this.canAct(this.actionQueue[0])) this.actionQueue.shift();
    if (this.actionQueue.length) { this.turnSeat = this.actionQueue.shift(); return; }
    const owing = this.orderedFrom((this.lastAggressor + 1 + this.players.length) % this.players.length,
      (seat) => this.canAct(seat) && this.players[seat].bet < this.currentBet);
    if (owing.length) { this.actionQueue = owing; this.turnSeat = this.actionQueue.shift(); return; }
    this.closeStreet();
  }

  closeStreet() {
    for (const player of this.players) player.bet = 0;
    this.currentBet = 0;
    this.minimumRaise = BIG_BLIND;
    this.actedSinceFullRaise.clear();
    this.lastAggressor = -1;
    if (this.street === "preflop") { this.burn(); this.community.push(this.draw(), this.draw(), this.draw()); this.street = "flop"; }
    else if (this.street === "flop") { this.burn(); this.community.push(this.draw()); this.street = "turn"; }
    else if (this.street === "turn") { this.burn(); this.community.push(this.draw()); this.street = "river"; }
    else { this.showdown(); return; }
    const actionable = this.activeSeats().filter((seat) => this.canAct(seat));
    if (actionable.length < 2) { this.runBoardToShowdown(); return; }
    const first = this.nextLiving(this.dealer);
    this.actionQueue = this.orderedFrom(first, (seat) => this.canAct(seat));
    this.advanceQueue();
  }

  runBoardToShowdown() {
    while (this.street !== "river") {
      if (this.street === "preflop") { this.burn(); this.community.push(this.draw(), this.draw(), this.draw()); this.street = "flop"; }
      else if (this.street === "flop") { this.burn(); this.community.push(this.draw()); this.street = "turn"; }
      else { this.burn(); this.community.push(this.draw()); this.street = "river"; }
    }
    this.showdown();
  }

  finishByFold() {
    const winner = this.activeSeats()[0];
    this.players[winner].chips += this.pot;
    this.lastResult = { reason: "fold", payouts: { [winner]: this.pot }, winners: [winner] };
    this.finishHand();
  }

  showdown() {
    const eligible = this.activeSeats();
    const payouts = calculateSidePots(this.players, eligible, this.community);
    for (const [seat, amount] of Object.entries(payouts)) this.players[Number(seat)].chips += amount;
    const winners = Object.entries(payouts).filter(([, amount]) => amount > 0).map(([seat]) => Number(seat));
    this.lastResult = { reason: "showdown", payouts, winners };
    this.finishHand();
  }

  finishHand() {
    this.pot = 0;
    this.turnSeat = -1;
    this.actionQueue = [];
    this.handComplete = true;
    this.street = "showdown";
    for (const player of this.players) if (player.chips <= 0) player.eliminated = true;
  }

  publicState() {
    return {
      handNumber: this.handNumber, dealer: this.dealer, smallBlindSeat: this.smallBlindSeat, bigBlindSeat: this.bigBlindSeat,
      street: this.street, community: this.community, pot: this.pot, currentBet: this.currentBet,
      minimumRaise: this.minimumRaise, turnSeat: this.turnSeat, handComplete: this.handComplete, lastResult: this.lastResult,
      players: this.players.map(({ cards, ...publicPlayer }) => ({ ...publicPlayer, cardCount: cards.length }))
    };
  }

  privateState(playerId) {
    const state = this.publicState();
    const player = this.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("Jugador desconocido.");
    state.yourSeat = player.seat;
    state.yourCards = player.cards;
    state.legalActions = this.legalActions(player.seat);
    if (this.handComplete && this.lastResult?.reason === "showdown") {
      state.revealedCards = this.players.filter((entry) => !entry.folded).map((entry) => ({ seat: entry.seat, cards: entry.cards }));
    }
    return state;
  }
}

export function calculateSidePots(players, eligibleSeats, community) {
  const payouts = Object.fromEntries(eligibleSeats.map((seat) => [seat, 0]));
  const levels = [...new Set(players.map((player) => player.handBet).filter((amount) => amount > 0))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = players.filter((player) => player.handBet >= level);
    const eligible = contributors.filter((player) => eligibleSeats.includes(player.seat)).map((player) => player.seat);
    const layer = (level - previous) * contributors.length;
    previous = level;
    if (!layer || !eligible.length) continue;
    const winners = bestSeats(players, eligible, community);
    const split = Math.floor(layer / winners.length);
    let remainder = layer % winners.length;
    for (const seat of winners) payouts[seat] = (payouts[seat] || 0) + split + (remainder-- > 0 ? 1 : 0);
  }
  return payouts;
}

export function bestSeats(players, seats, community) {
  let best = null;
  let winners = [];
  for (const seat of seats) {
    const score = evaluate([...players[seat].cards, ...community]);
    const comparison = best ? compareScores(score, best) : 1;
    if (comparison > 0) { best = score; winners = [seat]; }
    else if (comparison === 0) winners.push(seat);
  }
  return winners;
}

export function evaluate(cards) {
  if (cards.length < 5) throw new Error("Se necesitan al menos cinco cartas.");
  let best = null;
  for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++)
    for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++)
      for (let e = d + 1; e < cards.length; e++) {
        const score = scoreFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
        if (!best || compareScores(score, best) > 0) best = score;
      }
  return best;
}

export function scoreFive(cards) {
  const values = cards.map((card) => card.rank).sort((a, b) => b - a);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...counts.keys()].sort((a, b) => a - b);
  let straightHigh = unique.length === 5 && unique[4] - unique[0] === 4 ? unique[4] : 0;
  if (unique.join(",") === "2,3,4,5,14") straightHigh = 5;
  if (flush && straightHigh) return [8, straightHigh];
  const groups = [...counts].map(([value, count]) => [count, value]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, groups[0][1], ...groups.slice(1).map((g) => g[1])];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, Math.max(groups[0][1], groups[1][1]), Math.min(groups[0][1], groups[1][1]), groups[2][1]];
  if (groups[0][0] === 2) return [1, groups[0][1], ...groups.slice(1).map((g) => g[1])];
  return [0, ...values];
}

export function compareScores(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

