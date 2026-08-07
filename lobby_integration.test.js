import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 19137;
const URL = `ws://127.0.0.1:${PORT}`;

function waitFor(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout esperando ${expectedType}`)), 3000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== expectedType) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message.payload);
    };
    socket.on("message", listener);
  });
}

function send(socket, type, payload = {}) {
  socket.send(JSON.stringify({ v: 1, type, payload }));
}

async function connect() {
  const socket = new WebSocket(URL);
  const welcome = waitFor(socket, "welcome");
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await welcome;
  return socket;
}

test("navega salas, protege contraseña y solo el host inicia", async (context) => {
  const server = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) } });
  context.after(() => server.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("El servidor no inició")), 3000);
    server.stdout.on("data", (data) => {
      if (data.toString().includes("listening")) { clearTimeout(timer); resolve(); }
    });
    server.once("error", reject);
  });

  const host = await connect();
  const guest = await connect();
  context.after(() => { host.close(); guest.close(); });

  const joinedPromise = waitFor(host, "room_joined");
  const hostStatePromise = waitFor(host, "room_state");
  send(host, "create_room", { name: "Host", character: "El Tramposo", roomName: "Mesa porteña", password: "mate", listed: true });
  const joined = await joinedPromise;
  const hostState = await hostStatePromise;
  assert.equal(hostState.hostPlayerId, hostState.players[0].id);

  send(guest, "list_rooms");
  const directory = await waitFor(guest, "room_list");
  const listed = directory.rooms.find((room) => room.code === joined.code);
  assert.equal(listed.locked, true);
  assert.equal("password" in listed, false);

  send(guest, "join_room", { code: joined.code, name: "Invitado", character: "El Contador", password: "mal" });
  assert.match((await waitFor(guest, "error")).message, /Contraseña/);
  const guestJoined = waitFor(guest, "room_joined");
  const guestState = waitFor(guest, "room_state");
  send(guest, "join_room", { code: joined.code, name: "Invitado", character: "El Contador", password: "mate" });
  await guestJoined;
  await guestState;

  send(guest, "start_game");
  assert.match((await waitFor(guest, "error")).message, /anfitrión/);
  const gameState = waitFor(host, "game_state");
  send(host, "start_game");
  const game = await gameState;
  assert.equal(game.yourCards.length, 2);
  assert.equal(game.players.length, 2);
});
