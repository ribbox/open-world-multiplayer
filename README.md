# Open World Prototype (Multiplayer)

Browser-based open-world game with multiplayer support, packaged for Docker. The ground has hills, a river, and lakes. The minimap is divided into named zones and shows coordinates from 0 to 100 inside the current zone. The Map button on the minimap turns markers on or off. Hide the instruction box with ×; Help brings it back.

## Models
- `/models/player.glb` — more human low-poly civilian (CC0) used for the local player.
- `/models/npc.glb` — older shared minion, no longer used in game.
- `/models/boar.glb`, `wolf.glb`, `spider.glb`, `bandit.glb`, `ogre.glb`, `wisp.glb`, `knight.glb`, `cultist.glb` — one file per hostile type.
- `/models/shop.glb`, `trainer.glb`, `quest.glb` — friendly camp roles.
All of them are served by the Node.js server (no embedding).

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
- W/S: move, A/D: turn. Turning eases in, and the camera swings behind you unless the right mouse button is held.
- Space: jump, Shift: sprint
- 1-8 use the current action-bar page. [ and ] change page. The slots, bag, and character buttons are icons. Right-click a slot to assign a trained action.
- Click an NPC or another player, or press Tab, to select them. Attacks hit the NPC. Mend heals the selected player, or you if nobody is selected.
- When you die you become a ghost at the spawn. Your body stays where you fell. Walk back to it and press Return to your body, or R, when the prompt appears.
- A hit flashes the NPC and pops a damage number. A killing blow tips the body over and bursts it apart. Damage you take reddens the screen.
- B opens the bag. C opens the character sheet. Choose Warrior or Mage once.
- The sheet equips a weapon and off hand around a body: head, neck, shoulders, cloak, chest, hands, waist, legs, and feet. Class spells are trained there. Each level after the first gives a talent point for that class's tree.
- Bag slots show an icon for the item. A count appears only when a stack is more than one. Right-click a slot to destroy one item. Shift+right-click destroys the whole stack, which frees room for new loot.
- Crafting is on the character sheet. Core sets are bought from a shop assistant, grouped by rarity. There is no shop button on the bar. Extra patterns drop in chests. Click a pattern in the bag to learn it.
- F: loot a chest. H and M use the first health or mana potion.
- Hold Right Mouse + move: orbit camera
- Mouse wheel: zoom in/out on the character

## Notes
- The world map shows each zone's mob level. Green is close to your level, orange and red are higher, and gray is 5 or more levels below you. Killing a gray mob gives no XP. Click a spot on the world map to teleport.
- A shop assistant buys bag items and supplies. The coin price is rarity times quality: armor, magic, and potion strength raise it. Shift-click sells a whole stack. Spell training still requires a trainer. A character can learn only 2 crafting skills.
- Gathering and inventory are server-authoritative. Trees and rocks are shared, and a depleted node stays gone for everyone.
- Hostile NPCs roam, chase nearby players, and show up as red squares on the minimap. Each kind is a different shape: boar, wolf, spider, bandit, ogre, wisp, knight, and cultist. Each zone has its own creatures. Camp Glade is wild boars at level 1–2. Neighboring zones are wolves, spiders, or bandits, and farther zones are ogres, knights, wisps, and cultists at higher levels. Their loot follows the creature: hides, silk, coins, ore, gems, plate, or magic patterns. NPC level sets their hit points. Armor reduces the damage they deal.
- Friendly NPCs do not fight and use their own shapes. In Camp Glade, Mira sells crafting patterns, Bram trains spells, and Sela gives the boar quest. They are green on the minimap. Press T while standing next to one.
- A kill drops a chest at the body, shown in gold on the minimap. It lasts 60 seconds. The contents depend on the creature: boars and wolves drop leather, spiders drop cloth, bandits drop coins, ogres drop ore, knights drop plate, and wisps and cultists drop gems and magic patterns. Higher level creatures drop more.
- Press 1 for the sword attack, or put Power Strike on the bar. The staff's spells are Arcane Bolt and Mend. A kill grants XP. The XP needed for the next level is 50 times the current level.
- Level, XP, inventory, potions, coins, armor, and node state are saved in the Docker volume `game-data` (`/app/data/save.json`).
- Each browser keeps a player id in localStorage, so wood, stone, name, color, and level come back after a refresh.
- Other players use a SkeletonUtils clone of the human model, tinted, with a name above them.
- Change your name in the inventory panel. It is stored with your inventory.