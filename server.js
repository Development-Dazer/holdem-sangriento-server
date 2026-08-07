import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PokerEngine } from "./poker_engine.js";
import { LeaderboardStore } from "./leaderboard.js";

const PORT = Number(process.env.PORT || 10000);
const VERSION = 2;
const RELEASE = process.env.RELEASE_VERSION || "2.2.0";
const MAX_PLAYERS = 4;
const MAX_ROOMS = 100;
const CHARACTERS = new Set(["El Tramposo", "El Contador", "El Psicólogo", "El Ladrón", "El Suicida", "El Prestamista", "El Guardaespaldas"]);
const ACTIONS = new Set(["check", "call", "raise", "fold", "all_in"]);
const rooms = new Map();
const leaderboardFile = process.env.LEADERBOARD_FILE === undefined ? "./data/leaderboard.json" : process.env.LEADERBOARD_FILE;
const leaderboard = new LeaderboardStore({ filePath: leaderboardFile, season: process.env.LEADERBOARD_SEASON || "preseason-1" });

function httpHeaders(contentType) {
  return {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'"
  };
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, httpHeaders("application/json; charset=utf-8"));
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, protocol: VERSION, release: RELEASE }));
    return;
  }
  const parsedUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && parsedUrl.pathname === "/leaderboard") {
    response.writeHead(200, { ...httpHeaders("application/json; charset=utf-8"), "cache-control": "public, max-age=20" });
    response.end(JSON.stringify(leaderboard.snapshot(parsedUrl.searchParams.get("limit"))));
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { ...httpHeaders("application/json; charset=utf-8"), allow: "GET" });
    response.end(JSON.stringify({ error: "Método no permitido." }));
    return;
  }
  response.writeHead(200, httpHeaders("text/plain; charset=utf-8"));
  response.end("Hold'em Sangriento online server\n");
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(socket, type, payload = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: VERSION, type, payload }));
}

function cleanName(value) {
  return String(value || "JUGADOR").replace(/[\r\n<>\[\]]/g, "").trim().slice(0, 18) || "JUGADOR";
}

function roomCode() {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase(); while (rooms.has(code));
  return code;
}

function cleanRoomName(value) {
  return String(value || "SALA DE PÓKER").replace(/[\r\n<>\[\]]/g, "").trim().slice(0, 28) || "SALA DE PÓKER";
}

function passwordDigest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function roomDirectoryEntry(room) {
  return {
    code: room.code,
    name: room.name,
    locked: room.passwordHash !== "",
    players: room.players.filter((player) => player.connected).length,
    maxPlayers: MAX_PLAYERS,
    phase: room.phase
  };
}

function roomDirectory() {
  return [...rooms.values()]
    .filter((room) => room.listed && room.phase === "lobby")
    .map(roomDirectoryEntry)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sendRoomList(socket) {
  send(socket, "room_list", { rooms: roomDirectory() });
}

function broadcastRoomList() {
  const payload = { rooms: roomDirectory() };
  for (const socket of wss.clients) send(socket, "room_list", payload);
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    locked: room.passwordHash !== "",
    listed: room.listed,
    hostPlayerId: room.hostPlayerId,
    rematchVotes: [...(room.rematchVotes || [])],
    disconnectedPlayerId: room.disconnectedPlayerId || "",
    phase: room.phase,
    turnPlayerId: room.turnPlayerId,
    players: room.players.map(({ id, name, character, ready, connected }) => ({ id, name, character, ready, connected }))
  };
}

function broadcastRoom(room) {
  const state = publicRoom(room);
  for (const player of room.players) send(player.socket, "room_state", state);
}

function broadcastGame(room) {
  if (!room.engine) return;
  for (const player of room.players) {
    if (player.connected) send(player.socket, "game_state", room.engine.privateState(player.id));
  }
}

function leaveRoom(client) {
  const room = rooms.get(client.roomCode);
  if (!room) return;
  client.roomCode = "";
  const player = room.players.find((entry) => entry.id === client.id);
  if (!player) return;
  if (room.phase === "lobby" || room.phase === "rematch") {
    room.players = room.players.filter((entry) => entry.id !== client.id);
    room.rematchVotes?.delete(client.id);
  } else {
    player.connected = false;
  }
  if (room.phase === "playing" || (room.phase === "hand_complete" && room.engine?.livingSeats().length >= 2)) {
    room.previousPhase = room.phase;
    room.phase = "paused_disconnect";
    room.disconnectedPlayerId = player.id;
  }
  if (room.players.every((entry) => !entry.connected)) rooms.delete(room.code);
  else {
    if (room.hostPlayerId === client.id) {
      room.hostPlayerId = room.players.find((entry) => entry.connected)?.id || "";
    }
    broadcastRoom(room);
  }
  broadcastRoomList();
}

function addPlayer(socket, client, room, payload) {
  if (room.passwordHash !== "" && passwordDigest(payload.password) !== room.passwordHash) throw new Error("Contraseña incorrecta.");
  const character = String(payload.character || "");
  if (!CHARACTERS.has(character)) throw new Error("Personaje inválido.");
  const requestedName = cleanName(payload.name);
  if (room.phase === "paused_disconnect") {
    const reconnectToken = String(payload.reconnectToken || "");
    const returning = room.players.find((entry) => !entry.connected && entry.reconnectToken === reconnectToken && entry.name === requestedName && entry.character === character);
    if (!returning) throw new Error("No se pudo verificar la recuperación de ese asiento.");
    client.id = returning.id;
    client.roomCode = room.code;
    returning.socket = socket;
    returning.connected = true;
    send(socket, "room_joined", { playerId: returning.id, code: room.code, reconnectToken: returning.reconnectToken, reconnected: true });
    if (room.players.every((entry) => entry.connected)) {
      room.phase = room.previousPhase || "playing";
      room.disconnectedPlayerId = "";
    }
    broadcastRoom(room);
    broadcastGame(room);
    broadcastRoomList();
    return;
  }
  if (room.phase !== "lobby") throw new Error("La partida ya comenzó.");
  if (room.players.length >= MAX_PLAYERS) throw new Error("La sala está completa.");
  if (room.players.some((player) => player.name.toLocaleLowerCase("es") === requestedName.toLocaleLowerCase("es"))) throw new Error("Ese nombre ya está en uso en la sala.");
  if (room.players.some((player) => player.character === character)) throw new Error("Ese personaje ya fue elegido.");
  const player = { id: client.id, name: requestedName, character, ready: false, connected: true, socket, reconnectToken: crypto.randomBytes(24).toString("base64url") };
  room.players.push(player);
  client.roomCode = room.code;
  send(socket, "room_joined", { playerId: client.id, code: room.code, reconnectToken: player.reconnectToken });
  broadcastRoom(room);
  broadcastRoomList();
}

function recordCompletedMatch(room, abandonedIds = []) {
  if (!room.engine || room.engine.livingSeats().length !== 1 || room.rankedRecorded) return false;
  const winnerSeat = room.engine.livingSeats()[0];
  const winner = room.engine.players[winnerSeat];
  const recorded = leaderboard.recordMatch({
    matchId: `${room.matchId}:${room.engine.handNumber}`,
    players: room.players.map(({ id, name }) => ({ id, name })),
    winnerId: winner.id,
    abandonedIds
  });
  if (recorded) room.rankedRecorded = true;
  return recorded;
}

wss.on("connection", (socket) => {
  const client = { id: crypto.randomUUID(), roomCode: "", quotaStartedAt: Date.now(), quotaCount: 0 };
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  send(socket, "welcome", { playerId: client.id, protocol: VERSION, release: RELEASE });

  socket.on("message", (raw) => {
    try {
      const now = Date.now();
      if (now - client.quotaStartedAt >= 10_000) { client.quotaStartedAt = now; client.quotaCount = 0; }
      client.quotaCount += 1;
      if (client.quotaCount > 40) throw new Error("Demasiados comandos. Espera unos segundos.");
      const message = JSON.parse(raw.toString("utf8"));
      if (message.v !== VERSION || typeof message.type !== "string") throw new Error("Versión de protocolo inválida.");
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      if (message.type === "ping") return send(socket, "pong", { at: Date.now() });
      if (message.type === "list_rooms") return sendRoomList(socket);
      if (message.type === "create_room") {
        if (client.roomCode) throw new Error("Ya perteneces a una sala.");
        if (rooms.size >= MAX_ROOMS) throw new Error("El servidor alcanzó el límite temporal de salas.");
        const code = roomCode();
        const password = String(payload.password || "").slice(0, 32);
        const room = {
          code,
          name: cleanRoomName(payload.roomName),
          listed: payload.listed !== false,
          passwordHash: password === "" ? "" : passwordDigest(password),
          hostPlayerId: client.id,
          phase: "lobby",
          turnPlayerId: "",
          players: [],
          engine: null,
          rematchVotes: new Set(),
          previousPhase: "",
          disconnectedPlayerId: "",
          matchId: crypto.randomUUID(),
          rankedRecorded: false
        };
        rooms.set(code, room);
        return addPlayer(socket, client, room, payload);
      }
      if (message.type === "join_room") {
        if (client.roomCode) throw new Error("Ya perteneces a una sala.");
        const room = rooms.get(String(payload.code || "").toUpperCase());
        if (!room) throw new Error("Sala inexistente.");
        return addPlayer(socket, client, room, payload);
      }
      const room = rooms.get(client.roomCode);
      if (!room) throw new Error("Primero debes entrar a una sala.");
      const player = room.players.find((entry) => entry.id === client.id);
      if (!player) throw new Error("Jugador no registrado.");
      if (message.type === "ready") {
        player.ready = Boolean(payload.value);
        broadcastRoom(room);
        return;
      }
      if (message.type === "end_due_disconnect") {
        if (room.hostPlayerId !== client.id) throw new Error("Solo el anfitrión puede finalizar por desconexión.");
        if (room.phase !== "paused_disconnect" || !room.engine) throw new Error("La partida no está pausada por desconexión.");
        const connected = room.engine.players.filter((enginePlayer) => room.players.find((entry) => entry.id === enginePlayer.id)?.connected);
        if (connected.length === 0) throw new Error("No quedan jugadores conectados.");
        connected.sort((a, b) => b.chips - a.chips);
        const winner = connected[0];
        const totalChips = room.engine.players.reduce((sum, entry) => sum + entry.chips, 0) + room.engine.pot;
        for (const enginePlayer of room.engine.players) {
          enginePlayer.chips = enginePlayer.id === winner.id ? totalChips : 0;
          enginePlayer.eliminated = enginePlayer.id !== winner.id;
          enginePlayer.folded = enginePlayer.id !== winner.id;
        }
        room.engine.pot = 0;
        room.engine.handComplete = true;
        room.engine.street = "showdown";
        room.engine.turnSeat = -1;
        room.engine.lastResult = { reason: "disconnect", winners: [winner.seat], payouts: { [winner.seat]: totalChips } };
        room.phase = "hand_complete";
        const abandonedIds = room.disconnectedPlayerId ? [room.disconnectedPlayerId] : [];
        room.disconnectedPlayerId = "";
        recordCompletedMatch(room, abandonedIds);
        broadcastRoom(room);
        return broadcastGame(room);
      }
      if (message.type === "start_game") {
        if (room.hostPlayerId !== client.id) throw new Error("Solo el anfitrión puede iniciar la partida.");
        if (room.phase !== "lobby") throw new Error("La partida ya comenzó.");
        const connectedPlayers = room.players.filter((entry) => entry.connected);
        if (connectedPlayers.length < 2) throw new Error("Se necesitan al menos 2 jugadores.");
        room.players = connectedPlayers;
        room.engine = new PokerEngine(room.players);
        room.engine.startHand();
        room.phase = room.engine.handComplete ? "hand_complete" : "playing";
        room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
        broadcastRoom(room);
        broadcastRoomList();
        return broadcastGame(room);
      }
      if (message.type === "next_hand") {
        if (room.hostPlayerId !== client.id) throw new Error("Solo el anfitrión puede repartir la siguiente mano.");
        if (room.phase !== "hand_complete" || !room.engine) throw new Error("La mano actual todavía no terminó.");
        if (room.engine.livingSeats().length < 2) throw new Error("La partida terminó. Propón una revancha.");
        room.engine.startHand();
        room.phase = room.engine.handComplete ? "hand_complete" : "playing";
        room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
        recordCompletedMatch(room);
        broadcastRoom(room);
        return broadcastGame(room);
      }
      if (message.type === "propose_rematch") {
        if (room.hostPlayerId !== client.id) throw new Error("Solo el anfitrión puede proponer una revancha.");
        if (room.phase !== "hand_complete" || !room.engine || room.engine.livingSeats().length >= 2) throw new Error("La partida actual todavía puede continuar.");
        room.phase = "rematch";
        room.rematchVotes = new Set([client.id]);
        return broadcastRoom(room);
      }
      if (message.type === "accept_rematch") {
        if (room.phase !== "rematch") throw new Error("No hay una revancha propuesta.");
        room.rematchVotes.add(client.id);
        const connectedIds = room.players.filter((entry) => entry.connected).map((entry) => entry.id);
        if (connectedIds.length >= 2 && connectedIds.every((id) => room.rematchVotes.has(id))) {
          room.players = room.players.filter((entry) => entry.connected);
          room.engine = new PokerEngine(room.players);
          room.matchId = crypto.randomUUID();
          room.rankedRecorded = false;
          room.engine.startHand();
          room.phase = room.engine.handComplete ? "hand_complete" : "playing";
          room.rematchVotes.clear();
          room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
          broadcastRoom(room);
          return broadcastGame(room);
        }
        return broadcastRoom(room);
      }
      if (message.type === "ability" || message.type === "favor" || message.type === "guess_fake") {
        if (room.phase !== "playing" || !room.engine) throw new Error("La partida no está activa.");
        let accepted;
        if (message.type === "ability") accepted = room.engine.useAbility(client.id, payload.target);
        else if (message.type === "favor") accepted = room.engine.useFavor(client.id, String(payload.option || ""), payload.target, payload.cardIndex);
        else accepted = room.engine.guessFakeCard(client.id, payload.cardIndex);
        room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
        if (room.engine.handComplete) {
          room.phase = "hand_complete";
          recordCompletedMatch(room);
        }
        send(socket, "action_accepted", accepted);
        broadcastRoom(room);
        return broadcastGame(room);
      }
      if (message.type === "action") {
        if (room.phase !== "playing" || !room.engine) throw new Error("La partida no está activa.");
        const action = String(payload.action || "");
        if (!ACTIONS.has(action)) throw new Error("Acción inválida.");
        const amount = Number(payload.amount || 0);
        if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Cantidad inválida.");
        const accepted = room.engine.act(client.id, action, amount);
        room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
        if (room.engine.handComplete) {
          room.phase = "hand_complete";
          recordCompletedMatch(room);
        }
        for (const target of room.players) send(target.socket, "action_accepted", accepted);
        broadcastRoom(room);
        return broadcastGame(room);
      }
      throw new Error("Comando desconocido.");
    } catch (error) {
      send(socket, "error", { message: error instanceof Error ? error.message : "Mensaje inválido." });
    }
  });

  socket.on("close", () => leaveRoom(client));
  socket.on("error", () => leaveRoom(client));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, "Servidor reiniciándose");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen(PORT, "0.0.0.0", () => console.log(`Hold'em Sangriento server listening on ${PORT}`));
