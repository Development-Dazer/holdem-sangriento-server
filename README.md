# Servidor autoritativo

## Desarrollo

```text
npm install
npm test
npm start
```

Salud: `http://localhost:10000/health`  
WebSocket: `ws://localhost:10000`

El servidor nunca incluye el mazo ni cartas privadas ajenas en `room_state`. Cada conexión recibe un `game_state` generado mediante `privateState(playerId)`.

## Implementado

- Salas privadas de 2 a 4 jugadores.
- Personajes únicos y estado listo.
- Mazo Fisher–Yates con aleatoriedad criptográfica de Node.
- Dealer, ciegas, heads-up y orden por calles.
- Check, call, fold, raise y All-in.
- Subida mínima y All-in corto sin reapertura ilegal.
- Showdown, evaluador completo y pozos laterales.
- Rechazo de turno, acción y cantidad inválidos.

## Pendiente antes de producción

- Eventos, habilidades y Favor autoritativos.
- Reconexión mediante token rotativo.
- Temporizador y abandono.
- Persistencia opcional de perfiles/estadísticas.
- Mesa remota completa en Godot y pruebas reales con latencia.

