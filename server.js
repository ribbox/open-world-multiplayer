import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { chunkResources, zoneAt, zoneNpc, zoneCamp, zoneCampPlan, campSpot, zoneInWorld, clampWorld, sellPrice, fogCellsAround, terrainHeight, designedZoneAt, listDesignedZones, listRoads, applyWorldConfig, worldShape, boundaryInset, blocksClimb, swimTooFar, customMap, waterAt, ZONE_SIZE, WORLD_RADIUS, listDungeons, dungeonById, dungeonWorld, dungeonClamp, dungeonBlocked, dungeonTravel } from './worldgen.js';
import { defaultIconName, iconKeyFromChoice } from './icons.js';
import { buildWorkbook, readWorkbook, spreadsheetUrl, clipboardSheets } from './sheets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const GATHER_RANGE = 3.2;
const GATHER_COOLDOWN_MS = 400;
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ec4899'];
const worldRules = { hpBase: 6, hpPerLevel: 4, grayLevels: 5, xpPerMobLevel: 20, spawnPerMin: 4, spawnCap: 8 };
let lootTables = null;

const dataDir = path.join(__dirname, 'data');
const savePath = path.join(dataDir, 'save.json');

app.use((req, res, next) => {
    if (req.path.startsWith('/data') || req.path === '/server.js' || req.path === '/package.json' || req.path === '/Dockerfile') {
        res.status(404).end();
        return;
    }
    next();
});
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));

function loadSave() {
    try {
        const parsed = JSON.parse(fs.readFileSync(savePath, 'utf8'));
        return {
            resources: parsed.resources && typeof parsed.resources === 'object' ? parsed.resources : {},
            players: parsed.players && typeof parsed.players === 'object' ? parsed.players : {}
        };
    } catch {
        return { resources: {}, players: {} };
    }
}

const save = loadSave();
let saveTimer = null;

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(savePath, JSON.stringify(save));
        } catch (err) {
            console.error('Save failed', err);
        }
    }, 200);
}

function colorFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
}

function sanitizeName(name) {
    const cleaned = String(name || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 16);
    return cleaned || 'Player';
}

function resourceById(id) {
    if (typeof id !== 'string') return null;
    const parts = id.split(',');
    if (parts.length !== 3) return null;
    const cx = Number(parts[0]);
    const cz = Number(parts[1]);
    const index = Number(parts[2]);
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || !Number.isInteger(index) || index < 0) return null;
    const list = chunkResources(cx, cz);
    return list[index] || null;
}

function hitsFor(id) {
    if (Object.prototype.hasOwnProperty.call(save.resources, id)) return save.resources[id];
    const base = resourceById(id);
    return base ? base.hits : null;
}

const players = new Map();
const npcs = new Map();
const AGGRO_RANGE = 9;
const ATTACK_RANGE = 2.6;
const NPC_HIT_RANGE = 1.55;
const SETTLEMENT_RADIUS = 28;

const NPC_KINDS = {
    boar: { id: 'boar', name: 'Wild Boar', tint: '#8d6a3a', loot: 'hide' },
    wolf: { id: 'wolf', name: 'Wolf', tint: '#7f8c8d', loot: 'hide' },
    spider: { id: 'spider', name: 'Moss Spider', tint: '#1e8449', loot: 'silk' },
    bandit: { id: 'bandit', name: 'Bandit', tint: '#c0392b', loot: 'bandit' },
    ogre: { id: 'ogre', name: 'Hill Ogre', tint: '#6e4b2a', loot: 'ore' },
    wisp: { id: 'wisp', name: 'Fen Wisp', tint: '#5dade2', loot: 'wisp' },
    knight: { id: 'knight', name: 'Plate Knight', tint: '#d5d8dc', loot: 'plate' },
    cultist: { id: 'cultist', name: 'Cultist', tint: '#8e44ad', loot: 'magic' }
};

const GLADE_INN = campSpot('hamlet', 'inn', 0, 6);
const DEFAULT_SPAWN = { x: GLADE_INN.x, z: GLADE_INN.z, name: 'Holt' };

const CIVILIANS = [
    { id: 'mira', name: 'Mira', role: 'shop', title: 'Shop assistant', tint: '#f1c40f', x: 10, z: 4, text: 'I buy what you carry and sell potions and crafting skills. Bring coins.' },
    { id: 'bram', name: 'Bram', role: 'trainer', title: 'Trainer', tint: '#5dade2', x: -10, z: 4, text: 'Choose a class, then train your spells with me. I also teach crafting tiers.' },
    { id: 'sela', name: 'Sela', role: 'quest', title: 'Quest giver', tint: '#2ecc71', x: 0, z: 14, text: 'The boars are tearing up the glade.', quest: 'boar-tusks' },
    { id: 'holt', name: 'Holt', role: 'inn', title: 'Innkeeper', tint: '#e67e22', x: GLADE_INN.x, z: GLADE_INN.z, text: 'I keep the inn. Set your rest here, then press H to return. I also have a spare sack if you clear some wolves.' },
    { id: 'nessa', name: 'Nessa', role: 'bank', title: 'Banker', tint: '#f4d03f', x: GLADE_INN.x + 3.2, z: GLADE_INN.z + 1.2, text: 'The vault is only here, in the main settlement. I will hold what you do not want to carry.' },
    { id: 'wren', name: 'Wren', role: 'quest', title: 'Fen watcher', tint: '#5dade2', x: 160, z: 30, text: 'The chapel drowned, but the prior did not. Clear the fen, then take a party of four through the portal.' }
];

function pushCampRole(list, camp, zone, index, role, title, tint, text) {
    const name = camp[role];
    if (!name) return;
    const spot = campSpot(camp.layout, role, camp.x, camp.z);
    if (!campStanding(spot.x, spot.z)) return;
    list.push({
        id: 'd' + role + '-' + zone.id + '-' + index,
        name,
        role,
        title,
        tint,
        x: spot.x,
        z: spot.z,
        text,
        quest: ''
    });
}

function onLand(x, z) {
    return boundaryInset(x, z) >= 6 && !waterAt(x, z);
}

function campStanding(x, z) {
    if (designedZoneAt(x, z) && boundaryInset(x, z) >= -2) return true;
    return boundaryInset(x, z) >= 0 && !waterAt(x, z);
}

function mapSpawn() {
    if (customMap()) {
        const sites = campSites();
        if (sites[0]) {
            const spot = campSpot(sites[0].layout || 'hamlet', 'inn', sites[0].x, sites[0].z);
            if (onLand(spot.x, spot.z)) return { x: spot.x, z: spot.z, name: 'Inn' };
            if (onLand(sites[0].x, sites[0].z)) return { x: sites[0].x, z: sites[0].z, name: 'Camp' };
        }
        const zone = listDesignedZones()[0];
        if (zone && zone.points && zone.points[0]) return { x: zone.points[0][0], z: zone.points[0][1], name: zone.name || 'Camp' };
    }
    return DEFAULT_SPAWN;
}

function rebuildCivilians() {
    const home = CIVILIANS.filter(civ => civ.id === 'mira' || civ.id === 'bram' || civ.id === 'sela' || civ.id === 'holt' || civ.id === 'nessa' || civ.id === 'wren');
    CIVILIANS.length = 0;
    if (!customMap()) CIVILIANS.push(...home);
    if (!customMap()) {
        for (let zx = -WORLD_RADIUS; zx <= WORLD_RADIUS; zx++) {
            for (let zz = -WORLD_RADIUS; zz <= WORLD_RADIUS; zz++) {
                if (zx === 0 && zz === 0) continue;
                const plan = zoneCampPlan(zx, zz);
                if (!onLand(plan.x, plan.z)) continue;
                const drawn = designedZoneAt(plan.x, plan.z);
                if (drawn && drawn.camps.length) continue;
                CIVILIANS.push(...plan.folk.filter(person => onLand(person.x, person.z)));
            }
        }
    }
    for (const zone of listDesignedZones()) {
        zone.camps.forEach((camp, index) => {
            if (!campStanding(camp.x, camp.z)) return;
            pushCampRole(CIVILIANS, camp, zone, index, 'inn', 'Innkeeper', '#e67e22', 'I keep the inn in ' + zone.name + '. Set your rest here, then press H to return.');
            pushCampRole(CIVILIANS, camp, zone, index, 'shop', 'Shop', '#f1c40f', 'I buy and sell in ' + zone.name + '.');
            pushCampRole(CIVILIANS, camp, zone, index, 'trainer', 'Trainer', '#5dade2', 'I train spells in ' + zone.name + '.');
            pushCampRole(CIVILIANS, camp, zone, index, 'quest', 'Quest giver', '#2ecc71', 'I keep the road through ' + zone.name + '.');
        });
    }
    for (const dungeon of listDungeons()) {
        const live = dungeonById(dungeon.id) || dungeon;
        const samples = live.samples && live.samples.length ? live.samples : live.points;
        const spotLocal = retreatAlong(samples, 3.4);
        const spot = dungeonWorld(live, spotLocal[0], spotLocal[1]);
        CIVILIANS.push({
            id: 'dend-' + dungeon.id,
            name: dungeon.endName || 'Warden',
            role: 'quest',
            title: 'Inside ' + dungeon.name,
            tint: '#bb88ff',
            x: spot.x,
            z: spot.z,
            text: 'The only way out is the portal. I take what you finished in here.',
            quest: '',
            dungeonId: dungeon.id
        });
    }
    if (customMap() && !CIVILIANS.some(civ => civ.role === 'bank')) {
        const spawn = mapSpawn();
        let best = null;
        for (const civ of CIVILIANS) {
            if (civ.role !== 'inn') continue;
            const dist = Math.hypot(civ.x - spawn.x, civ.z - spawn.z);
            if (!best || dist < best.dist) best = { dist, civ };
        }
        if (best) {
            CIVILIANS.push({
                id: 'nessa',
                name: 'Nessa',
                role: 'bank',
                title: 'Banker',
                tint: '#f4d03f',
                x: best.civ.x + 2.4,
                z: best.civ.z,
                text: 'The vault is only here, in the main settlement. I will hold what you do not want to carry.'
            });
        }
    }
    rememberSettlements();
}

function campSites() {
    const sites = [];
    if (!customMap() && onLand(0, 6)) sites.push({ id: 'glade', x: 0, z: 6, layout: 'hamlet' });
    if (!customMap()) {
        for (let zx = -WORLD_RADIUS; zx <= WORLD_RADIUS; zx++) {
            for (let zz = -WORLD_RADIUS; zz <= WORLD_RADIUS; zz++) {
                if (zx === 0 && zz === 0) continue;
                const plan = zoneCampPlan(zx, zz);
                if (!onLand(plan.x, plan.z)) continue;
                const drawn = designedZoneAt(plan.x, plan.z);
                if (drawn && drawn.camps.length) continue;
                sites.push({ id: plan.id, x: plan.x, z: plan.z, layout: plan.layout });
            }
        }
    }
    for (const zone of listDesignedZones()) {
        zone.camps.forEach((camp, index) => {
            if (!campStanding(camp.x, camp.z)) return;
            sites.push({ id: 'dcamp-' + zone.id + '-' + index, x: camp.x, z: camp.z, layout: camp.layout || 'hamlet' });
        });
    }
    return sites;
}

let settlementSites = [];
function rememberSettlements() {
    settlementSites = campSites().map(site => ({ x: site.x, z: site.z }));
}

function inSettlement(x, z) {
    return !!settlementAt(x, z);
}

function settlementAt(x, z) {
    let best = null;
    const reach = SETTLEMENT_RADIUS * SETTLEMENT_RADIUS;
    for (const site of settlementSites) {
        const dx = x - site.x;
        const dz = z - site.z;
        const d = dx * dx + dz * dz;
        if (d <= reach && (!best || d < best.d)) best = { x: site.x, z: site.z, d };
    }
    return best;
}

function outsideSettlement(x, z) {
    const site = settlementAt(x, z);
    if (!site) return { x, z };
    const dist = Math.sqrt(site.d) || 1;
    let dx = (x - site.x) / dist;
    let dz = (z - site.z) / dist;
    if (!dx && !dz) { dx = 1; dz = 0; }
    const reach = SETTLEMENT_RADIUS + 2;
    return { x: site.x + dx * reach, z: site.z + dz * reach };
}

rebuildCivilians();

function publicCivilian(civ) {
    const quests = Array.isArray(civ.quests) ? civ.quests : (civ.quest ? [civ.quest] : []);
    return { id: civ.id, name: civ.name, role: civ.role, title: civ.title, tint: civ.tint, x: civ.x, z: civ.z, text: civ.text, quest: quests[0] || '', quests, dungeonId: civ.dungeonId || '' };
}

const QUEST_TYPES = ['kill', 'gather', 'named', 'protect'];
const MOB_IDS = ['boar', 'wolf', 'spider', 'bandit', 'ogre', 'wisp', 'knight', 'cultist'];

function questBlurb(quest) {
    if (quest.custom && quest.text) return quest.text;
    const mob = NPC_KINDS[quest.mob];
    const label = mob ? mob.name : 'creature';
    const many = quest.count === 1 ? label : label + 's';
    let text;
    if (quest.type === 'gather') {
        const who = quest.named || many;
        text = 'Gather ' + quest.count + ' ' + (quest.item || 'items') + '. ' + who + ' sometimes leave them in a chest.';
    } else if (quest.type === 'named') text = 'Kill ' + (quest.elite ? 'the elite ' : '') + (quest.named || label) + '.';
    else if (quest.type === 'protect') text = 'Protect ' + (quest.named || 'the villager') + '. They leave the camp. Defeat ' + quest.count + ' attackers.';
    else text = 'Kill ' + quest.count + ' ' + many + '.';
    if (quest.dungeonId) {
        const cave = dungeonById(quest.dungeonId);
        if (cave) text += ' Do this in ' + cave.name + ', then turn it in at the end.';
    }
    return text;
}

const QUESTS = {
    'boar-tusks': {
        id: 'boar-tusks',
        name: 'Boar Tusks',
        text: 'Kill 3 wild boars in Camp Glade.',
        custom: true,
        type: 'kill',
        mob: 'boar',
        kind: 'boar',
        count: 3,
        coins: 20,
        xp: 50,
        minLevel: 1,
        giver: 'Sela',
        requires: '',
        item: '',
        named: '',
        rewardKind: '',
        rewardName: '',
        rewardQty: 1,
        designed: false
    },
    'pack-for-the-road': {
        id: 'pack-for-the-road',
        name: 'Pack for the Road',
        text: 'Kill 4 wolves. Holt will give you a linen sack.',
        custom: true,
        type: 'kill',
        mob: 'wolf',
        kind: 'wolf',
        count: 4,
        coins: 15,
        xp: 40,
        minLevel: 1,
        giver: 'Holt',
        requires: '',
        item: '',
        named: '',
        rewardKind: 'bag',
        rewardName: 'Linen Sack',
        rewardQty: 1,
        designed: false
    }
};

function questZoneName(quest) {
    if (quest && quest.dungeonId) {
        const cave = dungeonById(quest.dungeonId);
        if (cave) return cave.name;
    }
    if (!quest || !quest.zoneId) return '';
    const zone = listDesignedZones().find(entry => entry.id === quest.zoneId);
    return zone ? zone.name : '';
}

function publicQuests() {
    const out = {};
    for (const [id, quest] of Object.entries(QUESTS)) {
        out[id] = {
            name: quest.name,
            text: questBlurb(quest),
            count: quest.count,
            coins: quest.coins,
            xp: quest.xp,
            type: quest.type || 'kill',
            minLevel: quest.minLevel || 1,
            requires: quest.requires || '',
            item: quest.item || '',
            named: quest.named || '',
            zoneId: quest.zoneId || '',
            zoneName: questZoneName(quest),
            dungeonId: quest.dungeonId || '',
            giver: quest.giver || '',
            rewardKind: quest.rewardKind || '',
            rewardName: quest.rewardName || '',
            rewardQty: quest.rewardQty || 1
        };
    }
    return out;
}

function readSpawn(prof) {
    const spawn = prof && prof.spawn;
    const x = Number(spawn && spawn.x);
    const z = Number(spawn && spawn.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return mapSpawn();
    if (customMap() && boundaryInset(x, z) < 0) return mapSpawn();
    return { x, z, name: String(spawn.name || 'Inn').slice(0, 16) };
}

function loadQuests(prof) {
    const next = {};
    const raw = prof.quests && typeof prof.quests === 'object' ? prof.quests : {};
    for (const [id, row] of Object.entries(raw)) {
        if (!QUESTS[id] || !row) continue;
        next[id] = {
            state: row.state === 'done' ? 'done' : 'active',
            count: Math.max(0, Math.min(QUESTS[id].count, Number(row.count) || 0)),
            failed: !!row.failed
        };
    }
    prof.quests = next;
}

function nearCivilian(player, id) {
    const civ = CIVILIANS.find(entry => entry.id === id);
    if (!civ) return null;
    if (Math.hypot(civ.x - player.x, civ.z - player.z) > 3.6) return null;
    return civ;
}

function nearRole(player, role) {
    return CIVILIANS.find(civ => civ.role === role && Math.hypot(civ.x - player.x, civ.z - player.z) <= 3.6) || null;
}

function placePlayer(player, data) {
    if (typeof data.x === 'number' && Number.isFinite(data.x)) player.x = data.x;
    if (typeof data.z === 'number' && Number.isFinite(data.z)) player.z = data.z;
    const edge = clampWorld(player.x, player.z, 2.2);
    player.x = edge.x;
    player.z = edge.z;
}

function noteKill(player, npc) {
    let changed = false;
    let item = false;
    for (const [id, quest] of Object.entries(QUESTS)) {
        const row = player.quests && player.quests[id];
        if (!row || row.state !== 'active' || row.failed || row.count >= quest.count) continue;
        if (quest.dungeonId && npc.dungeonId !== quest.dungeonId) continue;
        const namedHit = quest.named && npc.name === quest.named;
        const kindHit = quest.mob && npc.kind === quest.mob;
        if (quest.type === 'kill' && kindHit) {
            row.count += 1;
            changed = true;
        } else if (quest.type === 'named' && (npc.questId === id || namedHit)) {
            row.count = 1;
            changed = true;
            if (quest.item) {
                const leftover = addToSlots(player, { kind: 'quest', name: quest.item, qty: 1 });
                if (leftover) player.questNote = 'Bag full';
                else item = true;
            }
        } else if (quest.type === 'protect' && npc.questId === id) {
            row.count += 1;
            changed = true;
        }
    }
    if (changed || item) player.questDirty = true;
    if (changed) savePlayer(player);
    return { changed, item };
}

function questDoneByName(player, name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return true;
    return Object.entries(player.quests || {}).some(([id, row]) => row.state === 'done' && QUESTS[id] && QUESTS[id].name.toLowerCase() === needle);
}

function civInZone(zoneId, role, camp, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (zoneId && role && Number.isInteger(camp)) {
        const exact = CIVILIANS.find(civ => civ.id === 'd' + role + '-' + zoneId + '-' + camp);
        if (exact && (!wanted || exact.name.toLowerCase() === wanted)) return exact;
    }
    if (zoneId && wanted) {
        const named = CIVILIANS.find(civ => String(civ.id).includes('-' + zoneId + '-') && civ.name.toLowerCase() === wanted && (!role || civ.role === role))
            || CIVILIANS.find(civ => String(civ.id).includes('-' + zoneId + '-') && civ.name.toLowerCase() === wanted);
        if (named) return named;
    }
    return null;
}

function offersQuest(civ, questId) {
    const quest = questId && QUESTS[questId];
    if (!civ || !quest) return false;
    if (Array.isArray(civ.quests) && civ.quests.includes(questId)) return true;
    if (civ.quest === questId) return true;
    if (civ.dungeonId && quest.dungeonId === civ.dungeonId) return true;
    if (!quest.giver || civ.name.toLowerCase() !== quest.giver.toLowerCase()) return false;
    if (quest.zoneId && !String(civ.id).includes('-' + quest.zoneId + '-')) return false;
    return true;
}

function bindQuestGivers() {
    for (const civ of CIVILIANS) {
        civ.quests = civ.quest && QUESTS[civ.quest] ? [civ.quest] : [];
    }
    for (const [id, quest] of Object.entries(QUESTS)) {
        if (!quest.designed || !quest.giver) continue;
        const giver = civInZone(quest.zoneId, quest.giverRole, quest.giverCamp, quest.giver)
            || CIVILIANS.find(civ => civ.role === 'quest' && civ.name.toLowerCase() === quest.giver.toLowerCase())
            || CIVILIANS.find(civ => civ.name.toLowerCase() === quest.giver.toLowerCase());
        if (!giver) continue;
        if (!giver.quests.includes(id)) giver.quests.push(id);
        giver.quest = giver.quests[0] || '';
    }
}

function installQuests(list) {
    for (const key of Object.keys(QUESTS)) delete QUESTS[key];
    if (!customMap()) {
        QUESTS['boar-tusks'] = {
            id: 'boar-tusks',
            name: 'Boar Tusks',
            text: 'Kill 3 wild boars in Camp Glade.',
            custom: true,
            type: 'kill',
            mob: 'boar',
            kind: 'boar',
            count: 3,
            coins: 20,
            xp: 50,
            minLevel: 1,
            giver: 'Sela',
            requires: '',
            item: '',
            named: '',
            rewardKind: '',
            rewardName: '',
            rewardQty: 1,
            designed: false
        };
        QUESTS['pack-for-the-road'] = {
            id: 'pack-for-the-road',
            name: 'Pack for the Road',
            text: 'Kill 4 wolves. Holt will give you a linen sack.',
            custom: true,
            type: 'kill',
            mob: 'wolf',
            kind: 'wolf',
            count: 4,
            coins: 15,
            xp: 40,
            minLevel: 1,
            giver: 'Holt',
            requires: '',
            item: '',
            named: '',
            rewardKind: 'bag',
            rewardName: 'Linen Sack',
            rewardQty: 1,
            designed: false
        };
        Object.assign(QUESTS, storyQuests());
    }
    for (const quest of list || []) {
        QUESTS[quest.id] = { ...quest, designed: true, guardHp: 0, guardMax: 0 };
    }
    bindQuestGivers();
}

function storyQuests() {
    return {
        'fen-wolves': {
            id: 'fen-wolves',
            name: 'Wolves of the Fen',
            text: 'Kill 5 wolves east of the river. Wren waits by the drowned chapel.',
            custom: true,
            type: 'kill',
            mob: 'wolf',
            kind: 'wolf',
            count: 5,
            coins: 25,
            xp: 70,
            minLevel: 2,
            giver: 'Wren',
            requires: 'Boar Tusks',
            item: '',
            named: '',
            rewardKind: '',
            rewardName: '',
            rewardQty: 1,
            designed: false
        },
        'chapel-spiders': {
            id: 'chapel-spiders',
            name: 'What Crawled Out',
            text: 'Kill 4 moss spiders. They came out of the chapel.',
            custom: true,
            type: 'kill',
            mob: 'spider',
            kind: 'spider',
            count: 4,
            coins: 30,
            xp: 80,
            minLevel: 2,
            giver: 'Wren',
            requires: 'Wolves of the Fen',
            item: '',
            named: '',
            rewardKind: '',
            rewardName: '',
            rewardQty: 1,
            designed: false
        },
        prior: {
            id: 'prior',
            name: 'The Drowned Prior',
            text: 'Enter the Drowned Chapel with up to three allies and kill the Drowned Prior.',
            custom: true,
            type: 'named',
            mob: 'cultist',
            kind: 'cultist',
            count: 1,
            coins: 80,
            xp: 160,
            minLevel: 3,
            giver: 'Wren',
            requires: 'What Crawled Out',
            item: '',
            named: 'Drowned Prior',
            dungeonId: 'chapel',
            rewardKind: 'bag',
            rewardName: 'Traveler Pack',
            rewardQty: 1,
            designed: false
        }
    };
}

function giverOf(quest) {
    return civInZone(quest.zoneId, quest.giverRole, quest.giverCamp, quest.giver)
        || CIVILIANS.find(civ => civ.name.toLowerCase() === String(quest.giver || '').toLowerCase())
        || null;
}

function beginEscort(civ, quest) {
    if (civ.homeX == null) {
        civ.homeX = civ.x;
        civ.homeZ = civ.z;
    }
    const site = settlementAt(civ.homeX, civ.homeZ) || { x: civ.homeX, z: civ.homeZ };
    let dx = civ.homeX - site.x;
    let dz = civ.homeZ - site.z;
    if (Math.hypot(dx, dz) < 0.8) {
        dx = 1;
        dz = 0.35;
    }
    const len = Math.hypot(dx, dz) || 1;
    civ.escort = {
        questId: quest.id,
        dx: dx / len,
        dz: dz / len,
        outsideAt: inSettlement(civ.x, civ.z) ? 0 : Date.now()
    };
}

function protectPressure(escort, quest, now) {
    if (!escort || !escort.outsideAt) return { count: 0, interval: 3600 };
    const seconds = (now - escort.outsideAt) / 1000;
    if (seconds < 3) return { count: 0, interval: 3600 };
    const count = Math.max(1, Math.min(quest.count, 1 + Math.floor((seconds - 3) / 10)));
    const interval = Math.max(1100, 3400 - seconds * 55);
    return { count, interval };
}

function stepCiv(civ, gx, gz, stepMax) {
    let dx = gx - civ.x;
    let dz = gz - civ.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.6) return false;
    const step = Math.min(stepMax, dist);
    dx /= dist;
    dz /= dist;
    const held = clampWorld(civ.x + dx * step, civ.z + dz * step, 2);
    if (!onLand(held.x, held.z)) {
        if (civ.escort) {
            const c = Math.cos(0.9);
            const s = Math.sin(0.9);
            const ndx = civ.escort.dx * c - civ.escort.dz * s;
            const ndz = civ.escort.dx * s + civ.escort.dz * c;
            civ.escort.dx = ndx;
            civ.escort.dz = ndz;
        }
        return false;
    }
    civ.x = held.x;
    civ.z = held.z;
    civ.rotY = Math.atan2(dx, dz);
    return true;
}

let lastCivMove = 0;
function tickEscorts(dt, now) {
    let moved = false;
    for (const civ of CIVILIANS) {
        if (!civ.escort) continue;
        const quest = QUESTS[civ.escort.questId];
        const active = quest && someoneNeeds(civ.escort.questId) && (quest.guardHp || 0) > 0;
        if (!active) {
            if (civ.homeX == null) {
                civ.escort = null;
                continue;
            }
            if (stepCiv(civ, civ.homeX, civ.homeZ, 2.4 * dt)) moved = true;
            if (Math.hypot(civ.x - civ.homeX, civ.z - civ.homeZ) < 0.8) {
                civ.x = civ.homeX;
                civ.z = civ.homeZ;
                civ.escort = null;
                moved = true;
            }
            continue;
        }
        const site = settlementAt(civ.homeX, civ.homeZ) || { x: civ.homeX, z: civ.homeZ };
        const goal = SETTLEMENT_RADIUS + 22;
        if (stepCiv(civ, site.x + civ.escort.dx * goal, site.z + civ.escort.dz * goal, 2.2 * dt)) moved = true;
        if (!inSettlement(civ.x, civ.z) && !civ.escort.outsideAt) civ.escort.outsideAt = now;
    }
    if (moved && now - lastCivMove > 200) {
        lastCivMove = now;
        const civs = CIVILIANS.filter(civ => civ.escort || (civ.homeX != null && Math.hypot(civ.x - civ.homeX, civ.z - civ.homeZ) > 0.4));
        if (civs.length) broadcast({ type: 'civMove', civs: civs.map(civ => ({ id: civ.id, x: civ.x, z: civ.z, rotY: civ.rotY || 0 })) });
    }
}

function attackSpot(civ, index) {
    const escort = civ.escort || { dx: 1, dz: 0 };
    let dist = 12 + index * 4;
    for (let n = 0; n < 6; n++) {
        const px = civ.x + escort.dx * dist + escort.dz * ((index % 3) - 1) * 3;
        const pz = civ.z + escort.dz * dist - escort.dx * ((index % 3) - 1) * 3;
        const edge = clampWorld(px, pz, 2);
        if (onLand(edge.x, edge.z) && !inSettlement(edge.x, edge.z)) return edge;
        dist += 6;
    }
    return clampWorld(civ.x + escort.dx * 16, civ.z + escort.dz * 16, 2);
}

function protectTarget(quest) {
    return civInZone(quest.zoneId, quest.protectRole, quest.protectCamp, quest.named)
        || CIVILIANS.find(civ => civ.name.toLowerCase() === String(quest.named || '').toLowerCase())
        || null;
}

function someoneNeeds(questId) {
    const quest = QUESTS[questId];
    if (!quest) return false;
    for (const player of players.values()) {
        const row = player.quests && player.quests[questId];
        if (row && row.state === 'active' && !row.failed && row.count < quest.count) return true;
    }
    return false;
}

function dropQuestMob(npc) {
    if (!npcs.has(npc.id)) return;
    npcs.delete(npc.id);
    broadcast({ type: 'npcUnload', ids: [npc.id] });
}

function spawnQuestMob(quest, questId, index, x, z, guardId) {
    const kind = NPC_KINDS[quest.mob] || NPC_KINDS.boar;
    const npc = {
        id: guardId ? 'qa-' + questId + '-' + index : 'qn-' + questId,
        zx: Math.round(x / ZONE_SIZE),
        zz: Math.round(z / ZONE_SIZE),
        pinned: true,
        questId,
        guardId: guardId || '',
        x, z,
        kind: kind.id,
        name: quest.type === 'named' ? (quest.named || kind.name) : kind.name,
        tint: kind.tint,
        loot: kind.loot,
        level: Math.max(1, quest.minLevel || 1),
        alive: true,
        aggroId: null,
        attackAt: 0
    };
    const zone = designedZoneAt(x, z);
    const elite = quest.type === 'named' ? !!quest.elite : !!(zone && zone.elite);
    const base = quest.type !== 'named' && zone && zone.hp > 0 ? zone.hp : 0;
    applyElite(npc, elite, base);
    npc.homeX = x;
    npc.homeZ = z;
    pickWander(npc);
    npcs.set(npc.id, npc);
    return npc;
}

function spotNear(x, z, index) {
    const angle = index * 1.7;
    let px = x + Math.cos(angle) * (8 + index * 2);
    let pz = z + Math.sin(angle) * (8 + index * 2);
    if (!onLand(px, pz)) {
        px = x;
        pz = z;
    }
    return { x: px, z: pz };
}

function respawnPinned(npc) {
    if (npc.dungeonId) {
        dropQuestMob(npc);
        return;
    }
    const quest = QUESTS[npc.questId];
    if (!quest || !someoneNeeds(npc.questId) || (quest.type === 'protect' && (quest.guardHp || 0) <= 0)) {
        dropQuestMob(npc);
        return;
    }
    npc.alive = true;
    npc.hp = npc.maxHp;
    npc.aggroId = null;
    pickWander(npc);
}

function failProtect(questId) {
    const quest = QUESTS[questId];
    if (!quest) return;
    quest.guardHp = 0;
    for (const npc of [...npcs.values()]) {
        if (npc.questId === questId) dropQuestMob(npc);
    }
    for (const player of players.values()) {
        const row = player.quests && player.quests[questId];
        if (!row || row.state !== 'active' || row.failed) continue;
        row.failed = true;
        row.count = 0;
        savePlayer(player);
        send(player.ws, { type: 'quests', ok: false, reason: (quest.named || 'They') + ' has fallen', quests: player.quests });
    }
}

function playerOnObjective(player, quest) {
    if (!player || player.ghost) return false;
    if (quest.zoneId) {
        const here = designedZoneAt(player.x, player.z);
        if (here && here.id === quest.zoneId) return true;
    }
    const giver = giverOf(quest);
    if (giver && Math.hypot(player.x - giver.x, player.z - giver.z) < 90) return true;
    return !quest.zoneId && Math.hypot(player.x, player.z) < 110;
}

function aliveKindNear(x, z, kind, range) {
    let count = 0;
    for (const npc of npcs.values()) {
        if (!npc.alive || npc.kind !== kind) continue;
        if (Math.hypot(npc.x - x, npc.z - z) <= range) count += 1;
    }
    return count;
}

function herdStillNeeded(npc) {
    for (const player of players.values()) {
        if (Math.hypot(player.x - npc.homeX, player.z - npc.homeZ) > 100) continue;
        for (const quest of Object.values(QUESTS)) {
            if (quest.mob !== npc.kind || (quest.type !== 'kill' && quest.type !== 'gather')) continue;
            const row = player.quests && player.quests[quest.id];
            if (!row || row.state !== 'active' || row.failed || row.count >= quest.count) continue;
            if (playerOnObjective(player, quest)) return true;
        }
    }
    return false;
}

function respawnHerd(npc) {
    npc.alive = true;
    npc.hp = npc.maxHp;
    npc.aggroId = null;
    npc.x = npc.homeX;
    npc.z = npc.homeZ;
    pickWander(npc);
}

function spawnHerdMob(quest, x, z) {
    const kind = NPC_KINDS[quest.mob] || NPC_KINDS.boar;
    for (let attempt = 0; attempt < 8; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 16 + Math.random() * 24;
        const px = x + Math.cos(angle) * dist;
        const pz = z + Math.sin(angle) * dist;
        if (!onLand(px, pz)) continue;
        if (quest.zoneId) {
            const here = designedZoneAt(px, pz);
            if (!here || here.id !== quest.zoneId) continue;
        }
        let level = quest.minLevel || 1;
        let loot = kind.loot;
        let bonusHp = 0;
        const ground = designedZoneAt(px, pz);
        if (ground && ground.mob === quest.mob) {
            level = ground.level || level;
            loot = ground.loot || loot;
            bonusHp = ground.hp || 0;
        }
        const npc = {
            id: 'qh-' + quest.id + '-' + Math.random().toString(36).slice(2, 7),
            zx: Math.round(px / ZONE_SIZE),
            zz: Math.round(pz / ZONE_SIZE),
            herd: true,
            x: px,
            z: pz,
            homeX: px,
            homeZ: pz,
            kind: kind.id,
            name: kind.name,
            tint: kind.tint,
            loot,
            level,
            alive: true,
            aggroId: null,
            attackAt: 0
        };
        applyElite(npc, ground && ground.elite, bonusHp);
        pickWander(npc);
        npcs.set(npc.id, npc);
        return npc;
    }
    return null;
}

function topUpQuestMobs() {
    for (const player of players.values()) {
        for (const quest of Object.values(QUESTS)) {
            if (quest.type !== 'kill' && quest.type !== 'gather') continue;
            if (!quest.mob) continue;
            const row = player.quests && player.quests[quest.id];
            if (!row || row.state !== 'active' || row.failed || row.count >= quest.count) continue;
            if (!playerOnObjective(player, quest)) continue;
            let near = aliveKindNear(player.x, player.z, quest.mob, 70);
            let added = 0;
            while (near < 6 && added < 3) {
                const npc = spawnHerdMob(quest, player.x, player.z);
                if (!npc) break;
                near += 1;
                added += 1;
            }
        }
    }
    for (const npc of [...npcs.values()]) {
        if (!npc.herd || npc.aggroId) continue;
        if (!herdStillNeeded(npc)) dropQuestMob(npc);
    }
}

let lastQuestSync = 0;
function syncQuestActors(now) {
    if (now - lastQuestSync < 1000) return;
    lastQuestSync = now;
    for (const [id, quest] of Object.entries(QUESTS)) {
        if (quest.type === 'named') {
            const mobs = [...npcs.values()].filter(npc => npc.questId === id);
            if (!someoneNeeds(id)) {
                for (const npc of mobs) if (!npc.alive) dropQuestMob(npc);
                continue;
            }
            if (mobs.some(npc => npc.alive || npc.respawnAt > now)) continue;
            const giver = giverOf(quest) || { x: 0, z: 8 };
            const spot = spotNear(giver.x, giver.z, 1);
            spawnQuestMob(quest, id, 0, spot.x, spot.z, '');
        } else if (quest.type === 'protect') {
            if (!someoneNeeds(id)) {
                for (const npc of [...npcs.values()]) if (npc.questId === id) dropQuestMob(npc);
                continue;
            }
            const civ = protectTarget(quest);
            if (!civ) continue;
            if (!quest.guardMax) quest.guardMax = 50 + quest.count * 20;
            if (!quest.guardHp) quest.guardHp = quest.guardMax;
            if (!civ.escort || civ.escort.questId !== id) beginEscort(civ, quest);
            const pressure = protectPressure(civ.escort, quest, now);
            quest.attackEvery = pressure.interval;
            const alive = [...npcs.values()].filter(npc => npc.questId === id && (npc.alive || npc.respawnAt > now));
            for (let i = alive.length; i < pressure.count; i++) {
                const spot = attackSpot(civ, alive.length + i + 1);
                spawnQuestMob(quest, id, now + i, spot.x, spot.z, civ.id);
            }
        }
    }
    topUpQuestMobs();
}

function coinRoom() {
    return true;
}

function xpToNext(level) {
    return 50 * level;
}

const MAX_LEVEL = 60;

function maxHpFor(level) {
    return 20 + (level - 1) * 4;
}

function npcMaxHp(level) {
    return Math.max(1, worldRules.hpBase + level * worldRules.hpPerLevel);
}

const STAT_KEYS = ['strength', 'stamina', 'intellect'];

function cleanStats(raw) {
    const stats = {};
    for (const key of STAT_KEYS) {
        const n = Math.max(0, Math.round(Number(raw && raw[key]) || 0));
        if (n) stats[key] = n;
    }
    return stats;
}

function mobBias(kind) {
    return kind === 'wisp' || kind === 'cultist' ? 'intellect' : 'strength';
}

function mobStatBlock(level, kind) {
    const lv = Math.max(1, Math.round(level) || 1);
    const stamina = lv;
    const primary = lv + 1;
    if (mobBias(kind) === 'intellect') return { strength: 0, stamina, intellect: primary };
    return { strength: primary, stamina, intellect: 0 };
}

function gearAmount(level) {
    return Math.max(1, Math.round((level * level) / 33));
}

function gearReq(level) {
    return Math.max(1, Math.round(level) || 1);
}

function classBaseStats(player) {
    const steps = Math.max(0, (player.level || 1) - 1);
    if (player.class === 'mage' || player.class === 'warlock') {
        return { strength: 0, stamina: 1 + Math.floor(steps / 2), intellect: 1 + steps };
    }
    if (player.class === 'warrior' || player.class === 'hunter') {
        return { strength: 1 + steps, stamina: 1 + Math.floor(steps / 2), intellect: 0 };
    }
    return { strength: 1, stamina: 1, intellect: 0 };
}

function totalStats(player) {
    const total = classBaseStats(player);
    for (const slot of EQUIP_SLOTS) {
        const piece = player.equipment && player.equipment[slot];
        if (!piece || !piece.stats) continue;
        for (const key of STAT_KEYS) total[key] += piece.stats[key] || 0;
    }
    return total;
}

function applyElite(npc, elite, baseHp) {
    npc.elite = !!elite;
    npc.stats = mobStatBlock(npc.level, npc.kind);
    const base = baseHp > 0 ? baseHp : npcMaxHp(npc.level);
    const hp = base + (npc.stats.stamina || 0) * 2;
    npc.maxHp = npc.elite ? Math.round(hp * 2.5) : hp;
    npc.hp = npc.maxHp;
}

function publicGear(player) {
    const gear = {};
    const slots = ['head', 'shoulders', 'chest', 'legs', 'feet', 'cloak', 'offhand'];
    for (const slot of slots) {
        const piece = player.equipment && player.equipment[slot];
        if (!piece) continue;
        const style = piece.style === 'plate' || piece.style === 'leather' || piece.style === 'cloth' ? piece.style : '';
        if (!style) continue;
        gear[slot] = { style, level: piece.reqLevel || 1, magic: !!piece.magic };
    }
    return gear;
}

function publicPlayer(id, p) {
    return {
        id,
        x: p.x,
        y: p.y,
        z: p.z,
        rotY: p.rotY,
        tool: p.tool,
        name: p.name,
        color: p.color,
        hp: p.hp,
        maxHp: p.maxHp,
        ghost: !!p.ghost,
        corpse: p.corpse || null,
        gear: publicGear(p)
    };
}

function publicNpc(n) {
    return {
        id: n.id,
        x: n.x,
        z: n.z,
        rotY: n.rotY,
        level: n.level,
        hp: n.hp,
        maxHp: n.maxHp,
        name: n.name,
        kind: n.kind,
        tint: n.tint,
        elite: !!n.elite,
        dungeonId: n.dungeonId || ''
    };
}

function zoneKey(zx, zz) {
    return zx + ',' + zz;
}

function clampToZone(npc, x, z) {
    const half = ZONE_SIZE / 2 - 8;
    const cx = npc.zx * ZONE_SIZE;
    const cz = npc.zz * ZONE_SIZE;
    return {
        x: Math.max(cx - half, Math.min(cx + half, x)),
        z: Math.max(cz - half, Math.min(cz + half, z))
    };
}

function placeNpc(npc, spot) {
    const profile = zoneNpc(npc.zx, npc.zz);
    const kind = NPC_KINDS[profile.kind] || NPC_KINDS.boar;
    const span = ZONE_SIZE - 44;
    let x = spot ? spot.x : npc.zx * ZONE_SIZE;
    let z = spot ? spot.z : npc.zz * ZONE_SIZE;
    if (!spot) {
        for (let n = 0; n < 8; n++) {
            x = npc.zx * ZONE_SIZE + (Math.random() - 0.5) * span;
            z = npc.zz * ZONE_SIZE + (Math.random() - 0.5) * span;
            if (Math.hypot(x, z) > 16) break;
        }
        if (Math.hypot(x, z) < 16) x += 18;
    }
    const camp = zoneCamp(npc.zx, npc.zz);
    if (Math.hypot(x - camp.x, z - camp.z) < 16) {
        x = camp.x + 22;
        z = camp.z + 8;
    }
    const placed = clampToZone(npc, x, z);
    npc.x = placed.x;
    npc.z = placed.z;
    npc.kind = kind.id;
    npc.name = kind.name;
    npc.tint = kind.tint;
    npc.loot = kind.loot;
    npc.level = profile.level;
    npc.maxHp = npcMaxHp(npc.level);
    const drawn = designedZoneAt(npc.x, npc.z);
    if (drawn) {
        const shaped = NPC_KINDS[drawn.mob] || kind;
        npc.kind = shaped.id;
        npc.name = shaped.name;
        npc.tint = shaped.tint;
        npc.loot = drawn.loot || shaped.loot;
        npc.level = drawn.level;
        applyElite(npc, drawn.elite, drawn.hp);
    } else applyElite(npc, false, 0);
    if (!npc.dungeonId && inSettlement(npc.x, npc.z)) {
        const out = outsideSettlement(npc.x, npc.z);
        const shifted = clampToZone(npc, out.x, out.z);
        npc.x = shifted.x;
        npc.z = shifted.z;
    }
    npc.alive = true;
    npc.aggroId = null;
    npc.homeX = npc.x;
    npc.homeZ = npc.z;
    npc.attackAt = 0;
    pickWander(npc);
}

function pickWander(npc) {
    if (npc.dungeonId) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 0.35 + Math.random() * 0.9;
        npc.wanderX = npc.homeX + Math.cos(angle) * dist;
        npc.wanderZ = npc.homeZ + Math.sin(angle) * dist;
        npc.wanderUntil = Date.now() + 2500 + Math.random() * 3000;
        return;
    }
    const angle = Math.random() * Math.PI * 2;
    const dist = 4 + Math.random() * 14;
    const next = clampToZone(npc, npc.homeX + Math.cos(angle) * dist, npc.homeZ + Math.sin(angle) * dist);
    const clear = inSettlement(next.x, next.z) ? outsideSettlement(next.x, next.z) : next;
    npc.wanderX = clear.x;
    npc.wanderZ = clear.z;
    npc.wanderUntil = Date.now() + 3000 + Math.random() * 4000;
}

function areaOfCell(zx, zz) {
    const cx = zx * ZONE_SIZE;
    const cz = zz * ZONE_SIZE;
    if (!zoneInWorld(zx, zz)) return null;
    if (boundaryInset(cx, cz) < 24) return null;
    if (customMap()) {
        const zone = designedZoneAt(cx, cz);
        if (!zone) return null;
        return { key: 'd:' + zone.id, zone, zx, zz };
    }
    return { key: 'g:' + zx + ',' + zz, zone: null, zx, zz };
}

function spawnRules(area) {
    if (area.zone) {
        return { perMin: area.zone.perMin, cap: area.zone.cap };
    }
    return { perMin: worldRules.spawnPerMin, cap: worldRules.spawnCap };
}

function livingInArea(area) {
    let count = 0;
    for (const npc of npcs.values()) {
        if (!npc.alive || npc.questId || npc.pinned || npc.herd) continue;
        if (area.zone) {
            const at = designedZoneAt(npc.x, npc.z);
            if (at && at.id === area.zone.id) count++;
        } else if (npc.zx === area.zx && npc.zz === area.zz) count++;
    }
    return count;
}

function randomInZone(zone) {
    const pts = zone.points || [];
    if (pts.length < 3) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of pts) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
    }
    for (let n = 0; n < 16; n++) {
        const x = minX + Math.random() * (maxX - minX);
        const z = minZ + Math.random() * (maxZ - minZ);
        const at = designedZoneAt(x, z);
        if (!at || at.id !== zone.id) continue;
        if (!onLand(x, z)) continue;
        if (Math.hypot(x, z) < 18) continue;
        return { x, z };
    }
    return null;
}

let ambientSeq = 1;
const zoneSpawns = new Map();
let activeAreas = new Map();

function spawnAmbient(area) {
    const spot = area.zone ? randomInZone(area.zone) : null;
    if (area.zone && !spot) return;
    const cell = spot ? zoneAt(spot.x, spot.z) : { zx: area.zx, zz: area.zz };
    const npc = { id: 'a' + (ambientSeq++), zx: cell.zx, zz: cell.zz, ambient: true };
    placeNpc(npc, spot);
    if (area.zone) {
        const at = designedZoneAt(npc.x, npc.z);
        if (!at || at.id !== area.zone.id) return;
    }
    if (!onLand(npc.x, npc.z)) return;
    npcs.set(npc.id, npc);
}

function tickAreaSpawns(area, now) {
    const rules = spawnRules(area);
    let plan = zoneSpawns.get(area.key);
    if (!plan || now >= plan.until) {
        const times = [];
        for (let i = 0; i < rules.perMin; i++) times.push(now + Math.random() * 60000);
        times.sort((a, b) => a - b);
        plan = { until: now + 60000, times };
        zoneSpawns.set(area.key, plan);
    }
    while (plan.times.length && plan.times[0] <= now) {
        const due = plan.times.shift();
        if (now - due > 1500) continue;
        if (livingInArea(area) >= rules.cap) continue;
        spawnAmbient(area);
    }
}

function downNpc(npc) {
    npc.hp = 0;
    npc.alive = false;
    if (npc.dungeonId) return;
    if (npc.herd || npc.pinned || npc.questId) npc.respawnAt = Date.now() + 8000;
    else npc.ambientGone = true;
}

function refreshNpcZones() {
    const want = new Set();
    const marks = [{ x: 0, z: 0 }];
    for (const player of players.values()) marks.push(player);
    for (const mark of marks) {
        const here = zoneAt(mark.x, mark.z);
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) want.add(zoneKey(here.zx + dx, here.zz + dz));
        }
    }
    const areas = new Map();
    for (const key of want) {
        const [zx, zz] = key.split(',').map(Number);
        const area = areaOfCell(zx, zz);
        if (area) areas.set(area.key, area);
    }
    if (customMap()) {
        for (const mark of marks) {
            const zone = designedZoneAt(mark.x, mark.z);
            if (!zone) continue;
            const cell = zoneAt(mark.x, mark.z);
            areas.set('d:' + zone.id, { key: 'd:' + zone.id, zone, zx: cell.zx, zz: cell.zz });
        }
    }
    activeAreas = areas;
    const unload = [];
    for (const [id, npc] of npcs) {
        if (npc.pinned) continue;
        if (want.has(zoneKey(npc.zx, npc.zz))) continue;
        unload.push(id);
        npcs.delete(id);
    }
    if (unload.length) broadcast({ type: 'npcUnload', ids: unload });
}

function revealFog(player) {
    if (!player.explored) player.explored = new Set();
    const add = [];
    for (const key of fogCellsAround(player.x, player.z)) {
        if (player.explored.has(key)) continue;
        player.explored.add(key);
        add.push(key);
    }
    if (!add.length) return add;
    const prof = save.players[player.persistentId];
    if (prof) prof.explored = Array.from(player.explored);
    scheduleSave();
    return add;
}

function restoreFoughtMobs(player) {
    for (const npc of npcs.values()) {
        if (!npc.alive || npc.hp >= npc.maxHp) continue;
        const mine = npc.aggroId === player.persistentId;
        const near = Math.hypot(npc.x - player.x, npc.z - player.z) < 28;
        if (!mine && !near) continue;
        const other = nearestPlayer(npc, 12);
        if (other && other !== player) continue;
        npc.hp = npc.maxHp;
        npc.aggroId = null;
        broadcast({
            type: 'npcHit',
            id: npc.id,
            hp: npc.hp,
            maxHp: npc.maxHp,
            alive: true,
            x: npc.x,
            z: npc.z,
            level: npc.level,
            name: npc.name,
            tint: npc.tint
        });
    }
}

function becomeGhost(player, now) {
    if (player.ghost) return;
    restoreFoughtMobs(player);
    player.ghost = true;
    let corpse = { x: player.x, z: player.z };
    if (player.dungeonId) {
        const cave = dungeonById(player.dungeonId);
        const instId = player.instanceId || '';
        player.dungeonId = '';
        player.instanceId = '';
        if (cave) corpse = { x: cave.portal.x + 3, z: cave.portal.z };
        if (instId) clearInstanceIfEmpty(instId);
    }
    player.corpse = corpse;
    const home = player.spawn || mapSpawn();
    player.hp = 0;
    player.absorb = 0;
    player.absorbUntil = 0;
    player.x = home.x;
    player.y = 0;
    player.z = home.z;
    player.invulnUntil = now + 1500;
    const revealed = revealFog(player);
    if (revealed.length) send(player.ws, { type: 'fog', add: revealed });
    send(player.ws, { type: 'died', x: player.x, y: 0, z: player.z, corpse: player.corpse, ...statsOf(player) });
    broadcast({ type: 'ghost', ...publicPlayer(player.persistentId, player) });
    refreshSight(player);
    savePlayer(player);
}

function dungeonThreat(npc) {
    const cave = dungeonById(npc.dungeonId);
    if (!cave) return null;
    let best = null;
    let bestD = AGGRO_RANGE * AGGRO_RANGE;
    for (const player of players.values()) {
        if (player.hp <= 0 || player.ghost) continue;
        if (player.dungeonId !== npc.dungeonId) continue;
        if ((player.instanceId || '') !== (npc.instanceId || '')) continue;
        if (dungeonTravel(cave, player.x, player.z) < 5) continue;
        const dx = player.x - npc.x;
        const dz = player.z - npc.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
            bestD = d;
            best = player;
        }
    }
    return best;
}

function nearestPlayer(npc, range) {
    let best = null;
    let bestD = range * range;
    for (const player of players.values()) {
        if (player.hp <= 0 || player.ghost || player.dungeonId) continue;
        if (inSettlement(player.x, player.z)) continue;
        const dx = player.x - npc.x;
        const dz = player.z - npc.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
            bestD = d;
            best = player;
        }
    }
    return best;
}

function talentRank(player, id) {
    if (!player || !player.talents) return 0;
    return player.talents[id] || 0;
}

function ranksIn(player, ids) {
    let total = 0;
    for (const id of ids) total += talentRank(player, id);
    return total;
}

function maxManaFor(player) {
    return 10 + ((player.level || 1) - 1) * 4 + ranksIn(player, ['meditation', 'reservoir', 'ward', 'torment']) * 2;
}

function damageScale(playerLevel, mobLevel) {
    const gap = (mobLevel || 1) - (playerLevel || 1);
    if (gap <= 0) return 1;
    const mild = Math.pow(0.85, Math.min(gap, 3));
    const steep = gap > 3 ? Math.pow(0.62, gap - 3) : 1;
    return Math.max(0.05, mild * steep);
}

function xpForKill(player, npc) {
    if (!npc || npc.level <= player.level - worldRules.grayLevels) return 0;
    const base = worldRules.xpPerMobLevel * npc.level;
    return npc.elite ? Math.round(base * 1.5) : base;
}

function grantXp(player, amount) {
    if ((player.level || 1) >= MAX_LEVEL) {
        player.level = MAX_LEVEL;
        player.xp = 0;
        return false;
    }
    player.xp += amount;
    let leveled = false;
    while (player.level < MAX_LEVEL && player.xp >= xpToNext(player.level)) {
        player.xp -= xpToNext(player.level);
        player.level += 1;
        refreshDerived(player);
        player.hp = player.maxHp;
        player.mana = player.maxMana;
        leveled = true;
    }
    if (player.level >= MAX_LEVEL) {
        player.level = MAX_LEVEL;
        player.xp = 0;
    }
    savePlayer(player);
    return leveled;
}

function statsOf(player) {
    return {
        level: player.level,
        xp: player.xp,
        xpToNext: player.level >= MAX_LEVEL ? 0 : xpToNext(player.level),
        hp: Math.floor(player.hp),
        maxHp: player.maxHp,
        mana: Math.floor(player.mana),
        maxMana: player.maxMana,
        absorb: Date.now() < (player.absorbUntil || 0) ? Math.floor(player.absorb || 0) : 0,
        armor: player.armor,
        stats: player.stats || { strength: 0, stamina: 0, intellect: 0 }
    };
}

function noteMana(player) {
    player.manaShown = Math.floor(player.mana);
    player.hpShown = Math.floor(player.hp);
    player.manaSent = Date.now();
    send(player.ws, { type: 'stats', ...statsOf(player) });
}

const parties = new Map();
const partyInvites = new Map();
let partySeq = 1;
const PARTY_MAX = 5;
const PARTY_RANGE = 30;

function playersNamed(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return [];
    const found = [];
    for (const other of players.values()) {
        if ((other.name || '').toLowerCase() === want) found.push(other);
    }
    return found;
}

function handleChat(player, data) {
    const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!text) return;
    const now = Date.now();
    if (player.lastChat && now - player.lastChat < 400) return;
    player.lastChat = now;
    const channel = data.channel === 'party' || data.channel === 'whisper' ? data.channel : 'world';
    if (channel === 'world') {
        broadcast({ type: 'chat', channel: 'world', from: player.name, text });
        return;
    }
    if (channel === 'party') {
        const party = partyOf(player);
        if (!party) {
            send(player.ws, { type: 'chat', channel: 'party', system: true, text: 'You are not in a party' });
            return;
        }
        const msg = { type: 'chat', channel: 'party', from: player.name, text };
        for (const id of party.members) {
            const member = players.get(id);
            if (member) send(member.ws, msg);
        }
        return;
    }
    let target = data.toId ? players.get(String(data.toId)) : null;
    if (!target && data.to) {
        const named = playersNamed(data.to);
        if (named.length > 1) {
            send(player.ws, { type: 'chat', channel: 'whisper', system: true, text: 'More than one ' + data.to + '. Target them and use /t' });
            return;
        }
        target = named[0] || null;
    }
    if (!target) {
        send(player.ws, { type: 'chat', channel: 'whisper', system: true, text: 'No player named ' + (data.to || 'that') });
        return;
    }
    if (target === player) {
        send(player.ws, { type: 'chat', channel: 'whisper', system: true, text: 'You cannot whisper yourself' });
        return;
    }
    const msg = { type: 'chat', channel: 'whisper', from: player.name, to: target.name, text };
    send(target.ws, msg);
    send(player.ws, { ...msg, self: true });
}

function partyOf(player) {
    if (!player || !player.partyId) return null;
    return parties.get(player.partyId) || null;
}

function partyMembersNear(player) {
    const party = partyOf(player);
    const ids = party ? party.members : [player.persistentId];
    const near = [];
    for (const id of ids) {
        const member = id === player.persistentId ? player : players.get(id);
        if (!member || member.ghost || member.hp <= 0) continue;
        if ((member.dungeonId || '') !== (player.dungeonId || '')) continue;
        if ((member.instanceId || '') !== (player.instanceId || '')) continue;
        if (Math.hypot(member.x - player.x, member.z - player.z) > PARTY_RANGE) continue;
        near.push(member);
    }
    if (!near.includes(player)) near.unshift(player);
    return near;
}

function awardKill(killer, npc) {
    const members = partyMembersNear(killer);
    const earning = members.filter(member => xpForKill(member, npc) > 0);
    const count = earning.length;
    let killerGain = 0;
    let killerLevel = false;
    for (const member of members) {
        const full = xpForKill(member, npc);
        const share = count > 1 && full > 0 ? Math.floor(full / count) + (member === earning[0] ? full % count : 0) : full;
        const gained = share > 0 ? share : 0;
        const leveled = gained > 0 ? grantXp(member, gained) : false;
        noteKill(member, npc);
        if (member === killer) {
            killerGain = gained;
            killerLevel = leveled;
            continue;
        }
        send(member.ws, {
            type: 'partyAward',
            gained,
            leveled,
            name: npc.name,
            quests: member.quests,
            inventory: member.questDirty ? inventoryOf(member) : undefined,
            questNote: member.questNote || '',
            ...statsOf(member)
        });
        member.questDirty = false;
        member.questNote = '';
    }
    return { gained: killerGain, leveled: killerLevel, members };
}

function publicParty(party) {
    return {
        id: party.id,
        leader: party.leader,
        members: party.members.map(id => {
            const member = players.get(id);
            return {
                id,
                name: member ? member.name : 'Offline',
                level: member ? member.level : 1,
                hp: member ? Math.floor(member.hp) : 0,
                maxHp: member ? member.maxHp : 1,
                mana: member ? Math.floor(member.mana) : 0,
                maxMana: member ? member.maxMana : 1,
                ghost: member ? !!member.ghost : false
            };
        })
    };
}

function sendParty(party) {
    const msg = { type: 'party', party: party ? publicParty(party) : null };
    const ids = party ? party.members : [];
    for (const id of ids) {
        const member = players.get(id);
        if (member) send(member.ws, msg);
    }
}

function clearParty(party) {
    parties.delete(party.id);
    for (const id of party.members) {
        const member = players.get(id);
        if (!member) continue;
        member.partyId = null;
        send(member.ws, { type: 'party', party: null });
    }
}

function leaveParty(player) {
    const party = partyOf(player);
    if (!party) return;
    party.members = party.members.filter(id => id !== player.persistentId);
    player.partyId = null;
    send(player.ws, { type: 'party', party: null });
    if (party.members.length < 2) clearParty(party);
    else {
        if (party.leader === player.persistentId) party.leader = party.members[0];
        sendParty(party);
    }
}

function syncPartyVitals() {
    for (const party of parties.values()) {
        const sig = party.members.map(id => {
            const member = players.get(id);
            if (!member) return 'x';
            return [Math.floor(member.hp), Math.floor(member.mana), member.maxHp, member.maxMana, member.ghost ? 1 : 0, member.name].join(':');
        }).join('|');
        if (sig === party.sig) continue;
        party.sig = sig;
        sendParty(party);
    }
}

const ABILITIES = {
    sword: { weapon: 'sword', mana: 0, range: 2.6, damage: (level) => 4 + level },
    'power-strike': { weapon: 'sword', mana: 6, range: 2.6, damage: (level) => 8 + level * 2 },
    hamstring: { weapon: 'sword', mana: 4, range: 2.6, slow: 5000, damage: (level) => 2 + level },
    execute: { weapon: 'sword', mana: 8, range: 2.6, execute: 2, damage: (level) => 6 + level * 2 },
    cleave: { weapon: 'sword', mana: 5, range: 2.6, aoe: 2.6, damage: (level) => 6 + level },
    whirlwind: { weapon: 'sword', mana: 10, range: 3.2, aoe: 3.2, aoeSelf: true, damage: (level) => 5 + level },
    staff: { weapon: 'staff', mana: 5, range: 8, bolt: true, damage: (level) => 4 + level },
    'arcane-bolt': { weapon: 'staff', mana: 8, range: 8, bolt: true, damage: (level) => 6 + level },
    'frost-bolt': { weapon: 'staff', mana: 7, range: 8, bolt: true, slow: 4000, damage: (level) => 5 + level },
    'arcane-surge': { weapon: 'staff', mana: 14, range: 8, bolt: true, damage: (level) => 12 + level * 2 },
    mend: { weapon: 'staff', mana: 8, range: 0, heal: (level) => 8 + level * 2 },
    barrier: { weapon: 'staff', mana: 12, range: 0, absorb: (level) => 6 + level * 2 },
    'frost-nova': { weapon: 'staff', mana: 12, range: 4.2, aoe: 4.2, aoeSelf: true, slow: 3500, damage: (level) => 4 + level },
    bow: { weapon: 'bow', mana: 0, range: 9, bolt: true, damage: (level) => 4 + level },
    'aimed-shot': { weapon: 'bow', mana: 6, range: 9, bolt: true, damage: (level) => 8 + level * 2 },
    'wing-clip': { weapon: 'bow', mana: 4, range: 9, bolt: true, slow: 4000, damage: (level) => 2 + level },
    'multi-shot': { weapon: 'bow', mana: 8, range: 9, aoe: 2.8, damage: (level) => 5 + level },
    'kill-shot': { weapon: 'bow', mana: 8, range: 9, bolt: true, execute: 2, damage: (level) => 6 + level * 2 },
    wand: { weapon: 'wand', mana: 5, range: 8, bolt: true, damage: (level) => 4 + level },
    'shadow-bolt': { weapon: 'wand', mana: 8, range: 8, bolt: true, damage: (level) => 7 + level },
    'drain-life': { weapon: 'wand', mana: 8, range: 8, bolt: true, leech: 1, damage: (level) => 4 + level },
    curse: { weapon: 'wand', mana: 6, range: 8, bolt: true, slow: 5000, damage: (level) => 3 + level },
    hellfire: { weapon: 'wand', mana: 12, range: 4.2, aoe: 4.2, aoeSelf: true, damage: (level) => 5 + level },
    'soul-burn': { weapon: 'wand', mana: 14, range: 8, bolt: true, execute: 2, damage: (level) => 8 + level * 2 }
};
const ABILITY_COOLDOWN = {
    sword: 1200,
    'power-strike': 6000,
    hamstring: 8000,
    execute: 8000,
    cleave: 8000,
    whirlwind: 12000,
    staff: 1200,
    'arcane-bolt': 1800,
    'frost-bolt': 2200,
    'arcane-surge': 8000,
    mend: 5000,
    barrier: 18000,
    'frost-nova': 14000,
    bow: 1400,
    'aimed-shot': 6000,
    'wing-clip': 8000,
    'multi-shot': 8000,
    'kill-shot': 8000,
    wand: 1400,
    'shadow-bolt': 2000,
    'drain-life': 5000,
    curse: 8000,
    hellfire: 12000,
    'soul-burn': 8000
};
const POTION_COOLDOWN = 12000;
const BOMB_COOLDOWN = 4000;

function cooldownLeft(player, key, now) {
    const until = player.cds && player.cds[key];
    return until ? Math.max(0, until - now) : 0;
}

function startCooldown(player, key, ms, now) {
    if (!player.cds) player.cds = {};
    player.cds[key] = now + ms;
}

const BAR_PAGES = 3;
const BAR_SLOTS = 8;
const ACTION_IDS = new Set(['sword', 'power-strike', 'hamstring', 'execute', 'cleave', 'whirlwind', 'staff', 'arcane-bolt', 'frost-bolt', 'arcane-surge', 'mend', 'barrier', 'frost-nova', 'bow', 'aimed-shot', 'wing-clip', 'multi-shot', 'kill-shot', 'wand', 'shadow-bolt', 'drain-life', 'curse', 'hellfire', 'soul-burn', 'gather', 'health', 'mana', 'bomb']);
const BAR_UTILITY = new Set(['gather', 'health', 'mana', 'bomb']);

function blankActionBar() {
    return Array.from({ length: BAR_PAGES }, () => Array(BAR_SLOTS).fill(null));
}

function defaultActionBar(className) {
    const bar = blankActionBar();
    const kit = CLASS_KITS[className];
    const attack = kit && kit.trained && kit.trained[0];
    if (attack) bar[0][0] = attack;
    return bar;
}

function actionAllowed(player, id) {
    if (!id || !ACTION_IDS.has(id)) return false;
    if (BAR_UTILITY.has(id)) return true;
    if (!player || !player.class) return false;
    return knownSpells(player).includes(id);
}

function sanitizeActionBar(pages, player) {
    if (!Array.isArray(pages)) return defaultActionBar(player && player.class);
    const bar = blankActionBar();
    const extra = [];
    pages.forEach((row, page) => {
        if (!Array.isArray(row)) return;
        row.forEach((id, index) => {
            if (!actionAllowed(player, id)) return;
            if (page < BAR_PAGES && index < BAR_SLOTS && !bar[page][index]) bar[page][index] = id;
            else extra.push(id);
        });
    });
    for (let page = 0; page < BAR_PAGES && extra.length; page++) {
        for (let index = 0; index < BAR_SLOTS && extra.length; index++) {
            if (!bar[page][index]) bar[page][index] = extra.shift();
        }
    }
    return bar;
}

const EQUIP_SLOTS = ['head', 'neck', 'shoulders', 'cloak', 'chest', 'hands', 'waist', 'legs', 'feet', 'weapon', 'offhand'];
const CLASS_KITS = {
    warrior: {
        weapon: { kind: 'weapon', weapon: 'sword', name: 'Worn Sword', qty: 1, armor: 0, amount: 0, slot: 'weapon', stats: { strength: 1 }, reqLevel: 1 },
        trained: ['sword']
    },
    mage: {
        weapon: { kind: 'weapon', weapon: 'staff', name: 'Apprentice Staff', qty: 1, armor: 0, amount: 0, slot: 'weapon', stats: { intellect: 1 }, reqLevel: 1 },
        trained: ['staff']
    },
    hunter: {
        weapon: { kind: 'weapon', weapon: 'bow', name: 'Short Bow', qty: 1, armor: 0, amount: 0, slot: 'weapon', stats: { strength: 1 }, reqLevel: 1 },
        trained: ['bow']
    },
    warlock: {
        weapon: { kind: 'weapon', weapon: 'wand', name: 'Apprentice Wand', qty: 1, armor: 0, amount: 0, slot: 'weapon', stats: { intellect: 1 }, reqLevel: 1 },
        trained: ['wand']
    }
};
const SPELLS = {
    sword: { class: 'warrior', name: 'Sword', level: 1, cost: 0, maxRank: 5, rankCost: 8, mana: 0, manaRank: 2, power: 4, scale: 1 },
    'power-strike': { class: 'warrior', name: 'Power Strike', level: 1, cost: 0, maxRank: 5, rankCost: 12, mana: 6, manaRank: 3, power: 8, scale: 2 },
    hamstring: { class: 'warrior', name: 'Hamstring', level: 2, cost: 12, maxRank: 5, rankCost: 10, mana: 4, manaRank: 2, power: 2, scale: 1 },
    execute: { class: 'warrior', name: 'Execute', level: 6, cost: 30, maxRank: 5, rankCost: 16, mana: 8, manaRank: 4, power: 6, scale: 2, execute: true },
    cleave: { class: 'warrior', name: 'Cleave', level: 4, cost: 20, maxRank: 5, rankCost: 16, mana: 5, manaRank: 3, power: 6, scale: 1 },
    whirlwind: { class: 'warrior', name: 'Whirlwind', level: 8, cost: 40, maxRank: 5, rankCost: 18, mana: 10, manaRank: 4, power: 5, scale: 1 },
    staff: { class: 'mage', name: 'Staff', level: 1, cost: 0, maxRank: 5, rankCost: 8, mana: 5, manaRank: 3, power: 4, scale: 1 },
    'arcane-bolt': { class: 'mage', name: 'Arcane Missile', level: 1, cost: 0, maxRank: 5, rankCost: 12, mana: 8, manaRank: 4, power: 6, scale: 1 },
    'frost-bolt': { class: 'mage', name: 'Frost Bolt', level: 3, cost: 15, maxRank: 5, rankCost: 12, mana: 7, manaRank: 3, power: 5, scale: 1 },
    mend: { class: 'mage', name: 'Mend', level: 2, cost: 15, maxRank: 5, rankCost: 12, mana: 8, manaRank: 4, power: 8, scale: 2, effect: 'heal' },
    barrier: { class: 'mage', name: 'Barrier', level: 6, cost: 28, maxRank: 5, rankCost: 16, mana: 12, manaRank: 4, power: 6, scale: 2, effect: 'shield' },
    'frost-nova': { class: 'mage', name: 'Frost Nova', level: 8, cost: 36, maxRank: 5, rankCost: 18, mana: 12, manaRank: 5, power: 4, scale: 1 },
    'arcane-surge': { class: 'mage', name: 'Arcane Surge', level: 4, cost: 25, maxRank: 5, rankCost: 18, mana: 14, manaRank: 6, power: 12, scale: 2 },
    bow: { class: 'hunter', name: 'Bow', level: 1, cost: 0, maxRank: 5, rankCost: 8, mana: 0, manaRank: 2, power: 4, scale: 1 },
    'aimed-shot': { class: 'hunter', name: 'Aimed Shot', level: 1, cost: 0, maxRank: 5, rankCost: 12, mana: 6, manaRank: 3, power: 8, scale: 2 },
    'wing-clip': { class: 'hunter', name: 'Wing Clip', level: 2, cost: 12, maxRank: 5, rankCost: 10, mana: 4, manaRank: 2, power: 2, scale: 1 },
    'multi-shot': { class: 'hunter', name: 'Multi-Shot', level: 4, cost: 20, maxRank: 5, rankCost: 16, mana: 8, manaRank: 3, power: 5, scale: 1 },
    'kill-shot': { class: 'hunter', name: 'Kill Shot', level: 6, cost: 30, maxRank: 5, rankCost: 16, mana: 8, manaRank: 4, power: 6, scale: 2, execute: true },
    wand: { class: 'warlock', name: 'Wand', level: 1, cost: 0, maxRank: 5, rankCost: 8, mana: 5, manaRank: 3, power: 4, scale: 1 },
    'shadow-bolt': { class: 'warlock', name: 'Shadow Bolt', level: 1, cost: 0, maxRank: 5, rankCost: 12, mana: 8, manaRank: 4, power: 7, scale: 1 },
    'drain-life': { class: 'warlock', name: 'Drain Life', level: 2, cost: 15, maxRank: 5, rankCost: 12, mana: 8, manaRank: 4, power: 4, scale: 1, leech: 1 },
    curse: { class: 'warlock', name: 'Curse', level: 3, cost: 15, maxRank: 5, rankCost: 12, mana: 6, manaRank: 3, power: 3, scale: 1 },
    hellfire: { class: 'warlock', name: 'Hellfire', level: 8, cost: 36, maxRank: 5, rankCost: 18, mana: 12, manaRank: 5, power: 5, scale: 1 },
    'soul-burn': { class: 'warlock', name: 'Soul Burn', level: 6, cost: 30, maxRank: 5, rankCost: 18, mana: 14, manaRank: 6, power: 8, scale: 2, execute: true }
};
const TREE = {
    sword: { class: 'warrior', spell: 'sword', requires: null },
    'power-strike': { class: 'warrior', spell: 'power-strike', requires: 'sword' },
    might: { class: 'warrior', name: 'Might', max: 5, requires: 'power-strike', text: '+1 melee damage per rank' },
    hamstring: { class: 'warrior', spell: 'hamstring', requires: 'might' },
    execute: { class: 'warrior', spell: 'execute', requires: 'hamstring' },
    cleave: { class: 'warrior', spell: 'cleave', requires: 'sword' },
    sweep: { class: 'warrior', name: 'Sweep', max: 5, requires: 'cleave', text: '+0.6m area per rank' },
    whirlwind: { class: 'warrior', spell: 'whirlwind', requires: 'sweep' },
    frenzy: { class: 'warrior', name: 'Frenzy', max: 5, requires: 'whirlwind', text: '+1 melee damage per rank' },
    toughness: { class: 'warrior', name: 'Toughness', max: 5, requires: 'sword', text: '+1 armor per rank' },
    stalwart: { class: 'warrior', name: 'Stalwart', max: 5, requires: 'toughness', text: '+4 health per rank' },
    defiance: { class: 'warrior', name: 'Defiance', max: 5, requires: 'stalwart', text: '+1 armor per rank' },
    'last-stand': { class: 'warrior', name: 'Last Stand', max: 5, requires: 'defiance', text: '+4 health per rank' },
    staff: { class: 'mage', spell: 'staff', requires: null },
    'arcane-bolt': { class: 'mage', spell: 'arcane-bolt', requires: 'staff' },
    'arcane-power': { class: 'mage', name: 'Arcane Power', max: 5, requires: 'arcane-bolt', text: '+1 spell damage per rank' },
    'arcane-surge': { class: 'mage', spell: 'arcane-surge', requires: 'arcane-power' },
    focus: { class: 'mage', name: 'Focus', max: 5, requires: 'arcane-surge', text: '+1 spell damage per rank' },
    'frost-bolt': { class: 'mage', spell: 'frost-bolt', requires: 'staff' },
    blast: { class: 'mage', name: 'Blast', max: 5, requires: 'frost-bolt', text: '+0.6m area per rank' },
    'frost-nova': { class: 'mage', spell: 'frost-nova', requires: 'blast' },
    winter: { class: 'mage', name: 'Winter', max: 5, requires: 'frost-nova', text: '+0.6m area per rank' },
    mend: { class: 'mage', spell: 'mend', requires: 'staff' },
    meditation: { class: 'mage', name: 'Meditation', max: 5, requires: 'mend', text: '+2 max mana per rank' },
    barrier: { class: 'mage', spell: 'barrier', requires: 'meditation' },
    ward: { class: 'mage', name: 'Ward', max: 5, requires: 'barrier', text: '+2 max mana per rank' },
    bow: { class: 'hunter', spell: 'bow', requires: null },
    'aimed-shot': { class: 'hunter', spell: 'aimed-shot', requires: 'bow' },
    precision: { class: 'hunter', name: 'Precision', max: 5, requires: 'aimed-shot', text: '+1 shot damage per rank' },
    'kill-shot': { class: 'hunter', spell: 'kill-shot', requires: 'precision' },
    'eagle-eye': { class: 'hunter', name: 'Eagle Eye', max: 5, requires: 'kill-shot', text: '+1 shot damage per rank' },
    'wing-clip': { class: 'hunter', spell: 'wing-clip', requires: 'bow' },
    'thick-hide': { class: 'hunter', name: 'Thick Hide', max: 5, requires: 'wing-clip', text: '+1 armor per rank' },
    endure: { class: 'hunter', name: 'Endure', max: 5, requires: 'thick-hide', text: '+4 health per rank' },
    stonehide: { class: 'hunter', name: 'Stonehide', max: 5, requires: 'endure', text: '+1 armor per rank' },
    'multi-shot': { class: 'hunter', spell: 'multi-shot', requires: 'bow' },
    volley: { class: 'hunter', name: 'Volley', max: 5, requires: 'multi-shot', text: '+0.6m area per rank' },
    barrage: { class: 'hunter', name: 'Barrage', max: 5, requires: 'volley', text: '+0.6m area per rank' },
    salvo: { class: 'hunter', name: 'Salvo', max: 5, requires: 'barrage', text: '+0.6m area per rank' },
    wand: { class: 'warlock', spell: 'wand', requires: null },
    'shadow-bolt': { class: 'warlock', spell: 'shadow-bolt', requires: 'wand' },
    affliction: { class: 'warlock', name: 'Affliction', max: 5, requires: 'shadow-bolt', text: '+1 spell damage per rank' },
    'soul-burn': { class: 'warlock', spell: 'soul-burn', requires: 'affliction' },
    ruin: { class: 'warlock', name: 'Ruin', max: 5, requires: 'soul-burn', text: '+1 spell damage per rank' },
    curse: { class: 'warlock', spell: 'curse', requires: 'wand' },
    immolate: { class: 'warlock', name: 'Immolate', max: 5, requires: 'curse', text: '+0.6m area per rank' },
    'drain-life': { class: 'warlock', spell: 'drain-life', requires: 'immolate' },
    siphon: { class: 'warlock', name: 'Siphon', max: 5, requires: 'drain-life', text: '+1 spell damage per rank' },
    hellfire: { class: 'warlock', spell: 'hellfire', requires: 'wand' },
    reservoir: { class: 'warlock', name: 'Reservoir', max: 5, requires: 'hellfire', text: '+2 max mana per rank' },
    torment: { class: 'warlock', name: 'Torment', max: 5, requires: 'reservoir', text: '+2 max mana per rank' },
    'soul-link': { class: 'warlock', name: 'Soul Link', max: 5, requires: 'torment', text: '+4 health per rank' }
};
const TALENTS = Object.fromEntries(Object.entries(TREE).filter(([, node]) => !node.spell).map(([id, node]) => [id, {
    class: node.class,
    name: node.name,
    max: node.max,
    requires: node.requires ? { [node.requires]: 1 } : null,
    text: node.text
}]));

function abilityRank(player, id) {
    const maxRank = (SPELLS[id] && SPELLS[id].maxRank) || 1;
    const rank = (player.spellRanks && player.spellRanks[id]) || 1;
    return Math.max(1, Math.min(maxRank, rank));
}

function abilityCost(id, rank) {
    const spell = SPELLS[id];
    const base = spell && spell.mana != null ? spell.mana : ((ABILITIES[id] && ABILITIES[id].mana) || 0);
    const step = spell && spell.manaRank != null ? spell.manaRank : 0;
    return base + Math.max(0, rank - 1) * step;
}

function rankPower(rank) {
    return 1 + Math.max(0, rank - 1) * 0.2;
}

function spellAmount(id, level) {
    const spell = SPELLS[id];
    if (!spell || spell.power == null) return 0;
    return spell.power + (level || 1) * (spell.scale || 0);
}

const COMBAT_HOLD = 6000;

function enterCombat(player, now) {
    player.combatUntil = (now || Date.now()) + COMBAT_HOLD;
}

const RECIPES = {
    'cloth-hat': { name: 'Cloth Hat', set: 'cloth', slot: 'head', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 2 } },
    'cloth-robe': { name: 'Cloth Robe', set: 'cloth', slot: 'chest', kind: 'armor', style: 'cloth', armor: 2, cost: { cloth: 4 } },
    'cloth-gloves': { name: 'Cloth Gloves', set: 'cloth', slot: 'hands', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 2 } },
    'cloth-pants': { name: 'Cloth Pants', set: 'cloth', slot: 'legs', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 3 } },
    'cloth-shoes': { name: 'Cloth Shoes', set: 'cloth', slot: 'feet', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 2 } },
    'cloth-shoulders': { name: 'Cloth Shoulders', set: 'cloth', slot: 'shoulders', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 3 }, loot: true },
    'cloth-sash': { name: 'Cloth Sash', set: 'cloth', slot: 'waist', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 2 }, loot: true },
    'cloth-cloak': { name: 'Cloth Cloak', set: 'cloth', slot: 'cloak', kind: 'armor', style: 'cloth', armor: 1, cost: { cloth: 3 }, loot: true },
    'leather-cap': { name: 'Leather Cap', set: 'leather', slot: 'head', kind: 'armor', style: 'leather', armor: 2, cost: { leather: 2 } },
    'leather-jerkin': { name: 'Leather Jerkin', set: 'leather', slot: 'chest', kind: 'armor', style: 'leather', armor: 3, cost: { leather: 4 } },
    'leather-gloves': { name: 'Leather Gloves', set: 'leather', slot: 'hands', kind: 'armor', style: 'leather', armor: 2, cost: { leather: 2 } },
    'leather-pants': { name: 'Leather Pants', set: 'leather', slot: 'legs', kind: 'armor', style: 'leather', armor: 2, cost: { leather: 3 } },
    'leather-boots': { name: 'Leather Boots', set: 'leather', slot: 'feet', kind: 'armor', style: 'leather', armor: 2, cost: { leather: 2 } },
    'leather-shoulders': { name: 'Leather Shoulders', set: 'leather', slot: 'shoulders', kind: 'armor', style: 'leather', armor: 2, cost: { leather: 3 }, loot: true },
    'leather-belt': { name: 'Leather Belt', set: 'leather', slot: 'waist', kind: 'armor', style: 'leather', armor: 1, cost: { leather: 2 }, loot: true },
    'plate-helm': { name: 'Plate Helm', set: 'plate', slot: 'head', kind: 'armor', style: 'plate', armor: 3, cost: { ore: 3, stone: 1 } },
    'plate-breastplate': { name: 'Plate Breastplate', set: 'plate', slot: 'chest', kind: 'armor', style: 'plate', armor: 5, cost: { ore: 5, stone: 2 } },
    'plate-gauntlets': { name: 'Plate Gauntlets', set: 'plate', slot: 'hands', kind: 'armor', style: 'plate', armor: 3, cost: { ore: 3 } },
    'plate-greaves': { name: 'Plate Greaves', set: 'plate', slot: 'legs', kind: 'armor', style: 'plate', armor: 4, cost: { ore: 4, stone: 1 } },
    'plate-sabatons': { name: 'Plate Sabatons', set: 'plate', slot: 'feet', kind: 'armor', style: 'plate', armor: 3, cost: { ore: 3, stone: 1 } },
    'plate-pauldrons': { name: 'Plate Pauldrons', set: 'plate', slot: 'shoulders', kind: 'armor', style: 'plate', armor: 3, cost: { ore: 3 }, loot: true },
    'plate-belt': { name: 'Plate Belt', set: 'plate', slot: 'waist', kind: 'armor', style: 'plate', armor: 2, cost: { ore: 2 }, loot: true },
    'iron-sword': { name: 'Iron Sword', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', armor: 0, cost: { ore: 2, wood: 1 } },
    'oak-staff': { name: 'Oak Staff', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'staff', armor: 0, cost: { wood: 3 } },
    'yew-bow': { name: 'Yew Bow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', armor: 0, cost: { wood: 3 } },
    'oak-wand': { name: 'Oak Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', armor: 0, cost: { wood: 2, gem: 1 } },
    'iron-buckler': { name: 'Iron Buckler', set: 'weapon', slot: 'offhand', kind: 'armor', style: 'plate', armor: 2, cost: { ore: 3 }, loot: true },
    'rune-blade': { name: 'Rune Blade', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'sword', magic: true, armor: 0, cost: { ore: 2, wood: 1, gem: 1 } },
    'arcane-staff': { name: 'Arcane Staff', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'staff', magic: true, armor: 0, cost: { wood: 2, gem: 1 } },
    'greater-rune-blade': { name: 'Greater Rune Blade', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'sword', magic: true, armor: 0, cost: { ore: 4, wood: 1, gem: 2 }, loot: true },
    'greater-arcane-staff': { name: 'Greater Arcane Staff', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'staff', magic: true, armor: 0, cost: { wood: 3, gem: 2 }, loot: true },
    'spell-focus': { name: 'Spell Focus', set: 'magic', slot: 'offhand', kind: 'armor', style: 'cloth', magic: true, armor: 1, cost: { wood: 1, gem: 1 }, loot: true },
    'gem-pendant': { name: 'Gem Pendant', set: 'magic', slot: 'neck', kind: 'armor', style: 'cloth', magic: true, armor: 1, cost: { cloth: 1, gem: 1 }, loot: true },
    'minor-health': { name: 'Minor Health Potion', set: 'alchemy', kind: 'health', amount: 18, cost: { herb: 2 } },
    'minor-mana': { name: 'Minor Mana Potion', set: 'alchemy', kind: 'mana', amount: 14, cost: { herb: 2 } },
    'greater-health': { name: 'Greater Health Potion', set: 'alchemy', kind: 'health', amount: 40, cost: { herb: 4, powder: 1 }, loot: true },
    'greater-mana': { name: 'Greater Mana Potion', set: 'alchemy', kind: 'mana', amount: 30, cost: { herb: 4, powder: 1 }, loot: true },
    'rough-bomb': { name: 'Rough Bomb', set: 'explosive', kind: 'bomb', amount: 14, cost: { powder: 2, stone: 1 } },
    'bitter-flask': { name: 'Bitter Flask', set: 'explosive', kind: 'bomb', amount: 10, cost: { herb: 2, powder: 1 } },
    'heavy-bomb': { name: 'Heavy Bomb', set: 'explosive', kind: 'bomb', amount: 28, cost: { powder: 3, ore: 1 }, loot: true },
    'silk-robe': { name: 'Silk Robe', set: 'cloth', slot: 'chest', kind: 'armor', style: 'cloth', armor: 4, cost: { cloth: 8 }, tier: 75, craftLevel: 75 },
    'silk-gloves': { name: 'Silk Gloves', set: 'cloth', slot: 'hands', kind: 'armor', style: 'cloth', armor: 2, cost: { cloth: 5 }, tier: 75, craftLevel: 100 },
    'rune-robe': { name: 'Runecloth Robe', set: 'cloth', slot: 'chest', kind: 'armor', style: 'cloth', armor: 6, cost: { cloth: 10, gem: 1 }, tier: 150, craftLevel: 150 },
    'rune-hood': { name: 'Runecloth Hood', set: 'cloth', slot: 'head', kind: 'armor', style: 'cloth', armor: 4, cost: { cloth: 6, gem: 1 }, tier: 150, craftLevel: 180 },
    'arcane-robe': { name: 'Arcanoweave Robe', set: 'cloth', slot: 'chest', kind: 'armor', style: 'cloth', magic: true, armor: 8, cost: { cloth: 12, gem: 2 }, tier: 225, craftLevel: 225 },
    'arcane-hood': { name: 'Arcanoweave Hood', set: 'cloth', slot: 'head', kind: 'armor', style: 'cloth', magic: true, armor: 5, cost: { cloth: 8, gem: 2 }, tier: 225, craftLevel: 260 },
    'silk-shoulders': { name: 'Silk Shoulders', set: 'cloth', slot: 'shoulders', kind: 'armor', style: 'cloth', armor: 2, cost: { cloth: 5 }, tier: 75, craftLevel: 90 },
    'silk-pants': { name: 'Silk Pants', set: 'cloth', slot: 'legs', kind: 'armor', style: 'cloth', armor: 3, cost: { cloth: 6 }, tier: 75, craftLevel: 110 },
    'rune-gloves': { name: 'Runecloth Gloves', set: 'cloth', slot: 'hands', kind: 'armor', style: 'cloth', armor: 3, cost: { cloth: 6, gem: 1 }, tier: 150, craftLevel: 165 },
    'rune-shoulders': { name: 'Runecloth Shoulders', set: 'cloth', slot: 'shoulders', kind: 'armor', style: 'cloth', armor: 4, cost: { cloth: 8, gem: 1 }, tier: 150, craftLevel: 175 },
    'rune-cloak': { name: 'Runecloth Cloak', set: 'cloth', slot: 'cloak', kind: 'armor', style: 'cloth', armor: 3, cost: { cloth: 6, gem: 1 }, tier: 150, craftLevel: 190 },
    'arcane-gloves': { name: 'Arcanoweave Gloves', set: 'cloth', slot: 'hands', kind: 'armor', style: 'cloth', magic: true, armor: 4, cost: { cloth: 8, gem: 2 }, tier: 225, craftLevel: 240 },
    'arcane-shoulders': { name: 'Arcanoweave Shoulders', set: 'cloth', slot: 'shoulders', kind: 'armor', style: 'cloth', magic: true, armor: 5, cost: { cloth: 10, gem: 2 }, tier: 225, craftLevel: 250 },
    'arcane-cloak': { name: 'Arcanoweave Cloak', set: 'cloth', slot: 'cloak', kind: 'armor', style: 'cloth', magic: true, armor: 4, cost: { cloth: 8, gem: 2 }, tier: 225, craftLevel: 270 },
    'cured-jerkin': { name: 'Cured Jerkin', set: 'leather', slot: 'chest', kind: 'armor', style: 'leather', armor: 5, cost: { leather: 8 }, tier: 75, craftLevel: 75 },
    'cured-boots': { name: 'Cured Boots', set: 'leather', slot: 'feet', kind: 'armor', style: 'leather', armor: 3, cost: { leather: 5 }, tier: 75, craftLevel: 100 },
    'thick-jerkin': { name: 'Thick Jerkin', set: 'leather', slot: 'chest', kind: 'armor', style: 'leather', armor: 7, cost: { leather: 10 }, tier: 150, craftLevel: 150 },
    'thick-cap': { name: 'Thick Cap', set: 'leather', slot: 'head', kind: 'armor', style: 'leather', armor: 5, cost: { leather: 6 }, tier: 150, craftLevel: 180 },
    'hardened-jerkin': { name: 'Hardened Jerkin', set: 'leather', slot: 'chest', kind: 'armor', style: 'leather', armor: 9, cost: { leather: 12, gem: 1 }, tier: 225, craftLevel: 225 },
    'hardened-cap': { name: 'Hardened Cap', set: 'leather', slot: 'head', kind: 'armor', style: 'leather', armor: 6, cost: { leather: 8, gem: 1 }, tier: 225, craftLevel: 260 },
    'cured-gloves': { name: 'Cured Gloves', set: 'leather', slot: 'hands', kind: 'armor', style: 'leather', armor: 3, cost: { leather: 5 }, tier: 75, craftLevel: 90 },
    'cured-shoulders': { name: 'Cured Shoulders', set: 'leather', slot: 'shoulders', kind: 'armor', style: 'leather', armor: 3, cost: { leather: 6 }, tier: 75, craftLevel: 110 },
    'thick-gloves': { name: 'Thick Gloves', set: 'leather', slot: 'hands', kind: 'armor', style: 'leather', armor: 4, cost: { leather: 7 }, tier: 150, craftLevel: 165 },
    'thick-boots': { name: 'Thick Boots', set: 'leather', slot: 'feet', kind: 'armor', style: 'leather', armor: 5, cost: { leather: 8 }, tier: 150, craftLevel: 175 },
    'thick-shoulders': { name: 'Thick Shoulders', set: 'leather', slot: 'shoulders', kind: 'armor', style: 'leather', armor: 5, cost: { leather: 8 }, tier: 150, craftLevel: 190 },
    'hardened-gloves': { name: 'Hardened Gloves', set: 'leather', slot: 'hands', kind: 'armor', style: 'leather', armor: 6, cost: { leather: 9, gem: 1 }, tier: 225, craftLevel: 240 },
    'hardened-boots': { name: 'Hardened Boots', set: 'leather', slot: 'feet', kind: 'armor', style: 'leather', armor: 7, cost: { leather: 10, gem: 1 }, tier: 225, craftLevel: 250 },
    'hardened-cloak': { name: 'Hardened Cloak', set: 'leather', slot: 'cloak', kind: 'armor', style: 'leather', armor: 5, cost: { leather: 8, gem: 1 }, tier: 225, craftLevel: 270 },
    'steel-breastplate': { name: 'Steel Breastplate', set: 'plate', slot: 'chest', kind: 'armor', style: 'plate', armor: 7, cost: { ore: 8, stone: 2 }, tier: 75, craftLevel: 75 },
    'steel-helm': { name: 'Steel Helm', set: 'plate', slot: 'head', kind: 'armor', style: 'plate', armor: 5, cost: { ore: 5, stone: 1 }, tier: 75, craftLevel: 100 },
    'mithril-breastplate': { name: 'Mithril Breastplate', set: 'plate', slot: 'chest', kind: 'armor', style: 'plate', armor: 9, cost: { ore: 10, stone: 3, gem: 1 }, tier: 150, craftLevel: 150 },
    'mithril-helm': { name: 'Mithril Helm', set: 'plate', slot: 'head', kind: 'armor', style: 'plate', armor: 6, cost: { ore: 6, stone: 2, gem: 1 }, tier: 150, craftLevel: 180 },
    'thorium-breastplate': { name: 'Thorium Breastplate', set: 'plate', slot: 'chest', kind: 'armor', style: 'plate', armor: 12, cost: { ore: 12, stone: 4, gem: 2 }, tier: 225, craftLevel: 225 },
    'thorium-helm': { name: 'Thorium Helm', set: 'plate', slot: 'head', kind: 'armor', style: 'plate', armor: 8, cost: { ore: 8, stone: 2, gem: 2 }, tier: 225, craftLevel: 260 },
    'steel-sword': { name: 'Steel Sword', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', armor: 0, cost: { ore: 4, wood: 1 }, tier: 75, craftLevel: 75 },
    'steel-staff': { name: 'Steel Staff', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'staff', armor: 0, cost: { wood: 6 }, tier: 75, craftLevel: 100 },
    'mithril-sword': { name: 'Mithril Sword', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', armor: 0, cost: { ore: 6, wood: 1, gem: 1 }, tier: 150, craftLevel: 150 },
    'mithril-staff': { name: 'Mithril Staff', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'staff', armor: 0, cost: { wood: 8, gem: 1 }, tier: 150, craftLevel: 180 },
    'thorium-sword': { name: 'Thorium Sword', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', armor: 0, cost: { ore: 8, wood: 2, gem: 2 }, tier: 225, craftLevel: 225 },
    'thorium-staff': { name: 'Thorium Staff', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'staff', armor: 0, cost: { wood: 10, gem: 2 }, tier: 225, craftLevel: 260 },
    'ash-bow': { name: 'Ash Bow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', armor: 0, cost: { wood: 5 }, tier: 75, craftLevel: 85 },
    'recurve-bow': { name: 'Recurve Bow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', armor: 0, cost: { wood: 8 }, tier: 150, craftLevel: 160 },
    'longbow': { name: 'Longbow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', armor: 0, cost: { wood: 10, gem: 1 }, tier: 225, craftLevel: 240 },
    'bone-wand': { name: 'Bone Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', armor: 0, cost: { wood: 4, gem: 1 }, tier: 75, craftLevel: 90 },
    'shadow-wand': { name: 'Shadow Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', armor: 0, cost: { wood: 6, gem: 1 }, tier: 150, craftLevel: 170 },
    'void-wand': { name: 'Void Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', armor: 0, cost: { wood: 8, gem: 2 }, tier: 225, craftLevel: 250 },
    'bright-blade': { name: 'Bright Rune Blade', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'sword', magic: true, armor: 0, cost: { ore: 3, wood: 1, gem: 1 }, tier: 75, craftLevel: 75 },
    'bright-staff': { name: 'Bright Staff', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'staff', magic: true, armor: 0, cost: { wood: 3, gem: 2 }, tier: 75, craftLevel: 100 },
    'sun-blade': { name: 'Sun Blade', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'sword', magic: true, armor: 0, cost: { ore: 4, gem: 2 }, tier: 150, craftLevel: 150 },
    'sun-staff': { name: 'Sun Staff', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'staff', magic: true, armor: 0, cost: { wood: 4, gem: 3 }, tier: 150, craftLevel: 180 },
    'star-blade': { name: 'Star Blade', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'sword', magic: true, armor: 0, cost: { ore: 6, gem: 3 }, tier: 225, craftLevel: 225 },
    'star-staff': { name: 'Star Staff', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'staff', magic: true, armor: 0, cost: { wood: 6, gem: 4 }, tier: 225, craftLevel: 260 },
    'hawk-bow': { name: 'Hawk Bow', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'bow', magic: true, armor: 0, cost: { wood: 4, gem: 1 }, tier: 75, craftLevel: 90 },
    'eagle-bow': { name: 'Eagle Bow', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'bow', magic: true, armor: 0, cost: { wood: 6, gem: 2 }, tier: 150, craftLevel: 170 },
    'phoenix-bow': { name: 'Phoenix Bow', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'bow', magic: true, armor: 0, cost: { wood: 8, gem: 3 }, tier: 225, craftLevel: 250 },
    'ember-wand': { name: 'Ember Wand', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'wand', magic: true, armor: 0, cost: { wood: 3, gem: 2 }, tier: 75, craftLevel: 100 },
    'hex-wand': { name: 'Hex Wand', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'wand', magic: true, armor: 0, cost: { wood: 4, gem: 3 }, tier: 150, craftLevel: 180 },
    'soul-wand': { name: 'Soul Wand', set: 'magic', slot: 'weapon', kind: 'weapon', weapon: 'wand', magic: true, armor: 0, cost: { wood: 6, gem: 4 }, tier: 225, craftLevel: 260 },
    'strong-health': { name: 'Strong Health Potion', set: 'alchemy', kind: 'health', amount: 55, cost: { herb: 6, powder: 1 }, tier: 75, craftLevel: 75 },
    'strong-mana': { name: 'Strong Mana Potion', set: 'alchemy', kind: 'mana', amount: 40, cost: { herb: 6, powder: 1 }, tier: 75, craftLevel: 100 },
    'mighty-health': { name: 'Mighty Health Potion', set: 'alchemy', kind: 'health', amount: 80, cost: { herb: 8, powder: 2 }, tier: 150, craftLevel: 150 },
    'mighty-mana': { name: 'Mighty Mana Potion', set: 'alchemy', kind: 'mana', amount: 60, cost: { herb: 8, powder: 2 }, tier: 150, craftLevel: 180 },
    'flask-health': { name: 'Health Flask', set: 'alchemy', kind: 'health', amount: 120, cost: { herb: 10, powder: 3, gem: 1 }, tier: 225, craftLevel: 225 },
    'flask-mana': { name: 'Mana Flask', set: 'alchemy', kind: 'mana', amount: 90, cost: { herb: 10, powder: 3, gem: 1 }, tier: 225, craftLevel: 260 },
    'packed-bomb': { name: 'Packed Bomb', set: 'explosive', kind: 'bomb', amount: 36, cost: { powder: 4, stone: 2 }, tier: 75, craftLevel: 75 },
    'packed-flask': { name: 'Packed Flask', set: 'explosive', kind: 'bomb', amount: 22, cost: { herb: 4, powder: 2 }, tier: 75, craftLevel: 100 },
    'siege-bomb': { name: 'Siege Bomb', set: 'explosive', kind: 'bomb', amount: 50, cost: { powder: 6, ore: 2 }, tier: 150, craftLevel: 150 },
    'siege-flask': { name: 'Siege Flask', set: 'explosive', kind: 'bomb', amount: 36, cost: { herb: 6, powder: 3 }, tier: 150, craftLevel: 180 },
    'devastation': { name: 'Devastation Charge', set: 'explosive', kind: 'bomb', amount: 70, cost: { powder: 8, ore: 2, gem: 1 }, tier: 225, craftLevel: 225 },
    'ruin-flask': { name: 'Ruin Flask', set: 'explosive', kind: 'bomb', amount: 50, cost: { herb: 8, powder: 4, gem: 1 }, tier: 225, craftLevel: 260 },
    'healing-draught': { name: 'Healing Draught', set: 'alchemy', kind: 'health', amount: 10, cost: { herb: 1 }, craftLevel: 8 },
    'mana-draught': { name: 'Mana Draught', set: 'alchemy', kind: 'mana', amount: 8, cost: { herb: 1 }, craftLevel: 22 },
    'bracing-health': { name: 'Bracing Potion', set: 'alchemy', kind: 'health', amount: 48, cost: { herb: 5, powder: 1 }, tier: 75, craftLevel: 85 },
    'bracing-mana': { name: 'Bracing Mana', set: 'alchemy', kind: 'mana', amount: 32, cost: { herb: 5 }, tier: 75, craftLevel: 115 },
    'potent-health': { name: 'Potent Health Potion', set: 'alchemy', kind: 'health', amount: 95, cost: { herb: 9, powder: 2 }, tier: 150, craftLevel: 165 },
    'potent-mana': { name: 'Potent Mana Potion', set: 'alchemy', kind: 'mana', amount: 70, cost: { herb: 9, powder: 2 }, tier: 150, craftLevel: 195 },
    'elixir-health': { name: 'Health Elixir', set: 'alchemy', kind: 'health', amount: 150, cost: { herb: 12, powder: 4, gem: 1 }, tier: 225, craftLevel: 240 },
    'elixir-mana': { name: 'Mana Elixir', set: 'alchemy', kind: 'mana', amount: 110, cost: { herb: 12, powder: 4, gem: 1 }, tier: 225, craftLevel: 275 },
    'stone-charge': { name: 'Stone Charge', set: 'explosive', kind: 'bomb', amount: 8, cost: { stone: 2, powder: 1 }, craftLevel: 12 },
    'spark-flask': { name: 'Spark Flask', set: 'explosive', kind: 'bomb', amount: 16, cost: { herb: 1, powder: 2 }, craftLevel: 35 },
    'iron-charge': { name: 'Iron Charge', set: 'explosive', kind: 'bomb', amount: 30, cost: { powder: 3, ore: 1 }, tier: 75, craftLevel: 85 },
    'caustic-flask': { name: 'Caustic Flask', set: 'explosive', kind: 'bomb', amount: 28, cost: { herb: 3, powder: 3 }, tier: 75, craftLevel: 120 },
    'ore-charge': { name: 'Ore Charge', set: 'explosive', kind: 'bomb', amount: 44, cost: { powder: 5, ore: 2 }, tier: 150, craftLevel: 165 },
    'venom-flask': { name: 'Venom Flask', set: 'explosive', kind: 'bomb', amount: 42, cost: { herb: 5, powder: 4 }, tier: 150, craftLevel: 195 },
    'gem-charge': { name: 'Gem Charge', set: 'explosive', kind: 'bomb', amount: 85, cost: { powder: 8, ore: 2, gem: 1 }, tier: 225, craftLevel: 240 },
    'void-flask': { name: 'Void Flask', set: 'explosive', kind: 'bomb', amount: 62, cost: { herb: 8, powder: 5, gem: 1 }, tier: 225, craftLevel: 275 },
    'cut-gem': { name: 'Cut Gem', set: 'alchemy', kind: 'gem', yield: { gem: 1 }, cost: { powder: 8 }, buy: true, price: 20, craftLevel: 20 },
    'bright-cut': { name: 'Bright Cut', set: 'alchemy', kind: 'gem', yield: { gem: 1 }, cost: { powder: 6, herb: 1 }, buy: true, price: 80, craftLevel: 90 },
    'rare-cut': { name: 'Rare Cut', set: 'alchemy', kind: 'gem', yield: { gem: 1 }, cost: { powder: 4, herb: 2 }, buy: true, price: 180, craftLevel: 180 },
    'pristine-cut': { name: 'Pristine Cut', set: 'alchemy', kind: 'gem', yield: { gem: 2 }, cost: { powder: 6, herb: 2 }, buy: true, price: 320, craftLevel: 260 },
    'crystal-health': { name: 'Crystal Health Potion', set: 'alchemy', kind: 'health', amount: 180, cost: { herb: 12, powder: 5, gem: 2 }, buy: true, price: 160, craftLevel: 240 },
    'crystal-mana': { name: 'Crystal Mana Potion', set: 'alchemy', kind: 'mana', amount: 130, cost: { herb: 12, powder: 5, gem: 2 }, buy: true, price: 180, craftLevel: 270 },
    'silk-sash': { name: 'Silk Sash', set: 'cloth', slot: 'waist', kind: 'armor', style: 'cloth', armor: 2, cost: { cloth: 4, silk: 2 }, buy: true, price: 24, craftLevel: 40, reqLevel: 10, statsSet: true, stats: { intellect: 3, stamina: 1 } },
    'rune-sash': { name: 'Runecloth Sash', set: 'cloth', slot: 'waist', kind: 'armor', style: 'cloth', armor: 4, cost: { cloth: 8, silk: 4, gem: 1 }, buy: true, price: 80, craftLevel: 120, reqLevel: 26, statsSet: true, stats: { intellect: 6, stamina: 2 } },
    'nightweave-robe': { name: 'Nightweave Robe', set: 'cloth', slot: 'chest', kind: 'armor', style: 'cloth', magic: true, armor: 7, cost: { cloth: 12, silk: 6, gem: 2 }, buy: true, price: 180, craftLevel: 200, reqLevel: 42, statsSet: true, stats: { intellect: 10, stamina: 3 } },
    'starweave-hood': { name: 'Starweave Hood', set: 'cloth', slot: 'head', kind: 'armor', style: 'cloth', magic: true, armor: 6, cost: { cloth: 10, silk: 8, gem: 4 }, buy: true, price: 320, craftLevel: 280, reqLevel: 56, statsSet: true, stats: { intellect: 14, stamina: 4 } },
    'trail-belt': { name: 'Trail Belt', set: 'leather', slot: 'waist', kind: 'armor', style: 'leather', armor: 3, cost: { leather: 5 }, buy: true, price: 28, craftLevel: 50, reqLevel: 14, statsSet: true, stats: { strength: 3, stamina: 2 } },
    'studded-belt': { name: 'Studded Belt', set: 'leather', slot: 'waist', kind: 'armor', style: 'leather', armor: 5, cost: { leather: 8, gem: 1 }, buy: true, price: 90, craftLevel: 140, reqLevel: 30, statsSet: true, stats: { strength: 6, stamina: 3 } },
    'night-jerkin': { name: 'Night Jerkin', set: 'leather', slot: 'chest', kind: 'armor', style: 'leather', armor: 8, cost: { leather: 12, gem: 2 }, buy: true, price: 200, craftLevel: 220, reqLevel: 46, statsSet: true, stats: { strength: 10, stamina: 4 } },
    'shadow-cloak': { name: 'Shadow Cloak', set: 'leather', slot: 'cloak', kind: 'armor', style: 'leather', armor: 6, cost: { leather: 10, gem: 4 }, buy: true, price: 340, craftLevel: 285, reqLevel: 58, statsSet: true, stats: { strength: 12, stamina: 5 } },
    'iron-belt': { name: 'Iron Belt', set: 'plate', slot: 'waist', kind: 'armor', style: 'plate', armor: 4, cost: { ore: 5, stone: 2 }, buy: true, price: 32, craftLevel: 55, reqLevel: 16, statsSet: true, stats: { strength: 4, stamina: 3 } },
    'steel-greaves': { name: 'Steel Greaves', set: 'plate', slot: 'legs', kind: 'armor', style: 'plate', armor: 7, cost: { ore: 8, stone: 3, gem: 1 }, buy: true, price: 100, craftLevel: 150, reqLevel: 32, statsSet: true, stats: { strength: 7, stamina: 5 } },
    'mithril-gauntlets': { name: 'Mithril Gauntlets', set: 'plate', slot: 'hands', kind: 'armor', style: 'plate', armor: 8, cost: { ore: 10, stone: 3, gem: 2 }, buy: true, price: 210, craftLevel: 210, reqLevel: 44, statsSet: true, stats: { strength: 11, stamina: 6 } },
    'thorium-sabatons': { name: 'Thorium Sabatons', set: 'plate', slot: 'feet', kind: 'armor', style: 'plate', armor: 10, cost: { ore: 14, stone: 4, gem: 4 }, buy: true, price: 360, craftLevel: 290, reqLevel: 58, statsSet: true, stats: { strength: 14, stamina: 8 } },
    'bronze-sword': { name: 'Bronze Sword', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', armor: 0, cost: { ore: 4, wood: 1 }, buy: true, price: 36, craftLevel: 60, reqLevel: 16, statsSet: true, stats: { strength: 5 } },
    'gemmed-blade': { name: 'Gemmed Blade', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', armor: 0, cost: { ore: 7, wood: 2, gem: 2 }, buy: true, price: 140, craftLevel: 160, reqLevel: 36, statsSet: true, stats: { strength: 10 } },
    'king-blade': { name: 'King Blade', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'sword', magic: true, armor: 0, cost: { ore: 12, wood: 2, gem: 4 }, buy: true, price: 340, craftLevel: 275, reqLevel: 55, statsSet: true, stats: { strength: 16 } },
    'grove-bow': { name: 'Grove Bow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', armor: 0, cost: { wood: 6 }, buy: true, price: 40, craftLevel: 70, reqLevel: 18, statsSet: true, stats: { strength: 5 } },
    'elder-bow': { name: 'Elder Bow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', armor: 0, cost: { wood: 8, gem: 2 }, buy: true, price: 160, craftLevel: 175, reqLevel: 38, statsSet: true, stats: { strength: 11 } },
    'warbow': { name: 'Warbow', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'bow', magic: true, armor: 0, cost: { wood: 12, gem: 4 }, buy: true, price: 320, craftLevel: 270, reqLevel: 54, statsSet: true, stats: { strength: 15 } },
    'thorn-wand': { name: 'Thorn Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', armor: 0, cost: { wood: 3, gem: 1 }, buy: true, price: 40, craftLevel: 65, reqLevel: 16, statsSet: true, stats: { intellect: 5 } },
    'night-wand': { name: 'Night Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', armor: 0, cost: { wood: 6, gem: 2 }, buy: true, price: 150, craftLevel: 170, reqLevel: 36, statsSet: true, stats: { intellect: 10 } },
    'abyss-wand': { name: 'Abyss Wand', set: 'weapon', slot: 'weapon', kind: 'weapon', weapon: 'wand', magic: true, armor: 0, cost: { wood: 8, gem: 4 }, buy: true, price: 300, craftLevel: 265, reqLevel: 52, statsSet: true, stats: { intellect: 15 } },
    'minor-focus': { name: 'Minor Focus', set: 'magic', slot: 'offhand', kind: 'armor', style: 'cloth', magic: true, armor: 2, cost: { wood: 2, gem: 2 }, buy: true, price: 70, craftLevel: 80, reqLevel: 20, statsSet: true, stats: { intellect: 6 } },
    'star-focus': { name: 'Star Focus', set: 'magic', slot: 'offhand', kind: 'armor', style: 'cloth', magic: true, armor: 3, cost: { wood: 3, gem: 3 }, buy: true, price: 170, craftLevel: 190, reqLevel: 40, statsSet: true, stats: { intellect: 11 } },
    'void-focus': { name: 'Void Focus', set: 'magic', slot: 'offhand', kind: 'armor', style: 'cloth', magic: true, armor: 4, cost: { wood: 4, gem: 5 }, buy: true, price: 340, craftLevel: 280, reqLevel: 56, statsSet: true, stats: { intellect: 16 } }
};

const CRAFT_SETS = {
    cloth: { name: 'Clothworking', cost: 12, rarity: 1, text: 'Cloth armor for mages and warlocks.' },
    leather: { name: 'Leatherworking', cost: 20, rarity: 2, text: 'Leather armor for hunters.' },
    plate: { name: 'Armorsmithing', cost: 30, rarity: 3, text: 'Helm, breastplate, gauntlets, greaves, and sabatons.' },
    weapon: { name: 'Weaponsmithing', cost: 16, rarity: 1, text: 'Swords, staves, bows, and wands.' },
    magic: { name: 'Spellforging', cost: 28, rarity: 4, text: 'Enchanted blades, staves, bows, and wands.' },
    alchemy: { name: 'Alchemy', cost: 18, rarity: 2, text: 'Potions, and refining powder into gems.' },
    explosive: { name: 'Explosives', cost: 22, rarity: 2, text: 'Charges and flasks from powder, stone, and ore.' }
};

const SHOP_GOODS = [
    { id: 'health', name: 'Health potions', kind: 'health', itemName: 'Health potion', amount: 18, qty: 5, cost: 20 },
    { id: 'mana', name: 'Mana potions', kind: 'mana', itemName: 'Mana potion', amount: 14, qty: 5, cost: 20 }
];

const MAX_CRAFT_SKILLS = 2;
const CRAFT_CAP = 300;
const CRAFT_TIERS = [75, 150, 225];
const APPRENTICE_LEVEL = {
    'cloth-hat': 1, 'cloth-gloves': 1, 'cloth-shoes': 15, 'cloth-pants': 30, 'cloth-robe': 50,
    'leather-cap': 1, 'leather-gloves': 10, 'leather-boots': 20, 'leather-pants': 35, 'leather-jerkin': 55,
    'plate-helm': 5, 'plate-gauntlets': 15, 'plate-sabatons': 25, 'plate-greaves': 40, 'plate-breastplate': 55,
    'iron-sword': 1, 'oak-staff': 25, 'yew-bow': 10, 'oak-wand': 25,
    'rune-blade': 15, 'arcane-staff': 40,
    'minor-health': 1, 'minor-mana': 15,
    'rough-bomb': 1, 'bitter-flask': 20
};

for (const [id, recipe] of Object.entries(RECIPES)) {
    recipe.tier = recipe.tier || 0;
    if (!recipe.craftLevel) {
        if (recipe.loot) {
            const greater = /greater|heavy/i.test(recipe.name);
            recipe.tier = greater ? 150 : 75;
            recipe.craftLevel = greater ? 160 : 85;
        } else recipe.craftLevel = APPRENTICE_LEVEL[id] || 1;
    }
    const tier = recipe.tier || 0;
    if (recipe.buy || !tier) continue;
    if (recipe.set === 'cloth') recipe.cost = { ...recipe.cost, silk: tier === 75 ? 2 : tier === 150 ? 4 : 6 };
    if (tier >= 150 && recipe.set !== 'alchemy' && recipe.set !== 'explosive' && recipe.set !== 'cloth') {
        recipe.cost = { ...recipe.cost, gem: Math.max(recipe.cost.gem || 0, tier === 150 ? 1 : 2) };
    }
    if (tier === 225 && (recipe.set === 'alchemy' || recipe.set === 'explosive')) {
        recipe.cost = { ...recipe.cost, gem: Math.max(recipe.cost.gem || 0, 2) };
    }
}

function xpToNextCraft(level) {
    return Math.max(1, Math.round((6 + level * 2) * 0.25));
}

function craftXpGain(craftLevel, skill) {
    if (skill >= CRAFT_CAP) return 0;
    const over = skill - craftLevel;
    if (over >= 40) return 0;
    const base = Math.max(1, Math.ceil(craftLevel / 10));
    if (over <= 0) return base;
    return Math.max(1, Math.ceil(base * (40 - over) / 40));
}

const MATERIAL_NAMES = { cloth: 'Cloth', leather: 'Leather', ore: 'Ore', gem: 'Gem', wood: 'Wood', stone: 'Stone', herb: 'Herb', powder: 'Powder', silk: 'Silk' };

function lootRecipeIds() {
    return Object.keys(RECIPES).filter(id => RECIPES[id].loot);
}

function statsForRecipe(recipe) {
    if (recipe && recipe.statsSet) {
        return { stats: cleanStats(recipe.stats), reqLevel: Math.max(1, Math.round(Number(recipe.reqLevel) || 1)) };
    }
    return craftedStats(recipe);
}

function rewardFromCatalog(quest) {
    if (quest.rewardKind === 'bag') {
        const named = Object.entries(BAGS).find(([, bag]) => bag.name === quest.rewardName);
        return makeBag(named ? named[0] : 'linen-sack');
    }
    const name = quest.rewardName || quest.rewardKind;
    const found = Object.values(RECIPES).find(recipe => recipe.name === name && (!quest.rewardKind || recipe.kind === quest.rewardKind));
    if (!found) return { kind: quest.rewardKind, name, qty: quest.rewardQty || 1 };
    const made = statsForRecipe(found);
    return {
        kind: found.kind,
        name: found.name,
        qty: quest.rewardQty || 1,
        armor: found.armor || 0,
        weapon: found.weapon || '',
        slot: found.slot || '',
        style: found.style || '',
        magic: !!found.magic,
        amount: found.amount || 0,
        icon: found.icon || defaultIconName(found),
        stats: made.stats,
        reqLevel: made.reqLevel
    };
}

function publicCraft() {
    const recipes = {};
    for (const [id, recipe] of Object.entries(RECIPES)) {
        const made = statsForRecipe(recipe);
        recipes[id] = {
            name: recipe.name,
            set: recipe.set,
            slot: recipe.slot,
            kind: recipe.kind,
            style: recipe.style || '',
            armor: recipe.armor || 0,
            weapon: recipe.weapon || '',
            magic: !!recipe.magic,
            cost: recipe.cost,
            loot: !!recipe.loot,
            buy: !!recipe.buy,
            price: recipe.price || 0,
            yield: recipe.yield || null,
            tier: recipe.tier || 0,
            craftLevel: recipe.craftLevel || 1,
            icon: recipe.icon || defaultIconName(recipe),
            stats: made.stats,
            reqLevel: made.reqLevel
        };
    }
    return { sets: CRAFT_SETS, recipes };
}

function emptyEquipment() {
    const gear = {};
    for (const slot of EQUIP_SLOTS) gear[slot] = null;
    return gear;
}

function loadCharacter(prof) {
    prof.legacyArmor = prof.legacyArmor || 0;
    if (!prof.equipment) {
        prof.equipment = emptyEquipment();
        const old = prof.armor || 0;
        if (old > 0) {
            prof.equipment.chest = { kind: 'armor', slot: 'chest', name: 'Salvaged Armor', qty: 1, armor: old, amount: 0, weapon: '' };
            prof.legacyArmor = 0;
        } else {
            prof.legacyArmor = 0;
        }
    } else {
        const next = emptyEquipment();
        for (const slot of EQUIP_SLOTS) next[slot] = prof.equipment[slot] ? copySlot(prof.equipment[slot]) : null;
        prof.equipment = next;
    }
    if (!CLASS_KITS[prof.class]) prof.class = null;
    if (!CLASS_KITS[prof.look]) prof.look = prof.class || '';
    prof.trained = Array.isArray(prof.trained) ? prof.trained.filter(id => SPELLS[id]) : [];
    const rawRanks = prof.spellRanks && typeof prof.spellRanks === 'object' ? { ...prof.spellRanks } : {};
    if (prof.talents && typeof prof.talents === 'object') {
        for (const [id, rank] of Object.entries(prof.talents)) {
            const node = TREE[id];
            if (!node || !node.spell || node.class !== prof.class) continue;
            const maxRank = (SPELLS[node.spell] && SPELLS[node.spell].maxRank) || 1;
            const value = Math.max(0, Math.min(maxRank, Math.round(Number(rank) || 0)));
            if (!value) continue;
            if (!prof.trained.includes(node.spell)) prof.trained.push(node.spell);
            rawRanks[node.spell] = Math.max(Number(rawRanks[node.spell]) || 0, value);
        }
    }
    const talents = {};
    if (prof.talents && typeof prof.talents === 'object') {
        for (const [id, rank] of Object.entries(prof.talents)) {
            const def = TALENTS[id];
            if (!def) continue;
            talents[id] = Math.max(0, Math.min(def.max, Number(rank) || 0));
        }
    }
    prof.talents = talents;
    const ranks = {};
    for (const id of prof.trained) {
        const maxRank = (SPELLS[id] && SPELLS[id].maxRank) || 1;
        ranks[id] = Math.max(1, Math.min(maxRank, Number(rawRanks[id]) || 1));
    }
    prof.spellRanks = ranks;
    const seen = new Set();
    prof.recipes = (Array.isArray(prof.recipes) ? prof.recipes : []).filter(id => {
        if (!RECIPES[id] || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    if (!prof.craftSkill || typeof prof.craftSkill !== 'object') prof.craftSkill = {};
    const skills = {};
    for (const setId of learnedCraftSets({ recipes: prof.recipes })) {
        const cur = prof.craftSkill[setId] || {};
        const level = Math.max(1, Math.min(CRAFT_CAP, Math.round(Number(cur.level) || 1)));
        const tiers = [0];
        for (const tier of Array.isArray(cur.tiers) ? cur.tiers : []) {
            const value = Number(tier);
            if (CRAFT_TIERS.includes(value) && !tiers.includes(value)) tiers.push(value);
        }
        skills[setId] = { level, xp: Math.max(0, Math.round(Number(cur.xp) || 0)), tiers };
    }
    prof.craftSkill = skills;
    for (const [setId, skill] of Object.entries(skills)) {
        for (const tier of skill.tiers) {
            for (const id of Object.keys(RECIPES)) {
                const recipe = RECIPES[id];
                if (recipe.set !== setId || (recipe.tier || 0) !== tier || recipe.loot || seen.has(id)) continue;
                prof.recipes.push(id);
                seen.add(id);
            }
        }
    }
    loadQuests(prof);
}

function armorValue(player) {
    let total = ranksIn(player, ['toughness', 'thick-hide', 'defiance', 'stonehide']);
    let worn = false;
    for (const slot of EQUIP_SLOTS) {
        if (slot === 'weapon') continue;
        const piece = player.equipment && player.equipment[slot];
        if (!piece) continue;
        worn = true;
        total += piece.armor || 0;
    }
    if (!worn) total += player.legacyArmor || 0;
    return total;
}

function refreshDerived(player) {
    player.stats = totalStats(player);
    player.armor = armorValue(player);
    const nextHp = maxHpFor(player.level) + player.stats.stamina * 4 + ranksIn(player, ['stalwart', 'last-stand', 'endure', 'soul-link']) * 4;
    const nextMana = maxManaFor(player) + player.stats.intellect * 2;
    const wasFull = !player.maxHp || player.hp >= player.maxHp;
    player.maxHp = nextHp;
    if (wasFull || player.hp > nextHp) player.hp = nextHp;
    if (player.mana > nextMana) player.mana = nextMana;
    player.maxMana = nextMana;
}

function pointsEarned(level) {
    const lv = level || 1;
    if (lv < 5) return 0;
    return 1 + Math.floor((lv - 5) / 2);
}

function talentPoints(player) {
    return Math.max(0, pointsEarned(player.level) - ranksSpent(player));
}

function ranksSpent(player) {
    if (!player.class || !CLASS_KITS[player.class]) return 0;
    const free = new Set(CLASS_KITS[player.class].trained);
    let spent = 0;
    for (const [id, node] of Object.entries(TREE)) {
        if (node.class !== player.class) continue;
        const rank = nodeRank(player, id);
        if (!rank) continue;
        if (node.spell && free.has(node.spell)) spent += Math.max(0, rank - 1);
        else spent += rank;
    }
    return spent;
}

function nodeRank(player, id) {
    const node = TREE[id];
    if (!node) return 0;
    if (node.spell) return player.trained.includes(node.spell) ? ((player.spellRanks && player.spellRanks[node.spell]) || 1) : 0;
    return talentRank(player, id);
}

function nodeMax(id) {
    const node = TREE[id];
    if (!node) return 1;
    if (node.spell) return (SPELLS[node.spell] && SPELLS[node.spell].maxRank) || 1;
    return node.max || 1;
}

function knownSpells(player) {
    if (!player.class) return ['sword', 'power-strike', 'staff', 'arcane-bolt', 'mend', 'gather'];
    const known = ['gather'];
    for (const id of player.trained) {
        const spell = SPELLS[id];
        if (!spell || spell.class !== player.class) continue;
        known.push(id);
    }
    return known;
}

function publicCharacter(player) {
    return {
        class: player.class,
        look: player.look || player.class || '',
        equipment: player.equipment,
        trained: player.trained,
        talents: player.talents,
        spellRanks: player.spellRanks || {},
        recipes: player.recipes || [],
        craft: publicCraft(),
        craftSkill: player.craftSkill || {},
        points: talentPoints(player),
        known: knownSpells(player),
        spells: SPELLS,
        tree: TREE,
        talentsDef: TALENTS,
        stats: player.stats || totalStats(player)
    };
}

const MATERIAL_KINDS = ['wood', 'stone', 'cloth', 'leather', 'ore', 'gem', 'herb', 'powder', 'silk'];

function blankMaterials() {
    return { wood: 0, stone: 0, cloth: 0, leather: 0, ore: 0, gem: 0, herb: 0, powder: 0, silk: 0 };
}

function coinCount(player) {
    return player.coins || 0;
}

function spendCoins(player, amount) {
    if (amount <= 0) return true;
    if (coinCount(player) < amount) return false;
    player.coins -= amount;
    return true;
}

function countKind(player, kind) {
    if (kind === 'coins') return player.coins || 0;
    if (MATERIAL_KINDS.includes(kind)) return (player.materials && player.materials[kind]) || 0;
    return player.slots.reduce((sum, slot) => sum + (slot && slot.kind === kind ? slot.qty : 0), 0);
}

function takeKind(player, kind, amount) {
    if (countKind(player, kind) < amount) return false;
    if (kind === 'coins') return spendCoins(player, amount);
    if (MATERIAL_KINDS.includes(kind)) {
        player.materials[kind] -= amount;
        return true;
    }
    let left = amount;
    for (let i = 0; i < player.slots.length && left > 0; i++) {
        const slot = player.slots[i];
        if (!slot || slot.kind !== kind) continue;
        const take = Math.min(slot.qty, left);
        slot.qty -= take;
        left -= take;
        if (slot.qty <= 0) player.slots[i] = null;
    }
    return true;
}

function learnedCraftSets(player) {
    const sets = new Set();
    for (const id of player.recipes || []) {
        const recipe = RECIPES[id];
        if (recipe) sets.add(recipe.set);
    }
    return sets;
}

function craftRoom(player, setId) {
    const sets = learnedCraftSets(player);
    if (sets.has(setId)) return null;
    if (sets.size >= MAX_CRAFT_SKILLS) return 'You can only learn 2 crafting skills';
    return null;
}

function learnSet(player, setId) {
    const set = CRAFT_SETS[setId];
    if (!set) return 'Unknown set';
    const blocked = craftRoom(player, setId);
    if (blocked) return blocked;
    const ids = Object.keys(RECIPES).filter(id => RECIPES[id].set === setId && !RECIPES[id].loot && !RECIPES[id].buy && !(RECIPES[id].tier > 0));
    if (ids.every(id => player.recipes.includes(id))) return 'Already learned';
    if (!spendCoins(player, set.cost)) return 'Not enough coins';
    for (const id of ids) if (!player.recipes.includes(id)) player.recipes.push(id);
    if (!player.craftSkill) player.craftSkill = {};
    if (!player.craftSkill[setId]) player.craftSkill[setId] = { level: 1, xp: 0, tiers: [0] };
    savePlayer(player);
    return null;
}

function buyPattern(player, id) {
    const recipe = RECIPES[id];
    if (!recipe || !recipe.buy) return 'Not for sale';
    if (player.recipes.includes(id)) return 'Already known';
    const skill = player.craftSkill && player.craftSkill[recipe.set];
    if (!skill) return 'Learn ' + ((CRAFT_SETS[recipe.set] && CRAFT_SETS[recipe.set].name) || 'that skill') + ' first';
    if (skill.level < (recipe.craftLevel || 1)) return 'Requires crafting level ' + recipe.craftLevel;
    if (!spendCoins(player, recipe.price || 0)) return 'Not enough coins';
    player.recipes.push(id);
    savePlayer(player);
    return null;
}

function buySupply(player, id) {
    const good = SHOP_GOODS.find(row => row.id === id);
    if (!good) return 'Not for sale';
    if (!spendCoins(player, good.cost)) return 'Not enough coins';
    const leftover = addToSlots(player, { kind: good.kind, name: good.itemName, qty: good.qty, amount: good.amount });
    const left = leftover ? leftover.qty : 0;
    if (left >= good.qty) {
        player.coins += good.cost;
        return 'Bag full';
    }
    if (left > 0) player.coins += Math.round(good.cost * left / good.qty);
    savePlayer(player);
    return null;
}

function learnPattern(player, index) {
    player.craftNote = '';
    const slot = player.slots[index];
    if (!slot || slot.kind !== 'recipe') return 'Not a pattern';
    const recipe = RECIPES[slot.recipe];
    if (!recipe) return 'Unknown pattern';
    const blocked = craftRoom(player, recipe.set);
    if (blocked) return blocked;
    if (!learnedCraftSets(player).has(recipe.set) && !nearRole(player, 'shop')) return 'Learn new skills from a shop assistant';
    if (player.recipes.includes(slot.recipe)) return 'Already known';
    player.recipes.push(slot.recipe);
    slot.qty -= 1;
    if (slot.qty <= 0) player.slots[index] = null;
    const tier = recipe.tier || 0;
    const skill = player.craftSkill && player.craftSkill[recipe.set];
    if (tier > 0 && (!skill || !(skill.tiers || []).includes(tier))) {
        player.craftNote = 'Pattern learned. A trainer teaches tier ' + tier;
    }
    savePlayer(player);
    return null;
}

function craftedStats(recipe) {
    if (!recipe || (recipe.kind !== 'armor' && recipe.kind !== 'weapon')) return { stats: {}, reqLevel: 1 };
    const intellect = recipe.style === 'cloth' || recipe.weapon === 'staff' || recipe.weapon === 'wand';
    let amount = recipe.kind === 'weapon' ? 2 : Math.max(1, recipe.armor || 1);
    if (recipe.magic) amount += 2;
    if (recipe.loot) amount += 1;
    if (recipe.tier === 75) amount += 2;
    if (recipe.tier === 150) amount += 4;
    if (recipe.tier === 225) amount += 6;
    const stats = { [intellect ? 'intellect' : 'strength']: amount };
    if (recipe.style === 'plate' || recipe.set === 'plate') stats.stamina = Math.max(1, Math.ceil(amount / 2));
    else if (recipe.loot || (recipe.armor || 0) >= 3) stats.stamina = 1;
    let reqLevel = 1;
    if (recipe.style === 'plate' || recipe.set === 'plate') reqLevel = 6;
    if (recipe.loot) reqLevel = 8;
    if (recipe.tier === 75) reqLevel = Math.max(reqLevel, 8);
    if (recipe.tier === 150) reqLevel = Math.max(reqLevel, 14);
    if (recipe.tier === 225) reqLevel = Math.max(reqLevel, 20);
    return { stats, reqLevel };
}

function learnTier(player, setId) {
    const set = CRAFT_SETS[setId];
    const skill = player.craftSkill && player.craftSkill[setId];
    if (!set || !skill) return 'Learn the skill from a shop assistant first';
    const have = new Set(skill.tiers || [0]);
    const next = CRAFT_TIERS.find(tier => !have.has(tier));
    if (!next) return 'All tiers trained';
    if (skill.level < next) return 'Requires crafting level ' + next;
    const ids = Object.keys(RECIPES).filter(id => RECIPES[id].set === setId && RECIPES[id].tier === next && !RECIPES[id].loot && !RECIPES[id].buy);
    if (!ids.length) return 'Nothing to teach';
    for (const id of ids) if (!player.recipes.includes(id)) player.recipes.push(id);
    skill.tiers.push(next);
    savePlayer(player);
    return null;
}

function ensureCraftSkill(player, setId) {
    if (!CRAFT_SETS[setId]) return null;
    if (!player.craftSkill || typeof player.craftSkill !== 'object') player.craftSkill = {};
    if (!player.craftSkill[setId]) player.craftSkill[setId] = { level: 1, xp: 0, tiers: [0] };
    return player.craftSkill[setId];
}

function grantCraftXp(player, recipe) {
    const skill = ensureCraftSkill(player, recipe.set);
    if (!skill) return '';
    const gain = craftXpGain(recipe.craftLevel || 1, skill.level);
    if (!gain) return 'No skill gain';
    skill.xp += gain;
    let raised = 0;
    while (skill.level < CRAFT_CAP && skill.xp >= xpToNextCraft(skill.level)) {
        skill.xp -= xpToNextCraft(skill.level);
        skill.level += 1;
        raised += 1;
    }
    if (skill.level >= CRAFT_CAP) skill.xp = 0;
    const name = (CRAFT_SETS[recipe.set] && CRAFT_SETS[recipe.set].name) || 'Craft';
    if (raised) return name + ' is now level ' + skill.level;
    return name + ' +' + gain;
}

function craftCount(player, recipe) {
    let count = Infinity;
    for (const [kind, qty] of Object.entries(recipe.cost || {})) {
        if (qty <= 0) continue;
        count = Math.min(count, Math.floor(countKind(player, kind) / qty));
    }
    return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function craftStatus(player) {
    const job = player.crafting;
    if (!job) return null;
    const recipe = RECIPES[job.recipe];
    return {
        recipe: job.recipe,
        name: recipe ? recipe.name : 'Item',
        made: job.made,
        total: job.total,
        ms: 3000,
        until: job.nextAt
    };
}

function startCraft(player, id, count) {
    if (player.crafting) return 'Already crafting';
    const recipe = RECIPES[id];
    if (!recipe) return 'Unknown recipe';
    if (!player.recipes.includes(id)) return 'Recipe not learned';
    const skill = ensureCraftSkill(player, recipe.set) || { level: 1, xp: 0, tiers: [0] };
    const tier = recipe.tier || 0;
    if (!(skill.tiers || [0]).includes(tier)) return 'Train tier ' + tier + ' at a trainer';
    if (skill.level < Math.max(tier, recipe.buy ? (recipe.craftLevel || 1) : 0)) return 'Requires crafting level ' + Math.max(tier, recipe.buy ? recipe.craftLevel : tier);
    const can = craftCount(player, recipe);
    if (can < 1) {
        const [kind, qty] = Object.entries(recipe.cost || {})[0] || ['materials', 1];
        return 'Need ' + qty + ' ' + (MATERIAL_NAMES[kind] || kind);
    }
    const asked = count === 'all' ? can : Math.max(1, Math.min(200, Math.round(Number(count) || 1)));
    const total = Math.min(can, asked);
    player.crafting = { recipe: id, left: total, made: 0, total, nextAt: Date.now() + 3000 };
    return null;
}

function tickCrafting(now) {
    for (const player of players.values()) {
        const job = player.crafting;
        if (!job || now < job.nextAt) continue;
        const recipe = RECIPES[job.recipe];
        const error = craftItem(player, job.recipe);
        if (error) {
            const made = job.made;
            const name = recipe ? recipe.name : 'item';
            player.crafting = null;
            player.craftNote = '';
            send(player.ws, {
                type: 'character',
                ok: false,
                reason: made ? 'Crafted ' + made + ' ' + name + '. ' + error : error,
                craft: null,
                character: publicCharacter(player),
                inventory: inventoryOf(player),
                ...statsOf(player)
            });
            continue;
        }
        job.made += 1;
        job.left -= 1;
        if (job.left <= 0) {
            const name = recipe ? recipe.name : 'item';
            const note = 'Crafted ' + job.made + ' ' + name + (player.craftNote ? ' · ' + player.craftNote : '');
            player.craftNote = '';
            player.crafting = null;
            send(player.ws, {
                type: 'character',
                ok: true,
                note,
                craft: null,
                character: publicCharacter(player),
                inventory: inventoryOf(player),
                ...statsOf(player)
            });
        } else {
            job.nextAt = now + 3000;
            player.craftNote = '';
            send(player.ws, {
                type: 'character',
                ok: true,
                quiet: true,
                craft: craftStatus(player),
                character: publicCharacter(player),
                inventory: inventoryOf(player),
                ...statsOf(player)
            });
        }
    }
}

function craftItem(player, id) {
    const recipe = RECIPES[id];
    if (!recipe) return 'Unknown recipe';
    if (!player.recipes.includes(id)) return 'Recipe not learned';
    const skill = ensureCraftSkill(player, recipe.set) || { level: 1, xp: 0, tiers: [0] };
    const tier = recipe.tier || 0;
    if (!(skill.tiers || [0]).includes(tier)) return 'Train tier ' + tier + ' at a trainer';
    if (skill.level < Math.max(tier, recipe.buy ? (recipe.craftLevel || 1) : 0)) return 'Requires crafting level ' + Math.max(tier, recipe.buy ? recipe.craftLevel : tier);
    for (const [kind, qty] of Object.entries(recipe.cost)) {
        if (countKind(player, kind) < qty) return 'Need ' + qty + ' ' + (MATERIAL_NAMES[kind] || kind);
    }
    for (const [kind, qty] of Object.entries(recipe.cost)) takeKind(player, kind, qty);
    if (recipe.yield) {
        for (const [kind, qty] of Object.entries(recipe.yield)) {
            addToSlots(player, { kind, name: MATERIAL_NAMES[kind] || kind, qty });
        }
        player.craftNote = grantCraftXp(player, recipe);
        savePlayer(player);
        return null;
    }
    const made = statsForRecipe(recipe);
    const rest = addToSlots(player, {
        kind: recipe.kind,
        name: recipe.name,
        qty: 1,
        armor: recipe.armor || 0,
        weapon: recipe.weapon || '',
        slot: recipe.slot || '',
        style: recipe.style || '',
        magic: !!recipe.magic,
        amount: recipe.amount || 0,
        icon: recipe.icon || defaultIconName(recipe),
        stats: made.stats,
        reqLevel: made.reqLevel
    });
    if (rest) {
        for (const [kind, qty] of Object.entries(recipe.cost)) {
            addToSlots(player, { kind, name: MATERIAL_NAMES[kind] || kind, qty });
        }
        return 'Inventory full';
    }
    player.craftNote = grantCraftXp(player, recipe);
    savePlayer(player);
    return null;
}

function chooseClass(player, className) {
    if (player.class) return 'Class already chosen';
    const kit = CLASS_KITS[className];
    if (!kit) return 'Unknown class';
    player.class = className;
    player.look = player.look || className;
    player.trained = kit.trained.slice();
    player.talents = {};
    player.spellRanks = {};
    for (const id of player.trained) player.spellRanks[id] = 1;
    player.actionbar = defaultActionBar(className);
    player.equipment.weapon = copySlot(kit.weapon);
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function trainSpell(player, id) {
    return spendNode(player, id);
}

function spendNode(player, id) {
    const node = TREE[id];
    if (!player.class) return 'Choose a class first';
    if (!node || node.class !== player.class) return 'Not for your class';
    const rank = nodeRank(player, id);
    const max = nodeMax(id);
    if (rank >= max) return 'Max rank';
    if (talentPoints(player) < 1) return 'No talent points';
    if (node.requires) {
        const parent = TREE[node.requires];
        if (!parent || nodeRank(player, node.requires) < 1) {
            const name = parent && parent.spell ? SPELLS[parent.spell].name : (parent && parent.name) || 'the previous talent';
            return 'Requires 1 point in ' + name;
        }
    }
    const before = talentPoints(player);
    if (node.spell) {
        if (!player.spellRanks) player.spellRanks = {};
        if (!player.trained.includes(node.spell)) player.trained.push(node.spell);
        player.spellRanks[node.spell] = rank + 1;
        if (player.talents) delete player.talents[id];
    } else {
        player.talents[id] = rank + 1;
    }
    if (before - talentPoints(player) !== 1) {
        if (node.spell) {
            if (rank <= 0) {
                player.trained = player.trained.filter(spell => spell !== node.spell);
                delete player.spellRanks[node.spell];
            } else player.spellRanks[node.spell] = rank;
        } else if (rank <= 0) delete player.talents[id];
        else player.talents[id] = rank;
        return 'Could not spend that point';
    }
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function resetTalents(player) {
    if (!player.class || !CLASS_KITS[player.class]) return 'Choose a class first';
    if (ranksSpent(player) <= 0) return 'Nothing to reset';
    const kit = CLASS_KITS[player.class];
    player.trained = kit.trained.slice();
    player.talents = {};
    player.spellRanks = {};
    for (const id of player.trained) player.spellRanks[id] = 1;
    player.actionbar = sanitizeActionBar(player.actionbar, player);
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function spendTalent(player, id) {
    return spendNode(player, id);
}

function equipItem(player, equipSlot, bagIndex) {
    if (!EQUIP_SLOTS.includes(equipSlot)) return 'Bad slot';
    const item = player.slots[bagIndex];
    if (!item) return 'Empty slot';
    const fits = item.kind === 'weapon' ? 'weapon' : (item.slot || 'chest');
    if (item.kind !== 'weapon' && item.kind !== 'armor') return 'Cannot equip that';
    if (fits !== equipSlot) return 'Does not fit';
    if ((item.reqLevel || 1) > (player.level || 1)) return 'Requires level ' + (item.reqLevel || 1);
    if (!player.class) return 'Choose a class first';
    if (item.kind === 'weapon' && item.weapon !== CLASS_KITS[player.class].weapon.weapon) return 'Wrong class';
    if (item.kind === 'armor' && item.slot !== 'neck' && item.slot !== 'cloak') {
        const need = { warrior: 'plate', hunter: 'leather', mage: 'cloth', warlock: 'cloth' }[player.class];
        if (item.style && need && item.style !== need) {
            const who = player.class.charAt(0).toUpperCase() + player.class.slice(1);
            return who + 's wear ' + need;
        }
    }
    const piece = copySlot(item);
    piece.qty = 1;
    item.qty -= 1;
    const worn = player.equipment[equipSlot];
    if (item.qty <= 0) player.slots[bagIndex] = null;
    if (worn) {
        const rest = addToSlots(player, worn);
        if (rest) {
            if (player.slots[bagIndex]) player.slots[bagIndex].qty += 1;
            else player.slots[bagIndex] = copySlot(item.qty ? item : piece);
            return 'Inventory full';
        }
    }
    player.equipment[equipSlot] = piece;
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function unequipItem(player, equipSlot) {
    if (!EQUIP_SLOTS.includes(equipSlot)) return 'Bad slot';
    const worn = player.equipment[equipSlot];
    if (!worn) return 'Nothing equipped';
    const rest = addToSlots(player, worn);
    if (rest) return 'Inventory full';
    player.equipment[equipSlot] = null;
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function equipBag(player, index) {
    normalizeBags(player);
    normalizeSlots(player);
    const item = player.slots[index];
    if (!item || item.kind !== 'bag') return 'That is not a bag';
    const pocket = player.bags.findIndex(bag => !bag);
    if (pocket < 0) return 'Bag slots are full';
    player.bags[pocket] = { kind: 'bag', name: item.name, qty: 1, slots: item.slots || 4, bag: item.bag || '' };
    item.qty -= 1;
    if (item.qty <= 0) player.slots[index] = null;
    normalizeSlots(player);
    savePlayer(player);
    return null;
}

function unequipBag(player, pocket) {
    normalizeBags(player);
    const bag = player.bags[pocket];
    if (!bag) return 'Empty bag slot';
    const nextCap = slotCapacity(player) - bag.slots;
    let occupied = 0;
    let high = -1;
    player.slots.forEach((slot, index) => {
        if (!slot) return;
        occupied += 1;
        high = index;
    });
    if (occupied + 1 > nextCap || high >= nextCap) return 'Empty some slots first';
    const leftover = addToSlots(player, bag);
    if (leftover) return 'Inventory full';
    player.bags[pocket] = null;
    while (player.slots.length > slotCapacity(player) && !player.slots[player.slots.length - 1]) player.slots.pop();
    savePlayer(player);
    return null;
}

function moveItem(player, from, to) {
    normalizeSlots(player);
    from = Math.round(Number(from));
    to = Math.round(Number(to));
    if (!Number.isInteger(from) || !Number.isInteger(to)) return 'Bad slot';
    if (from < 0 || to < 0 || from >= player.slots.length || to >= player.slots.length || from === to) return null;
    const source = player.slots[from];
    if (!source) return null;
    const target = player.slots[to];
    if (target && sameStack(source, target)) {
        const room = stackLimit(target) - (target.qty || 0);
        if (room > 0) {
            const take = Math.min(room, source.qty || 1);
            target.qty += take;
            source.qty -= take;
            if (source.qty <= 0) player.slots[from] = null;
            savePlayer(player);
            return null;
        }
    }
    player.slots[from] = target || null;
    player.slots[to] = source;
    savePlayer(player);
    return null;
}

function nearBanker(player) {
    return CIVILIANS.find(civ => civ.role === 'bank' && Math.hypot(civ.x - player.x, civ.z - player.z) <= 3.6) || null;
}

function bankStore(player, index) {
    if (!nearBanker(player)) return 'The bank is only in the main settlement';
    normalizeSlots(player);
    normalizeBank(player);
    const item = player.slots[index];
    if (!item) return 'Empty slot';
    if (item.kind === 'quest') return 'Quest items stay with you';
    const hole = player.bank.findIndex(slot => !slot);
    if (hole < 0) return 'The vault is full';
    player.bank[hole] = copySlot(item);
    player.slots[index] = null;
    savePlayer(player);
    return null;
}

function bankTake(player, index) {
    if (!nearBanker(player)) return 'The bank is only in the main settlement';
    normalizeBank(player);
    const item = player.bank[index];
    if (!item) return 'Empty vault slot';
    const leftover = addToSlots(player, item);
    if (leftover) return 'Inventory full';
    player.bank[index] = null;
    savePlayer(player);
    return null;
}

const BAG_POCKETS = 4;
const BANK_SLOTS = 24;
const BAGS = {
    'linen-sack': { name: 'Linen Sack', slots: 4 },
    'traveler-pack': { name: 'Traveler Pack', slots: 6 },
    'deep-pack': { name: 'Deep Pack', slots: 8 }
};

function makeBag(id) {
    const key = BAGS[id] ? id : 'linen-sack';
    const def = BAGS[key];
    return { kind: 'bag', name: def.name, qty: 1, slots: def.slots, bag: key };
}

function normalizeBags(player) {
    const raw = Array.isArray(player.bags) ? player.bags : [];
    player.bags = raw.slice(0, BAG_POCKETS).map(bag => {
        if (!bag || bag.kind !== 'bag') return null;
        const slots = Math.max(1, Math.min(12, Math.round(Number(bag.slots) || 4)));
        return { kind: 'bag', name: String(bag.name || 'Bag').slice(0, 24), qty: 1, slots, bag: String(bag.bag || '').slice(0, 24) };
    });
    while (player.bags.length < BAG_POCKETS) player.bags.push(null);
}

function normalizeBank(player) {
    const raw = Array.isArray(player.bank) ? player.bank : [];
    player.bank = raw.slice(0, BANK_SLOTS).map(slot => copySlot(slot));
    while (player.bank.length < BANK_SLOTS) player.bank.push(null);
}

function bagBonus(player) {
    normalizeBags(player);
    return player.bags.reduce((sum, bag) => sum + (bag ? bag.slots : 0), 0);
}

const BASE_SLOTS = 16;

function stackLimit(item) {
    if (item.kind === 'coins') return 99;
    if (item.kind === 'bag') return 1;
    if (item.kind === 'wood' || item.kind === 'stone' || item.kind === 'cloth' || item.kind === 'leather' || item.kind === 'ore') return 20;
    if (item.kind === 'junk' || item.kind === 'gem' || item.kind === 'recipe' || item.kind === 'quest') return 10;
    if (item.kind === 'health' || item.kind === 'mana' || item.kind === 'armor' || item.kind === 'bomb') return 5;
    return 1;
}

function sameStack(a, b) {
    if (!a || !b || a.kind !== b.kind || a.name !== b.name) return false;
    if ((a.amount || 0) !== (b.amount || 0) || (a.armor || 0) !== (b.armor || 0)) return false;
    if ((a.slot || '') !== (b.slot || '') || (a.weapon || '') !== (b.weapon || '')) return false;
    if ((a.reqLevel || 1) !== (b.reqLevel || 1)) return false;
    if (String(a.icon || '') !== String(b.icon || '')) return false;
    const as = a.stats || {};
    const bs = b.stats || {};
    return (as.strength || 0) === (bs.strength || 0) && (as.stamina || 0) === (bs.stamina || 0) && (as.intellect || 0) === (bs.intellect || 0);
}

function slotCapacity(player) {
    return BASE_SLOTS + (player.bagSlots || 0) + bagBonus(player);
}

function normalizeSlots(player) {
    if (!Array.isArray(player.slots)) player.slots = [];
    const cap = slotCapacity(player);
    while (player.slots.length < cap) player.slots.push(null);
    while (player.slots.length > cap && !player.slots[player.slots.length - 1]) player.slots.pop();
}

function expandBag(player, extra) {
    player.bagSlots = (player.bagSlots || 0) + extra;
    normalizeSlots(player);
}

function addToSlots(player, source) {
    if (!player.materials) player.materials = blankMaterials();
    if (source.kind === 'coins') {
        player.coins = (player.coins || 0) + (source.qty || 1);
        return null;
    }
    if (MATERIAL_KINDS.includes(source.kind)) {
        player.materials[source.kind] = (player.materials[source.kind] || 0) + (source.qty || 1);
        return null;
    }
    normalizeSlots(player);
    let qty = source.qty || 1;
    const limit = stackLimit(source);
    for (const slot of player.slots) {
        if (!sameStack(slot, source) || slot.qty >= limit) continue;
        const take = Math.min(limit - slot.qty, qty);
        slot.qty += take;
        qty -= take;
        if (qty <= 0) return null;
    }
    for (let i = 0; i < player.slots.length; i++) {
        if (player.slots[i]) continue;
        const take = Math.min(limit, qty);
        player.slots[i] = {
            kind: source.kind,
            name: source.name,
            qty: take,
            amount: source.amount || 0,
            armor: source.armor || 0,
            weapon: source.weapon || '',
            slot: source.slot || '',
            style: source.style || '',
            magic: !!source.magic,
            recipe: source.recipe || '',
            icon: source.icon ? String(source.icon).slice(0, 32) : '',
            stats: cleanStats(source.stats),
            reqLevel: Math.max(1, Math.round(Number(source.reqLevel) || 1)),
            slots: Math.max(0, Math.round(Number(source.slots) || 0)),
            bag: source.bag ? String(source.bag).slice(0, 24) : ''
        };
        qty -= take;
        if (qty <= 0) return null;
    }
    return { kind: source.kind, name: source.name, qty, amount: source.amount || 0, armor: source.armor || 0, weapon: source.weapon || '', slot: source.slot || '', style: source.style || '', magic: !!source.magic, recipe: source.recipe || '', icon: source.icon ? String(source.icon).slice(0, 32) : '', stats: cleanStats(source.stats), reqLevel: Math.max(1, Math.round(Number(source.reqLevel) || 1)), slots: Math.max(0, Math.round(Number(source.slots) || 0)), bag: source.bag ? String(source.bag).slice(0, 24) : '' };
}

function copySlot(slot) {
    if (!slot) return null;
    return { kind: slot.kind, name: slot.name, qty: slot.qty || 1, amount: slot.amount || 0, armor: slot.armor || 0, weapon: slot.weapon || '', slot: slot.slot || '', style: slot.style || '', magic: !!slot.magic, recipe: slot.recipe || '', icon: slot.icon ? String(slot.icon).slice(0, 32) : '', stats: cleanStats(slot.stats), reqLevel: Math.max(1, Math.round(Number(slot.reqLevel) || 1)), slots: Math.max(0, Math.round(Number(slot.slots) || 0)), bag: slot.bag ? String(slot.bag).slice(0, 24) : '' };
}

function absorbWallet(player) {
    player.coins = Math.max(0, Number(player.coins) || 0);
    const materials = blankMaterials();
    const raw = player.materials || {};
    for (const kind of MATERIAL_KINDS) materials[kind] = Math.max(0, Number(raw[kind]) || 0);
    player.materials = materials;
    if (!Array.isArray(player.slots)) player.slots = [];
    for (let i = 0; i < player.slots.length; i++) {
        const slot = player.slots[i];
        if (!slot) continue;
        if (slot.kind === 'coins') player.coins += slot.qty || 0;
        else if (MATERIAL_KINDS.includes(slot.kind)) materials[slot.kind] += slot.qty || 0;
        else continue;
        player.slots[i] = null;
    }
    player.slots = player.slots.filter(Boolean);
    while (player.slots.length > slotCapacity(player)) expandBag(player, 4);
    normalizeSlots(player);
    normalizeBags(player);
    normalizeBank(player);
}

function loadInventory(prof) {
    const player = {
        bagSlots: prof.bagSlots || 0,
        bags: Array.isArray(prof.bags) ? prof.bags.map(copySlot) : [],
        bank: Array.isArray(prof.bank) ? prof.bank.map(copySlot) : [],
        slots: Array.isArray(prof.slots) ? prof.slots.map(copySlot) : [],
        coins: prof.coins || 0,
        materials: prof.materials || blankMaterials()
    };
    if (!Array.isArray(prof.slots)) {
        player.materials.wood += prof.wood || 0;
        player.materials.stone += prof.stone || 0;
        if (prof.junk) player.slots.push({ kind: 'junk', name: 'Junk', qty: prof.junk });
        for (const amount of prof.healthPotions || []) player.slots.push({ kind: 'health', name: 'Health potion', qty: 1, amount });
        for (const amount of prof.manaPotions || []) player.slots.push({ kind: 'mana', name: 'Mana potion', qty: 1, amount });
    }
    absorbWallet(player);
    prof.slots = player.slots;
    prof.bagSlots = player.bagSlots;
    prof.bags = player.bags;
    prof.bank = player.bank;
    prof.coins = player.coins;
    prof.materials = player.materials;
    prof.wood = 0;
    prof.stone = 0;
    prof.junk = 0;
    prof.healthPotions = [];
    prof.manaPotions = [];
}

function inventoryOf(player) {
    normalizeBank(player);
    return {
        slots: player.slots,
        capacity: slotCapacity(player),
        bagSlots: player.bagSlots || 0,
        bags: player.bags,
        bank: player.bank,
        baseSlots: BASE_SLOTS,
        coins: player.coins || 0,
        materials: player.materials || blankMaterials()
    };
}

function savePlayer(player) {
    const prof = save.players[player.persistentId];
    prof.slots = player.slots;
    prof.bagSlots = player.bagSlots || 0;
    prof.bags = player.bags;
    prof.bank = player.bank;
    prof.armor = player.armor;
    prof.legacyArmor = player.legacyArmor || 0;
    prof.class = player.class || null;
    prof.look = player.look || player.class || '';
    prof.equipment = player.equipment;
    prof.trained = player.trained;
    prof.talents = player.talents;
    prof.spellRanks = player.spellRanks || {};
    prof.recipes = player.recipes || [];
    prof.craftSkill = JSON.parse(JSON.stringify(player.craftSkill || {}));
    prof.quests = player.quests || {};
    prof.spawn = player.spawn || mapSpawn();
    prof.level = player.level;
    prof.xp = player.xp;
    prof.coins = player.coins || 0;
    prof.materials = player.materials || blankMaterials();
    prof.dungeonId = player.dungeonId || '';
    prof.dungeonX = player.dungeonId ? player.x : 0;
    prof.dungeonZ = player.dungeonId ? player.z : 0;
    prof.junk = 0;
    prof.healthPotions = [];
    prof.manaPotions = [];
    scheduleSave();
}

const LOOT_TABLES = {
    hide: [
        { kind: 'leather', weight: 34 },
        { kind: 'junk', weight: 26, names: ['Tusk', 'Torn hide', 'Bone chip'] },
        { kind: 'coins', weight: 16 },
        { kind: 'health', weight: 14 },
        { kind: 'cloth', weight: 6 },
        { kind: 'recipe', weight: 4, sets: ['leather'] }
    ],
    silk: [
        { kind: 'silk', weight: 36 },
        { kind: 'cloth', weight: 10 },
        { kind: 'herb', weight: 14 },
        { kind: 'junk', weight: 12, names: ['Webbing', 'Dried silk', 'Chitin'] },
        { kind: 'mana', weight: 14 },
        { kind: 'coins', weight: 10 },
        { kind: 'recipe', weight: 8, sets: ['cloth'] },
        { kind: 'health', weight: 6 }
    ],
    bandit: [
        { kind: 'coins', weight: 34 },
        { kind: 'junk', weight: 18, names: ['Bent dagger', 'Torn bandana', 'Rusty key'] },
        { kind: 'leather', weight: 14 },
        { kind: 'recipe', weight: 14, sets: ['weapon', 'leather'] },
        { kind: 'health', weight: 10 },
        { kind: 'ore', weight: 10 }
    ],
    ore: [
        { kind: 'ore', weight: 32 },
        { kind: 'stone', weight: 18 },
        { kind: 'junk', weight: 14, names: ['Ogre tooth', 'Cracked club', 'Flint'] },
        { kind: 'coins', weight: 12 },
        { kind: 'health', weight: 12 },
        { kind: 'recipe', weight: 12, sets: ['plate', 'weapon'] }
    ],
    wisp: [
        { kind: 'gem', weight: 22 },
        { kind: 'mana', weight: 22 },
        { kind: 'cloth', weight: 14 },
        { kind: 'recipe', weight: 18, sets: ['magic'] },
        { kind: 'coins', weight: 12 },
        { kind: 'junk', weight: 12, names: ['Wisp ash', 'Faded rune', 'Glass bead'] }
    ],
    plate: [
        { kind: 'ore', weight: 22 },
        { kind: 'armor', weight: 20 },
        { kind: 'coins', weight: 18 },
        { kind: 'recipe', weight: 16, sets: ['plate', 'weapon'] },
        { kind: 'health', weight: 12 },
        { kind: 'junk', weight: 12, names: ['Broken rivet', 'Dented plate', 'Banner scrap'] }
    ],
    magic: [
        { kind: 'gem', weight: 20 },
        { kind: 'mana', weight: 18 },
        { kind: 'recipe', weight: 22, sets: ['magic'] },
        { kind: 'cloth', weight: 14 },
        { kind: 'coins', weight: 12 },
        { kind: 'junk', weight: 14, names: ['Hexed bead', 'Burnt page', 'Black candle'] }
    ],
    boss: [
        { kind: 'coins', weight: 26 },
        { kind: 'bag', weight: 16, bags: ['linen-sack', 'traveler-pack'] },
        { kind: 'bag', weight: 6, bags: ['deep-pack'] },
        { kind: 'health', weight: 14 },
        { kind: 'armor', weight: 16 },
        { kind: 'gem', weight: 10 },
        { kind: 'recipe', weight: 12, sets: ['weapon', 'plate', 'cloth', 'leather', 'magic'] }
    ]
};

function rollRow(table) {
    const total = table.reduce((sum, row) => sum + row.weight, 0);
    let roll = Math.random() * total;
    for (const row of table) {
        roll -= row.weight;
        if (roll <= 0) return row;
    }
    return table[table.length - 1];
}

function lootItem(row, level, tableId) {
    const kind = row.kind;
    if (kind === 'junk') {
        const names = row.names || ['Bent nail', 'Torn cloth', 'Cracked bead'];
        return { kind, name: names[Math.floor(Math.random() * names.length)], qty: 1 };
    }
    if (kind === 'coins') {
        return { kind, name: 'Coins', qty: level * 4 + Math.floor(Math.random() * (level * 2 + 1)) };
    }
    if (kind === 'health') return { kind, name: 'Health potion', qty: 1, amount: 8 + level * 3 };
    if (kind === 'mana') return { kind, name: 'Mana potion', qty: 1, amount: 6 + level * 2 };
    if (kind === 'stone' || kind === 'herb' || kind === 'powder' || kind === 'silk') return { kind, name: MATERIAL_NAMES[kind], qty: 1 + Math.floor(level / 3) };
    if (kind === 'cloth' || kind === 'leather' || kind === 'ore' || kind === 'gem') {
        return { kind, name: MATERIAL_NAMES[kind], qty: kind === 'gem' ? 1 : 1 + Math.floor(level / 2) };
    }
    if (kind === 'recipe') {
        let ids = lootRecipeIds();
        if (row.sets) ids = ids.filter(id => row.sets.includes(RECIPES[id].set));
        if (!ids.length) ids = lootRecipeIds();
        const id = ids[Math.floor(Math.random() * ids.length)];
        return { kind: 'recipe', name: 'Pattern: ' + RECIPES[id].name, qty: 1, recipe: id };
    }
    if (kind === 'bag') {
        const ids = Array.isArray(row.bags) && row.bags.length ? row.bags : ['linen-sack'];
        return makeBag(ids[Math.floor(Math.random() * ids.length)]);
    }
    return makeGear(level, tableId || 'plate');
}

const GEAR_SLOTS = ['head', 'shoulders', 'chest', 'hands', 'waist', 'legs', 'feet', 'neck', 'cloak', 'weapon', 'offhand'];

function gearFocus(tableId) {
    if (tableId === 'silk' || tableId === 'wisp' || tableId === 'magic') return 'intellect';
    return 'strength';
}

function makeGear(level, tableId) {
    const lv = Math.max(1, Math.round(level) || 1);
    const amount = gearAmount(lv);
    const focus = gearFocus(tableId);
    const magic = tableId === 'wisp' || tableId === 'magic';
    const style = focus === 'intellect' ? 'cloth' : (tableId === 'ore' || tableId === 'plate' ? 'plate' : 'leather');
    const slot = GEAR_SLOTS[Math.floor(Math.random() * GEAR_SLOTS.length)];
    const stats = { [focus]: amount };
    if (lv >= 6) stats.stamina = amount;
    let armor = 0;
    if (style === 'plate') armor = 1 + Math.floor(lv / 6);
    else if (style === 'leather') armor = Math.floor(lv / 8);
    const piece = {
        kind: slot === 'weapon' ? 'weapon' : 'armor',
        name: 'Gear',
        qty: 1,
        armor,
        weapon: '',
        slot,
        style: slot === 'weapon' ? '' : style,
        magic: magic && focus === 'intellect',
        amount: 0,
        stats,
        reqLevel: gearReq(lv)
    };
    if (slot === 'weapon') {
        if (focus === 'intellect') {
            piece.weapon = 'staff';
            piece.name = amount >= 6 ? 'Arcane Staff' : 'Carved Staff';
            piece.magic = amount >= 6 || magic;
        } else {
            piece.weapon = 'sword';
            piece.name = amount >= 6 ? 'Rune Blade' : 'Iron Sword';
        }
    } else if (slot === 'offhand') {
        if (focus === 'intellect') {
            piece.name = 'Spell Focus';
            piece.style = 'cloth';
            piece.magic = true;
            piece.armor = Math.max(1, armor);
        } else {
            piece.name = 'Iron Buckler';
            piece.style = 'plate';
            piece.armor = Math.max(1, 1 + Math.floor(lv / 6));
        }
    } else if (slot === 'neck') {
        piece.name = focus === 'intellect' ? 'Gem Pendant' : (style === 'plate' ? 'Iron Pendant' : 'Hide Pendant');
        piece.style = focus === 'intellect' ? 'cloth' : style;
    } else {
        const prefix = magic && style === 'cloth' ? 'Rune' : (style === 'plate' ? 'Plate' : style === 'leather' ? 'Leather' : 'Cloth');
        const part = {
            head: style === 'plate' ? 'Helm' : style === 'leather' ? 'Cap' : 'Hood',
            shoulders: style === 'plate' ? 'Pauldrons' : 'Shoulders',
            chest: style === 'plate' ? 'Breastplate' : style === 'leather' ? 'Jerkin' : 'Robe',
            hands: 'Gloves',
            waist: style === 'cloth' ? 'Sash' : 'Belt',
            legs: style === 'plate' ? 'Greaves' : 'Pants',
            feet: style === 'plate' ? 'Sabatons' : style === 'leather' ? 'Boots' : 'Shoes',
            cloak: 'Cloak'
        };
        if (style === 'plate' && slot === 'hands') part.hands = 'Gauntlets';
        piece.name = prefix + ' ' + part[slot];
    }
    if (style === 'cloth' && slot === 'chest') piece.armor = Math.max(piece.armor, 1);
    return piece;
}

function rollLoot(level, tableId) {
    const tables = lootTables || LOOT_TABLES;
    const table = tables[tableId] || tables.hide || LOOT_TABLES.hide;
    const coins = table.filter(row => row.kind === 'coins');
    const junk = table.filter(row => row.kind === 'junk');
    const goods = table.filter(row => row.kind !== 'coins' && row.kind !== 'junk' && row.kind !== 'recipe' && row.kind !== 'bag');
    const patterns = table.filter(row => row.kind === 'recipe');
    const items = [];
    if (coins.length && Math.random() < 0.7) items.push(lootItem(rollRow(coins), level, tableId));
    if (patterns.length && Math.random() < 0.04) items.push(lootItem(rollRow(patterns), level, tableId));
    else if (Math.random() < 0.55 || !goods.length) items.push(makeGear(level, tableId));
    else if (goods.length) items.push(lootItem(rollRow(goods), level, tableId));
    if (junk.length && Math.random() < 0.6) items.push(lootItem(rollRow(junk), level, tableId));
    const bags = table.filter(row => row.kind === 'bag');
    if (bags.length) {
        const bagWeight = bags.reduce((sum, row) => sum + row.weight, 0);
        const total = table.reduce((sum, row) => sum + row.weight, 0);
        if (total > 0 && Math.random() < bagWeight / total) items.push(lootItem(rollRow(bags), level, tableId));
    }
    if (!items.length) items.push(makeGear(level, tableId));
    return items;
}

const chests = new Map();
let chestSeq = 1;

function publicChest(chest) {
    return { id: chest.id, x: chest.x, z: chest.z, level: chest.level, items: chest.items };
}

function spawnChest(npc, owners) {
    if (npc.chapel) return spawnChapelChests(npc, owners);
    const items = rollLoot(npc.level, npc.loot);
    const list = Array.isArray(owners) ? owners : [owners];
    const seen = new Set();
    for (const owner of list) {
        if (!owner) continue;
        for (const drop of questChestDrops(owner, npc)) {
            const key = (drop.questId || '') + '\n' + drop.name;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(drop);
        }
    }
    const chest = {
        id: 'c' + (chestSeq++),
        x: npc.x,
        z: npc.z,
        level: npc.level,
        items,
        spawnedAt: Date.now()
    };
    chests.set(chest.id, chest);
    broadcast({ type: 'chest', chest: publicChest(chest) });
    return chest;
}

function chapelPiece(player) {
    const style = { warrior: 'plate', hunter: 'leather', mage: 'cloth', warlock: 'cloth' }[player.class] || 'leather';
    const slot = ['head', 'chest', 'legs'][(player.level + (player.persistentId || '').length) % 3];
    const names = {
        plate: { head: 'Chapel Helm', chest: 'Chapel Breastplate', legs: 'Chapel Greaves' },
        leather: { head: 'Chapel Cap', chest: 'Chapel Jerkin', legs: 'Chapel Leggings' },
        cloth: { head: 'Chapel Hood', chest: 'Chapel Robe', legs: 'Chapel Pants' }
    };
    const magic = player.class === 'warlock' || player.class === 'mage';
    const focus = style === 'cloth' ? 'intellect' : 'strength';
    return {
        kind: 'armor',
        name: names[style][slot],
        qty: 1,
        armor: style === 'plate' ? 3 : style === 'leather' ? 2 : 1,
        weapon: '',
        slot,
        style,
        magic: magic && style === 'cloth',
        amount: 0,
        stats: { [focus]: 3, stamina: 2 },
        reqLevel: 4
    };
}

function spawnChapelChests(npc, owners) {
    const list = (Array.isArray(owners) ? owners : [owners]).filter(Boolean);
    let first = null;
    list.forEach((owner, index) => {
        const items = [chapelPiece(owner), { kind: 'health', name: 'Health potion', qty: 1, amount: 30 }];
        if (Math.random() < 0.45) items.push(makeBag(Math.random() < 0.3 ? 'deep-pack' : 'traveler-pack'));
        const chest = {
            id: 'c' + (chestSeq++),
            x: npc.x + (index - (list.length - 1) / 2) * 0.8,
            z: npc.z,
            level: npc.level,
            items,
            ownerId: owner.persistentId,
            spawnedAt: Date.now()
        };
        chests.set(chest.id, chest);
        send(owner.ws, { type: 'chest', chest: publicChest(chest) });
        if (owner === list[0]) first = chest;
    });
    return first;
}

function questMatchesMob(quest, npc) {
    const namedHit = quest.named && npc.name === quest.named;
    const kindHit = quest.mob && npc.kind === quest.mob;
    return namedHit || (!quest.named && kindHit);
}

function questChestDrops(player, npc) {
    if (!player || !player.quests) return [];
    const drops = [];
    for (const [id, quest] of Object.entries(QUESTS)) {
        if (quest.type !== 'gather' || !quest.item) continue;
        const row = player.quests[id];
        if (!row || row.state !== 'active' || row.failed || row.count >= quest.count) continue;
        if (!questMatchesMob(quest, npc)) continue;
        if (Math.random() > 0.6) continue;
        drops.push({ kind: 'quest', name: quest.item, qty: 1, questId: id });
    }
    return drops;
}

function needsQuestItem(player, item) {
    if (!item || item.kind !== 'quest') return true;
    for (const [id, quest] of Object.entries(QUESTS)) {
        if (quest.type !== 'gather' || quest.item !== item.name) continue;
        if (item.questId && item.questId !== id) continue;
        const row = player.quests && player.quests[id];
        if (row && row.state === 'active' && !row.failed && row.count < quest.count) return true;
    }
    return false;
}

function clearUnusedQuestItems(player) {
    if (!player.slots) return;
    for (let i = 0; i < player.slots.length; i++) {
        const slot = player.slots[i];
        if (slot && slot.kind === 'quest' && !needsQuestItem(player, slot)) player.slots[i] = null;
    }
}

function creditQuestItem(player, item, qty) {
    const quest = (item.questId && QUESTS[item.questId]) || Object.values(QUESTS).find(entry => entry.type === 'gather' && entry.item === item.name);
    if (!quest || quest.type !== 'gather') return false;
    const row = player.quests && player.quests[quest.id];
    if (!row || row.state !== 'active' || row.failed || row.count >= quest.count) return false;
    row.count = Math.min(quest.count, row.count + qty);
    player.questDirty = true;
    return true;
}

function giveLoot(player, items) {
    const taken = [];
    const leftover = [];
    let quested = false;
    for (const item of items) {
        if (item.kind === 'quest' && !needsQuestItem(player, item)) {
            leftover.push(item);
            continue;
        }
        const qty = item.qty || 1;
        const rest = addToSlots(player, item);
        const left = rest ? rest.qty : 0;
        const got = qty - left;
        if (got > 0) {
            taken.push({ ...item, qty: got });
            if (item.kind === 'quest' && creditQuestItem(player, item, got)) quested = true;
        }
        if (rest) {
            if (item.questId) rest.questId = item.questId;
            leftover.push(rest);
        }
    }
    if (taken.length) savePlayer(player);
    if (quested) savePlayer(player);
    return { taken, leftover, quested };
}

let lastNpcTick = Date.now();
let lastNpcBroadcast = 0;

function tickNpcs() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - lastNpcTick) / 1000);
    lastNpcTick = now;
    tickEscorts(dt, now);
    tickCrafting(now);
    refreshNpcZones();
    for (const area of activeAreas.values()) tickAreaSpawns(area, now);

    for (const npc of npcs.values()) {
        if (!npc.alive) {
            if (npc.herd) {
                const crowded = aliveKindNear(npc.homeX, npc.homeZ, npc.kind, 70) >= 6;
                if (!herdStillNeeded(npc) || crowded) {
                    if (now >= (npc.respawnAt || 0)) dropQuestMob(npc);
                } else if (now >= (npc.respawnAt || 0)) respawnHerd(npc);
                continue;
            }
            if (now >= npc.respawnAt) {
                if (npc.pinned) respawnPinned(npc);
                else placeNpc(npc);
            }
            continue;
        }
        if (npc.guardId) {
            const civ = CIVILIANS.find(entry => entry.id === npc.guardId);
            const quest = QUESTS[npc.questId];
            const playerNear = civ && [...players.values()].some(entry => {
                const row = entry.quests && entry.quests[npc.questId];
                return row && row.state === 'active' && !row.failed && Math.hypot(entry.x - civ.x, entry.z - civ.z) < 42;
            });
            if (civ && quest && playerNear && !nearestPlayer(npc, AGGRO_RANGE) && !inSettlement(civ.x, civ.z)) {
                const dx = civ.x - npc.x;
                const dz = civ.z - npc.z;
                const dist = Math.hypot(dx, dz) || 0;
                npc.rotY = Math.atan2(dx, dz);
                if (dist <= 1.8) {
                    if (now >= npc.attackAt) {
                        npc.attackAt = now + (quest.attackEvery || 2800);
                        quest.guardHp = (quest.guardHp || 0) - 4;
                        if (quest.guardHp <= 0) failProtect(npc.questId);
                    }
                    continue;
                }
                const step = Math.min(3.2 * dt, dist);
                npc.x += (dx / dist) * step;
                npc.z += (dz / dist) * step;
                continue;
            }
        }
        if (!npc.dungeonId && !npc.guardId && inSettlement(npc.x, npc.z)) {
            const out = outsideSettlement(npc.x, npc.z);
            const dx = out.x - npc.x;
            const dz = out.z - npc.z;
            const dist = Math.hypot(dx, dz) || 1;
            const step = Math.min(3.6 * dt, dist);
            npc.x += (dx / dist) * step;
            npc.z += (dz / dist) * step;
            npc.rotY = Math.atan2(dx, dz);
            npc.aggroId = null;
            continue;
        }
        const target = npc.dungeonId ? dungeonThreat(npc) : nearestPlayer(npc, AGGRO_RANGE);
        if (npc.dungeonId && !target) npc.aggroId = null;
        let tx = npc.wanderX;
        let tz = npc.wanderZ;
        let speed = 1.7;
        if (target) {
            npc.aggroId = target.persistentId;
            tx = target.x;
            tz = target.z;
            speed = 3.8;
        } else if (now > npc.wanderUntil) {
            pickWander(npc);
            tx = npc.wanderX;
            tz = npc.wanderZ;
        }
        if ((npc.slowUntil || 0) > now) speed *= 0.4;
        const dx = tx - npc.x;
        const dz = tz - npc.z;
        const dist = Math.hypot(dx, dz) || 0;
        if (target && dist <= NPC_HIT_RANGE) {
            npc.rotY = Math.atan2(dx, dz);
            if (now >= npc.attackAt && now >= target.invulnUntil) {
                npc.attackAt = now + 1300;
                const block = npc.stats || mobStatBlock(npc.level, npc.kind);
                const primary = mobBias(npc.kind) === 'intellect' ? (block.intellect || npc.level) : (block.strength || npc.level);
                const raw = 1 + primary;
                let damage = Math.max(1, Math.round(raw * (npc.elite ? 1.8 : 1)) - target.armor);
                let absorbed = 0;
                if ((target.absorbUntil || 0) > now && target.absorb > 0) {
                    absorbed = Math.min(target.absorb, damage);
                    target.absorb -= absorbed;
                    damage -= absorbed;
                }
                if (damage > 0) target.hp = Math.max(0, target.hp - damage);
                enterCombat(target, now);
                send(target.ws, { type: 'hurt', damage, absorbed, attackerId: npc.id, attacker: npc.level, ...statsOf(target) });
                if (target.hp <= 0) becomeGhost(target, now);
            }
            continue;
        }
        if (dist < 0.4) {
            if (!target) pickWander(npc);
            continue;
        }
        const step = Math.min(speed * dt, dist);
        npc.x += (dx / dist) * step;
        npc.z += (dz / dist) * step;
        if (npc.dungeonId) {
            const cave = dungeonById(npc.dungeonId);
            if (cave) {
                const held = dungeonClamp(cave, npc.x, npc.z);
                npc.x = held.x;
                npc.z = held.z;
            }
        }
        npc.rotY = Math.atan2(dx, dz);
    }

    tickChapelBosses(now);
    tickHazards(now);

    for (const player of players.values()) {
        if (!player.ghost) {
            const intellect = (player.stats && player.stats.intellect) || 0;
            const stamina = (player.stats && player.stats.stamina) || 0;
            if (player.mana < player.maxMana) {
                const rate = 0.8 + intellect * 0.15 + stamina * 0.05;
                player.mana = Math.min(player.maxMana, player.mana + dt * rate);
            }
            if (now >= (player.combatUntil || 0) && player.hp > 0 && player.hp < player.maxHp) {
                player.hp = Math.min(player.maxHp, player.hp + dt * player.maxHp * 0.04);
            }
        }
        if ((player.absorbUntil || 0) <= now) player.absorb = 0;
        const shownMana = Math.floor(player.mana);
        const shownHp = Math.floor(player.hp);
        const shownAbsorb = Math.floor(player.absorb || 0);
        if ((shownMana !== player.manaShown || shownHp !== player.hpShown || shownAbsorb !== player.absorbShown) && now - player.manaSent > 800) {
            player.manaShown = shownMana;
            player.hpShown = shownHp;
            player.absorbShown = shownAbsorb;
            player.manaSent = now;
            send(player.ws, { type: 'stats', ...statsOf(player) });
        }
    }

    for (const [id, chest] of chests) {
        if (now - chest.spawnedAt > 60000) {
            chests.delete(id);
            broadcast({ type: 'chestGone', id });
        }
    }

    if (now - lastNpcBroadcast > 100) {
        lastNpcBroadcast = now;
        for (const player of players.values()) send(player.ws, { type: 'npcs', npcs: visibleNpcs(player) });
    }
    syncPartyVitals();
    syncQuestActors(now);
}

setInterval(tickNpcs, 50);

function broadcast(data, excludeWs = null) {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client !== excludeWs && client.readyState === 1) client.send(msg);
    }
}

function send(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
    let sessionId = null;

    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (data.type === 'hello') {
            if (sessionId) return;
            let persistentId = String(data.persistentId || '');
            if (!/^[a-zA-Z0-9_-]{6,64}$/.test(persistentId)) {
                persistentId = Math.random().toString(36).slice(2, 12);
            }
            const name = sanitizeName(data.name);
            if (!save.players[persistentId]) {
                save.players[persistentId] = { name, wood: 0, stone: 0, color: colorFor(persistentId), level: 1, xp: 0 };
            } else if (data.name) {
                save.players[persistentId].name = name;
            }
            const prof = save.players[persistentId];
            if (!prof.color) prof.color = colorFor(persistentId);
            prof.level = Math.max(1, Math.min(MAX_LEVEL, Math.round(Number(prof.level) || 1)));
            prof.xp = prof.level >= MAX_LEVEL ? 0 : (prof.xp || 0);
            prof.armor = prof.armor || 0;
            loadInventory(prof);
            loadCharacter(prof);
            prof.actionbar = sanitizeActionBar(prof.actionbar, prof);

            const existing = players.get(persistentId);
            if (existing && existing.ws !== ws) {
                existing.ws._replaced = true;
                try { existing.ws.close(); } catch { /* already closing */ }
            }

            const spawn = readSpawn(prof);
            prof.spawn = spawn;
            const cave = dungeonById(prof.dungeonId);
            const inside = cave && !cave.instanced;
            const kicked = cave && cave.instanced ? { x: cave.portal.x + 3, z: cave.portal.z } : null;
            if (kicked) {
                prof.dungeonId = '';
                prof.dungeonX = 0;
                prof.dungeonZ = 0;
            }
            const player = {
                ws,
                persistentId,
                dungeonId: inside ? cave.id : '',
                instanceId: '',
                x: inside ? Number(prof.dungeonX) || spawn.x : (kicked ? kicked.x : spawn.x),
                y: inside ? 0.2 : 0,
                z: inside ? Number(prof.dungeonZ) || spawn.z : (kicked ? kicked.z : spawn.z),
                rotY: 0,
                tool: 'axe',
                name: prof.name,
                color: prof.color,
                level: prof.level,
                xp: prof.xp,
                maxHp: maxHpFor(prof.level),
                hp: maxHpFor(prof.level),
                maxMana: maxManaFor({ level: prof.level, talents: prof.talents }),
                mana: maxManaFor({ level: prof.level, talents: prof.talents }),
                manaShown: -1,
                hpShown: -1,
                absorb: 0,
                absorbUntil: 0,
                absorbShown: -1,
                manaSent: 0,
                armor: 0,
                legacyArmor: prof.legacyArmor || 0,
                class: prof.class,
                look: prof.look || prof.class || '',
                equipment: Object.fromEntries(EQUIP_SLOTS.map(slot => [slot, prof.equipment[slot] ? copySlot(prof.equipment[slot]) : null])),
                trained: prof.trained.slice(),
                talents: { ...prof.talents },
                spellRanks: { ...prof.spellRanks },
                recipes: Array.isArray(prof.recipes) ? prof.recipes.slice() : [],
                craftSkill: JSON.parse(JSON.stringify(prof.craftSkill || {})),
                quests: JSON.parse(JSON.stringify(prof.quests || {})),
                bagSlots: prof.bagSlots || 0,
                bags: Array.isArray(prof.bags) ? prof.bags.map(copySlot) : [],
                bank: Array.isArray(prof.bank) ? prof.bank.map(copySlot) : [],
                coins: prof.coins || 0,
                materials: Object.assign(blankMaterials(), prof.materials || {}),
                slots: prof.slots.map(copySlot),
                actionbar: prof.actionbar,
                invulnUntil: 0,
                combatUntil: 0,
                lastGather: 0,
                lastAttack: 0,
                ghost: false,
                corpse: null,
                spawn,
                explored: new Set(Array.isArray(prof.explored) ? prof.explored.filter(key => typeof key === 'string') : []),
                persistentId,
                partyId: null
            };
            players.set(persistentId, player);
            if (!player.class && CLASS_KITS[data.class]) chooseClass(player, data.class);
            refreshDerived(player);
            revealFog(player);
            sessionId = persistentId;
            scheduleSave();

            send(ws, {
                type: 'welcome',
                id: persistentId,
                name: player.name,
                color: player.color,
                inventory: inventoryOf(player),
                stats: statsOf(player),
                npcs: visibleNpcs(player),
                civilians: CIVILIANS.map(publicCivilian),
                camps: campSites(),
                spawn: player.spawn,
                quests: player.quests,
                questDefs: publicQuests(),
                chests: Array.from(chests.values()).filter(chest => !chest.ownerId || chest.ownerId === persistentId).map(publicChest),
                actionbar: player.actionbar,
                character: publicCharacter(player),
                resources: save.resources,
                fog: Array.from(player.explored),
                dungeons: listDungeons(),
                dungeon: player.dungeonId ? { id: player.dungeonId, x: player.x, y: 0.2, z: player.z } : null,
                place: kicked,
                players: Array.from(players.entries())
                    .filter(([pid, p]) => pid !== persistentId && sameView(player, p))
                    .map(([pid, p]) => publicPlayer(pid, p))
            });
            broadcastSeen(player, { type: 'join', ...publicPlayer(persistentId, player) });
            return;
        }

        const player = sessionId ? players.get(sessionId) : null;
        if (!player || player.ws !== ws) return;

        if (data.type === 'update') {
            const prevX = player.x;
            const prevZ = player.z;
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.y === 'number') player.y = data.y;
            if (typeof data.z === 'number') player.z = data.z;
            if (player.dungeonId) {
                const cave = dungeonById(player.dungeonId);
                if (!cave) player.dungeonId = '';
                else {
                    const held = dungeonClamp(cave, player.x, player.z);
                    if (dungeonBlocked(cave, prevX, prevZ, held.x, held.z)) {
                        const back = dungeonClamp(cave, prevX, prevZ);
                        const outside = Math.hypot(back.x - prevX, back.z - prevZ) > 0.3;
                        player.x = outside ? held.x : prevX;
                        player.z = outside ? held.z : prevZ;
                    } else {
                        player.x = held.x;
                        player.z = held.z;
                    }
                    player.y = 0.2;
                    if (typeof data.rotY === 'number') player.rotY = data.rotY;
                    if (data.tool === 'axe' || data.tool === 'pickaxe' || data.tool === 'sword' || data.tool === 'staff') player.tool = data.tool;
                    if (Math.hypot(player.x - data.x, player.z - data.z) > 0.45) {
                        send(ws, { type: 'teleport', x: player.x, y: 0.2, z: player.z, add: [], quiet: true });
                    }
                    broadcastSeen(player, { type: 'update', ...publicPlayer(sessionId, player) });
                    return;
                }
            }
            const edge = clampWorld(player.x, player.z, 2.2);
            const tooFar = swimTooFar(edge.x, edge.z);
            const leavingShore = tooFar && !swimTooFar(prevX, prevZ);
            const deeper = tooFar && boundaryInset(edge.x, edge.z) < boundaryInset(prevX, prevZ) - 0.2;
            if (blocksClimb(prevX, prevZ, edge.x, edge.z) || leavingShore || deeper) {
                player.x = prevX;
                player.z = prevZ;
            } else {
                player.x = edge.x;
                player.z = edge.z;
            }
            if (typeof data.rotY === 'number') player.rotY = data.rotY;
            if (data.tool === 'axe' || data.tool === 'pickaxe' || data.tool === 'sword' || data.tool === 'staff') player.tool = data.tool;
            const revealed = revealFog(player);
            broadcastSeen(player, { type: 'update', ...publicPlayer(sessionId, player) });
            if (revealed.length) send(ws, { type: 'fog', add: revealed });
            return;
        }

        if (data.type === 'teleport') {
            if (player.dungeonId) {
                send(ws, { type: 'teleport', x: player.x, y: 0.2, z: player.z, add: [], quiet: true });
                send(ws, { type: 'note', text: 'The only way out is the portal' });
                return;
            }
            const edge = clampWorld(Number(data.x), Number(data.z), 2.2);
            player.x = edge.x;
            player.z = edge.z;
            player.y = terrainHeight(player.x, player.z);
            const revealed = revealFog(player);
            broadcastSeen(player, { type: 'update', ...publicPlayer(sessionId, player) });
            send(ws, { type: 'teleport', x: player.x, y: player.y, z: player.z, add: revealed });
            return;
        }

        if (data.type === 'enterDungeon') {
            const cave = dungeonById(data.id);
            if (!cave || player.dungeonId) {
                send(ws, { type: 'dungeon', ok: false, reason: player.dungeonId ? 'Already inside' : 'No such dungeon' });
                return;
            }
            if (Math.hypot(player.x - cave.portal.x, player.z - cave.portal.z) > 4.5) {
                send(ws, { type: 'dungeon', ok: false, reason: 'Too far from the portal' });
                return;
            }
            if (cave.instanced) {
                const error = enterChapel(player, cave);
                if (error) send(ws, { type: 'dungeon', ok: false, reason: error });
                return;
            }
            const samples = cave.samples && cave.samples.length ? cave.samples : cave.points;
            const spot = dungeonWorld(cave, samples[0][0], samples[0][1]);
            player.dungeonId = cave.id;
            player.x = spot.x;
            player.z = spot.z;
            player.y = 0.2;
            savePlayer(player);
            send(ws, { type: 'dungeon', ok: true, action: 'enter', id: cave.id, x: spot.x, y: 0.2, z: spot.z });
            broadcastSeen(player, { type: 'update', ...publicPlayer(sessionId, player) });
            return;
        }

        if (data.type === 'exitDungeon') {
            const cave = dungeonById(player.dungeonId);
            if (!cave) {
                player.dungeonId = '';
                player.instanceId = '';
                send(ws, { type: 'dungeon', ok: false, reason: 'You are not inside' });
                return;
            }
            if (player.instanceId || cave.instanced) {
                const samples = cave.samples && cave.samples.length ? cave.samples : cave.points;
                const mouth = dungeonWorld(cave, samples[0][0], samples[0][1]);
                if (Math.hypot(player.x - mouth.x, player.z - mouth.z) > 4.5) {
                    send(ws, { type: 'dungeon', ok: false, reason: 'The portal is at the entrance' });
                    return;
                }
                leaveChapel(player);
                return;
            }
            const samples = cave.samples && cave.samples.length ? cave.samples : cave.points;
            const mouth = dungeonWorld(cave, samples[0][0], samples[0][1]);
            if (Math.hypot(player.x - mouth.x, player.z - mouth.z) > 4.5) {
                send(ws, { type: 'dungeon', ok: false, reason: 'The portal is at the entrance' });
                return;
            }
            player.dungeonId = '';
            player.x = cave.portal.x + 3;
            player.z = cave.portal.z;
            player.y = terrainHeight(player.x, player.z);
            savePlayer(player);
            send(ws, { type: 'dungeon', ok: true, action: 'exit', x: player.x, y: player.y, z: player.z });
            broadcastSeen(player, { type: 'update', ...publicPlayer(sessionId, player) });
            return;
        }

        if (data.type === 'rename') {
            player.name = sanitizeName(data.name);
            save.players[player.persistentId].name = player.name;
            scheduleSave();
            broadcast({ type: 'rename', id: sessionId, name: player.name, color: player.color });
            return;
        }

        if (data.type === 'gather') {
            if (player.ghost) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'You are a ghost' });
                return;
            }
            const now = Date.now();
            if (now - player.lastGather < GATHER_COOLDOWN_MS) return;
            player.lastGather = now;
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            const tool = data.tool === 'pickaxe' ? 'pickaxe' : data.tool === 'hands' ? 'hands' : 'axe';
            player.tool = tool === 'hands' ? player.tool : tool;

            const node = resourceById(data.id);
            if (!node) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'Unknown node' });
                return;
            }
            if (node.type === 'boulder' || node.type === 'plain-tree' || node.type === 'plain-rock' || ((node.type === 'tree' || node.type === 'rock') && !node.placed)) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'That cannot be gathered' });
                return;
            }
            const hits = hitsFor(node.id);
            if (hits <= 0) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'Already gone', id: node.id, hits: 0, inventory: inventoryOf(player) });
                return;
            }
            const dx = player.x - node.x;
            const dz = player.z - node.z;
            if (dx * dx + dz * dz > GATHER_RANGE * GATHER_RANGE) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'Too far' });
                return;
            }
            const needsAxe = node.type === 'tree';
            const needsPick = node.type === 'rock' || node.type === 'sulfur';
            if ((needsAxe && tool !== 'axe') || (needsPick && tool !== 'pickaxe')) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'Wrong tool' });
                return;
            }

            const next = hits - 1;
            let gained = null;
            if (next <= 0) {
                const drop = node.type === 'tree'
                    ? { kind: 'wood', name: 'Wood', qty: 1 }
                    : node.type === 'herb'
                        ? { kind: 'herb', name: 'Herb', qty: 1 }
                        : node.type === 'sulfur'
                            ? { kind: 'powder', name: 'Powder', qty: 1 }
                            : { kind: 'stone', name: 'Stone', qty: 1 };
                const gem = node.type === 'rock' && Math.random() < 0.3
                    ? { kind: 'gem', name: 'Gem', qty: 1 }
                    : null;
                if (addToSlots(player, drop) || (gem && addToSlots(player, gem))) {
                    send(ws, { type: 'gatherResult', ok: false, reason: 'Inventory full', id: node.id, hits, inventory: inventoryOf(player) });
                    return;
                }
                gained = gem ? 'stone-gem' : drop.kind;
                savePlayer(player);
            }
            save.resources[node.id] = next;
            scheduleSave();
            broadcast({ type: 'resource', id: node.id, hits: next });
            send(ws, {
                type: 'gatherResult',
                ok: true,
                id: node.id,
                hits: next,
                gained,
                inventory: inventoryOf(player)
            });
            return;
        }

        if (data.type === 'attack') {
            if (player.ghost) {
                send(ws, { type: 'attackResult', ok: false, reason: 'You are a ghost' });
                return;
            }
            const now = Date.now();
            const abilityId = ABILITIES[data.ability] ? data.ability : 'sword';
            const spec = ABILITIES[abilityId];
            const cdMax = ABILITY_COOLDOWN[abilityId] || 1200;
            const left = cooldownLeft(player, abilityId, now);
            if (left > 0) {
                send(ws, { type: 'attackResult', ok: false, reason: 'Not ready', ability: abilityId, cd: left, cdMax });
                return;
            }
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            if (typeof data.rotY === 'number') player.rotY = data.rotY;
            player.tool = spec.weapon;
            if (player.class) {
                const worn = player.equipment.weapon && player.equipment.weapon.weapon;
                if (worn !== spec.weapon) {
                    send(ws, { type: 'attackResult', ok: false, reason: 'Equip a ' + spec.weapon });
                    return;
                }
                if (!knownSpells(player).includes(abilityId)) {
                    send(ws, { type: 'attackResult', ok: false, reason: 'Spell not trained' });
                    return;
                }
            }
            if (!spec.heal && inSettlement(player.x, player.z)) {
                send(ws, { type: 'attackResult', ok: false, reason: 'This camp is safe' });
                return;
            }
            const rank = abilityRank(player, abilityId);
            const cost = abilityCost(abilityId, rank);
            if (player.mana < cost) {
                send(ws, { type: 'attackResult', ok: false, reason: 'Not enough mana', ability: data.ability || 'sword', ...statsOf(player) });
                return;
            }
            player.mana -= cost;
            if (cost > 0) noteMana(player);
            if (spec.heal) {
                let subject = player;
                if (data.targetId && data.targetId !== player.persistentId) {
                    const ally = players.get(data.targetId);
                    if (!ally) {
                        player.mana += cost;
                        noteMana(player);
                        send(ws, { type: 'attackResult', ok: false, reason: npcs.has(data.targetId) ? 'Select a player to heal' : 'No target', ...statsOf(player) });
                        return;
                    }
                    if (ally.ghost) {
                        player.mana += cost;
                        noteMana(player);
                        send(ws, { type: 'attackResult', ok: false, reason: 'Cannot heal a ghost', ...statsOf(player) });
                        return;
                    }
                    if (Math.hypot(ally.x - player.x, ally.z - player.z) > 8) {
                        player.mana += cost;
                        noteMana(player);
                        send(ws, { type: 'attackResult', ok: false, reason: 'Out of range', ...statsOf(player) });
                        return;
                    }
                    subject = ally;
                }
                const healed = Math.round((spellAmount(abilityId, player.level) + ((player.stats && player.stats.intellect) || 0)) * rankPower(rank));
                subject.hp = Math.min(subject.maxHp, subject.hp + healed);
                startCooldown(player, abilityId, cdMax, now);
                broadcast({
                    type: 'cast',
                    casterId: sessionId,
                    ability: abilityId,
                    bolts: 1,
                    travel: 280,
                    x: player.x,
                    z: player.z,
                    tx: subject.x,
                    tz: subject.z
                });
                if (subject !== player) send(subject.ws, { type: 'healed', amount: healed, from: player.name, ...statsOf(subject) });
                send(ws, { type: 'attackResult', ok: true, ability: abilityId, cd: cdMax, cdMax, spent: cost, heal: healed, targetId: subject.persistentId, ...statsOf(player) });
                return;
            }
            if (spec.absorb) {
                const amount = Math.round((spellAmount(abilityId, player.level) + ((player.stats && player.stats.intellect) || 0)) * rankPower(rank));
                const current = now < (player.absorbUntil || 0) ? (player.absorb || 0) : 0;
                player.absorb = Math.max(current, amount);
                player.absorbUntil = now + 15000;
                startCooldown(player, abilityId, cdMax, now);
                noteMana(player);
                broadcast({
                    type: 'cast',
                    casterId: sessionId,
                    ability: abilityId,
                    bolts: 1,
                    travel: 280,
                    x: player.x,
                    z: player.z,
                    tx: player.x,
                    tz: player.z
                });
                send(ws, { type: 'attackResult', ok: true, ability: abilityId, cd: cdMax, cdMax, spent: cost, shield: player.absorb, ...statsOf(player) });
                return;
            }
            const ally = players.get(data.targetId);
            if (ally) {
                player.mana += cost;
                noteMana(player);
                send(ws, { type: 'attackResult', ok: false, reason: 'Cannot attack a player', ...statsOf(player) });
                return;
            }
            const npc = npcs.get(data.targetId);
            if (!npc || !npc.alive || (npc.instanceId || '') !== (player.instanceId || '')) {
                player.mana += cost;
                noteMana(player);
                send(ws, { type: 'attackResult', ok: false, reason: 'No target', ...statsOf(player) });
                return;
            }
            const dist = Math.hypot(npc.x - player.x, npc.z - player.z);
            if (dist > spec.range) {
                player.mana += cost;
                noteMana(player);
                send(ws, { type: 'attackResult', ok: false, reason: 'Out of range', ...statsOf(player) });
                return;
            }
            startCooldown(player, abilityId, cdMax, now);
            enterCombat(player, now);
            const bolts = abilityId === 'arcane-bolt' ? Math.min(3, rank) : 1;
            const statBonus = (spec.weapon === 'sword' || spec.weapon === 'bow')
                ? ((player.stats && player.stats.strength) || 0)
                : ((player.stats && player.stats.intellect) || 0);
            const powerTalent = spec.weapon === 'sword' ? ['might', 'frenzy'] : spec.weapon === 'bow' ? ['precision', 'eagle-eye'] : spec.weapon === 'wand' ? ['affliction', 'ruin', 'siphon'] : ['arcane-power', 'focus'];
            const per = (spellAmount(abilityId, player.level) + statBonus + (spec.damage || spec.leech ? ranksIn(player, powerTalent) : 0)) * rankPower(rank);
            const projectile = !!spec.bolt;
            const travel = projectile ? Math.min(900, Math.max(220, Math.round(dist * 140))) : 0;
            const victims = [npc];
            if (spec.aoe && !projectile) {
                const areaTalent = spec.weapon === 'sword' ? ['sweep'] : spec.weapon === 'bow' ? ['volley', 'barrage', 'salvo'] : spec.weapon === 'wand' ? ['immolate'] : ['blast', 'winter'];
                const reach = spec.aoe + ranksIn(player, areaTalent) * 0.6;
                const ox = spec.aoeSelf ? player.x : npc.x;
                const oz = spec.aoeSelf ? player.z : npc.z;
                for (const other of npcs.values()) {
                    if (other === npc || !other.alive) continue;
                    if ((other.dungeonId || '') !== (player.dungeonId || '')) continue;
                    if ((other.instanceId || '') !== (player.instanceId || '')) continue;
                    if (Math.hypot(other.x - ox, other.z - oz) > reach) continue;
                    victims.push(other);
                    if (victims.length >= 6) break;
                }
            }
            broadcast({
                type: 'cast',
                casterId: sessionId,
                ability: abilityId,
                npcId: npc.id,
                bolts: spec.aoe ? victims.length : bolts,
                travel,
                x: player.x,
                z: player.z,
                tx: npc.x,
                tz: npc.z
            });
            const finish = (dealt, killed, gained, leveled, chest, executed) => {
                if (ws.readyState !== 1) return;
                let drained = 0;
                if (spec.leech && dealt > 0) {
                    drained = Math.max(1, Math.round(dealt * spec.leech));
                    player.hp = Math.min(player.maxHp, player.hp + drained);
                }
                const note = executed ? 'Execute' : spec.leech ? 'Drained' : spec.slow ? 'Slowed' : 'Hit';
                send(ws, {
                    type: 'attackResult',
                    ok: true,
                    damage: dealt,
                    drained,
                    bolts,
                    note,
                    npcId: npc.id,
                    killed,
                    gained,
                    leveled,
                    ability: abilityId,
                    cd: cdMax,
                    cdMax,
                    spent: cost,
                    chest: chest ? publicChest(chest) : null,
                    quests: player.quests,
                    inventory: player.questDirty ? inventoryOf(player) : undefined,
                    questNote: player.questNote || '',
                    ...statsOf(player)
                });
                player.questDirty = false;
                player.questNote = '';
            };
            const hitVictim = (victim) => {
                if (!victim.alive) return { dealt: 0, killed: false, gained: 0, leveled: false, chest: null, executed: false };
                let scale = 1;
                let executed = false;
                if (spec.execute && victim.maxHp > 0 && victim.hp / victim.maxHp <= 0.35) {
                    scale = spec.execute;
                    executed = true;
                }
                const dealtNow = Math.max(1, Math.round(per * scale * damageScale(player.level, victim.level)));
                victim.hp -= dealtNow;
                victim.aggroId = player.persistentId;
                if (spec.slow) victim.slowUntil = Math.max(victim.slowUntil || 0, Date.now() + spec.slow);
                let gained = 0;
                let leveled = false;
                let chest = null;
                if (victim.hp <= 0) {
                    downNpc(victim);
                    const award = awardKill(player, victim);
                    gained = award.gained;
                    leveled = award.leveled;
                    chest = spawnChest(victim, award.members);
                }
                broadcast({
                    type: 'npcHit',
                    id: victim.id,
                    hp: victim.hp,
                    maxHp: victim.maxHp,
                    alive: victim.alive,
                    x: victim.x,
                    z: victim.z,
                    level: victim.level,
                    name: victim.name,
                    tint: victim.tint
                });
                if (victim.ambientGone) npcs.delete(victim.id);
                return { dealt: dealtNow, killed: !victim.alive, gained, leveled, chest, executed };
            };
            if (!projectile) {
                let dealt = 0;
                let killed = false;
                let gained = 0;
                let leveled = false;
                let chest = null;
                let executed = false;
                for (const victim of victims) {
                    const hit = hitVictim(victim);
                    dealt += hit.dealt;
                    killed = killed || hit.killed;
                    gained += hit.gained;
                    leveled = leveled || hit.leveled;
                    chest = hit.chest || chest;
                    executed = executed || hit.executed;
                }
                finish(dealt, killed, gained, leveled, chest, executed);
                return;
            }
            let landed = 0;
            let dealt = 0;
            let reported = false;
            let executed = false;
            const report = (hit) => {
                if (reported) return;
                reported = true;
                finish(dealt, hit ? hit.killed : false, hit ? hit.gained : 0, hit ? hit.leveled : false, hit ? hit.chest : null, executed);
            };
            for (let i = 0; i < bolts; i++) {
                setTimeout(() => {
                    const hit = hitVictim(npc);
                    dealt += hit.dealt;
                    executed = executed || hit.executed;
                    landed += 1;
                    if (hit.killed || landed >= bolts) report(hit);
                }, travel + i * 90);
            }
            return;
        }

        if (data.type === 'reclaim') {
            if (!player.ghost || !player.corpse) {
                send(ws, { type: 'reclaim', ok: false, reason: 'You are not a ghost' });
                return;
            }
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            if (Math.hypot(player.x - player.corpse.x, player.z - player.corpse.z) > 3.2) {
                send(ws, { type: 'reclaim', ok: false, reason: 'Too far from your body' });
                return;
            }
            player.ghost = false;
            player.hp = player.maxHp;
            player.mana = player.maxMana;
            player.corpse = null;
            player.invulnUntil = Date.now() + 2000;
            broadcast({ type: 'ghost', ...publicPlayer(player.persistentId, player) });
            send(ws, { type: 'reclaim', ok: true, ...statsOf(player) });
            return;
        }

        if (data.type === 'loot') {
            const chest = chests.get(data.id);
            if (!chest) {
                send(ws, { type: 'lootResult', ok: false, reason: 'Chest is gone' });
                return;
            }
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            if (Math.hypot(player.x - chest.x, player.z - chest.z) > 2.6) {
                send(ws, { type: 'lootResult', ok: false, reason: 'Too far' });
                return;
            }
            if (chest.ownerId && chest.ownerId !== player.persistentId) {
                send(ws, { type: 'lootResult', ok: false, reason: 'That chest is not yours' });
                return;
            }
            const { taken, leftover, quested } = giveLoot(player, chest.items);
            if (!taken.length) {
                const onlyQuest = leftover.length > 0 && leftover.every(item => item.kind === 'quest');
                send(ws, { type: 'lootResult', ok: false, reason: onlyQuest ? 'Nothing you need' : 'Inventory full', inventory: inventoryOf(player) });
                return;
            }
            if (leftover.length) {
                chest.items = leftover;
                broadcast({ type: 'chest', chest: publicChest(chest) });
            } else {
                chests.delete(chest.id);
                broadcast({ type: 'chestGone', id: chest.id });
            }
            send(ws, {
                type: 'lootResult',
                ok: true,
                items: taken,
                leftover: leftover.length,
                inventory: inventoryOf(player),
                quests: quested ? player.quests : undefined,
                ...statsOf(player)
            });
            if (quested) player.questDirty = false;
            return;
        }

        if (data.type === 'setSpawn') {
            const civ = nearCivilian(player, data.id);
            if (!civ || civ.role !== 'inn') {
                send(ws, { type: 'spawn', ok: false, reason: civ ? 'Not an innkeeper' : 'Too far', spawn: player.spawn });
                return;
            }
            player.spawn = { x: civ.x, z: civ.z, name: civ.name };
            savePlayer(player);
            send(ws, { type: 'spawn', ok: true, spawn: player.spawn, note: 'Rest set to ' + civ.name + '. Press H to return here.' });
            return;
        }

        if (data.type === 'hearth') {
            if (player.ghost) {
                send(ws, { type: 'hearth', ok: false, reason: 'You are a ghost' });
                return;
            }
            if (Date.now() < (player.combatUntil || 0)) {
                send(ws, { type: 'hearth', ok: false, reason: 'You are in combat' });
                return;
            }
            const home = player.spawn;
            if (!home || !Number.isFinite(home.x) || !Number.isFinite(home.z)) {
                send(ws, { type: 'hearth', ok: false, reason: 'Set your rest with an innkeeper' });
                return;
            }
            const instId = player.instanceId || '';
            if (player.dungeonId || instId) {
                player.instanceId = '';
                player.dungeonId = '';
                for (const hz of hazards.values()) {
                    if (hz.instanceId === instId) send(ws, { type: 'hazard', id: hz.id, on: false });
                }
                if (instId) clearInstanceIfEmpty(instId);
            }
            player.x = home.x;
            player.z = home.z;
            player.y = terrainHeight(player.x, player.z);
            savePlayer(player);
            const revealed = revealFog(player);
            send(ws, {
                type: 'hearth',
                ok: true,
                x: player.x,
                y: player.y,
                z: player.z,
                name: home.name || 'the inn',
                add: revealed
            });
            send(ws, { type: 'npcs', npcs: visibleNpcs(player) });
            refreshSight(player);
            return;
        }

        if (data.type === 'acceptQuest') {
            const civ = nearCivilian(player, data.id);
            const questId = data.quest && offersQuest(civ, data.quest) ? data.quest : '';
            const quest = questId && QUESTS[questId];
            if (!civ || !quest) {
                send(ws, { type: 'quests', ok: false, reason: civ ? 'No quest here' : 'Too far', quests: player.quests });
                return;
            }
            const row = player.quests[questId];
            if (row && row.state === 'done') {
                send(ws, { type: 'quests', ok: false, reason: 'Already complete', quests: player.quests });
                return;
            }
            if (row && row.state === 'active' && !row.failed) {
                send(ws, { type: 'quests', ok: false, reason: 'Already taken', quests: player.quests });
                return;
            }
            if ((player.level || 1) < (quest.minLevel || 1)) {
                send(ws, { type: 'quests', ok: false, reason: 'Requires level ' + quest.minLevel, quests: player.quests });
                return;
            }
            if (!questDoneByName(player, quest.requires)) {
                send(ws, { type: 'quests', ok: false, reason: 'Requires ' + quest.requires, quests: player.quests });
                return;
            }
            if (quest.type === 'protect' && !protectTarget(quest)) {
                send(ws, { type: 'quests', ok: false, reason: 'That person is not in the world', quests: player.quests });
                return;
            }
            const already = quest.type === 'protect' && someoneNeeds(questId);
            player.quests[questId] = { state: 'active', count: 0, failed: false };
            if (quest.type === 'protect') {
                quest.guardMax = 50 + quest.count * 20;
                if (!already || !quest.guardHp) quest.guardHp = quest.guardMax;
            }
            savePlayer(player);
            lastQuestSync = 0;
            syncQuestActors(Date.now());
            send(ws, { type: 'quests', ok: true, note: 'Quest accepted', quests: player.quests, questDefs: publicQuests() });
            return;
        }

        if (data.type === 'turnIn') {
            const civ = nearCivilian(player, data.id);
            const questId = data.quest && offersQuest(civ, data.quest) ? data.quest : '';
            const quest = questId && QUESTS[questId];
            const row = questId && player.quests[questId];
            if (!civ || !quest || !row || row.state !== 'active') {
                send(ws, { type: 'quests', ok: false, reason: civ ? 'Nothing to turn in' : 'Too far', quests: player.quests });
                return;
            }
            if (row.failed) {
                send(ws, { type: 'quests', ok: false, reason: 'The defense failed', quests: player.quests });
                return;
            }
            if (row.count < quest.count) {
                send(ws, { type: 'quests', ok: false, reason: row.count + '/' + quest.count, quests: player.quests });
                return;
            }
            if (quest.rewardKind && quest.rewardKind !== 'coins') {
                const reward = rewardFromCatalog(quest);
                const leftover = addToSlots(player, reward);
                if (leftover) {
                    send(ws, { type: 'quests', ok: false, reason: 'Inventory full', quests: player.quests });
                    return;
                }
            }
            row.state = 'done';
            row.failed = false;
            clearUnusedQuestItems(player);
            if (quest.coins) addToSlots(player, { kind: 'coins', name: 'Coins', qty: quest.coins });
            const leveled = grantXp(player, quest.xp || 0);
            savePlayer(player);
            send(ws, { type: 'quests', ok: true, note: 'Quest complete', leveled, quests: player.quests, inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'discard') {
            const index = Number.isInteger(data.slot) ? data.slot : -1;
            const slot = player.slots[index];
            if (!slot) {
                send(ws, { type: 'discardResult', ok: false, reason: 'Empty slot' });
                return;
            }
            const qty = data.all ? slot.qty : 1;
            const name = slot.name;
            slot.qty -= qty;
            if (slot.qty <= 0) player.slots[index] = null;
            savePlayer(player);
            send(ws, { type: 'discardResult', ok: true, name, qty, inventory: inventoryOf(player) });
            return;
        }

        if (data.type === 'discardMaterial') {
            const kind = data.kind;
            if (!MATERIAL_KINDS.includes(kind)) {
                send(ws, { type: 'discardResult', ok: false, reason: 'Not a supply' });
                return;
            }
            const have = player.materials[kind] || 0;
            if (!have) {
                send(ws, { type: 'discardResult', ok: false, reason: 'None left' });
                return;
            }
            const qty = data.all ? have : 1;
            player.materials[kind] = have - qty;
            savePlayer(player);
            send(ws, { type: 'discardResult', ok: true, name: MATERIAL_NAMES[kind] || kind, qty, inventory: inventoryOf(player) });
            return;
        }

        if (data.type === 'sell') {
            placePlayer(player, data);
            if (!nearRole(player, 'shop')) {
                send(ws, { type: 'sellResult', ok: false, reason: 'See a shop assistant' });
                return;
            }
            let price = 0;
            let qty = 0;
            let name = '';
            if (data.supply) {
                const kind = data.kind;
                if (!MATERIAL_KINDS.includes(kind)) {
                    send(ws, { type: 'sellResult', ok: false, reason: 'Not a supply' });
                    return;
                }
                const have = player.materials[kind] || 0;
                qty = data.all ? have : Math.min(1, have);
                if (!qty) {
                    send(ws, { type: 'sellResult', ok: false, reason: 'Nothing to sell' });
                    return;
                }
                price = sellPrice({ kind }) * qty;
                player.materials[kind] = have - qty;
                name = MATERIAL_NAMES[kind] || kind;
            } else {
                const index = Number.isInteger(data.slot) ? data.slot : -1;
                const slot = player.slots[index];
                if (!slot) {
                    send(ws, { type: 'sellResult', ok: false, reason: 'Nothing to sell' });
                    return;
                }
                if (slot.kind === 'quest') {
                    send(ws, { type: 'sellResult', ok: false, reason: 'Quest items cannot be sold' });
                    return;
                }
                qty = data.all ? slot.qty : 1;
                price = sellPrice(slot) * qty;
                name = slot.name;
                slot.qty -= qty;
                if (slot.qty <= 0) player.slots[index] = null;
            }
            player.coins += price;
            savePlayer(player);
            send(ws, { type: 'sellResult', ok: true, name, qty, price, inventory: inventoryOf(player) });
            return;
        }

        if (data.type === 'use') {
            let index = Number.isInteger(data.slot) ? data.slot : -1;
            if (index < 0 || !player.slots[index]) {
                index = player.slots.findIndex(slot => slot && (slot.kind === data.item));
            }
            const slot = player.slots[index];
            if (!slot) {
                send(ws, { type: 'useResult', ok: false, reason: 'Nothing to use' });
                return;
            }
            const now = Date.now();
            const cdKey = slot.kind === 'bomb' ? 'bomb' : (slot.kind === 'health' || slot.kind === 'mana' ? 'potion' : '');
            const cdMax = cdKey === 'bomb' ? BOMB_COOLDOWN : POTION_COOLDOWN;
            if (cdKey) {
                const left = cooldownLeft(player, cdKey, now);
                if (left > 0) {
                    send(ws, { type: 'useResult', ok: false, reason: 'Not ready', item: slot.kind, cd: left, cdMax, cdKey });
                    return;
                }
            }
            if (slot.kind === 'health') {
                player.hp = Math.min(player.maxHp, player.hp + (slot.amount || 10));
            } else if (slot.kind === 'mana') {
                player.mana = Math.min(player.maxMana, player.mana + (slot.amount || 8));
            } else if (slot.kind === 'bomb') {
                if (inSettlement(player.x, player.z)) {
                    send(ws, { type: 'useResult', ok: false, reason: 'This camp is safe' });
                    return;
                }
                const npc = npcs.get(data.targetId);
                if (!npc || !npc.alive || (npc.instanceId || '') !== (player.instanceId || '')) {
                    send(ws, { type: 'useResult', ok: false, reason: 'Select a hostile target' });
                    return;
                }
                if (Math.hypot(npc.x - player.x, npc.z - player.z) > 8) {
                    send(ws, { type: 'useResult', ok: false, reason: 'Out of range' });
                    return;
                }
                const damage = slot.amount || 10;
                enterCombat(player, now);
                npc.hp -= damage;
                let gained = 0;
                let leveled = false;
                let chest = null;
                if (npc.hp <= 0) {
                    downNpc(npc);
                    const award = awardKill(player, npc);
                    gained = award.gained;
                    leveled = award.leveled;
                    chest = spawnChest(npc, award.members);
                }
                broadcast({
                    type: 'npcHit',
                    id: npc.id,
                    hp: npc.hp,
                    maxHp: npc.maxHp,
                    alive: npc.alive,
                    x: npc.x,
                    z: npc.z,
                    level: npc.level,
                    name: npc.name,
                    tint: npc.tint
                });
                if (npc.ambientGone) npcs.delete(npc.id);
                slot.qty -= 1;
                if (slot.qty <= 0) player.slots[index] = null;
                startCooldown(player, 'bomb', BOMB_COOLDOWN, now);
                savePlayer(player);
                send(ws, {
                    type: 'useResult',
                    ok: true,
                    item: 'bomb',
                    cd: BOMB_COOLDOWN,
                    cdMax: BOMB_COOLDOWN,
                    cdKey: 'bomb',
                    damage,
                    killed: !npc.alive,
                    gained,
                    leveled,
                    chest: chest ? publicChest(chest) : null,
                    quests: player.quests,
                    inventory: inventoryOf(player),
                    ...statsOf(player)
                });
                return;
            } else if (slot.kind === 'armor' || slot.kind === 'weapon') {
                send(ws, { type: 'useResult', ok: false, reason: 'Equip it on your character sheet' });
                return;
            } else {
                send(ws, { type: 'useResult', ok: false, reason: 'Cannot use that' });
                return;
            }
            slot.qty -= 1;
            if (slot.qty <= 0) player.slots[index] = null;
            startCooldown(player, 'potion', POTION_COOLDOWN, now);
            savePlayer(player);
            send(ws, { type: 'useResult', ok: true, item: slot.kind, cd: POTION_COOLDOWN, cdMax: POTION_COOLDOWN, cdKey: 'potion', inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'actionbar') {
            player.actionbar = sanitizeActionBar(data.pages, player);
            save.players[player.persistentId].actionbar = player.actionbar;
            scheduleSave();
            send(ws, { type: 'actionbar', pages: player.actionbar });
            return;
        }

        if (data.type === 'reset') {
            if (player.partyId) leaveParty(player);
            const home = mapSpawn();
            player.level = 1;
            player.xp = 0;
            player.class = null;
            player.equipment = emptyEquipment();
            player.trained = [];
            player.talents = {};
            player.spellRanks = {};
            player.recipes = [];
            player.quests = {};
            player.bagSlots = 0;
            player.bags = [];
            player.bank = [];
            player.coins = 0;
            player.materials = blankMaterials();
            player.slots = [];
            normalizeBags(player);
            normalizeBank(player);
            normalizeSlots(player);
            player.actionbar = defaultActionBar(null);
            player.legacyArmor = 0;
            player.ghost = false;
            player.corpse = null;
            player.spawn = { x: home.x, z: home.z, name: home.name || 'Inn' };
            player.x = home.x;
            player.y = 0;
            player.z = home.z;
            player.maxHp = maxHpFor(1);
            player.hp = player.maxHp;
            player.explored = new Set();
            refreshDerived(player);
            player.mana = player.maxMana;
            player.manaShown = -1;
            savePlayer(player);
            const prof = save.players[player.persistentId];
            prof.actionbar = player.actionbar;
            prof.explored = [];
            revealFog(player);
            scheduleSave();
            send(ws, {
                type: 'reset',
                ok: true,
                note: 'Character reset',
                x: player.x,
                y: 0,
                z: player.z,
                spawn: player.spawn,
                quests: player.quests,
                actionbar: player.actionbar,
                fog: Array.from(player.explored),
                inventory: inventoryOf(player),
                character: publicCharacter(player),
                ...statsOf(player)
            });
            broadcastSeen(player, { type: 'update', ...publicPlayer(player.persistentId, player) });
            return;
        }

        if (data.type === 'chooseClass') {
            const error = chooseClass(player, data.class);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), actionbar: player.actionbar, inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'train') {
            placePlayer(player, data);
            if (!nearRole(player, 'trainer')) {
                send(ws, { type: 'character', ok: false, reason: 'See a trainer', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
                return;
            }
            const error = trainSpell(player, data.spell);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'talent') {
            placePlayer(player, data);
            if (player.dungeonId || !nearRole(player, 'trainer')) {
                send(ws, { type: 'character', ok: false, reason: 'See a trainer', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
                return;
            }
            const error = spendTalent(player, data.id);
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : 'Trained', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'resetTalents') {
            placePlayer(player, data);
            if (player.dungeonId || !nearRole(player, 'trainer')) {
                send(ws, { type: 'character', ok: false, reason: 'See a trainer', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
                return;
            }
            const error = resetTalents(player);
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : 'Talents reset. The points are yours again.', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'learnSet') {
            placePlayer(player, data);
            if (!nearRole(player, 'shop')) {
                send(ws, { type: 'character', ok: false, reason: 'See a shop assistant', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
                return;
            }
            const error = learnSet(player, data.set);
            const set = CRAFT_SETS[data.set];
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : (set ? set.name + ' learned' : ''), character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'buyRecipe') {
            placePlayer(player, data);
            if (!nearRole(player, 'shop')) {
                send(ws, { type: 'character', ok: false, reason: 'See a shop assistant', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
                return;
            }
            const error = buyPattern(player, data.recipe);
            const recipe = RECIPES[data.recipe];
            send(ws, {
                type: 'character',
                ok: !error,
                reason: error || '',
                note: error ? '' : ((recipe ? recipe.name : 'Pattern') + ' learned'),
                character: publicCharacter(player),
                inventory: inventoryOf(player),
                ...statsOf(player)
            });
            return;
        }

        if (data.type === 'buy') {
            placePlayer(player, data);
            if (!nearRole(player, 'shop')) {
                send(ws, { type: 'buyResult', ok: false, reason: 'See a shop assistant' });
                return;
            }
            const error = buySupply(player, data.id);
            const good = SHOP_GOODS.find(row => row.id === data.id);
            send(ws, {
                type: 'buyResult',
                ok: !error,
                reason: error || '',
                name: good ? good.name : '',
                inventory: inventoryOf(player),
                ...statsOf(player)
            });
            return;
        }

        if (data.type === 'learnPattern') {
            placePlayer(player, data);
            const error = learnPattern(player, data.slot);
            const extra = !error && player.craftNote ? player.craftNote : '';
            player.craftNote = '';
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : (extra || 'Pattern learned'), character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'learnTier') {
            placePlayer(player, data);
            if (!nearRole(player, 'trainer')) {
                send(ws, { type: 'character', ok: false, reason: 'See a trainer', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
                return;
            }
            const error = learnTier(player, data.set);
            const set = CRAFT_SETS[data.set];
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : ((set ? set.name : 'Craft') + ' tier trained'), character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'craft') {
            if (data.cancel) {
                const job = player.crafting;
                const made = job ? job.made : 0;
                const name = job && RECIPES[job.recipe] ? RECIPES[job.recipe].name : 'item';
                player.crafting = null;
                player.craftNote = '';
                send(ws, {
                    type: 'character',
                    ok: true,
                    note: job ? (made ? 'Stopped. Kept ' + made + ' ' + name : 'Crafting stopped') : 'Not crafting',
                    craft: null,
                    character: publicCharacter(player),
                    inventory: inventoryOf(player),
                    ...statsOf(player)
                });
                return;
            }
            const error = startCraft(player, data.recipe, data.count);
            send(ws, {
                type: 'character',
                ok: !error,
                quiet: !error,
                reason: error || '',
                craft: error ? null : craftStatus(player),
                character: publicCharacter(player),
                inventory: inventoryOf(player),
                ...statsOf(player)
            });
            return;
        }

        if (data.type === 'equip') {
            const error = equipItem(player, data.slot, data.index);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'unequip') {
            const error = unequipItem(player, data.slot);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'equipBag') {
            const error = equipBag(player, data.index);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'unequipBag') {
            const error = unequipBag(player, data.pocket);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'moveItem') {
            const error = moveItem(player, data.from, data.to);
            send(ws, { type: 'character', ok: !error, reason: error, quiet: !error, inventory: inventoryOf(player) });
            return;
        }

        if (data.type === 'bankStore') {
            const error = bankStore(player, data.index);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'bankTake') {
            const error = bankTake(player, data.index);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'chat') {
            handleChat(player, data);
            return;
        }

        if (data.type === 'partyInvite') {
            const target = players.get(data.targetId);
            if (!target || target === player) {
                send(ws, { type: 'party', ok: false, reason: 'Select another player' });
                return;
            }
            if (player.ghost || target.ghost) {
                send(ws, { type: 'party', ok: false, reason: 'A ghost cannot join a party' });
                return;
            }
            if (Math.hypot(player.x - target.x, player.z - target.z) > PARTY_RANGE) {
                send(ws, { type: 'party', ok: false, reason: 'Too far away' });
                return;
            }
            if (target.partyId) {
                send(ws, { type: 'party', ok: false, reason: 'They are already in a party' });
                return;
            }
            const party = partyOf(player);
            if (party && party.leader !== player.persistentId) {
                send(ws, { type: 'party', ok: false, reason: 'Only the leader can invite' });
                return;
            }
            if (party && party.members.length >= PARTY_MAX) {
                send(ws, { type: 'party', ok: false, reason: 'The party is full' });
                return;
            }
            partyInvites.set(target.persistentId, { fromId: player.persistentId, at: Date.now() });
            send(target.ws, { type: 'partyInvite', fromId: player.persistentId, fromName: player.name });
            send(ws, { type: 'party', ok: true, note: 'Invited ' + target.name });
            return;
        }

        if (data.type === 'partyAnswer') {
            const invite = partyInvites.get(player.persistentId);
            partyInvites.delete(player.persistentId);
            if (!data.accept) {
                send(ws, { type: 'party', ok: true, note: 'Invite declined' });
                return;
            }
            if (!invite || Date.now() - invite.at > 30000) {
                send(ws, { type: 'party', ok: false, reason: 'That invite expired' });
                return;
            }
            const leader = players.get(invite.fromId);
            if (!leader) {
                send(ws, { type: 'party', ok: false, reason: 'They have gone' });
                return;
            }
            if (player.partyId) {
                send(ws, { type: 'party', ok: false, reason: 'You are already in a party' });
                return;
            }
            if (player.ghost || leader.ghost) {
                send(ws, { type: 'party', ok: false, reason: 'A ghost cannot join a party' });
                return;
            }
            let group = partyOf(leader);
            if (group && group.leader !== leader.persistentId) {
                send(ws, { type: 'party', ok: false, reason: 'They cannot invite' });
                return;
            }
            if (group && group.members.length >= PARTY_MAX) {
                send(ws, { type: 'party', ok: false, reason: 'The party is full' });
                return;
            }
            if (!group) {
                group = { id: 'p' + partySeq, leader: leader.persistentId, members: [leader.persistentId], sig: '' };
                partySeq += 1;
                parties.set(group.id, group);
                leader.partyId = group.id;
            }
            group.members.push(player.persistentId);
            player.partyId = group.id;
            group.sig = '';
            sendParty(group);
            return;
        }

        if (data.type === 'partyLeave') {
            leaveParty(player);
            return;
        }

        if (data.type === 'partyKick') {
            const group = partyOf(player);
            if (!group || group.leader !== player.persistentId) {
                send(ws, { type: 'party', ok: false, reason: 'Only the leader can remove a member' });
                return;
            }
            const member = players.get(data.targetId);
            if (!member || !group.members.includes(data.targetId) || data.targetId === player.persistentId) return;
            leaveParty(member);
            return;
        }
    });

    ws.on('close', () => {
        if (ws._replaced || !sessionId) return;
        const current = players.get(sessionId);
        if (current && current.ws === ws) {
            leaveParty(current);
            players.delete(sessionId);
            broadcast({ type: 'leave', id: sessionId });
        }
    });
});

const worldPath = path.join(dataDir, 'world.json');
let worldConfig = null;
const adminTokens = new Set();
const LOOT_KINDS = ['junk', 'coins', 'health', 'mana', 'cloth', 'leather', 'ore', 'gem', 'stone', 'herb', 'powder', 'silk', 'recipe', 'armor', 'bag'];

function defaultWorldConfig() {
    return {
        hpBase: 6,
        hpPerLevel: 4,
        grayLevels: 5,
        xpPerMobLevel: 20,
        spawnPerMin: 4,
        spawnCap: 8,
        adminPassword: '',
        loot: JSON.parse(JSON.stringify(LOOT_TABLES)),
        zones: [],
        roads: [],
        quests: []
    };
}

function sanitizeLoot(input) {
    const out = {};
    const source = input && typeof input === 'object' ? input : {};
    const names = new Set([...Object.keys(LOOT_TABLES), ...Object.keys(source)]);
    for (const name of names) {
        if (!/^[a-z0-9-]{1,24}$/i.test(name)) continue;
        const rows = Array.isArray(source[name]) ? source[name] : LOOT_TABLES[name];
        if (!Array.isArray(rows)) continue;
        const clean = [];
        for (const row of rows.slice(0, 24)) {
            if (!row || !LOOT_KINDS.includes(row.kind)) continue;
            const weight = Math.max(1, Math.min(100, Math.round(Number(row.weight) || 0)));
            const entry = { kind: row.kind, weight };
            if (row.kind === 'junk') {
                const names = String(row.names || '').split(',').map(part => part.trim()).filter(Boolean).slice(0, 8);
                if (Array.isArray(row.names)) entry.names = row.names.map(part => String(part).slice(0, 24)).filter(Boolean).slice(0, 8);
                else if (names.length) entry.names = names.map(part => part.slice(0, 24));
            }
            if (row.kind === 'recipe') {
                const sets = Array.isArray(row.sets) ? row.sets : String(row.sets || '').split(',').map(part => part.trim()).filter(Boolean);
                entry.sets = sets.filter(id => CRAFT_SETS[id]).slice(0, 8);
            }
            if (row.kind === 'bag') {
                const bags = Array.isArray(row.bags) ? row.bags : String(row.bags || '').split(',').map(part => part.trim()).filter(Boolean);
                entry.bags = bags.filter(id => BAGS[id]).slice(0, 4);
                if (!entry.bags.length) entry.bags = ['linen-sack'];
            }
            clean.push(entry);
        }
        if (clean.length) out[name.slice(0, 24)] = clean;
    }
    if (!Object.keys(out).length) return JSON.parse(JSON.stringify(LOOT_TABLES));
    return out;
}

function clampNum(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function clampFloat(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

function sanitizeBounds(input) {
    const src = input && typeof input === 'object' ? input : {};
    const points = Array.isArray(src.points) ? src.points.slice(0, 80).map(point => [Number(point[0]), Number(point[1])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1])) : [];
    const closed = points.length >= 3;
    return {
        half: clampNum(src.half, 900, 200, 2000),
        edge: src.edge === 'sea' ? 'sea' : 'hills',
        swim: clampNum(src.swim, 14, 4, 40),
        maxSlope: clampFloat(src.maxSlope, 0.7, 0.3, 1.4),
        points: closed ? points : [],
        edges: closed ? points.map((_, index) => (src.edges && src.edges[index] === 'organic' ? 'organic' : 'line')) : []
    };
}

function sanitizeQuests(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    const seen = new Set();
    for (const raw of list.slice(0, 80)) {
        if (!raw || typeof raw !== 'object') continue;
        let id = String(raw.id || '').slice(0, 24);
        if (!/^[a-z0-9-]{2,24}$/i.test(id)) id = 'q' + Math.random().toString(36).slice(2, 8);
        if (seen.has(id)) continue;
        seen.add(id);
        const type = QUEST_TYPES.includes(raw.type) ? raw.type : 'kill';
        out.push({
            id,
            name: String(raw.name || 'Quest').slice(0, 32),
            minLevel: clampNum(raw.minLevel, 1, 1, 30),
            giver: String(raw.giver || '').trim().slice(0, 24),
            giverRole: ['inn', 'shop', 'trainer', 'quest'].includes(raw.giverRole) ? raw.giverRole : '',
            giverCamp: clampNum(raw.giverCamp, 0, 0, 5),
            zoneId: String(raw.zoneId || '').slice(0, 24),
            dungeonId: String(raw.dungeonId || '').slice(0, 24),
            protectRole: ['inn', 'shop', 'trainer', 'quest'].includes(raw.protectRole) ? raw.protectRole : '',
            protectCamp: clampNum(raw.protectCamp, 0, 0, 5),
            requires: String(raw.requires || '').trim().slice(0, 32),
            type,
            mob: MOB_IDS.includes(raw.mob) ? raw.mob : 'boar',
            count: type === 'named' ? 1 : clampNum(raw.count, 3, 1, 40),
            item: String(raw.item || '').trim().slice(0, 24),
            named: String(raw.named || '').trim().slice(0, 24),
            elite: type === 'named' && sheetFlag(raw.elite),
            custom: sheetFlag(raw.custom),
            text: String(raw.text || '').slice(0, 180),
            coins: clampNum(raw.coins, 10, 0, 500),
            xp: clampNum(raw.xp, 40, 0, 2000),
            rewardKind: LOOT_KINDS.includes(raw.rewardKind) ? raw.rewardKind : '',
            rewardName: String(raw.rewardName || '').trim().slice(0, 24),
            rewardQty: clampNum(raw.rewardQty, 1, 1, 10)
        });
    }
    return out;
}

function sanitizeRoads(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    const seen = new Set();
    for (const raw of list.slice(0, 40)) {
        if (!raw || typeof raw !== 'object') continue;
        let id = String(raw.id || '').slice(0, 24);
        if (!/^[a-z0-9-]{2,24}$/i.test(id)) id = 'r' + Math.random().toString(36).slice(2, 8);
        if (seen.has(id)) continue;
        seen.add(id);
        const points = (Array.isArray(raw.points) ? raw.points : []).slice(0, 24).map(point => [Math.round(Number(point[0])), Math.round(Number(point[1]))]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (points.length < 2) continue;
        const edges = [];
        for (let i = 0; i < points.length - 1; i++) edges.push(raw.edges && raw.edges[i] === 'organic' ? 'organic' : 'line');
        out.push({ id, points, edges });
    }
    return out;
}

function sanitizeDungeons(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    const seen = new Set();
    for (const raw of list.slice(0, 12)) {
        if (!raw || typeof raw !== 'object') continue;
        let id = String(raw.id || '').slice(0, 24);
        if (!/^[a-z0-9-]{2,24}$/i.test(id)) id = 'dg' + Math.random().toString(36).slice(2, 8);
        if (seen.has(id)) continue;
        seen.add(id);
        const points = (Array.isArray(raw.points) ? raw.points : []).slice(0, 18).map(point => [Math.round(Number(point[0])), Math.round(Number(point[1]))]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (points.length < 2) continue;
        const px = Number(raw.portal && raw.portal.x);
        const pz = Number(raw.portal && raw.portal.z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
        const edges = [];
        for (let i = 0; i < points.length - 1; i++) edges.push(raw.edges && raw.edges[i] === 'organic' ? 'organic' : 'line');
        const props = [];
        for (const prop of (Array.isArray(raw.props) ? raw.props : []).slice(0, 80)) {
            const x = Number(prop.x);
            const z = Number(prop.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            const type = prop.type === 'root' || prop.type === 'pillar' ? prop.type : 'rock';
            props.push({ type, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 });
        }
        out.push({
            id,
            name: String(raw.name || 'Cavern').slice(0, 32),
            mob: MOB_IDS.includes(raw.mob) ? raw.mob : 'spider',
            level: clampNum(raw.level, 1, 1, 30),
            elite: !!raw.elite,
            endName: String(raw.endName || 'Warden').slice(0, 24),
            portal: { x: Math.round(px), z: Math.round(pz) },
            points,
            edges,
            props
        });
    }
    return out;
}

function retreatAlong(samples, back) {
    let remain = back;
    for (let i = samples.length - 1; i > 0; i--) {
        const ax = samples[i][0];
        const az = samples[i][1];
        const bx = samples[i - 1][0];
        const bz = samples[i - 1][1];
        const len = Math.hypot(ax - bx, az - bz) || 0;
        if (len >= remain) {
            const t = remain / (len || 1);
            return [ax + (bx - ax) * t, az + (bz - az) * t];
        }
        remain -= len;
    }
    return samples[0];
}

const instances = new Map();
const hazards = new Map();
let instanceSeq = 1;

function sameView(a, b) {
    if (!a || !b) return false;
    if ((a.instanceId || '') !== (b.instanceId || '')) return false;
    if (a.instanceId) return true;
    return (a.dungeonId || '') === (b.dungeonId || '');
}

function visibleNpcs(player) {
    const list = [];
    for (const npc of npcs.values()) {
        if (!npc.alive) continue;
        if (npc.instanceId) {
            if (npc.instanceId === player.instanceId) list.push(publicNpc(npc));
        } else if (!player.instanceId) list.push(publicNpc(npc));
    }
    return list;
}

function broadcastSeen(source, data) {
    for (const other of players.values()) {
        if (other === source || other.ws === source.ws) continue;
        if (!sameView(source, other)) continue;
        send(other.ws, data);
    }
}

function refreshSight(player) {
    for (const [id, other] of players) {
        if (other === player) continue;
        const see = sameView(player, other);
        send(player.ws, see ? { type: 'join', ...publicPlayer(id, other) } : { type: 'leave', id });
        send(other.ws, see ? { type: 'join', ...publicPlayer(player.persistentId, player) } : { type: 'leave', id: player.persistentId });
    }
}

function tellInstance(instanceId, data) {
    for (const player of players.values()) {
        if (player.instanceId === instanceId) send(player.ws, data);
    }
}

function clearInstanceIfEmpty(instanceId) {
    if (!instanceId) return;
    for (const player of players.values()) {
        if (player.instanceId === instanceId) return;
    }
    for (const [id, npc] of npcs) {
        if (npc.instanceId === instanceId) npcs.delete(id);
    }
    for (const [id, hz] of hazards) {
        if (hz.instanceId === instanceId) hazards.delete(id);
    }
    instances.delete(instanceId);
}

function makeChapelNpc(inst, cave, local, extra) {
    const world = dungeonWorld(cave, local[0], local[1]);
    const kind = NPC_KINDS[extra.kind] || NPC_KINDS.cultist;
    const npc = {
        id: inst.id + '-' + extra.tag,
        instanceId: inst.id,
        dungeonId: cave.id,
        pinned: true,
        chapel: true,
        boss: !!extra.boss,
        questId: extra.questId || '',
        x: world.x,
        z: world.z,
        homeX: world.x,
        homeZ: world.z,
        zx: 0,
        zz: 0,
        kind: kind.id,
        name: extra.name,
        tint: extra.tint || kind.tint,
        loot: 'boss',
        level: extra.level,
        alive: true,
        aggroId: null,
        attackAt: 0
    };
    applyElite(npc, !!extra.elite, 0);
    pickWander(npc);
    npcs.set(npc.id, npc);
    return npc;
}

function spawnChapel(inst, cave) {
    const samples = cave.samples && cave.samples.length ? cave.samples : cave.points;
    const spots = [0.28, 0.46, 0.62, 0.74];
    spots.forEach((t, index) => {
        const at = Math.min(samples.length - 2, Math.max(1, Math.round(t * (samples.length - 1))));
        makeChapelNpc(inst, cave, samples[at], { tag: 'trash-' + index, kind: 'cultist', name: 'Drowned Acolyte', level: 5 });
    });
    makeChapelNpc(inst, cave, samples[samples.length - 1], {
        tag: 'prior',
        kind: 'cultist',
        name: 'Drowned Prior',
        level: 7,
        elite: true,
        boss: true,
        questId: 'prior',
        tint: '#6c3483'
    });
}

function chapelMouth(cave) {
    const samples = cave.samples && cave.samples.length ? cave.samples : cave.points;
    return dungeonWorld(cave, samples[0][0], samples[0][1]);
}

function enterChapel(player, cave) {
    let inst = null;
    if (player.partyId) {
        for (const row of instances.values()) {
            if (row.dungeonId === cave.id && row.partyId === player.partyId) inst = row;
        }
    }
    if (inst) {
        let inside = 0;
        for (const other of players.values()) if (other.instanceId === inst.id) inside += 1;
        if (inside >= 4) return 'That run already has four players';
    } else {
        inst = { id: 'i' + (instanceSeq++), dungeonId: cave.id, partyId: player.partyId || '' };
        instances.set(inst.id, inst);
        spawnChapel(inst, cave);
    }
    const spot = chapelMouth(cave);
    player.dungeonId = cave.id;
    player.instanceId = inst.id;
    player.x = spot.x;
    player.z = spot.z;
    player.y = 0.2;
    savePlayer(player);
    send(player.ws, {
        type: 'dungeon',
        ok: true,
        action: 'enter',
        id: cave.id,
        x: spot.x,
        y: 0.2,
        z: spot.z,
        note: 'The Drowned Chapel. Up to four in a party. Move out of the black water.'
    });
    send(player.ws, { type: 'npcs', npcs: visibleNpcs(player) });
    refreshSight(player);
    return null;
}

function leaveChapel(player) {
    const cave = dungeonById(player.dungeonId);
    const instId = player.instanceId || '';
    player.instanceId = '';
    player.dungeonId = '';
    if (cave) {
        player.x = cave.portal.x + 3;
        player.z = cave.portal.z;
        player.y = terrainHeight(player.x, player.z);
    }
    savePlayer(player);
    send(player.ws, { type: 'dungeon', ok: true, action: 'exit', x: player.x, y: player.y, z: player.z });
    send(player.ws, { type: 'npcs', npcs: visibleNpcs(player) });
    for (const hz of hazards.values()) {
        if (hz.instanceId === instId) send(player.ws, { type: 'hazard', id: hz.id, on: false });
    }
    refreshSight(player);
    clearInstanceIfEmpty(instId);
}

function tickHazards(now) {
    for (const [id, hz] of hazards) {
        if (now <= hz.until) continue;
        hazards.delete(id);
        tellInstance(hz.instanceId, { type: 'hazard', id, on: false });
    }
    for (const player of players.values()) {
        if (!player.instanceId || player.hp <= 0 || player.ghost) continue;
        for (const hz of [...hazards.values()]) {
            if (hz.instanceId !== player.instanceId || now > hz.until) continue;
            if (Math.hypot(player.x - hz.x, player.z - hz.z) > hz.r) continue;
            if (now < (player.poolUntil || 0)) continue;
            player.poolUntil = now + 800;
            player.hp = Math.max(0, player.hp - 6);
            enterCombat(player, now);
            send(player.ws, { type: 'hurt', damage: 6, absorbed: 0, attacker: 'Black water', ...statsOf(player) });
            if (player.hp <= 0) becomeGhost(player, now);
        }
    }
}

function tickChapelBosses(now) {
    for (const npc of npcs.values()) {
        if (!npc.chapel || !npc.boss || !npc.alive) continue;
        const ratio = npc.maxHp > 0 ? npc.hp / npc.maxHp : 1;
        if (!npc.puddle && ratio <= 0.7) {
            npc.puddle = true;
            const hz = { id: npc.id + '-pool', instanceId: npc.instanceId, x: npc.x, z: npc.z, r: 3.3, until: now + 16000 };
            hazards.set(hz.id, hz);
            tellInstance(npc.instanceId, { type: 'hazard', id: hz.id, x: hz.x, z: hz.z, r: hz.r, on: true });
            tellInstance(npc.instanceId, { type: 'note', text: 'Black water spreads. Move out of it.' });
        }
        if (!npc.adds && ratio <= 0.45) {
            npc.adds = true;
            const cave = dungeonById(npc.dungeonId);
            const inst = instances.get(npc.instanceId);
            if (cave && inst) {
                const end = dungeonLocal(cave, npc.x, npc.z);
                makeChapelNpc(inst, cave, [end.x + 2.2, end.z - 2], { tag: 'add-a-' + now, kind: 'cultist', name: 'Drowned Acolyte', level: 5 });
                makeChapelNpc(inst, cave, [end.x - 2.2, end.z - 2], { tag: 'add-b-' + now, kind: 'cultist', name: 'Drowned Acolyte', level: 5 });
                tellInstance(npc.instanceId, { type: 'note', text: 'The prior calls two acolytes.' });
            }
        }
    }
}

function spawnDungeonMobs() {
    for (const brief of listDungeons()) {
        const dungeon = dungeonById(brief.id) || brief;
        if (dungeon.instanced) continue;
        const samples = dungeon.samples && dungeon.samples.length ? dungeon.samples : dungeon.points;
        if (!samples || !samples.length) continue;
        let travel = 0;
        let since = 0;
        let spawned = 0;
        for (let i = 1; i < samples.length; i++) {
            const step = Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
            travel += step;
            since += step;
            if (travel < 10 || since < 9) continue;
            const remain = routeRemain(samples, i);
            if (remain < 8) break;
            since = 0;
            spawned += 1;
            const along = samples[i];
            const world = dungeonWorld(dungeon, along[0], along[1]);
            const kind = NPC_KINDS[dungeon.mob] || NPC_KINDS.spider;
            const npc = {
                id: 'dm-' + dungeon.id + '-' + spawned,
                dungeonId: dungeon.id,
                pinned: true,
                x: world.x,
                z: world.z,
                homeX: world.x,
                homeZ: world.z,
                zx: 0,
                zz: 0,
                kind: kind.id,
                name: kind.name,
                tint: kind.tint,
                loot: kind.loot,
                level: dungeon.level,
                alive: true,
                aggroId: null,
                attackAt: 0
            };
            applyElite(npc, dungeon.elite, 0);
            pickWander(npc);
            npcs.set(npc.id, npc);
        }
        const end = samples[samples.length - 1];
        const endWorld = dungeonWorld(dungeon, end[0], end[1]);
        for (const quest of Object.values(QUESTS)) {
            if (quest.type !== 'named' || quest.dungeonId !== dungeon.id) continue;
            const kind = NPC_KINDS[quest.mob] || NPC_KINDS[dungeon.mob] || NPC_KINDS.spider;
            const boss = {
                id: 'db-' + quest.id,
                dungeonId: dungeon.id,
                questId: quest.id,
                pinned: true,
                x: endWorld.x,
                z: endWorld.z,
                homeX: endWorld.x,
                homeZ: endWorld.z,
                zx: 0,
                zz: 0,
                kind: kind.id,
                name: quest.named || kind.name,
                tint: kind.tint,
                loot: kind.loot,
                level: Math.max(dungeon.level, quest.minLevel || 1),
                alive: true,
                aggroId: null,
                attackAt: 0
            };
            applyElite(boss, !!quest.elite, 0);
            boss.boss = true;
            boss.loot = 'boss';
            pickWander(boss);
            npcs.set(boss.id, boss);
        }
        const hasBoss = Array.from(npcs.values()).some(npc => npc.dungeonId === dungeon.id && npc.boss);
        if (!hasBoss) {
            const kind = NPC_KINDS[dungeon.mob] || NPC_KINDS.knight;
            const warden = {
                id: 'db-end-' + dungeon.id,
                dungeonId: dungeon.id,
                boss: true,
                pinned: true,
                x: endWorld.x,
                z: endWorld.z,
                homeX: endWorld.x,
                homeZ: endWorld.z,
                zx: 0,
                zz: 0,
                kind: kind.id,
                name: dungeon.endName || 'Warden',
                tint: kind.tint,
                loot: 'boss',
                level: dungeon.level + 1,
                alive: true,
                aggroId: null,
                attackAt: 0
            };
            applyElite(warden, true, 0);
            pickWander(warden);
            npcs.set(warden.id, warden);
        }
    }
}

function routeRemain(samples, index) {
    let left = 0;
    for (let i = index + 1; i < samples.length; i++) {
        left += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
    }
    return left;
}

function parseCost(value) {
    const cost = {};
    const write = (kind, qty) => {
        const name = String(kind || '').trim().toLowerCase();
        const n = Math.round(Number(qty) || 0);
        if (!/^[a-z]{2,16}$/.test(name) || n <= 0) return;
        cost[name] = Math.min(99, n);
    };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [kind, qty] of Object.entries(value)) write(kind, qty);
        return cost;
    }
    for (const part of String(value || '').split(',')) {
        const bit = part.trim();
        if (!bit) continue;
        if (bit.includes(':')) {
            const [kind, qty] = bit.split(':');
            write(kind, qty);
            continue;
        }
        const leading = bit.match(/^(\d+)\s+([a-z]+)$/i);
        const trailing = bit.match(/^([a-z]+)\s+(\d+)$/i);
        if (leading) write(leading[2], leading[1]);
        else if (trailing) write(trailing[1], trailing[2]);
    }
    return cost;
}

function sheetFlag(value) {
    if (value === true || value === 1) return true;
    const text = String(value || '').trim().toLowerCase();
    return text === 'yes' || text === 'true' || text === '1' || text === 'y';
}

const ITEM_KINDS = ['armor', 'weapon', 'health', 'mana', 'bomb', 'junk'];
const ITEM_SLOTS = ['', 'head', 'neck', 'shoulders', 'cloak', 'chest', 'hands', 'waist', 'legs', 'feet', 'weapon', 'offhand'];
const ITEM_STYLES = ['', 'cloth', 'leather', 'plate'];

function sanitizeItems(input) {
    if (!Array.isArray(input)) return null;
    const out = [];
    const seen = new Set();
    for (const raw of input.slice(0, 200)) {
        if (!raw || typeof raw !== 'object') continue;
        let id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
        if (!/^[a-z0-9-]{2,32}$/.test(id)) {
            id = String(raw.name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'item';
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const kind = ITEM_KINDS.includes(raw.kind) ? raw.kind : 'armor';
        let slot = ITEM_SLOTS.includes(raw.slot) ? raw.slot : '';
        if (!slot && kind === 'weapon') slot = 'weapon';
        const style = ITEM_STYLES.includes(raw.style) ? raw.style : '';
        const weapon = raw.weapon === 'staff' || raw.weapon === 'sword' || raw.weapon === 'bow' || raw.weapon === 'wand' ? raw.weapon : (kind === 'weapon' ? 'sword' : '');
        let set = String(raw.set || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 24);
        if (!set) set = kind === 'health' || kind === 'mana' ? 'alchemy' : kind === 'bomb' ? 'explosive' : kind === 'weapon' ? 'weapon' : 'cloth';
        out.push({
            id,
            name: String(raw.name || id).slice(0, 32),
            set,
            kind,
            slot,
            style,
            weapon,
            armor: clampNum(raw.armor, 0, 0, 40),
            amount: clampNum(raw.amount, 0, 0, 200),
            magic: sheetFlag(raw.magic),
            loot: sheetFlag(raw.loot),
            cost: parseCost(raw.cost),
            icon: iconKeyFromChoice(raw.icon).slice(0, 32),
            stats: cleanStats({
                strength: raw.strength != null && raw.strength !== '' ? raw.strength : (raw.stats && raw.stats.strength),
                stamina: raw.stamina != null && raw.stamina !== '' ? raw.stamina : (raw.stats && raw.stats.stamina),
                intellect: raw.intellect != null && raw.intellect !== '' ? raw.intellect : (raw.stats && raw.stats.intellect)
            }),
            reqLevel: clampNum(raw.reqLevel, 1, 1, 30),
            statsSet: true
        });
    }
    return out;
}

function installItems(list) {
    for (const key of Object.keys(RECIPES)) delete RECIPES[key];
    for (const row of list) {
        RECIPES[row.id] = {
            name: row.name,
            set: row.set,
            slot: row.slot,
            kind: row.kind,
            style: row.style,
            armor: row.armor,
            weapon: row.weapon,
            magic: row.magic,
            loot: row.loot,
            amount: row.amount,
            cost: row.cost,
            icon: row.icon,
            stats: row.stats,
            reqLevel: row.reqLevel,
            statsSet: true
        };
        if (!CRAFT_SETS[row.set]) {
            CRAFT_SETS[row.set] = {
                name: row.set.charAt(0).toUpperCase() + row.set.slice(1),
                cost: 20,
                rarity: 2,
                text: 'Added from the item sheet.'
            };
        }
    }
}

function costText(cost) {
    if (!cost || typeof cost !== 'object') return '';
    return Object.entries(cost).filter(([, qty]) => qty > 0).map(([kind, qty]) => kind + ':' + qty).join(', ');
}

function itemRecords() {
    return Object.entries(RECIPES).map(([id, recipe]) => {
        const made = statsForRecipe(recipe);
        return {
            id,
            name: recipe.name,
            set: recipe.set,
            kind: recipe.kind,
            slot: recipe.slot || '',
            style: recipe.style || '',
            weapon: recipe.weapon || '',
            armor: recipe.armor || 0,
            amount: recipe.amount || 0,
            magic: !!recipe.magic,
            loot: !!recipe.loot,
            cost: costText(recipe.cost),
            strength: made.stats.strength || 0,
            stamina: made.stats.stamina || 0,
            intellect: made.stats.intellect || 0,
            reqLevel: made.reqLevel || 1,
            icon: recipe.icon || defaultIconName(recipe)
        };
    });
}

function sanitizeWorld(input) {
    const src = input && typeof input === 'object' ? input : {};
    return {
        hpBase: clampNum(src.hpBase, 6, 1, 80),
        hpPerLevel: clampNum(src.hpPerLevel, 4, 0, 40),
        grayLevels: clampNum(src.grayLevels, 5, 1, 20),
        xpPerMobLevel: clampNum(src.xpPerMobLevel, 20, 0, 100),
        spawnPerMin: clampNum(src.spawnPerMin, 4, 0, 30),
        spawnCap: clampNum(src.spawnCap, 8, 0, 40),
        adminPassword: typeof src.adminPassword === 'string' ? src.adminPassword.slice(0, 64) : '',
        loot: sanitizeLoot(src.loot),
        zones: Array.isArray(src.zones) ? src.zones : [],
        roads: sanitizeRoads(src.roads),
        bounds: sanitizeBounds(src.bounds),
        dungeons: sanitizeDungeons(src.dungeons),
        quests: sanitizeQuests(src.quests),
        items: sanitizeItems(src.items),
        sheetUrl: cleanSheetUrl(src.sheetUrl)
    };
}

function adminPassword() {
    if (process.env.ADMIN_PASSWORD) return String(process.env.ADMIN_PASSWORD);
    if (worldConfig && worldConfig.adminPassword) return worldConfig.adminPassword;
    return 'admin';
}

function publicWorld() {
    return {
        hpBase: worldRules.hpBase,
        hpPerLevel: worldRules.hpPerLevel,
        grayLevels: worldRules.grayLevels,
        xpPerMobLevel: worldRules.xpPerMobLevel,
        spawnPerMin: worldRules.spawnPerMin,
        spawnCap: worldRules.spawnCap,
        bounds: worldShape(),
        zones: listDesignedZones(),
        roads: listRoads(),
        dungeons: listDungeons(),
        quests: (worldConfig && worldConfig.quests) || [],
        items: itemRecords()
    };
}

function applyLoaded(config) {
    worldRules.hpBase = config.hpBase;
    worldRules.hpPerLevel = config.hpPerLevel;
    worldRules.grayLevels = config.grayLevels;
    worldRules.xpPerMobLevel = config.xpPerMobLevel;
    worldRules.spawnPerMin = config.spawnPerMin;
    worldRules.spawnCap = config.spawnCap;
    applyWorldConfig(config);
    lootTables = config.loot;
    if (Array.isArray(config.items) && config.items.length) installItems(config.items);
    worldConfig = { ...config, zones: listDesignedZones(), bounds: worldShape(), loot: lootTables, quests: config.quests || [], dungeons: listDungeons(), items: itemRecords() };
    rebuildCivilians();
    installQuests(config.quests || []);
    npcs.clear();
    zoneSpawns.clear();
    refreshNpcZones();
    spawnDungeonMobs();
}

function loadWorldFile() {
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
    } catch { /* first run */ }
    const next = sanitizeWorld(parsed || {});
    if (parsed && typeof parsed.adminPassword === 'string') next.adminPassword = parsed.adminPassword.slice(0, 64);
    if (parsed && typeof parsed.sheetToken === 'string' && /^[a-f0-9]{32}$/.test(parsed.sheetToken)) next.sheetToken = parsed.sheetToken;
    applyLoaded(next);
}

function saveWorldFile() {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(worldPath, JSON.stringify(worldConfig));
    } catch (err) {
        console.error('World save failed', err);
    }
}

function requireAdmin(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!adminTokens.has(token)) {
        res.status(401).json({ error: 'Login required' });
        return;
    }
    next();
}

app.post('/api/setup/login', (req, res) => {
    if (String((req.body && req.body.password) || '') !== adminPassword()) {
        res.status(401).json({ error: 'Wrong password' });
        return;
    }
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    adminTokens.add(token);
    res.json({ token, locked: !!process.env.ADMIN_PASSWORD });
});

app.get('/api/world', (req, res) => {
    res.json(publicWorld());
});

function cleanSheetUrl(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 400) return '';
    let url;
    try { url = new URL(text); } catch { return ''; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'docs.google.com') return '';
    const id = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/);
    if (!id) return '';
    return 'https://docs.google.com/spreadsheets/d/' + id[1] + '/edit';
}

function setupPayload() {
    return { ...publicWorld(), loot: lootTables, locked: !!process.env.ADMIN_PASSWORD, sheetUrl: (worldConfig && worldConfig.sheetUrl) || '' };
}

function ensureSheetToken() {
    const current = worldConfig && worldConfig.sheetToken;
    if (typeof current === 'string' && /^[a-f0-9]{32}$/.test(current)) return current;
    worldConfig.sheetToken = crypto.randomBytes(16).toString('hex');
    saveWorldFile();
    return worldConfig.sheetToken;
}

function workbookBytes() {
    return buildWorkbook(workbookSource());
}

function workbookSource() {
    const items = itemRecords();
    const sets = new Set(['cloth', 'leather', 'plate', 'weapon', 'magic', 'alchemy', 'explosive']);
    for (const item of items) if (item.set) sets.add(String(item.set));
    return {
        items,
        quests: (worldConfig && worldConfig.quests) || [],
        zones: listDesignedZones(),
        dungeons: listDungeons(),
        lists: {
            kind: ['armor', 'weapon', 'health', 'mana', 'bomb', 'junk'],
            slot: ['head', 'neck', 'shoulders', 'cloak', 'chest', 'hands', 'waist', 'legs', 'feet', 'weapon', 'offhand'],
            style: ['cloth', 'leather', 'plate'],
            weapon: ['sword', 'staff'],
            set: [...sets],
            yes: ['yes', 'no'],
            type: ['kill', 'gather', 'named', 'protect'],
            mob: ['boar', 'wolf', 'spider', 'bandit', 'ogre', 'wisp', 'knight', 'cultist'],
            reward: ['junk', 'health', 'mana', 'cloth', 'leather', 'ore', 'gem', 'stone', 'herb', 'powder', 'silk', 'recipe', 'armor', 'bag'],
            role: ['inn', 'shop', 'trainer', 'quest']
        }
    };
}

async function fetchSpreadsheet(start) {
    let current = start;
    for (let hop = 0; hop < 5; hop++) {
        if (current.protocol !== 'https:' || blockedHost(current.hostname)) throw new Error('That link cannot be used');
        const response = await fetch(current, {
            redirect: 'manual',
            headers: { 'user-agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(20000)
        });
        if (response.status >= 300 && response.status < 400) {
            if (response.body && response.body.cancel) await response.body.cancel();
            const loc = response.headers.get('location');
            if (!loc) throw new Error('The spreadsheet link did not open');
            current = new URL(loc, current);
            continue;
        }
        if (!response.ok) throw new Error('The spreadsheet link could not be opened');
        const len = Number(response.headers.get('content-length') || 0);
        if (len > 8 * 1024 * 1024) throw new Error('That spreadsheet is too large');
        const buf = new Uint8Array(await response.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) throw new Error('That spreadsheet is too large');
        if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('That link did not return a spreadsheet. Share the Google Sheet as anyone with the link.');
        return buf;
    }
    throw new Error('The spreadsheet link redirected too many times');
}

function blockedHost(host) {
    const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!name || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name === 'metadata.google.internal' || name === '::1') return true;
    const parts = name.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!parts) return false;
    const n = parts.slice(1).map(Number);
    if (n[0] === 0 || n[0] === 10 || n[0] === 127) return true;
    if (n[0] === 169 && n[1] === 254) return true;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
    if (n[0] === 192 && n[1] === 168) return true;
    if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true;
    return false;
}

app.get('/api/setup/sheet.xlsx', requireAdmin, (req, res) => {
    try {
        const bytes = workbookBytes();
        res.set('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('content-disposition', 'attachment; filename="quests-and-items.xlsx"');
        res.set('cache-control', 'no-store');
        res.send(Buffer.from(bytes));
    } catch (err) {
        res.status(500).json({ error: 'The spreadsheet could not be built' });
    }
});

app.get('/api/setup/rows', requireAdmin, (req, res) => {
    try {
        res.set('cache-control', 'no-store');
        res.json(clipboardSheets(workbookSource()));
    } catch (err) {
        res.status(500).json({ error: 'The rows could not be built' });
    }
});

app.get('/sheet/:token', (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token) || !worldConfig || token !== worldConfig.sheetToken) {
        res.status(404).type('text/plain').send('Not found');
        return;
    }
    try {
        const bytes = workbookBytes();
        res.set('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('content-disposition', 'attachment; filename="quests-and-items.xlsx"');
        res.set('cache-control', 'no-store');
        res.send(Buffer.from(bytes));
    } catch (err) {
        res.status(500).json({ error: 'The spreadsheet could not be built' });
    }
});

app.get('/api/setup/config', requireAdmin, (req, res) => {
    res.json(setupPayload());
});

app.put('/api/setup/config', requireAdmin, (req, res) => {
    const next = sanitizeWorld(req.body || {});
    next.adminPassword = worldConfig.adminPassword || '';
    next.sheetToken = worldConfig.sheetToken || '';
    applyLoaded(next);
    saveWorldFile();
    broadcast({
        type: 'world',
        world: publicWorld(),
        civilians: CIVILIANS.map(publicCivilian),
        camps: campSites(),
        npcs: Array.from(npcs.values()).filter(npc => npc.alive).map(publicNpc),
        questDefs: publicQuests(),
        craft: publicCraft()
    });
    res.json({ ok: true, config: setupPayload() });
});

app.post('/api/setup/sheet', requireAdmin, async (req, res) => {
    try {
        const target = spreadsheetUrl(req.body && req.body.url);
        const bytes = await fetchSpreadsheet(target);
        const parsed = await readWorkbook(bytes);
        res.json({ items: parsed.items, quests: parsed.quests });
    } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        res.status(400).json({ error: timedOut ? 'The spreadsheet link timed out' : (err.message || 'That spreadsheet could not be read') });
    }
});

app.post('/api/setup/password', requireAdmin, (req, res) => {
    if (process.env.ADMIN_PASSWORD) {
        res.status(400).json({ error: 'Password is set by ADMIN_PASSWORD' });
        return;
    }
    const password = String((req.body && req.body.password) || '');
    if (password.length < 4) {
        res.status(400).json({ error: 'Use at least 4 characters' });
        return;
    }
    worldConfig.adminPassword = password.slice(0, 64);
    saveWorldFile();
    res.json({ ok: true });
});

loadWorldFile();

server.listen(PORT, () => {
    console.log(`Open World server running on http://0.0.0.0:${PORT}`);
    console.log('World setup page: /setup');
});
