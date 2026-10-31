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
- 1-8 use the current action-bar page. [ and ] change page. The slots, bag, and character buttons are icons. Right-click a slot to assign a trained action.
- Click an NPC, or press Tab, to select it. Attacks and spells hit that target only, and only while it is in range. A red ring and a health plate mark the selection.
- Arcane Missile and Arcane Surge fly from the caster to the target. Extra missile ranks leave as extra bolts.
- B opens the bag. C opens the character sheet. Choose Warrior or Mage once.
- The sheet equips a weapon and off hand around a body: head, neck, shoulders, cloak, chest, hands, waist, legs, and feet. Class spells are trained there. Each level after the first gives a talent point for that class's tree.
- Bag slots show an icon for the item. A count appears only when a stack is more than one.
- F: loot a chest. H and M use the first health or mana potion.
- Hold Right Mouse + move: orbit camera
- Mouse wheel: zoom in/out on the character

## Notes
- The bag has 16 slots. Extra bags can raise that later through `bagSlots`. Wood and stone stack to 20, coins to 99, junk to 10, potions and armor scraps to 5. A full bag will not take the last gather hit, and a chest keeps whatever does not fit.
- Gathering and inventory are server-authoritative. Trees and rocks are shared, and a depleted node stays gone for everyone.
- Hostile NPCs roam, chase nearby players, and show up as red squares on the minimap. Their level sets their hit points. Armor reduces the damage they deal.
- A kill drops a chest at the body, shown in gold on the minimap. It lasts 60 seconds. Loot is rolled from the NPC level: junk is the most common drop, then coins, gathered wood or stone, health potions, mana potions, and armor scraps are the rarest.
- Press 1 for the sword attack, or put Power Strike on the bar. The staff's spells are Arcane Bolt and Mend. A kill grants XP. The XP needed for the next level is 50 times the current level.
- Level, XP, inventory, potions, coins, armor, and node state are saved in the Docker volume `game-data` (`/app/data/save.json`).
- Each browser keeps a player id in localStorage, so wood, stone, name, color, and level come back after a refresh.
- Other players use a SkeletonUtils clone of the human model, tinted, with a name above them.
- Change your name in the inventory panel. It is stored with your inventory.