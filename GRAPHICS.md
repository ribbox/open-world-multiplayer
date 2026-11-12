# Graphics

Each graphic used by the game, and the object it stands for. The object cell is empty when the graphic is only an effect and is not tied to a thing in the world.

A `*` at the start of a graphic name means that graphic should be used by the game. Once it is, the `*` is removed and this table shows the graphic the game actually uses.

## Effects

| Graphic | Object |
| --- | --- |
| Death burst | |
| Hit flash | |
| Damage number | |
| Heal number | |
| Experience number | |
| Hurt veil | |
| Arcane Missile bolt | |
| Arcane Surge bolt | |
| Mend glow | |
| Power Strike slash | |
| Cleave slash | |

## Spells and actions

Icons are cells on `icons/fantasy-icons.png`, the transparent sheet from Shikashi's Fantasy Icons Pack. Arcane Missile repeats that lightning cell once per rank.

| Graphic | Object |
| --- | --- |
| icons/fantasy-icons.png cell 81 | Sword |
| icons/fantasy-icons.png cell 48 | Power Strike |
| icons/fantasy-icons.png cell 49 | Cleave |
| icons/fantasy-icons.png cell 104 | Staff |
| icons/fantasy-icons.png cell 8 | Arcane Missile |
| icons/fantasy-icons.png cell 336 | Arcane Surge |
| icons/fantasy-icons.png cell 53 | Mend |
| icons/fantasy-icons.png cell 70 | Gather |
| icons/fantasy-icons.png cell 160 | Bag |
| icons/fantasy-icons.png cell 117 | Character sheet |
| Quest mark | Quest giver |

## Items

| Graphic | Object |
| --- | --- |
| icons/fantasy-icons.png cell 144 | Health potion |
| icons/fantasy-icons.png cell 145 | Mana potion |
| icons/fantasy-icons.png cell 172 | Rough Bomb, Bitter Flask, Heavy Bomb |
| icons/fantasy-icons.png cell 272 | Wood |
| icons/fantasy-icons.png cell 273 | Stone |
| icons/fantasy-icons.png cell 279 | Cloth |
| icons/fantasy-icons.png cell 280 | Leather |
| icons/fantasy-icons.png cell 274 | Ore |
| icons/fantasy-icons.png cell 276 | Gem |
| icons/fantasy-icons.png cell 191 | Herb |
| icons/fantasy-icons.png cell 321 | Powder |
| icons/fantasy-icons.png cell 200 | Coins |
| icons/fantasy-icons.png cell 268 | Junk |
| icons/fantasy-icons.png cell 218 | Recipe |
| icons/fantasy-icons.png cell 219 | Quest item |
| icons/fantasy-icons.png cell 120 | Cloth armor |
| icons/fantasy-icons.png cell 118 | Leather armor |
| icons/fantasy-icons.png cell 116 | Plate armor |

## Held tools

These are drawn on the character while that tool is in use. They are not separate world objects. The grip is the handle end.

| Graphic | Object | Link |
| --- | --- | --- |
| models/simple_axe.glb | Axe | https://skfb.ly/6UuGS |
| models/pick_axe.glb | Pickaxe | https://skfb.ly/pBtsV |
| models/stylized_emerald_sword.glb | Sword | https://skfb.ly/oK9Kq |
| models/wizards_staff.glb | Staff | https://skfb.ly/6CPOA |
| Target ring | Selected target | |

## World models

State is where that graphic stands. **Done** is the model the game should keep. **In game** is wired up, but it is still someone else's mesh or a painted one. **Needs work** is wired up and not finished. **Placeholder** is the old simple shape. **Not used** is a file the game no longer loads.

| Graphic | Object | Link | State |
| --- | --- | --- | --- |
| models/player.glb | Player | | In game. Untextured low-poly civilian. |
| models/npc.glb | | | Not used. |
| models/wild_pigboar_meshy.glb | Wild boar | https://skfb.ly/p9qVQ | In game. |
| models/low_poly_wolf.glb | Wolf | https://skfb.ly/698Sv | In game. Vertex colors. Faces the player. |
| models/low-poly_spider.glb | Moss spider | https://skfb.ly/6YONM | In game. Attacks from the front. |
| models/bandit.glb | Bandit | | Needs work. Textured and rigged, sword in the right hand, but the body still needs a pass. |
| models/ogre_lowpoly.glb | Hill ogre | https://skfb.ly/n5ifd0a | In game. Vertex colors. |
| models/wisp.glb | Fen wisp | | Placeholder. No texture or rig. |
| models/knight.glb | Plate knight | | Placeholder. No texture or rig. |
| models/cultist.glb | Cultist | | Placeholder. No texture or rig. |
| models/merchant.glb | Merchant | | Done. Textured, skinned, idle and walk. |
| models/innkeeper.glb | Innkeeper | | Done. Textured, skinned, idle and walk. |
| models/banker.glb | Banker | | Done. Textured, skinned, idle and walk. |
| models/trainer.glb | Trainer | | Done. Textured, skinned, idle and walk. |
| models/broker.glb | Market broker | | Done. Textured, skinned, idle and walk. |
| models/questgiver.glb | Quest giver | | Done. Textured, skinned, idle and walk. Replaces the cat. |
| models/camp.glb | Camp | Done | Done |
| models/inn.glb | Inn | Done | Done |
| models/cabin.glb | Cabin | Done | Done |
| models/chest.glb | Loot chest | Done | Done |
| models/terrain-grass.glb | Grass | Done | Done |
| models/terrain-sand.glb | Sand | Done | Done |
| models/tree.glb | Scenery tree | Done | Done |
| models/gather-tree.glb | Gatherable tree | Done | Done |
| models/rock.glb | Scenery rock | Done | Done |
| models/mine-rock.glb | Mining rock | Done | Done |
| Herb plant | Herb node | | Drawn in code. |
| Sulfur crystal | Sulfur node | | Drawn in code. |
| Water surface | River, lake, sea | | Drawn in code. |
| Cliff tint | World-edge hills | | Drawn in code. |
| Name plate | Named character | | Drawn in code. |
| Ghost tint | Dead player | | Drawn in code. |
| Corpse marker | Player body | | Drawn in code. |

Not used, so do not wire these again: `models/boar.glb`, `models/wolf.glb`, `models/spider.glb`, `models/ogre.glb`, `models/shop.glb`, `models/quest.glb`, `models/low-poly-person.glb`, `models/cat-person_untextured.glb`.
