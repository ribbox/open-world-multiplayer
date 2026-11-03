# Open World Prototype (Multiplayer)

Browser-based open-world game with multiplayer support, packaged for Docker. The ground has hills, a river, and lakes. The minimap is divided into named zones and shows coordinates from 0 to 100 inside the current zone. The Map button on the minimap turns markers on or off. Hide the instruction box with ×; Help brings it back.

## Models
- `/models/player.glb` — more human low-poly civilian (CC0) used for the local player.
- `/models/npc.glb` — older shared minion, no longer used in game.
- `/models/boar.glb`, `wolf.glb`, `spider.glb`, `bandit.glb`, `ogre.glb`, `wisp.glb`, `knight.glb`, `cultist.glb` — one file per hostile type.
- `/models/terrain-grass.glb` — grass ground. Cliffs and deep water keep their own colors.
- `/models/terrain-sand.glb` — beach and shore.
- `/models/tree.glb` — trees that can be chopped.
- `/models/rock.glb` — static rocks. They block movement and cannot be mined.
- `/models/mine-rock.glb` — mining rocks. These are the nodes a pickaxe gathers.
- `/models/camp.glb`, `inn.glb`, `cabin.glb` — camp site, inn, and huts.
- `/models/chest.glb` — loot chests.
All of them are served by the Node.js server (no embedding).

Further GLB files should be taken from [Open Source 3D Assets](https://www.opensource3dassets.com/en). Check the asset page for the license, then add the original name, collection, and license to the credits below.

## Credits
These models are from [Open Source 3D Assets](https://www.opensource3dassets.com/en). The registry is maintained by ToxSam. The models were made by Polygonal Mind and are CC0, so they can be used and changed without asking. Credit is given here anyway.

| Game file | Original name | Collection |
| --- | --- | --- |
| `models/terrain-grass.glb` | TerrainGrass01 | Avatar Garden |
| `models/terrain-sand.glb` | TerrainSand01 | Avatar Garden |
| `models/tree.glb` | Tree01 | Avatar Garden |
| `models/rock.glb` | Rock_01 | Transit |
| `models/mine-rock.glb` | Rock02_Art | Tomb Chaser 2 |

Camp, inn, cabin, and chest are by [GuipGomes](https://sketchfab.com/GuipGomes) on Sketchfab. The license is [CC-BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/): credit is required, commercial use is not allowed, and changes must stay under the same license.

| Game file | Original name | Source |
| --- | --- | --- |
| `models/camp.glb` | Camp | https://sketchfab.com/3d-models/camp-ea0532fa7bfb4f5988113980a85eeb7e |
| `models/inn.glb` | Inn | https://sketchfab.com/3d-models/inn-bfe11cb5e3f64776bdf284648d64cd0c |
| `models/cabin.glb` | Cabin | https://sketchfab.com/3d-models/cabin-ec40bbe71e9442899f3f22b6fea0e010 |
| `models/chest.glb` | Chest | https://sketchfab.com/3d-models/chest-15a7657f143a4939a32457ebd9daffda |

## Run with Docker

```bash
docker-compose up --build
```

Open http://localhost:9898 for the game. World setup is a separate page at http://localhost:9898/setup . The first password is `admin`. Set `ADMIN_PASSWORD` on the container to lock it. From setup you can change the world size, choose a hill wall or a sea at the edge, draw zone outlines with straight or organic sides, and edit mobs, loot, camps, and resources. Drag the map to move it. A zone drawn past the coast is cut back to the shoreline. Export map downloads that world as JSON. Once a zone is drawn, the game only places the camps, people, and gather nodes from that map. Nothing else is scattered outside it, including into the sea. Each camp can be a hamlet, outpost, market, shrine, ruin, or ash ring. Every camp has an innkeeper, and talking to them sets the spawn you return to. Shop, trainer, and quest giver are optional. A steep slope cannot be climbed, and swimming only reaches a short way from shore.
Host port 9898 is mapped to the app inside the container (port 3000) so it does not collide with anything already using 3000 or 8080. If 9898 is also taken, change the left side in `docker-compose.yml` (for example `"9900:3000"`) and open that port instead.

## Manual Node.js run

```bash
npm install
node server.js
```

## Controls
- W/S or the arrow keys: move. A/D or Left/Right: turn. Turning eases in, and the camera swings behind you unless the right mouse button is held.
- Space: jump, Shift: sprint
- 1-8 use the current action-bar page. [ and ] change page. The slots, bag, and character buttons are icons. Right-click a slot to assign a trained action.
- Click an NPC or another player, or press Tab, to select them. Attacks hit the NPC. Mend heals the selected player, or you if nobody is selected.
- When you die you become a ghost at the spawn. Your body stays where you fell. Walk back to it and press Return to your body, or R, when the prompt appears.
- A hit flashes the NPC and pops a damage number. A killing blow tips the body over and bursts it apart. Damage you take reddens the screen.
- B opens the bag. C opens the character sheet. Choose Warrior or Mage once.
- The sheet equips a weapon and off hand around a body: head, neck, shoulders, cloak, chest, hands, waist, legs, and feet. Class spells are trained there. Each level after the first gives a talent point for that class's tree.
- Bag slots show an icon for the item. A count appears only when a stack is more than one. Right-click a slot to destroy one item. Shift+right-click destroys the whole stack, which frees room for new loot.
- Crafting is on the character sheet. Core sets are bought from a shop assistant, grouped by rarity. There is no shop button on the bar. Extra patterns drop in chests. Click a pattern in the bag to learn it.
- F: loot a chest. Click a health or mana potion in the bag to drink it, or put it on the action bar.
- M opens the world map. Scroll the wheel, or use + and −, to zoom. Right-click a spot to mark it. The minimap shows the point, or an arrow toward it. Left-click still teleports.
- While you are a ghost, the minimap shows a pale arrow toward your body, and the distance under the map.
- Hold Right Mouse + move: orbit camera
- Mouse wheel: zoom in/out on the character

## Notes
- The world map shows each zone's mob level. Green is close to your level, orange and red are higher, and gray is too far below you to give XP. Outlines drawn in the setup page are shown on the world map. Click a spot on the world map to teleport.
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