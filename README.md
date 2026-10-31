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

Open http://localhost:8080 . The server serves the HTML and the model files.
Host port 8080 is mapped to the app inside the container (port 3000) so it does not collide with anything already using 3000. If 8080 is also taken, change the left side in `docker-compose.yml` (for example `"8090:3000"`) and open that port instead.

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