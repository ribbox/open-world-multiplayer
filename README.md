# Open World Prototype (Multiplayer)

Browser-based open-world game with multiplayer support, packaged for Docker. The ground has hills, a river, and lakes. The minimap is divided into named zones and shows coordinates from 0 to 100 inside the current zone. The Map button on the minimap turns markers on or off. Hide the instruction box with ×; Help brings it back.

## Models
- `/models/player.glb` — more human low-poly civilian (CC0) used for the local player.
- `/models/npc.glb` — older shared minion, no longer used in game.
- `/models/boar.glb` is unused. Wild boars use `/models/wild_pigboar_meshy.glb`.
- `/models/wolf.glb`, `spider.glb`, `bandit.glb`, `ogre.glb`, `wisp.glb`, `knight.glb`, `cultist.glb` — one file per other hostile type.
- `/models/terrain-grass.glb` — grass ground. Cliffs and deep water keep their own colors.
- `/models/terrain-sand.glb` — beach and shore.
- `/models/tree.glb` — scenery trees. They block movement and cannot be chopped.
- `/models/gather-tree.glb` — trees placed in world setup that an axe can chop.
- `/models/rock.glb` — scenery rocks. They block movement and cannot be mined.
- `/models/mine-rock.glb` — rocks placed in world setup that a pickaxe can mine.
- `/models/camp.glb`, `inn.glb`, `cabin.glb` — camp site, inn, and huts.
- `/models/chest.glb` — loot chests.
All of them are served by the Node.js server (no embedding). [GRAPHICS.md](GRAPHICS.md) lists every graphic and the object it stands for. An empty object means the graphic is only an effect.

Further GLB files should be taken from [Open Source 3D Assets](https://www.opensource3dassets.com/en). Check the asset page for the license, then add the original name, collection, and license to the credits below.

## Credits
These models are from [Open Source 3D Assets](https://www.opensource3dassets.com/en). The registry is maintained by ToxSam. The models were made by Polygonal Mind and are CC0, so they can be used and changed without asking. Credit is given here anyway.

| Game file | Original name | Collection |
| --- | --- | --- |
| `models/terrain-grass.glb` | TerrainGrass01 | Avatar Garden |
| `models/terrain-sand.glb` | TerrainSand01 | Avatar Garden |
| `models/tree.glb` | Tree01 | Avatar Garden |
| `models/gather-tree.glb` | Tree04 | Avatar Garden |
| `models/rock.glb` | Rock_01 | Transit |
| `models/mine-rock.glb` | Rock02_Art | Tomb Chaser 2 |

Camp, inn, cabin, and chest are by [GuipGomes](https://sketchfab.com/GuipGomes) on Sketchfab. The license is [CC-BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/): credit is required, commercial use is not allowed, and changes must stay under the same license.

| Game file | Original name | Source |
| --- | --- | --- |
| `models/camp.glb` | Camp | https://sketchfab.com/3d-models/camp-ea0532fa7bfb4f5988113980a85eeb7e |
| `models/inn.glb` | Inn | https://sketchfab.com/3d-models/inn-bfe11cb5e3f64776bdf284648d64cd0c |
| `models/cabin.glb` | Cabin | https://sketchfab.com/3d-models/cabin-ec40bbe71e9442899f3f22b6fea0e010 |
| `models/chest.glb` | Chest | https://sketchfab.com/3d-models/chest-15a7657f143a4939a32457ebd9daffda |

Spell and item icons are cells from `icons/fantasy-icons.png`, the transparent sheet in [Shikashi's Fantasy Icons Pack](https://shikashipx.itch.io/shikashis-fantasy-icons-pack) by Matt Firth (shikashipx). The license is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Many of the icons are based on [game-icons.net](https://game-icons.net/). Credit both.

The held axe, pickaxe, sword, and staff, and the wild boar, are the models linked in [GRAPHICS.md](GRAPHICS.md).

## Run with Docker

```bash
docker-compose up --build
```

Open http://localhost:9898 for the game. World setup is a separate page at http://localhost:9898/setup . The first password is `admin`. Set `ADMIN_PASSWORD` on the container to lock it. From setup you can change the world size, choose a hill wall or a sea at the edge, draw zone outlines with straight or organic sides, and edit mobs, loot, camps, and resources. The Road tool connects two camps. Click the first camp, add bends, click the next camp, then Finish outline. Straight or organic sets each stretch. The path is flattened so it can be walked, and it shows on the minimap and world map once explored. Drag the map to move it. A zone drawn past the coast is cut back to the shoreline. Export map downloads that world as JSON. Once a zone is drawn, the game only places the camps, people, and gather nodes from that map. Nothing else is scattered outside it, including into the sea. Each camp can be a hamlet, outpost, market, shrine, ruin, or ash ring. Every camp has an innkeeper, and talking to them sets the spawn you return to. Shop, trainer, and quest giver are optional. A steep slope cannot be climbed, and swimming only reaches a short way from shore.
Host port 9898 is mapped to the app inside the container (port 3000) so it does not collide with anything already using 3000 or 8080. If 9898 is also taken, change the left side in `docker-compose.yml` (for example `"9900:3000"`) and open that port instead.

## Manual Node.js run

```bash
npm install
node server.js
```

## Controls
- W/S or the arrow keys: move. A/D or Left/Right: turn. Turning eases in, and the camera swings behind you unless the right mouse button is held.
- Space: jump, Shift: sprint
- 1-8 use the current action-bar page. [ and ] change page. The slots, bag, and character buttons are icons. Right-click a slot to assign a trained action. A slot turns dark and counts down while that action is cooling. A sword, a bolt, and a potion each wait a different time. Health and mana potions share one wait. Reaching a new level shows a short Level line.
- Click an NPC or another player, or press Tab, to select them. Attacks hit the NPC. Mend heals the selected player, or you if nobody is selected.
- When you die you become a ghost at the spawn. Your body stays where you fell. Walk back to it and press Return to your body, or R, when the prompt appears.
- A hit flashes the NPC and pops a damage number. Casting a spell spends mana at once, and the blue globe falls. A sword swing is free at rank 1. Each spell trains to rank 5, two levels apart. A higher rank hits about 20% harder and spends more mana. Arcane Missile gains a second bolt at rank 3 and a third at rank 5. Hamstring and Frost Bolt slow a creature to a crawl. Execute deals double damage once a foe is under 35% health. Cleave hits the target and anyone beside them, and Whirlwind and Frost Nova hit everything around you. Barrier absorbs incoming damage for 15 seconds. Health returns at about 4% a second, and only after 6 seconds out of combat. Mana always returns: a base trickle plus Intellect and Stamina. A killing blow tips the body over and bursts it apart. Damage you take flashes the screen red. A red tint stays and deepens as your health falls. The red globe by the action bar is health, and the blue globe is mana.
- B opens the bag. C opens the character sheet. Choose Warrior or Mage once.
- The sheet equips a weapon and off hand around a body: head, neck, shoulders, cloak, chest, hands, waist, legs, and feet. Class spells are trained there. Each level after the first gives a talent point for that class's tree. Warriors grow Strength, mages grow Intellect, and both grow Stamina. Worn gear adds to those stats. Strength raises melee damage, Intellect raises spell damage, Mend, and mana, and Stamina raises health.
- Bag slots show an icon for the item. Hover a slot to see what it does: a potion shows how much it restores, and armor shows cloth, leather, or plate, the worn slot, its armor, the Strength, Stamina, or Intellect it adds, and the level required to equip it. Potions with a different restore amount do not share a stack. A count appears only when a stack is more than one. Right-click a slot to destroy one item. Shift+right-click destroys the whole stack, which frees room for new loot.
- Crafting is on the character sheet. Core sets are bought from a shop assistant, grouped by rarity. There is no shop button on the bar. Extra patterns drop in chests. Click a pattern in the bag to learn it. Crafted armor and weapons grant Strength, Stamina, or Intellect. Cloth and staves favor Intellect, swords and leather favor Strength, and plate also adds Stamina. The craft list shows the bonus before you make it.
- F: loot a chest. Stand at a purple portal and press F to enter a dungeon. Inside, the entrance portal is the only way out. Click a health or mana potion in the bag to drink it, or put it on the action bar. Explosives can be assigned the same way and are thrown at the targeted hostile.
- M opens the world map. Scroll the wheel, or use + and −, to zoom. Right-click a spot to mark it. The minimap shows the point, or an arrow toward it. Left-click still teleports, except inside a dungeon.
- World setup can export and import the whole world: rules, coast, zones, camps, nodes, roads, dungeons, loot, quests, and items. Download spreadsheet saves the current items and quests. Copy items or Copy quests puts the same rows on the clipboard so you can click cell A1 and paste. In Google Sheets you can also use File, Import, Upload, and replace the current sheet. Share that sheet as anyone with the link, edit it, then paste the link and import. Name and a plain description come first, and the game id is the last column. Zone, dungeon, and icon are dropdowns of names, such as Plate helm or Sword. A picture cell number can still be typed. Cost is written as cloth:2, ore:1. Leave Game id alone on an existing row. A blank Game id on a new row is filled from the name. A quest reward that uses an item's name keeps that item's icon and stats. An older spreadsheet with the previous column names still imports. A file can still be imported if you already have one.
- The Dungeons tab builds a short cave. Place its portal on the world map, then draw the route. The first point is the entrance and the last point is the end. The corridor is wide and the roof is high. Rocks, roots, and pillars on the edge block the path. A killed mob stays dead. Mobs wait until you walk a few meters in from the entrance. A quest can be marked for that dungeon: the work is done inside, and the end NPC takes the hand-in. A named kill waits at the end.
- The Quests tab builds quests for a zone. The giver is an NPC from that zone. While a kill or gather quest is active, more of that mob appears nearby. A gather item is placed in that mob's chest, and some chests do not have it. Progress counts when you loot the item. L opens the quest log, grouped by zone. Up to five quests can be tracked on screen. A tracked quest marks the zone, the dungeon portal, or the turn-in on the minimap. Gold is the place to work, purple is a dungeon, and green is the hand-in.
- Open the character sheet and choose Reset character to clear level, class, spells, talents, crafting, quests, bag, coins, and explored map.
- Target another player and press P to invite them. A party holds you and up to four others. The frames on the left show each name, health, and mana. A kill splits its experience across party members within 30 paces, and it counts for each of them who has that quest.
- While you are a ghost, the minimap shows a pale arrow toward your body, and the distance under the map.
- Hold Right Mouse + move: orbit camera
- Mouse wheel: zoom in/out on the character

## Notes
- The world map shows each zone's mob level. Green is close to your level, orange and red are higher, and gray is too far below you to give XP. Outlines drawn in the setup page are shown on the world map. Click a spot on the world map to teleport.
- A shop assistant has Buy and Sell tabs. Buy lists a stack of health potions and a stack of mana potions, then the crafting skills, grouped by rarity. Sell lists what you carry, also by rarity. Prices are in coins: 100 coins make 1 silver, and 100 silver make 1 gold. The coin price is rarity times quality: armor, magic, potion strength, and stat bonuses raise it. Shift-click sells a whole stack. A trainer has Spells and Talents tabs. Spell training still requires standing there. A character can learn only 2 crafting skills. An innkeeper or quest giver adds a Quests tab when they have work for you.
- Gathering and inventory are server-authoritative. Trees and rocks are shared, and a depleted node stays gone for everyone.
- Hostile NPCs roam and chase nearby players, but they walk out of a camp. A player inside a camp cannot hit them. They show up as red squares on the minimap. Elites are larger gold squares. Mark a zone as an Elite area in setup and every mob there has more health, hits harder, and has a gold nameplate. A named-mob quest can be elite or normal on its own. Each kind is a different shape: boar, wolf, spider, bandit, ogre, wisp, knight, and cultist. Each zone has its own creatures. Camp Glade is wild boars at level 1–2. Neighboring zones are wolves, spiders, or bandits, and farther zones are ogres, knights, wisps, and cultists at higher levels. Their loot follows the creature: hides, silk, coins, ore, gems, plate, or magic patterns. A chest holds at most coins, one item, and a piece of junk. About half the time that item is gear. A level 1 creature drops a small Strength or Intellect bonus anyone can wear. A level 10 creature drops a larger bonus to that stat and to Stamina, and it needs a higher level to equip. Beasts, bandits, and plate favor Strength. Spiders, wisps, and cultists favor Intellect. Patterns turn up in about one chest in twenty-five. Physical mobs hit with Strength and casters with Intellect. Stamina raises their health. Armor reduces the damage they deal. A zone sets how many mobs spawn per minute and the most that can be alive there. Those spawns are spread at random through the minute, not released all at once. Land that is not inside a drawn zone uses the same two numbers from the Rules tab.
- Friendly NPCs do not fight and use their own shapes. In Camp Glade, Mira sells crafting patterns, Bram trains spells, and Sela gives the boar quest. They are green on the minimap. Press T while standing next to one.
- A kill drops a chest at the body, shown in gold on the minimap. It lasts 60 seconds. The contents depend on the creature: boars and wolves drop leather, spiders drop cloth, bandits drop coins, ogres drop ore, knights drop plate, and wisps and cultists drop gems and magic patterns. Higher level creatures drop more.
- Press 1 for the sword attack, or put Power Strike on the bar. The staff's spells are Arcane Bolt and Mend. A kill grants XP. The XP needed for the next level is 50 times the current level.
- Level, XP, inventory, potions, coins, armor, and node state are saved in the Docker volume `game-data` (`/app/data/save.json`).
- Each browser keeps a player id in localStorage, so wood, stone, name, color, and level come back after a refresh.
- Other players use a SkeletonUtils clone of the human model, tinted, with a name above them.
- Change your name in the inventory panel. It is stored with your inventory.