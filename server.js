import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PokerEngine } from "./poker_engine.js";

const PORT = Number(process.env.PORT || 10000);
const VERSION = 1;
const MAX_PLAYERS = 4;
const CHARACTERS = new Set(["El Tramposo", "El Contador", "El Psicólogo", "El Médico", "El Suicida", "El Prestamista"]);
const ACTIONS = new Set(["check", "call", "raise", "fold", "all_in", "ability", "favor"]);
const rooms = new Map();

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, protocol: VERSION }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
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
  const player = room.players.find((entry) => entry.id === client.id);
  if (player) player.connected = false;
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
  if (room.phase !== "lobby") throw new Error("La partida ya comenzó.");
  if (room.players.length >= MAX_PLAYERS) throw new Error("La sala está completa.");
  if (room.passwordHash !== "" && passwordDigest(payload.password) !== room.passwordHash) throw new Error("Contraseña incorrecta.");
  const character = String(payload.character || "");
  if (!CHARACTERS.has(character)) throw new Error("Personaje inválido.");
  if (room.players.some((player) => player.character === character)) throw new Error("Ese personaje ya fue elegido.");
  const player = { id: client.id, name: cleanName(payload.name), character, ready: false, connected: true, socket };
  room.players.push(player);
  client.roomCode = room.code;
  send(socket, "room_joined", { playerId: client.id, code: room.code });
  broadcastRoom(room);
  broadcastRoomList();
}

wss.on("connection", (socket) => {
  const client = { id: crypto.randomUUID(), roomCode: "" };
  send(socket, "welcome", { playerId: client.id, protocol: VERSION });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.v !== VERSION || typeof message.type !== "string") throw new Error("Versión de protocolo inválida.");
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      if (message.type === "ping") return send(socket, "pong", { at: Date.now() });
      if (message.type === "list_rooms") return sendRoomList(socket);
      if (message.type === "create_room") {
        if (client.roomCode) throw new Error("Ya perteneces a una sala.");
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
          rematchVotes: new Set()
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
      if (message.type === "start_game") {
        if (room.hostPlayerId !== client.id) throw new Error("Solo el anfitrión puede iniciar la partida.");
        if (room.phase !== "lobby") throw new Error("La partida ya comenzó.");
        const connectedPlayers = room.players.filter((entry) => entry.connected);
        if (connectedPlayers.length < 2) throw new Error("Se necesitan al menos 2 jugadores.");
        room.players = connectedPlayers;
        room.engine = new PokerEngine(room.players);
        room.engine.startHand();
        room.phase = "playing";
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
        room.phase = "playing";
        room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
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
          room.engine = new PokerEngine(room.players);
          room.engine.startHand();
          room.phase = "playing";
          room.rematchVotes.clear();
          room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
          broadcastRoom(room);
          return broadcastGame(room);
        }
        return broadcastRoom(room);
      }
      if (message.type === "action") {
        if (room.phase !== "playing" || !room.engine) throw new Error("La partida no está activa.");
        const action = String(payload.action || "");
        if (!ACTIONS.has(action)) throw new Error("Acción inválida.");
        const amount = Number(payload.amount || 0);
        if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Cantidad inválida.");
        if (action === "ability" || action === "favor") throw new Error("Esa acción todavía no está habilitada en el protocolo autoritativo.");
        const accepted = room.engine.act(client.id, action, amount);
        room.turnPlayerId = room.engine.players[room.engine.turnSeat]?.id || "";
        if (room.engine.handComplete) room.phase = "hand_complete";
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

server.listen(PORT, "0.0.0.0", () => console.log(`Hold'em Sangriento server listening on ${PORT}`));
