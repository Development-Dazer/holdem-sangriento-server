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
- Las siete habilidades, cuatro intervenciones de Favor y seis eventos globales.
- Recuperación de asiento mediante token aleatorio de 192 bits.
- Clasificación de pretemporada calculada por el servidor al finalizar una partida.
- Protección contra resultados duplicados mediante identificadores únicos de partida.

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
- Clasificación: `http://localhost:10000/leaderboard?limit=50`
- WebSocket: `ws://localhost:10000`

## Producción

- Salud: `https://holdem-sangriento-server.onrender.com/health`
- Clasificación: `https://holdem-sangriento-server.onrender.com/leaderboard?limit=50`
- WebSocket: `wss://holdem-sangriento-server.onrender.com`
- Plataforma: Render Web Service
- Despliegue: automático desde la rama `main`

El endpoint debe permanecer accesible desde Internet para los clientes del juego. La administración del servicio y el repositorio de origen son privados.

## Seguridad y límites

- Límite de 16 KiB por mensaje.
- Protocolo v2 obligatorio y cuota máxima de 40 comandos por 10 segundos y conexión.
- Validación de versión, tipo de comando, turno, saldo y cantidades.
- Contraseñas de sala resumidas en memoria; nunca se incluyen en el directorio.
- Estados privados generados individualmente para cada conexión.
- Comandos de anfitrión verificados en el servidor.
- Ping/pong periódico y terminación de conexiones inactivas.
- Las salas viven en memoria y se eliminan cuando dejan de tener conexiones.
- El cliente solo lee la clasificación; no existe un endpoint para declarar victorias o modificar puntos.

## Variables de clasificación

- `LEADERBOARD_SEASON`: identificador de temporada; por defecto `preseason-1`.
- `LEADERBOARD_FILE`: ruta para persistencia JSON local. Por defecto `./data/leaderboard.json`; una cadena vacía activa el modo únicamente en memoria.

El archivo conserva la pretemporada en desarrollo local y mientras exista el disco del servicio. El almacenamiento efímero del plan gratuito de Render puede desaparecer tras un redespliegue, por lo que la temporada pública estable requerirá una base de datos administrada y cuentas autenticadas.

## Estado del producto

La versión 2.2.0 ofrece el núcleo reglamentario completo, salas, habilidades, Favor, eventos, reconexión segura y clasificación experimental. La siguiente etapa competitiva contempla identidad autenticada, almacenamiento PostgreSQL, temporizadores de turno y observabilidad.

Este repositorio contiene únicamente el servicio de partidas. Los recursos gráficos y el proyecto Godot se mantienen fuera del despliegue.
