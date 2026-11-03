import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chunkResources, zoneAt, zoneNpc, zoneCamp, zoneCampPlan, campSpot, zoneInWorld, clampWorld, sellPrice, fogCellsAround, terrainHeight, designedZoneAt, listDesignedZones, applyWorldConfig, worldShape, boundaryInset, blocksClimb, swimTooFar, customMap, waterAt, ZONE_SIZE, WORLD_RADIUS } from './worldgen.js';

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
    { id: 'mira', name: 'Mira', role: 'shop', title: 'Shop assistant', tint: '#f1c40f', x: 10, z: 4, text: 'I buy what you carry and sell crafting skills. Bring coins.' },
    { id: 'bram', name: 'Bram', role: 'trainer', title: 'Trainer', tint: '#5dade2', x: -10, z: 4, text: 'Choose a class, then train your spells with me.' },
    { id: 'sela', name: 'Sela', role: 'quest', title: 'Quest giver', tint: '#2ecc71', x: 0, z: 14, text: 'The boars are tearing up the glade.', quest: 'boar-tusks' },
    { id: 'holt', name: 'Holt', role: 'inn', title: 'Innkeeper', tint: '#e67e22', x: GLADE_INN.x, z: GLADE_INN.z, text: 'I keep the inn. You can set your spawn here.' }
];

function pushCampRole(list, camp, zone, index, role, title, tint, text) {
    const name = camp[role];
    if (!name) return;
    const spot = campSpot(camp.layout, role, camp.x, camp.z);
    if (!onLand(spot.x, spot.z)) return;
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
    const home = CIVILIANS.filter(civ => civ.id === 'mira' || civ.id === 'bram' || civ.id === 'sela' || civ.id === 'holt');
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
            if (!onLand(camp.x, camp.z)) return;
            pushCampRole(CIVILIANS, camp, zone, index, 'inn', 'Innkeeper', '#e67e22', 'I keep the inn in ' + zone.name + '. You can set your spawn here.');
            pushCampRole(CIVILIANS, camp, zone, index, 'shop', 'Shop', '#f1c40f', 'I buy and sell in ' + zone.name + '.');
            pushCampRole(CIVILIANS, camp, zone, index, 'trainer', 'Trainer', '#5dade2', 'I train spells in ' + zone.name + '.');
            pushCampRole(CIVILIANS, camp, zone, index, 'quest', 'Quest giver', '#2ecc71', 'I keep the road through ' + zone.name + '.');
        });
    }
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
            if (!onLand(camp.x, camp.z)) return;
            sites.push({ id: 'dcamp-' + zone.id + '-' + index, x: camp.x, z: camp.z, layout: camp.layout || 'hamlet' });
        });
    }
    return sites;
}

rebuildCivilians();

function publicCivilian(civ) {
    const quests = Array.isArray(civ.quests) ? civ.quests : (civ.quest ? [civ.quest] : []);
    return { id: civ.id, name: civ.name, role: civ.role, title: civ.title, tint: civ.tint, x: civ.x, z: civ.z, text: civ.text, quest: quests[0] || '', quests };
}

const QUEST_TYPES = ['kill', 'gather', 'named', 'protect'];
const MOB_IDS = ['boar', 'wolf', 'spider', 'bandit', 'ogre', 'wisp', 'knight', 'cultist'];

function questBlurb(quest) {
    if (quest.custom && quest.text) return quest.text;
    const mob = NPC_KINDS[quest.mob];
    const label = mob ? mob.name : 'creature';
    const many = quest.count === 1 ? label : label + 's';
    if (quest.type === 'gather') {
        const who = quest.named || many;
        return 'Gather ' + quest.count + ' ' + (quest.item || 'items') + '. ' + who + ' drop them.';
    }
    if (quest.type === 'named') return 'Kill ' + (quest.named || label) + '.';
    if (quest.type === 'protect') return 'Protect ' + (quest.named || 'the villager') + '. Defeat ' + quest.count + ' attackers.';
    return 'Kill ' + quest.count + ' ' + many + '.';
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
    }
};

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
        } else if (quest.type === 'gather' && quest.item && (namedHit || (!quest.named && kindHit))) {
            const leftover = addToSlots(player, { kind: 'quest', name: quest.item, qty: 1 });
            if (leftover) player.questNote = 'Bag full';
            else {
                row.count += 1;
                changed = true;
                item = true;
            }
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
    if (zoneId && role && Number.isInteger(camp)) {
        const exact = CIVILIANS.find(civ => civ.id === 'd' + role + '-' + zoneId + '-' + camp);
        if (exact) return exact;
    }
    if (zoneId && name) {
        const inZone = CIVILIANS.find(civ => civ.id.includes('-' + zoneId + '-') && civ.name.toLowerCase() === name.toLowerCase() && (!role || civ.role === role));
        if (inZone) return inZone;
    }
    return null;
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
    }
    for (const quest of list || []) {
        QUESTS[quest.id] = { ...quest, designed: true, guardHp: 0, guardMax: 0 };
    }
    bindQuestGivers();
}

function giverOf(quest) {
    return civInZone(quest.zoneId, quest.giverRole, quest.giverCamp, quest.giver)
        || CIVILIANS.find(civ => civ.name.toLowerCase() === String(quest.giver || '').toLowerCase())
        || null;
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
    npc.maxHp = npcMaxHp(npc.level);
    npc.hp = npc.maxHp;
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
        npc.maxHp = bonusHp > 0 ? bonusHp : npcMaxHp(level);
        npc.hp = npc.maxHp;
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
            if (!someoneNeeds(id)) continue;
            const civ = protectTarget(quest);
            if (!civ) continue;
            if (!quest.guardMax) quest.guardMax = 50 + quest.count * 20;
            if (!quest.guardHp) quest.guardHp = quest.guardMax;
            const alive = [...npcs.values()].filter(npc => npc.questId === id && (npc.alive || npc.respawnAt > now));
            for (let i = alive.length; i < quest.count; i++) {
                const spot = spotNear(civ.x, civ.z, i + 1);
                spawnQuestMob(quest, id, i, spot.x, spot.z, civ.id);
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

function maxHpFor(level) {
    return 20 + (level - 1) * 4;
}

function npcMaxHp(level) {
    return Math.max(1, worldRules.hpBase + level * worldRules.hpPerLevel);
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
        corpse: p.corpse || null
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
        tint: n.tint
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
        npc.maxHp = drawn.hp > 0 ? drawn.hp : npcMaxHp(npc.level);
    }
    npc.hp = npc.maxHp;
    npc.alive = true;
    npc.aggroId = null;
    npc.homeX = npc.x;
    npc.homeZ = npc.z;
    npc.attackAt = 0;
    pickWander(npc);
}

function pickWander(npc) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 4 + Math.random() * 14;
    const next = clampToZone(npc, npc.homeX + Math.cos(angle) * dist, npc.homeZ + Math.sin(angle) * dist);
    npc.wanderX = next.x;
    npc.wanderZ = next.z;
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
    player.corpse = { x: player.x, z: player.z };
    const home = player.spawn || mapSpawn();
    player.hp = 0;
    player.x = home.x;
    player.y = 0;
    player.z = home.z;
    player.invulnUntil = now + 1500;
    const revealed = revealFog(player);
    if (revealed.length) send(player.ws, { type: 'fog', add: revealed });
    send(player.ws, { type: 'died', x: player.x, y: 0, z: player.z, corpse: player.corpse, ...statsOf(player) });
    broadcast({ type: 'ghost', ...publicPlayer(player.persistentId, player) });
}

function nearestPlayer(npc, range) {
    let best = null;
    let bestD = range * range;
    for (const player of players.values()) {
        if (player.hp <= 0 || player.ghost) continue;
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

function maxManaFor(player) {
    return 10 + ((player.level || 1) - 1) * 4 + talentRank(player, 'meditation') * 2;
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
    return worldRules.xpPerMobLevel * npc.level;
}

function grantXp(player, amount) {
    player.xp += amount;
    let leveled = false;
    while (player.xp >= xpToNext(player.level)) {
        player.xp -= xpToNext(player.level);
        player.level += 1;
        player.maxHp = maxHpFor(player.level);
        player.maxMana = maxManaFor(player);
        player.hp = player.maxHp;
        player.mana = player.maxMana;
        leveled = true;
    }
    savePlayer(player);
    return leveled;
}

function statsOf(player) {
    return {
        level: player.level,
        xp: player.xp,
        xpToNext: xpToNext(player.level),
        hp: player.hp,
        maxHp: player.maxHp,
        mana: Math.floor(player.mana),
        maxMana: player.maxMana,
        armor: player.armor
    };
}

const parties = new Map();
const partyInvites = new Map();
let partySeq = 1;
const PARTY_MAX = 5;
const PARTY_RANGE = 30;

function partyOf(player) {
    if (!player || !player.partyId) return null;
    return parties.get(player.partyId) || null;
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
                hp: member ? member.hp : 0,
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
            return [member.hp, Math.floor(member.mana), member.maxHp, member.maxMana, member.ghost ? 1 : 0, member.name].join(':');
        }).join('|');
        if (sig === party.sig) continue;
        party.sig = sig;
        sendParty(party);
    }
}

const ABILITIES = {
    sword: { weapon: 'sword', mana: 2, range: 2.6, damage: (level) => 4 + level },
    'power-strike': { weapon: 'sword', mana: 6, range: 2.6, damage: (level) => 8 + level * 2 },
    cleave: { weapon: 'sword', mana: 5, range: 2.6, damage: (level) => 6 + level },
    'arcane-bolt': { weapon: 'staff', mana: 5, range: 8, damage: (level) => 6 + level },
    'arcane-surge': { weapon: 'staff', mana: 8, range: 8, damage: (level) => 12 + level * 2 },
    mend: { weapon: 'staff', mana: 4, range: 0, heal: (level) => 8 + level * 2 }
};

const BAR_PAGES = 3;
const BAR_SLOTS = 8;
const ACTION_IDS = new Set(['sword', 'power-strike', 'cleave', 'staff', 'arcane-bolt', 'arcane-surge', 'mend', 'gather', 'health', 'mana', 'bomb']);

function defaultActionBar() {
    return [
        ['sword', 'power-strike', 'gather', null, null, null, null, null],
        ['staff', 'arcane-bolt', 'mend', null, null, null, null, null],
        [null, null, null, null, null, null, null, null]
    ];
}

function sanitizeActionBar(pages) {
    const bar = defaultActionBar();
    if (!Array.isArray(pages)) return bar;
    for (let p = 0; p < BAR_PAGES; p++) {
        const row = pages[p];
        if (!Array.isArray(row)) continue;
        for (let i = 0; i < BAR_SLOTS; i++) {
            bar[p][i] = ACTION_IDS.has(row[i]) ? row[i] : null;
        }
    }
    return bar;
}

const EQUIP_SLOTS = ['head', 'neck', 'shoulders', 'cloak', 'chest', 'hands', 'waist', 'legs', 'feet', 'weapon', 'offhand'];
const CLASS_KITS = {
    warrior: {
        weapon: { kind: 'weapon', weapon: 'sword', name: 'Worn Sword', qty: 1, armor: 0, amount: 0, slot: 'weapon' },
        trained: ['sword', 'power-strike']
    },
    mage: {
        weapon: { kind: 'weapon', weapon: 'staff', name: 'Apprentice Staff', qty: 1, armor: 0, amount: 0, slot: 'weapon' },
        trained: ['staff', 'arcane-bolt']
    }
};
const SPELLS = {
    sword: { class: 'warrior', name: 'Sword', level: 1, cost: 0 },
    'power-strike': { class: 'warrior', name: 'Power Strike', level: 1, cost: 0 },
    cleave: { class: 'warrior', name: 'Cleave', level: 4, cost: 20, talent: 'cleave' },
    staff: { class: 'mage', name: 'Staff', level: 1, cost: 0 },
    'arcane-bolt': { class: 'mage', name: 'Arcane Missile', level: 1, cost: 0, maxRank: 3, rankCost: 12 },
    mend: { class: 'mage', name: 'Mend', level: 2, cost: 15 },
    'arcane-surge': { class: 'mage', name: 'Arcane Surge', level: 4, cost: 25, talent: 'surge' }
};
const TALENTS = {
    toughness: { class: 'warrior', name: 'Toughness', max: 3, row: 0, requires: null, text: '+1 armor per rank' },
    might: { class: 'warrior', name: 'Might', max: 3, row: 1, requires: { toughness: 1 }, text: '+1 melee damage per rank' },
    cleave: { class: 'warrior', name: 'Cleave', max: 1, row: 2, requires: { might: 2 }, text: 'Unlocks Cleave' },
    meditation: { class: 'mage', name: 'Meditation', max: 3, row: 0, requires: null, text: '+2 max mana per rank' },
    'arcane-power': { class: 'mage', name: 'Arcane Power', max: 3, row: 1, requires: { meditation: 1 }, text: '+1 spell damage per rank' },
    surge: { class: 'mage', name: 'Surge', max: 1, row: 2, requires: { 'arcane-power': 2 }, text: 'Unlocks Arcane Surge' }
};

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
    'heavy-bomb': { name: 'Heavy Bomb', set: 'explosive', kind: 'bomb', amount: 28, cost: { powder: 3, ore: 1 }, loot: true }
};

const CRAFT_SETS = {
    cloth: { name: 'Clothworking', cost: 12, rarity: 1, text: 'Hat, robe, gloves, pants, and shoes.' },
    leather: { name: 'Leatherworking', cost: 20, rarity: 2, text: 'Cap, jerkin, gloves, pants, and boots.' },
    plate: { name: 'Armorsmithing', cost: 30, rarity: 3, text: 'Helm, breastplate, gauntlets, greaves, and sabatons.' },
    weapon: { name: 'Weaponsmithing', cost: 16, rarity: 1, text: 'Iron sword and oak staff.' },
    magic: { name: 'Spellforging', cost: 28, rarity: 4, text: 'Rune blade and arcane staff.' },
    alchemy: { name: 'Alchemy', cost: 18, rarity: 2, text: 'Health and mana potions from herbs.' },
    explosive: { name: 'Explosives', cost: 22, rarity: 2, text: 'Bombs from powder and stone.' }
};

const MAX_CRAFT_SKILLS = 2;

const MATERIAL_NAMES = { cloth: 'Cloth', leather: 'Leather', ore: 'Ore', gem: 'Gem', wood: 'Wood', stone: 'Stone', herb: 'Herb', powder: 'Powder' };
const LOOT_RECIPE_IDS = Object.keys(RECIPES).filter(id => RECIPES[id].loot);

function publicCraft() {
    const recipes = {};
    for (const [id, recipe] of Object.entries(RECIPES)) {
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
            loot: !!recipe.loot
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
    if (prof.class !== 'warrior' && prof.class !== 'mage') prof.class = null;
    prof.trained = Array.isArray(prof.trained) ? prof.trained.filter(id => SPELLS[id]) : [];
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
    const rawRanks = prof.spellRanks && typeof prof.spellRanks === 'object' ? prof.spellRanks : {};
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
    loadQuests(prof);
}

function armorValue(player) {
    let total = talentRank(player, 'toughness');
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
    player.armor = armorValue(player);
    player.maxMana = maxManaFor(player);
    if (player.mana > player.maxMana) player.mana = player.maxMana;
}

function talentPoints(player) {
    const spent = Object.values(player.talents || {}).reduce((sum, rank) => sum + rank, 0);
    return Math.max(0, (player.level || 1) - 1 - spent);
}

function knownSpells(player) {
    if (!player.class) return ['sword', 'power-strike', 'staff', 'arcane-bolt', 'mend', 'gather'];
    const known = ['gather'];
    for (const id of player.trained) {
        const spell = SPELLS[id];
        if (!spell || spell.class !== player.class) continue;
        if (spell.talent && talentRank(player, spell.talent) < 1) continue;
        known.push(id);
    }
    return known;
}

function publicCharacter(player) {
    return {
        class: player.class,
        equipment: player.equipment,
        trained: player.trained,
        talents: player.talents,
        spellRanks: player.spellRanks || {},
        recipes: player.recipes || [],
        craft: publicCraft(),
        points: talentPoints(player),
        known: knownSpells(player),
        spells: SPELLS,
        talentsDef: TALENTS
    };
}

const MATERIAL_KINDS = ['wood', 'stone', 'cloth', 'leather', 'ore', 'gem', 'herb', 'powder'];

function blankMaterials() {
    return { wood: 0, stone: 0, cloth: 0, leather: 0, ore: 0, gem: 0, herb: 0, powder: 0 };
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
    const ids = Object.keys(RECIPES).filter(id => RECIPES[id].set === setId && !RECIPES[id].loot);
    if (ids.every(id => player.recipes.includes(id))) return 'Already learned';
    if (!spendCoins(player, set.cost)) return 'Not enough coins';
    for (const id of ids) if (!player.recipes.includes(id)) player.recipes.push(id);
    savePlayer(player);
    return null;
}

function learnPattern(player, index) {
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
    savePlayer(player);
    return null;
}

function craftItem(player, id) {
    const recipe = RECIPES[id];
    if (!recipe) return 'Unknown recipe';
    if (!player.recipes.includes(id)) return 'Recipe not learned';
    for (const [kind, qty] of Object.entries(recipe.cost)) {
        if (countKind(player, kind) < qty) return 'Need ' + qty + ' ' + (MATERIAL_NAMES[kind] || kind);
    }
    normalizeSlots(player);
    if (!player.slots.some(slot => !slot)) return 'Inventory full';
    for (const [kind, qty] of Object.entries(recipe.cost)) takeKind(player, kind, qty);
    const rest = addToSlots(player, {
        kind: recipe.kind,
        name: recipe.name,
        qty: 1,
        armor: recipe.armor || 0,
        weapon: recipe.weapon || '',
        slot: recipe.slot || '',
        style: recipe.style || '',
        magic: !!recipe.magic,
        amount: recipe.amount || 0
    });
    if (rest) {
        for (const [kind, qty] of Object.entries(recipe.cost)) {
            addToSlots(player, { kind, name: MATERIAL_NAMES[kind] || kind, qty });
        }
        return 'Inventory full';
    }
    savePlayer(player);
    return null;
}

function chooseClass(player, className) {
    if (player.class) return 'Class already chosen';
    const kit = CLASS_KITS[className];
    if (!kit) return 'Unknown class';
    player.class = className;
    player.trained = kit.trained.slice();
    player.talents = {};
    player.spellRanks = {};
    for (const id of player.trained) player.spellRanks[id] = 1;
    player.equipment.weapon = copySlot(kit.weapon);
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function trainSpell(player, id) {
    const spell = SPELLS[id];
    if (!player.class) return 'Choose a class first';
    if (!spell || spell.class !== player.class) return 'Not for your class';
    if (spell.talent && talentRank(player, spell.talent) < 1) return 'Needs the talent';
    if (!player.spellRanks) player.spellRanks = {};
    const rank = player.trained.includes(id) ? (player.spellRanks[id] || 1) : 0;
    const maxRank = spell.maxRank || 1;
    if (rank >= maxRank) return 'Already trained';
    const next = rank + 1;
    if (player.level < spell.level + next - 1) return 'Requires level ' + (spell.level + next - 1);
    const cost = rank === 0 ? spell.cost : (spell.rankCost || spell.cost);
    if (!spendCoins(player, cost)) return 'Not enough coins';
    if (!player.trained.includes(id)) player.trained.push(id);
    player.spellRanks[id] = next;
    savePlayer(player);
    return null;
}

function spendTalent(player, id) {
    const def = TALENTS[id];
    if (!player.class) return 'Choose a class first';
    if (!def || def.class !== player.class) return 'Not for your class';
    const rank = talentRank(player, id);
    if (rank >= def.max) return 'Max rank';
    if (talentPoints(player) < 1) return 'No talent points';
    if (def.requires) {
        for (const [need, min] of Object.entries(def.requires)) {
            if (talentRank(player, need) < min) return 'Requires ' + TALENTS[need].name;
        }
    }
    player.talents[id] = rank + 1;
    if (id === 'cleave' && !player.trained.includes('cleave')) player.trained.push('cleave');
    if (id === 'surge' && !player.trained.includes('arcane-surge')) player.trained.push('arcane-surge');
    refreshDerived(player);
    savePlayer(player);
    return null;
}

function equipItem(player, equipSlot, bagIndex) {
    if (!EQUIP_SLOTS.includes(equipSlot)) return 'Bad slot';
    const item = player.slots[bagIndex];
    if (!item) return 'Empty slot';
    const fits = item.kind === 'weapon' ? 'weapon' : (item.slot || 'chest');
    if (item.kind !== 'weapon' && item.kind !== 'armor') return 'Cannot equip that';
    if (fits !== equipSlot) return 'Does not fit';
    if (!player.class) return 'Choose a class first';
    if (item.kind === 'weapon' && item.weapon !== CLASS_KITS[player.class].weapon.weapon) return 'Wrong class';
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

const BASE_SLOTS = 16;

function stackLimit(item) {
    if (item.kind === 'coins') return 99;
    if (item.kind === 'wood' || item.kind === 'stone' || item.kind === 'cloth' || item.kind === 'leather' || item.kind === 'ore') return 20;
    if (item.kind === 'junk' || item.kind === 'gem' || item.kind === 'recipe' || item.kind === 'quest') return 10;
    if (item.kind === 'health' || item.kind === 'mana' || item.kind === 'armor' || item.kind === 'bomb') return 5;
    return 1;
}

function sameStack(a, b) {
    return a && b && a.kind === b.kind && a.name === b.name && (a.amount || 0) === (b.amount || 0) && (a.armor || 0) === (b.armor || 0) && (a.slot || '') === (b.slot || '') && (a.weapon || '') === (b.weapon || '');
}

function slotCapacity(player) {
    return BASE_SLOTS + (player.bagSlots || 0);
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
            recipe: source.recipe || ''
        };
        qty -= take;
        if (qty <= 0) return null;
    }
    return { kind: source.kind, name: source.name, qty, amount: source.amount || 0, armor: source.armor || 0, weapon: source.weapon || '', slot: source.slot || '', style: source.style || '', magic: !!source.magic, recipe: source.recipe || '' };
}

function copySlot(slot) {
    if (!slot) return null;
    return { kind: slot.kind, name: slot.name, qty: slot.qty || 1, amount: slot.amount || 0, armor: slot.armor || 0, weapon: slot.weapon || '', slot: slot.slot || '', style: slot.style || '', magic: !!slot.magic, recipe: slot.recipe || '' };
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
}

function loadInventory(prof) {
    const player = {
        bagSlots: prof.bagSlots || 0,
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
    prof.coins = player.coins;
    prof.materials = player.materials;
    prof.wood = 0;
    prof.stone = 0;
    prof.junk = 0;
    prof.healthPotions = [];
    prof.manaPotions = [];
}

function inventoryOf(player) {
    return {
        slots: player.slots,
        capacity: slotCapacity(player),
        bagSlots: player.bagSlots || 0,
        baseSlots: BASE_SLOTS,
        coins: player.coins || 0,
        materials: player.materials || blankMaterials()
    };
}

function savePlayer(player) {
    const prof = save.players[player.persistentId];
    prof.slots = player.slots;
    prof.bagSlots = player.bagSlots || 0;
    prof.armor = player.armor;
    prof.legacyArmor = player.legacyArmor || 0;
    prof.class = player.class || null;
    prof.equipment = player.equipment;
    prof.trained = player.trained;
    prof.talents = player.talents;
    prof.spellRanks = player.spellRanks || {};
    prof.recipes = player.recipes || [];
    prof.quests = player.quests || {};
    prof.spawn = player.spawn || mapSpawn();
    prof.level = player.level;
    prof.xp = player.xp;
    prof.coins = player.coins || 0;
    prof.materials = player.materials || blankMaterials();
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
        { kind: 'cloth', weight: 30 },
        { kind: 'herb', weight: 16 },
        { kind: 'junk', weight: 18, names: ['Webbing', 'Dried silk', 'Chitin'] },
        { kind: 'mana', weight: 16 },
        { kind: 'coins', weight: 12 },
        { kind: 'recipe', weight: 12, sets: ['cloth'] },
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

function lootItem(row, level) {
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
    if (kind === 'stone' || kind === 'herb' || kind === 'powder') return { kind, name: MATERIAL_NAMES[kind], qty: 1 + Math.floor(level / 3) };
    if (kind === 'cloth' || kind === 'leather' || kind === 'ore' || kind === 'gem') {
        return { kind, name: MATERIAL_NAMES[kind], qty: kind === 'gem' ? 1 : 1 + Math.floor(level / 2) };
    }
    if (kind === 'recipe') {
        let ids = LOOT_RECIPE_IDS;
        if (row.sets) ids = ids.filter(id => row.sets.includes(RECIPES[id].set));
        if (!ids.length) ids = LOOT_RECIPE_IDS;
        const id = ids[Math.floor(Math.random() * ids.length)];
        return { kind: 'recipe', name: 'Pattern: ' + RECIPES[id].name, qty: 1, recipe: id };
    }
    const wear = ['head', 'shoulders', 'chest', 'hands', 'legs', 'feet'][Math.floor(Math.random() * 6)];
    const wearName = { head: 'Plate Helm', shoulders: 'Plate Pauldrons', chest: 'Plate Scrap', hands: 'Plate Gauntlets', legs: 'Plate Greaves', feet: 'Plate Sabatons' };
    return { kind: 'armor', slot: wear, style: 'plate', name: wearName[wear], qty: 1, armor: 1 + Math.floor((level - 1) / 2) };
}

function rollLoot(level, tableId) {
    const tables = lootTables || LOOT_TABLES;
    const table = tables[tableId] || tables.hide || LOOT_TABLES.hide;
    const count = 1 + Math.floor((level - 1) / 2) + (Math.random() < 0.5 ? 1 : 0);
    const items = [];
    for (let i = 0; i < count; i++) items.push(lootItem(rollRow(table), level));
    return items;
}

const chests = new Map();
let chestSeq = 1;

function publicChest(chest) {
    return { id: chest.id, x: chest.x, z: chest.z, level: chest.level, items: chest.items };
}

function spawnChest(npc) {
    const chest = {
        id: 'c' + (chestSeq++),
        x: npc.x,
        z: npc.z,
        level: npc.level,
        items: rollLoot(npc.level, npc.loot),
        spawnedAt: Date.now()
    };
    chests.set(chest.id, chest);
    broadcast({ type: 'chest', chest: publicChest(chest) });
    return chest;
}

function giveLoot(player, items) {
    const taken = [];
    const leftover = [];
    for (const item of items) {
        const qty = item.qty || 1;
        const rest = addToSlots(player, item);
        const left = rest ? rest.qty : 0;
        if (qty - left > 0) taken.push({ ...item, qty: qty - left });
        if (rest) leftover.push(rest);
    }
    if (taken.length) savePlayer(player);
    return { taken, leftover };
}

let lastNpcTick = Date.now();
let lastNpcBroadcast = 0;

function tickNpcs() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - lastNpcTick) / 1000);
    lastNpcTick = now;
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
            if (civ && quest && playerNear && !nearestPlayer(npc, AGGRO_RANGE)) {
                const dx = civ.x - npc.x;
                const dz = civ.z - npc.z;
                const dist = Math.hypot(dx, dz) || 0;
                npc.rotY = Math.atan2(dx, dz);
                if (dist <= 1.8) {
                    if (now >= npc.attackAt) {
                        npc.attackAt = now + 1500;
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
        const target = nearestPlayer(npc, AGGRO_RANGE);
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
        const dx = tx - npc.x;
        const dz = tz - npc.z;
        const dist = Math.hypot(dx, dz) || 0;
        if (target && dist <= NPC_HIT_RANGE) {
            npc.rotY = Math.atan2(dx, dz);
            if (now >= npc.attackAt && now >= target.invulnUntil) {
                npc.attackAt = now + 1300;
                const damage = Math.max(1, 1 + npc.level - target.armor);
                target.hp = Math.max(0, target.hp - damage);
                send(target.ws, { type: 'hurt', damage, attackerId: npc.id, attacker: npc.level, ...statsOf(target) });
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
        npc.rotY = Math.atan2(dx, dz);
    }

    for (const player of players.values()) {
        if (player.mana < player.maxMana) {
            player.mana = Math.min(player.maxMana, player.mana + dt * 1.5);
        }
        const shown = Math.floor(player.mana);
        if (shown !== player.manaShown && now - player.manaSent > 1000) {
            player.manaShown = shown;
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
        const living = [];
        for (const npc of npcs.values()) {
            if (npc.alive) living.push(publicNpc(npc));
        }
        if (wss.clients.size) broadcast({ type: 'npcs', npcs: living });
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
            prof.level = prof.level || 1;
            prof.xp = prof.xp || 0;
            prof.armor = prof.armor || 0;
            loadInventory(prof);
            loadCharacter(prof);
            prof.actionbar = sanitizeActionBar(prof.actionbar);

            const existing = players.get(persistentId);
            if (existing && existing.ws !== ws) {
                existing.ws._replaced = true;
                try { existing.ws.close(); } catch { /* already closing */ }
            }

            const spawn = readSpawn(prof);
            prof.spawn = spawn;
            const player = {
                ws,
                persistentId,
                x: spawn.x,
                y: 0,
                z: spawn.z,
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
                manaSent: 0,
                armor: 0,
                legacyArmor: prof.legacyArmor || 0,
                class: prof.class,
                equipment: Object.fromEntries(EQUIP_SLOTS.map(slot => [slot, prof.equipment[slot] ? copySlot(prof.equipment[slot]) : null])),
                trained: prof.trained.slice(),
                talents: { ...prof.talents },
                spellRanks: { ...prof.spellRanks },
                recipes: Array.isArray(prof.recipes) ? prof.recipes.slice() : [],
                quests: JSON.parse(JSON.stringify(prof.quests || {})),
                bagSlots: prof.bagSlots || 0,
                coins: prof.coins || 0,
                materials: Object.assign(blankMaterials(), prof.materials || {}),
                slots: prof.slots.map(copySlot),
                actionbar: prof.actionbar,
                invulnUntil: 0,
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
                npcs: Array.from(npcs.values()).filter(n => n.alive).map(publicNpc),
                civilians: CIVILIANS.map(publicCivilian),
                camps: campSites(),
                spawn: player.spawn,
                quests: player.quests,
                questDefs: publicQuests(),
                chests: Array.from(chests.values()).map(publicChest),
                actionbar: player.actionbar,
                character: publicCharacter(player),
                resources: save.resources,
                fog: Array.from(player.explored),
                players: Array.from(players.entries())
                    .filter(([pid]) => pid !== persistentId)
                    .map(([pid, p]) => publicPlayer(pid, p))
            });
            broadcast({ type: 'join', ...publicPlayer(persistentId, player) }, ws);
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
            broadcast({ type: 'update', ...publicPlayer(sessionId, player) }, ws);
            if (revealed.length) send(ws, { type: 'fog', add: revealed });
            return;
        }

        if (data.type === 'teleport') {
            const edge = clampWorld(Number(data.x), Number(data.z), 2.2);
            player.x = edge.x;
            player.z = edge.z;
            player.y = terrainHeight(player.x, player.z);
            const revealed = revealFog(player);
            broadcast({ type: 'update', ...publicPlayer(sessionId, player) }, ws);
            send(ws, { type: 'teleport', x: player.x, y: player.y, z: player.z, add: revealed });
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
                if (addToSlots(player, drop)) {
                    send(ws, { type: 'gatherResult', ok: false, reason: 'Inventory full', id: node.id, hits, inventory: inventoryOf(player) });
                    return;
                }
                gained = drop.kind;
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
            if (now - player.lastAttack < 500) return;
            player.lastAttack = now;
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            if (typeof data.rotY === 'number') player.rotY = data.rotY;
            if (data.tool === 'sword' || data.tool === 'staff') player.tool = data.tool;
            const spec = ABILITIES[data.ability] || ABILITIES.sword;
            player.tool = spec.weapon;
            if (player.class) {
                const worn = player.equipment.weapon && player.equipment.weapon.weapon;
                if (worn !== spec.weapon) {
                    send(ws, { type: 'attackResult', ok: false, reason: 'Equip a ' + spec.weapon });
                    return;
                }
                if (!knownSpells(player).includes(data.ability || 'sword')) {
                    send(ws, { type: 'attackResult', ok: false, reason: 'Spell not trained' });
                    return;
                }
            }
            if (player.mana < spec.mana) {
                send(ws, { type: 'attackResult', ok: false, reason: 'Not enough mana', ability: data.ability || 'sword', ...statsOf(player) });
                return;
            }
            player.mana -= spec.mana;
            if (spec.heal) {
                let subject = player;
                if (data.targetId && data.targetId !== player.persistentId) {
                    const ally = players.get(data.targetId);
                    if (!ally) {
                        player.mana += spec.mana;
                        send(ws, { type: 'attackResult', ok: false, reason: npcs.has(data.targetId) ? 'Select a player to heal' : 'No target', ...statsOf(player) });
                        return;
                    }
                    if (ally.ghost) {
                        player.mana += spec.mana;
                        send(ws, { type: 'attackResult', ok: false, reason: 'Cannot heal a ghost', ...statsOf(player) });
                        return;
                    }
                    if (Math.hypot(ally.x - player.x, ally.z - player.z) > 8) {
                        player.mana += spec.mana;
                        send(ws, { type: 'attackResult', ok: false, reason: 'Out of range', ...statsOf(player) });
                        return;
                    }
                    subject = ally;
                }
                const healed = spec.heal(player.level);
                subject.hp = Math.min(subject.maxHp, subject.hp + healed);
                player.lastAttack = now;
                broadcast({
                    type: 'cast',
                    casterId: sessionId,
                    ability: data.ability,
                    bolts: 1,
                    travel: 280,
                    x: player.x,
                    z: player.z,
                    tx: subject.x,
                    tz: subject.z
                });
                if (subject !== player) send(subject.ws, { type: 'healed', amount: healed, from: player.name, ...statsOf(subject) });
                send(ws, { type: 'attackResult', ok: true, ability: data.ability, heal: healed, targetId: subject.persistentId, ...statsOf(player) });
                return;
            }
            const ally = players.get(data.targetId);
            if (ally) {
                player.mana += spec.mana;
                send(ws, { type: 'attackResult', ok: false, reason: 'Cannot attack a player', ...statsOf(player) });
                return;
            }
            const npc = npcs.get(data.targetId);
            if (!npc || !npc.alive) {
                player.mana += spec.mana;
                send(ws, { type: 'attackResult', ok: false, reason: 'No target', ...statsOf(player) });
                return;
            }
            const dist = Math.hypot(npc.x - player.x, npc.z - player.z);
            if (dist > spec.range) {
                player.mana += spec.mana;
                send(ws, { type: 'attackResult', ok: false, reason: 'Out of range', ...statsOf(player) });
                return;
            }
            player.lastAttack = now;
            const rank = (player.spellRanks && player.spellRanks[data.ability || 'sword']) || 1;
            const bolts = (data.ability === 'arcane-bolt') ? rank : 1;
            const per = spec.damage(player.level) + (spec.weapon === 'sword' ? talentRank(player, 'might') : spec.damage ? talentRank(player, 'arcane-power') : 0);
            const projectile = data.ability === 'arcane-bolt' || data.ability === 'arcane-surge';
            const travel = projectile ? Math.min(900, Math.max(220, Math.round(dist * 140))) : 0;
            broadcast({
                type: 'cast',
                casterId: sessionId,
                ability: data.ability || 'sword',
                npcId: npc.id,
                bolts,
                travel,
                x: player.x,
                z: player.z,
                tx: npc.x,
                tz: npc.z
            });
            const finish = (dealt, killed, gained, leveled, chest) => {
                if (ws.readyState !== 1) return;
                send(ws, {
                    type: 'attackResult',
                    ok: true,
                    damage: dealt,
                    bolts,
                    npcId: npc.id,
                    killed,
                    gained,
                    leveled,
                    ability: data.ability || 'sword',
                    chest: chest ? publicChest(chest) : null,
                    quests: player.quests,
                    inventory: player.questDirty ? inventoryOf(player) : undefined,
                    questNote: player.questNote || '',
                    ...statsOf(player)
                });
                player.questDirty = false;
                player.questNote = '';
            };
            const land = () => {
                if (!npc.alive) return { dealt: 0, killed: false, gained: 0, leveled: false, chest: null };
                const dealtNow = Math.max(1, Math.round(per * damageScale(player.level, npc.level)));
                npc.hp -= dealtNow;
                npc.aggroId = player.persistentId;
                let gained = 0;
                let leveled = false;
                let chest = null;
                if (npc.hp <= 0) {
                    downNpc(npc);
                    gained = xpForKill(player, npc);
                    leveled = grantXp(player, gained);
                    chest = spawnChest(npc);
                    noteKill(player, npc);
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
                return { dealt: dealtNow, killed: !npc.alive, gained, leveled, chest };
            };
            if (!projectile) {
                const hit = land();
                finish(hit.dealt * bolts, hit.killed, hit.gained, hit.leveled, hit.chest);
                return;
            }
            let landed = 0;
            let dealt = 0;
            let reported = false;
            const report = (hit) => {
                if (reported) return;
                reported = true;
                finish(dealt, hit ? hit.killed : false, hit ? hit.gained : 0, hit ? hit.leveled : false, hit ? hit.chest : null);
            };
            for (let i = 0; i < bolts; i++) {
                setTimeout(() => {
                    const hit = land();
                    dealt += hit.dealt;
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
            const { taken, leftover } = giveLoot(player, chest.items);
            if (!taken.length) {
                send(ws, { type: 'lootResult', ok: false, reason: 'Inventory full', inventory: inventoryOf(player) });
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
                ...statsOf(player)
            });
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
            send(ws, { type: 'spawn', ok: true, spawn: player.spawn, note: 'Spawn set to ' + civ.name });
            return;
        }

        if (data.type === 'acceptQuest') {
            const civ = nearCivilian(player, data.id);
            const offered = civ && (civ.quests || (civ.quest ? [civ.quest] : []));
            const questId = offered && data.quest && offered.includes(data.quest) ? data.quest : (offered && offered[0]);
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
            const offered = civ && (civ.quests || (civ.quest ? [civ.quest] : []));
            const questId = offered && data.quest && offered.includes(data.quest) ? data.quest : (offered && offered[0]);
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
                const leftover = addToSlots(player, { kind: quest.rewardKind, name: quest.rewardName || quest.rewardKind, qty: quest.rewardQty || 1 });
                if (leftover) {
                    send(ws, { type: 'quests', ok: false, reason: 'Inventory full', quests: player.quests });
                    return;
                }
            }
            if (quest.type === 'gather' && quest.item) {
                let left = quest.count;
                for (let i = 0; i < player.slots.length && left > 0; i++) {
                    const slot = player.slots[i];
                    if (!slot || slot.kind !== 'quest' || slot.name !== quest.item) continue;
                    const take = Math.min(slot.qty, left);
                    slot.qty -= take;
                    left -= take;
                    if (slot.qty <= 0) player.slots[i] = null;
                }
            }
            row.state = 'done';
            row.failed = false;
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
            if (slot.kind === 'health') {
                player.hp = Math.min(player.maxHp, player.hp + (slot.amount || 10));
            } else if (slot.kind === 'mana') {
                player.mana = Math.min(player.maxMana, player.mana + (slot.amount || 8));
            } else if (slot.kind === 'bomb') {
                const npc = npcs.get(data.targetId);
                if (!npc || !npc.alive) {
                    send(ws, { type: 'useResult', ok: false, reason: 'Select a hostile target' });
                    return;
                }
                if (Math.hypot(npc.x - player.x, npc.z - player.z) > 8) {
                    send(ws, { type: 'useResult', ok: false, reason: 'Out of range' });
                    return;
                }
                const damage = slot.amount || 10;
                npc.hp -= damage;
                let gained = 0;
                let leveled = false;
                let chest = null;
                if (npc.hp <= 0) {
                    downNpc(npc);
                    gained = xpForKill(player, npc);
                    leveled = grantXp(player, gained);
                    chest = spawnChest(npc);
                    noteKill(player, npc);
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
                savePlayer(player);
                send(ws, {
                    type: 'useResult',
                    ok: true,
                    item: 'bomb',
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
            savePlayer(player);
            send(ws, { type: 'useResult', ok: true, item: slot.kind, inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'actionbar') {
            player.actionbar = sanitizeActionBar(data.pages);
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
            player.coins = 0;
            player.materials = blankMaterials();
            player.slots = [];
            normalizeSlots(player);
            player.actionbar = defaultActionBar();
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
            broadcast({ type: 'update', ...publicPlayer(player.persistentId, player) }, ws);
            return;
        }

        if (data.type === 'chooseClass') {
            const error = chooseClass(player, data.class);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
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
            const error = spendTalent(player, data.id);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
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

        if (data.type === 'learnPattern') {
            placePlayer(player, data);
            const error = learnPattern(player, data.slot);
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : 'Pattern learned', character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'craft') {
            const recipe = RECIPES[data.recipe];
            const error = craftItem(player, data.recipe);
            send(ws, { type: 'character', ok: !error, reason: error, note: error ? '' : ('Crafted ' + (recipe ? recipe.name : 'item')), character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
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
const LOOT_KINDS = ['junk', 'coins', 'health', 'mana', 'cloth', 'leather', 'ore', 'gem', 'stone', 'herb', 'powder', 'recipe', 'armor'];

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
    for (const raw of list.slice(0, 40)) {
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
            protectRole: ['inn', 'shop', 'trainer', 'quest'].includes(raw.protectRole) ? raw.protectRole : '',
            protectCamp: clampNum(raw.protectCamp, 0, 0, 5),
            requires: String(raw.requires || '').trim().slice(0, 32),
            type,
            mob: MOB_IDS.includes(raw.mob) ? raw.mob : 'boar',
            count: type === 'named' ? 1 : clampNum(raw.count, 3, 1, 40),
            item: String(raw.item || '').trim().slice(0, 24),
            named: String(raw.named || '').trim().slice(0, 24),
            custom: !!raw.custom,
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
        bounds: sanitizeBounds(src.bounds),
        quests: sanitizeQuests(src.quests)
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
        quests: (worldConfig && worldConfig.quests) || []
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
    worldConfig = { ...config, zones: listDesignedZones(), bounds: worldShape(), loot: lootTables, quests: config.quests || [] };
    rebuildCivilians();
    installQuests(config.quests || []);
    npcs.clear();
    zoneSpawns.clear();
    refreshNpcZones();
}

function loadWorldFile() {
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
    } catch { /* first run */ }
    const next = sanitizeWorld(parsed || {});
    if (parsed && typeof parsed.adminPassword === 'string') next.adminPassword = parsed.adminPassword.slice(0, 64);
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

app.get('/api/setup/config', requireAdmin, (req, res) => {
    res.json({ ...publicWorld(), loot: lootTables, locked: !!process.env.ADMIN_PASSWORD });
});

app.put('/api/setup/config', requireAdmin, (req, res) => {
    const next = sanitizeWorld(req.body || {});
    next.adminPassword = worldConfig.adminPassword || '';
    applyLoaded(next);
    saveWorldFile();
    broadcast({
        type: 'world',
        world: publicWorld(),
        civilians: CIVILIANS.map(publicCivilian),
        camps: campSites(),
        npcs: Array.from(npcs.values()).filter(npc => npc.alive).map(publicNpc),
        questDefs: publicQuests()
    });
    res.json({ ok: true, config: { ...publicWorld(), loot: lootTables } });
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
