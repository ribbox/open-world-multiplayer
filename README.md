# Open World Prototype (Multiplayer)

Browser-based open-world game with multiplayer support, packaged for Docker.

## Models
- `/models/player.glb` — more human low-poly civilian (CC0) used for the local player.
- `/models/npc.glb` — previous minion model used for NPCs.
Both are served by the Node.js server (no embedding).

## Run with Docker

```bash
docker-compose up --build
```

Open http://localhost:3000 . The server serves the HTML and the model files.

## Manual Node.js run

```bash
npm install
node server.js
```

## Controls
- W/S: move, A/D: turn
- Space: jump, Shift: sprint
- 1/2: switch tool, E: swing/gather
- Hold Right Mouse + move: orbit camera

## Notes
- Gathering is currently client-side (each player sees their own inventory).
- Remote players are shown as simple capsule characters for reliability.
- For production, add authentication, persistence, and server-authoritative gathering.
