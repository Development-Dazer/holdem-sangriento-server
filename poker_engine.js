import crypto from "node:crypto";

export const STARTING_CHIPS = 500;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const EVENT_DEFINITIONS = [
  { name: "CORTE DE LUZ", description: "Solo puedes ver tus cartas privadas durante esta mano." },
  { name: "DEALER CORRUPTO", description: "Una sexta carta comunitaria es falsa. Identifícala para ganar 60 fichas." },
  { name: "IMPUESTOS", description: "Todos pierden el 15% de sus fichas antes del reparto." },
  { name: "MANO OBLIGATORIA", description: "Nadie puede retirarse durante esta mano." },
  { name: "SANGRE CALIENTE", description: "Las ciegas y la subida mínima se duplican." },
  { name: "MUERTE SÚBITA", description: "Al terminar, quien tenga menos fichas pierde el 15% de su capital." }
];

const THIEF_STEAL_AMOUNT = 15;
const COOLDOWN_HANDS = 3;
const SUICIDE_PROFIT_RATE = 0.25;
const SUICIDE_LOSS_PENALTY = 20;
const LENDER_START_BONUS = 50;
const LENDER_INITIAL_DEBT = 65;
const LOAN_PRINCIPAL = 60;
const LOAN_REPAYMENT = 80;
const LOAN_TERM_HANDS = 3;
const BODYGUARD_REFUND_RATE = 0.25;
const BODYGUARD_REFUND_CAP = 25;
const INSURANCE_REFUND_RATE = 0.5;
const INSURANCE_REFUND_CAP = 60;

function preflopStrength(cards) {
  if (!cards || cards.length < 2) return 0;
  if (cards[0].rank === cards[1].rank) return 2;
  if (Math.max(cards[0].rank, cards[1].rank) >= 12) return 1;
  return 0;
}

function preflopComparisonScore(cards) {
  const high = Math.max(cards[0].rank, cards[1].rank);
  const low = Math.min(cards[0].rank, cards[1].rank);
  let score = high / 14 + low / 28;
  if (high === low) score += 0.55 + high / 28;
  if (cards[0].suit === cards[1].suit) score += 0.1;
  if (Math.abs(high - low) <= 2) score += 0.07;
  return score;
}

export class PokerEngine {
  constructor(players, options = {}) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4) throw new Error("Se requieren entre 2 y 4 jugadores.");
    this.randomInt = options.randomInt || ((maximum) => crypto.randomInt(maximum));
    this.players = players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      character: player.character,
      seat,
      chips: STARTING_CHIPS + (player.character === "El Prestamista" ? LENDER_START_BONUS : 0),
      cards: [], bet: 0, handBet: 0, folded: false, allIn: false, eliminated: false,
      favor: 0, favorUsed: false, abilityUsed: false, lossInsurance: false,
      abilityCooldownUntil: 0, thiefCooldownUntil: 0, thiefTarget: -1,
      guardCooldownUntil: 0, guardArmed: false,
      debt: player.character === "El Prestamista" ? LENDER_INITIAL_DEBT : 0,
      debtDue: player.character === "El Prestamista" ? 4 : 0,
      fakeGuessDone: false, privateNotice: "", previewCard: null, exposedCard: null
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
    this.eventName = "";
    this.eventDescription = "";
    this.fakeCard = null;
    this.fakePosition = -1;
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
    if (!this.handComplete) throw new Error("La mano actual todavía está activa.");
    if (this.livingSeats().length < 2) throw new Error("La partida ya tiene ganador.");
    this.handNumber += 1;
    this.street = "preflop";
    this.community = [];
    this.pot = 0;
    this.actionQueue = [];
    this.actedSinceFullRaise.clear();
    this.lastAggressor = -1;
    this.handComplete = false;
    this.lastResult = null;
    this.eventName = "";
    this.eventDescription = "";
    this.fakeCard = null;
    this.fakePosition = -1;
    for (const player of this.players) {
      player.cards = [];
      player.bet = 0;
      player.handBet = 0;
      player.folded = player.eliminated;
      player.allIn = false;
      player.favorUsed = false;
      player.abilityUsed = false;
      player.lossInsurance = false;
      player.guardArmed = false;
      player.thiefTarget = -1;
      player.fakeGuessDone = false;
      player.privateNotice = "";
      player.previewCard = null;
      player.exposedCard = null;
      if (!player.eliminated && player.debt > 0 && this.handNumber >= player.debtDue) {
        if (player.chips >= player.debt) {
          player.chips -= player.debt;
          player.privateNotice = `Deuda pagada: ${player.debt} fichas.`;
          player.debt = 0;
          player.debtDue = 0;
        } else {
          player.eliminated = true;
          player.folded = true;
          player.privateNotice = "No pudiste pagar la deuda y quedaste eliminado.";
        }
      }
    }
    if (this.livingSeats().length < 2) {
      const winner = this.livingSeats()[0] ?? -1;
      this.handComplete = true;
      this.street = "showdown";
      this.turnSeat = -1;
      this.lastResult = { reason: "debt", winners: winner >= 0 ? [winner] : [], payouts: {} };
      return this.publicState();
    }
    if (this.handNumber % 3 === 0) {
      const event = EVENT_DEFINITIONS[this.randomInt(EVENT_DEFINITIONS.length)];
      this.eventName = event.name;
      this.eventDescription = event.description;
      if (this.eventName === "IMPUESTOS") {
        for (const player of this.players) {
          if (!player.eliminated) player.chips -= Math.floor(player.chips * 0.15);
        }
      }
    }
    this.dealer = this.nextLiving(this.dealer);
    this.deck = this.buildDeck();
    this.shuffle(this.deck);
    const blindMultiplier = this.eventName === "SANGRE CALIENTE" ? 2 : 1;
    this.currentBet = BIG_BLIND * blindMultiplier;
    this.minimumRaise = BIG_BLIND * blindMultiplier;
    const living = this.livingSeats();
    if (living.length === 2) {
      this.smallBlindSeat = this.dealer;
      this.bigBlindSeat = this.nextLiving(this.dealer);
    } else {
      this.smallBlindSeat = this.nextLiving(this.dealer);
      this.bigBlindSeat = this.nextLiving(this.smallBlindSeat);
    }
    this.dealPrivateCards();
    this.commit(this.smallBlindSeat, SMALL_BLIND * blindMultiplier);
    this.commit(this.bigBlindSeat, BIG_BLIND * blindMultiplier);
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
    const actions = [needed === 0 ? "check" : "call"];
    if (this.eventName !== "MANO OBLIGATORIA") actions.push("fold");
    if (!this.actedSinceFullRaise.has(seat) && player.chips > needed) actions.push("raise", "all_in");
    else if (player.chips <= needed) actions.push("all_in");
    return [...new Set(actions)];
  }

  requireSpecialTurn(playerId) {
    if (this.handComplete) throw new Error("No hay una mano activa.");
    const seat = this.players.findIndex((player) => player.id === playerId);
    if (seat !== this.turnSeat || !this.canAct(seat)) throw new Error("Solo puedes usarlo durante tu turno.");
    return seat;
  }

  rivalSeat(actorSeat, targetSeat) {
    const target = Number(targetSeat);
    if (!Number.isSafeInteger(target) || target < 0 || target >= this.players.length || target === actorSeat) throw new Error("Rival inválido.");
    if (this.players[target].eliminated || this.players[target].folded) throw new Error("Ese rival ya no está activo en la mano.");
    return target;
  }

  riverPreviewCard() {
    const offset = this.street === "preflop" ? 8 : this.street === "flop" ? 4 : this.street === "turn" ? 2 : 0;
    if (!offset || this.deck.length < offset) throw new Error("El river ya está sobre la mesa.");
    return this.deck[this.deck.length - offset];
  }

  nextCommunityPreviewCard() {
    if (this.street === "river" || this.street === "showdown" || this.deck.length < 2) throw new Error("No queda una comunitaria por revelar.");
    return this.deck[this.deck.length - 2];
  }

  psychologicalRead(actorSeat, targetSeat) {
    const actor = this.players[actorSeat];
    const target = this.players[targetSeat];
    if (this.street === "preflop") {
      const difference = preflopComparisonScore(target.cards) - preflopComparisonScore(actor.cards);
      if (Math.abs(difference) < 0.08) return "Los gestos sugieren que ambas manos están muy parejas.";
      if (difference > 0) return difference < 0.3 ? "El rival parece ligeramente por delante." : "El rival parece claramente por delante.";
      return difference > -0.3 ? "Tu mano parece ligeramente por delante." : "Tu mano parece claramente por delante.";
    }
    const targetScore = evaluate([...target.cards, ...this.community]);
    const actorScore = evaluate([...actor.cards, ...this.community]);
    const comparison = compareScores(targetScore, actorScore);
    if (comparison === 0) return "Los gestos sugieren que ambas manos están prácticamente igualadas.";
    const categoryGap = Math.abs(targetScore[0] - actorScore[0]);
    if (comparison > 0) return categoryGap === 0 ? "El rival parece ligeramente por delante." : "El rival parece claramente por delante.";
    return categoryGap === 0 ? "Tu mano parece ligeramente por delante." : "Tu mano parece claramente por delante.";
  }

  useAbility(playerId, targetSeat = -1) {
    const seat = this.requireSpecialTurn(playerId);
    const player = this.players[seat];
    player.previewCard = null;
    player.exposedCard = null;
    if (player.character === "El Tramposo") {
      if (this.handNumber < player.abilityCooldownUntil) throw new Error(`Mirada al Futuro se recarga en la mano ${player.abilityCooldownUntil}.`);
      player.previewCard = this.riverPreviewCard();
      player.abilityCooldownUntil = this.handNumber + COOLDOWN_HANDS;
      player.privateNotice = `Mirada al Futuro: el river será ${player.previewCard.rank}${player.previewCard.suit}.`;
    } else if (player.character === "El Contador") {
      if (player.abilityUsed) throw new Error("Conteo Frío solo puede usarse una vez por mano.");
      const seen = [...player.cards, ...this.community];
      const highLeft = 16 - seen.filter((card) => card.rank >= 11).length;
      player.abilityUsed = true;
      player.privateNotice = `Conteo Frío: quedan ${highLeft} cartas J o mejores sin ver.`;
    } else if (player.character === "El Psicólogo") {
      if (player.abilityUsed) throw new Error("Leer Intenciones solo puede usarse una vez por mano.");
      const target = this.rivalSeat(seat, targetSeat);
      player.abilityUsed = true;
      player.privateNotice = `Leer Intenciones — ${this.players[target].name}: ${this.psychologicalRead(seat, target)}`;
    } else if (player.character === "El Ladrón") {
      if (this.handNumber < player.thiefCooldownUntil) throw new Error(`Marcar Botín se recarga en la mano ${player.thiefCooldownUntil}.`);
      const target = this.rivalSeat(seat, targetSeat);
      player.thiefTarget = target;
      player.thiefCooldownUntil = this.handNumber + COOLDOWN_HANDS;
      player.privateNotice = `Botín marcado: ${this.players[target].name}. Debes ganar solo para cobrar.`;
    } else if (player.character === "El Suicida") {
      throw new Error("Todo o Nada es una habilidad pasiva.");
    } else if (player.character === "El Guardaespaldas") {
      if (this.handNumber < player.guardCooldownUntil) throw new Error(`Cobertura se recarga en la mano ${player.guardCooldownUntil}.`);
      player.guardArmed = true;
      player.guardCooldownUntil = this.handNumber + COOLDOWN_HANDS;
      player.privateNotice = `Cobertura activa: recuperarás hasta ${BODYGUARD_REFUND_CAP} fichas si pierdes el showdown.`;
    } else if (player.character === "El Prestamista") {
      if (player.debt > 0) throw new Error(`Ya debes ${player.debt} fichas; vence en la mano ${player.debtDue}.`);
      player.chips += LOAN_PRINCIPAL;
      player.debt = LOAN_REPAYMENT;
      player.debtDue = this.handNumber + LOAN_TERM_HANDS;
      player.privateNotice = `Crédito recibido: ${LOAN_PRINCIPAL}. Debes pagar ${LOAN_REPAYMENT} en la mano ${player.debtDue}.`;
    } else {
      throw new Error("Personaje sin habilidad disponible.");
    }
    return { action: "ability", seat, message: player.privateNotice };
  }

  useFavor(playerId, option, targetSeat = -1, cardIndex = -1) {
    const seat = this.requireSpecialTurn(playerId);
    const player = this.players[seat];
    if (player.favorUsed) throw new Error("Ya usaste el Favor del Dealer en esta mano.");
    const costs = { preview: 1, reroll: 2, expose: 3, shield: 2 };
    const cost = costs[option];
    if (!cost) throw new Error("Intervención del Dealer inválida.");
    if (player.favor < cost) throw new Error("No tienes Favor suficiente.");
    player.previewCard = null;
    player.exposedCard = null;
    if (option === "preview") {
      player.previewCard = this.nextCommunityPreviewCard();
      player.privateNotice = `Próxima comunitaria: ${player.previewCard.rank}${player.previewCard.suit}.`;
    } else if (option === "reroll") {
      const index = Number(cardIndex);
      if (!Number.isSafeInteger(index) || index < 0 || index > 1) throw new Error("Elige cuál carta inicial quieres cambiar.");
      const oldCard = player.cards[index];
      player.cards[index] = this.draw();
      this.deck.unshift(oldCard);
      player.privateNotice = `El Dealer cambió ${oldCard.rank}${oldCard.suit} por ${player.cards[index].rank}${player.cards[index].suit}.`;
    } else if (option === "expose") {
      const target = this.rivalSeat(seat, targetSeat);
      const exposedIndex = this.randomInt(2);
      player.exposedCard = { seat: target, card: this.players[target].cards[exposedIndex] };
      player.privateNotice = `${this.players[target].name} expone una carta privada.`;
    } else {
      player.lossInsurance = true;
      player.privateNotice = "Seguro del Dealer activo para esta mano.";
    }
    player.favor -= cost;
    player.favorUsed = true;
    return { action: "favor", option, seat, message: player.privateNotice };
  }

  guessFakeCard(playerId, cardIndex) {
    const seat = this.requireSpecialTurn(playerId);
    const player = this.players[seat];
    if (this.eventName !== "DEALER CORRUPTO" || this.fakePosition < 0) throw new Error("No hay una carta falsa que identificar todavía.");
    if (player.fakeGuessDone) throw new Error("Ya hiciste tu acusación en esta mano.");
    const index = Number(cardIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index > 5) throw new Error("Carta comunitaria inválida.");
    player.fakeGuessDone = true;
    if (index === this.fakePosition) {
      player.chips += 60;
      player.privateNotice = "Descubriste la carta falsa y recibiste 60 fichas.";
    } else {
      const penalty = Math.min(25, player.chips);
      player.chips -= penalty;
      if (player.chips === 0) player.allIn = true;
      player.privateNotice = `Acusación incorrecta: pierdes ${penalty} fichas.`;
      if (player.allIn) this.advanceQueue();
    }
    return { action: "guess_fake", seat, correct: index === this.fakePosition, message: player.privateNotice };
  }

  act(playerId, action, amount = 0) {
    if (this.handComplete) throw new Error("No hay una mano activa.");
    const seat = this.players.findIndex((player) => player.id === playerId);
    if (seat !== this.turnSeat) throw new Error("No es tu turno.");
    if (!this.legalActions(seat).includes(action)) throw new Error("Acción no permitida.");
    const player = this.players[seat];
    // A private reveal is intentionally fleeting: after the buyer makes their
    // betting decision it must not be sent again in later state broadcasts.
    player.exposedCard = null;
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
    this.minimumRaise = BIG_BLIND * (this.eventName === "SANGRE CALIENTE" ? 2 : 1);
    this.actedSinceFullRaise.clear();
    this.lastAggressor = -1;
    if (this.street === "preflop") { this.burn(); this.community.push(this.draw(), this.draw(), this.draw()); this.street = "flop"; }
    else if (this.street === "flop") { this.burn(); this.community.push(this.draw()); this.street = "turn"; }
    else if (this.street === "turn") {
      this.burn();
      this.community.push(this.draw());
      this.street = "river";
      if (this.eventName === "DEALER CORRUPTO") {
        this.fakeCard = this.draw();
        this.fakePosition = this.randomInt(6);
      }
    }
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
      else {
        this.burn();
        this.community.push(this.draw());
        this.street = "river";
        if (this.eventName === "DEALER CORRUPTO") {
          this.fakeCard = this.draw();
          this.fakePosition = this.randomInt(6);
        }
      }
    }
    this.showdown();
  }

  finishByFold() {
    const winner = this.activeSeats()[0];
    const payouts = { [winner]: this.pot };
    this.players[winner].chips += this.pot;
    this.applyPostHandEffects(payouts, [winner], "fold");
    this.lastResult = { reason: "fold", payouts, winners: [winner] };
    this.finishHand();
  }

  showdown() {
    const eligible = this.activeSeats();
    const payouts = calculateSidePots(this.players, eligible, this.community);
    for (const [seat, amount] of Object.entries(payouts)) this.players[Number(seat)].chips += amount;
    const winners = Object.entries(payouts).filter(([, amount]) => amount > 0).map(([seat]) => Number(seat));
    this.applyPostHandEffects(payouts, winners, "showdown");
    this.lastResult = { reason: "showdown", payouts, winners };
    this.finishHand();
  }

  gainFavor(seat, amount, reason) {
    const player = this.players[seat];
    const gained = Math.min(amount, 9 - player.favor);
    if (gained <= 0) return;
    player.favor += gained;
    player.privateNotice = `${player.privateNotice ? `${player.privateNotice} ` : ""}+${gained} Favor: ${reason}.`;
  }

  handCategory(seat) {
    const cards = [...this.players[seat].cards, ...this.community];
    return cards.length >= 5 ? evaluate(cards)[0] : preflopStrength(this.players[seat].cards);
  }

  applyPostHandEffects(payouts, winners, reason) {
    for (const seat of winners) {
      const player = this.players[seat];
      const baseReward = Number(payouts[seat] || 0);
      if (player.character === "El Suicida") {
        const bonus = Math.round(Math.max(0, baseReward - player.handBet) * SUICIDE_PROFIT_RATE);
        player.chips += bonus;
        if (bonus > 0) player.privateNotice = `Todo o Nada suma ${bonus} fichas.`;
      }
      if (this.handCategory(seat) <= 1) this.gainFavor(seat, 2, "ganaste con una mano débil");
    }
    if (winners.length === 1) {
      const winnerSeat = winners[0];
      const winner = this.players[winnerSeat];
      if (winner.character === "El Ladrón" && winner.thiefTarget >= 0) {
        const target = this.players[winner.thiefTarget];
        if (target && !target.eliminated) {
          const stolen = Math.min(THIEF_STEAL_AMOUNT, target.chips);
          target.chips -= stolen;
          winner.chips += stolen;
          winner.privateNotice = `${winner.privateNotice ? `${winner.privateNotice} ` : ""}Marcar Botín transfiere ${stolen} fichas de ${target.name}.`;
        }
      }
      if (reason === "fold" && winnerSeat === this.lastAggressor && preflopStrength(winner.cards) === 0) this.gainFavor(winnerSeat, 2, "farol exitoso");
    }
    for (const player of this.players) {
      if (winners.includes(player.seat) || player.eliminated || player.folded) continue;
      if (player.character === "El Suicida") {
        const penalty = Math.min(SUICIDE_LOSS_PENALTY, player.chips);
        player.chips -= penalty;
        player.privateNotice = `Todo o Nada cobra ${penalty} fichas extra.`;
      }
      if (player.character === "El Guardaespaldas" && player.guardArmed) {
        const refund = Math.min(BODYGUARD_REFUND_CAP, Math.floor(player.handBet * BODYGUARD_REFUND_RATE));
        player.chips += refund;
        player.privateNotice = `Cobertura devuelve ${refund} fichas.`;
      }
      if (player.lossInsurance) {
        const refund = Math.min(INSURANCE_REFUND_CAP, Math.floor(player.handBet * INSURANCE_REFUND_RATE));
        player.chips += refund;
        player.privateNotice = `Seguro del Dealer devuelve ${refund} fichas.`;
      }
    }
    if (this.eventName === "MUERTE SÚBITA") {
      const candidates = this.players.filter((player) => !player.eliminated && player.chips > 0).sort((a, b) => a.chips - b.chips || a.seat - b.seat);
      if (candidates.length) {
        const last = candidates[0];
        const tax = Math.min(last.chips, Math.max(1, Math.floor(last.chips * 0.15)));
        last.chips -= tax;
        last.privateNotice = `${last.privateNotice ? `${last.privateNotice} ` : ""}Muerte Súbita cobra ${tax} fichas.`;
      }
    }
    for (const player of this.players) {
      if (!player.eliminated && player.chips > 0 && player.chips <= 100) this.gainFavor(player.seat, 1, "sobreviviste con 100 fichas o menos");
    }
  }

  finishHand() {
    this.pot = 0;
    this.turnSeat = -1;
    this.actionQueue = [];
    this.handComplete = true;
    this.street = "showdown";
    for (const player of this.players) if (player.chips <= 0) player.eliminated = true;
    if (this.lastResult && this.fakePosition >= 0) this.lastResult.fakeCardIndex = this.fakePosition;
  }

  displayedCommunity() {
    const cards = [...this.community];
    if (this.fakeCard && this.fakePosition >= 0) cards.splice(this.fakePosition, 0, this.fakeCard);
    return cards;
  }

  abilityState(seat) {
    const player = this.players[seat];
    const targets = this.activeSeats().filter((candidate) => candidate !== seat).map((candidate) => ({ seat: candidate, name: this.players[candidate].name }));
    let available = seat === this.turnSeat && this.canAct(seat);
    let requiresTarget = false;
    let passive = false;
    let reason = "";
    if (player.character === "El Tramposo") {
      if (this.handNumber < player.abilityCooldownUntil) { available = false; reason = `Recarga hasta la mano ${player.abilityCooldownUntil}.`; }
      else if (this.street === "river") { available = false; reason = "El river ya está en la mesa."; }
    } else if (player.character === "El Contador" || player.character === "El Psicólogo") {
      requiresTarget = player.character === "El Psicólogo";
      if (player.abilityUsed) { available = false; reason = "Ya fue usada en esta mano."; }
    } else if (player.character === "El Ladrón") {
      requiresTarget = true;
      if (this.handNumber < player.thiefCooldownUntil) { available = false; reason = `Recarga hasta la mano ${player.thiefCooldownUntil}.`; }
      else if (player.thiefTarget >= 0) { available = false; reason = "Ya marcaste un botín."; }
    } else if (player.character === "El Suicida") {
      passive = true; available = false; reason = "Habilidad pasiva siempre activa.";
    } else if (player.character === "El Guardaespaldas") {
      if (this.handNumber < player.guardCooldownUntil) { available = false; reason = `Recarga hasta la mano ${player.guardCooldownUntil}.`; }
      else if (player.guardArmed) { available = false; reason = "Cobertura ya activada."; }
    } else if (player.character === "El Prestamista" && player.debt > 0) {
      available = false; reason = `Deuda pendiente: ${player.debt}, vence en la mano ${player.debtDue}.`;
    }
    if (requiresTarget && targets.length === 0) { available = false; reason = "No quedan rivales activos."; }
    return { available, requiresTarget, passive, reason, targets };
  }

  favorState(seat) {
    const player = this.players[seat];
    const turnAvailable = seat === this.turnSeat && this.canAct(seat) && !player.favorUsed;
    const targets = this.activeSeats().filter((candidate) => candidate !== seat).map((candidate) => ({ seat: candidate, name: this.players[candidate].name }));
    return {
      favor: player.favor,
      used: player.favorUsed,
      options: [
        { id: "preview", cost: 1, available: turnAvailable && player.favor >= 1 && !["river", "showdown"].includes(this.street) },
        { id: "reroll", cost: 2, available: turnAvailable && player.favor >= 2 },
        { id: "expose", cost: 3, available: turnAvailable && player.favor >= 3 && targets.length > 0 },
        { id: "shield", cost: 2, available: turnAvailable && player.favor >= 2 && !player.lossInsurance }
      ],
      targets
    };
  }

  publicState() {
    return {
      handNumber: this.handNumber, dealer: this.dealer, smallBlindSeat: this.smallBlindSeat, bigBlindSeat: this.bigBlindSeat,
      street: this.street, community: this.displayedCommunity(), pot: this.pot, currentBet: this.currentBet,
      minimumRaise: this.minimumRaise, turnSeat: this.turnSeat, handComplete: this.handComplete, lastResult: this.lastResult,
      event: { name: this.eventName, description: this.eventDescription },
      players: this.players.map((player) => ({
        id: player.id, name: player.name, character: player.character, seat: player.seat,
        chips: player.chips, bet: player.bet, handBet: player.handBet, folded: player.folded,
        allIn: player.allIn, eliminated: player.eliminated, favor: player.favor,
        debt: player.debt, debtDue: player.debtDue, cardCount: player.cards.length
      }))
    };
  }

  privateState(playerId) {
    const state = this.publicState();
    const player = this.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("Jugador desconocido.");
    state.yourSeat = player.seat;
    state.yourCards = player.cards;
    state.legalActions = this.legalActions(player.seat);
    state.ability = this.abilityState(player.seat);
    state.favorActions = this.favorState(player.seat);
    state.privateNotice = player.privateNotice;
    state.previewCard = player.previewCard;
    state.exposedCard = player.exposedCard;
    state.fakeGuessAvailable = this.eventName === "DEALER CORRUPTO" && this.fakePosition >= 0 && !player.fakeGuessDone && player.seat === this.turnSeat && this.canAct(player.seat);
    if (this.eventName === "CORTE DE LUZ" && !this.handComplete) {
      state.communityCount = state.community.length;
      state.community = [];
      state.communityHidden = true;
    }
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
