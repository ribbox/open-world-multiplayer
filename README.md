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

Open http://localhost:9898 . The server serves the HTML and the model files.
Host port 9898 is mapped to the app inside the container (port 3000) so it does not collide with anything already using 3000 or 8080. If 9898 is also taken, change the left side in `docker-compose.yml` (for example `"9900:3000"`) and open that port instead.

## Manual Node.js run

```bash
npm install
node server.js
```

## Controls
- W/S: move, A/D: turn
- Space: jump, Shift: sprint
- 1/2/3: axe, pickaxe, sword. E: swing, gather, or attack
- Hold Right Mouse + move: orbit camera
- Mouse wheel: zoom in/out on the character

## Notes
- Gathering and inventory are server-authoritative. Trees and rocks are shared, and a depleted node stays gone for everyone.
- Hostile NPCs roam, chase nearby players, and show up as red squares on the minimap. Their level sets their hit points.
- Press 3 for the sword, then E while close to an NPC to attack. A kill grants XP. The XP needed for the next level is 50 times the current level.
- Level, XP, inventory, and node state are saved in the Docker volume `game-data` (`/app/data/save.json`).
- Each browser keeps a player id in localStorage, so wood, stone, name, color, and level come back after a refresh.
- Other players use a SkeletonUtils clone of the human model, tinted, with a name above them.
- Change your name in the inventory panel. It is stored with your inventory.