# Hold'em Sangriento — servidor de partidas

Servidor WebSocket autoritativo para las partidas online de **Hold'em Sangriento**. Mantiene las salas, administra el ciclo de cada mano y valida todas las acciones antes de actualizar el estado compartido.

## Responsabilidades

- Salas de 2 a 4 jugadores, abiertas o protegidas con contraseña.
- Navegador de salas con ocupación y estado en tiempo real.
- Control del anfitrión para iniciar partidas y proponer revanchas.
- Barajado Fisher–Yates mediante aleatoriedad criptográfica de Node.js.
- Reparto, dealer, ciegas, turnos y progresión preflop/flop/turn/river.
- Check, call, raise, fold y all-in con validación de subida mínima.
- Pozos principales y laterales, showdown y evaluación completa de manos.
- Pausa inmediata ante desconexiones, recuperación de asiento y cierre por abandono.
- Vista privada por conexión: cada cliente recibe únicamente sus propias cartas.

## Arquitectura

El cliente Godot intercambia mensajes JSON versionados mediante WebSocket. `server.js` gestiona transporte, sesiones y salas; `poker_engine.js` contiene el motor determinista de reglas. El mazo, las cartas privadas ajenas y la fuente de aleatoriedad permanecen exclusivamente en el servidor.

```text
Cliente Godot ── WebSocket ── Sala ── PokerEngine
       │                         ├── estado público
       └── vista privada ────────└── cartas del destinatario
```

## Desarrollo local

Requiere Node.js 20 o posterior.

```bash
npm install
npm test
npm run check
npm start
```

- Salud: `http://localhost:10000/health`
- WebSocket: `ws://localhost:10000`

## Producción

- Salud: `https://holdem-sangriento-server.onrender.com/health`
- WebSocket: `wss://holdem-sangriento-server.onrender.com`
- Plataforma: Render Web Service
- Despliegue: automático desde la rama `main`

El endpoint debe permanecer accesible desde Internet para los clientes del juego. La administración del servicio y el repositorio de origen son privados.

## Seguridad y límites

- Límite de 16 KiB por mensaje.
- Validación de versión, tipo de comando, turno, saldo y cantidades.
- Contraseñas de sala resumidas en memoria; nunca se incluyen en el directorio.
- Estados privados generados individualmente para cada conexión.
- Comandos de anfitrión verificados en el servidor.
- Las salas viven en memoria y se eliminan cuando dejan de tener conexiones.

## Estado del producto

El núcleo reglamentario, las salas y la mesa remota están operativos. La siguiente etapa contempla identidad persistente, token seguro de reconexión, temporizadores competitivos y paridad completa de habilidades, eventos y Favor del Dealer.

Este repositorio contiene únicamente el servicio de partidas. Los recursos gráficos y el proyecto Godot se mantienen fuera del despliegue.
