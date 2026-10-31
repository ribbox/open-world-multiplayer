import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chunkResources } from './worldgen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const GATHER_RANGE = 3.2;
const GATHER_COOLDOWN_MS = 400;
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ec4899'];

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
const NPC_COUNT = 8;
const AGGRO_RANGE = 9;
const ATTACK_RANGE = 2.6;
const NPC_HIT_RANGE = 1.55;

function xpToNext(level) {
    return 50 * level;
}

function maxHpFor(level) {
    return 20 + (level - 1) * 4;
}

function npcMaxHp(level) {
    return 6 + level * 4;
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
        color: p.color
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
        maxHp: n.maxHp
    };
}

function placeNpc(npc) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 18 + Math.random() * 55;
    npc.x = Math.cos(angle) * dist;
    npc.z = Math.sin(angle) * dist;
    npc.level = 1 + Math.floor(Math.random() * 5);
    npc.maxHp = npcMaxHp(npc.level);
    npc.hp = npc.maxHp;
    npc.alive = true;
    npc.homeX = npc.x;
    npc.homeZ = npc.z;
    npc.attackAt = 0;
    pickWander(npc);
}

function pickWander(npc) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 4 + Math.random() * 14;
    npc.wanderX = npc.homeX + Math.cos(angle) * dist;
    npc.wanderZ = npc.homeZ + Math.sin(angle) * dist;
    npc.wanderUntil = Date.now() + 3000 + Math.random() * 4000;
}

for (let i = 0; i < NPC_COUNT; i++) {
    const npc = { id: 'n' + i };
    placeNpc(npc);
    npcs.set(npc.id, npc);
}

function nearestPlayer(npc, range) {
    let best = null;
    let bestD = range * range;
    for (const player of players.values()) {
        if (player.hp <= 0) continue;
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

function grantXp(player, amount) {
    player.xp += amount;
    let leveled = false;
    while (player.xp >= xpToNext(player.level)) {
        player.xp -= xpToNext(player.level);
        player.level += 1;
        player.maxHp = maxHpFor(player.level);
        player.maxMana = 10 + (player.level - 1) * 4;
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

const BASE_SLOTS = 16;

function stackLimit(item) {
    if (item.kind === 'coins') return 99;
    if (item.kind === 'wood' || item.kind === 'stone') return 20;
    if (item.kind === 'junk') return 10;
    if (item.kind === 'health' || item.kind === 'mana' || item.kind === 'armor') return 5;
    return 1;
}

function sameStack(a, b) {
    return a && b && a.kind === b.kind && a.name === b.name && (a.amount || 0) === (b.amount || 0) && (a.armor || 0) === (b.armor || 0);
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
            armor: source.armor || 0
        };
        qty -= take;
        if (qty <= 0) return null;
    }
    return { kind: source.kind, name: source.name, qty, amount: source.amount || 0, armor: source.armor || 0 };
}

function copySlot(slot) {
    if (!slot) return null;
    return { kind: slot.kind, name: slot.name, qty: slot.qty || 1, amount: slot.amount || 0, armor: slot.armor || 0 };
}

function loadInventory(prof) {
    if (Array.isArray(prof.slots)) {
        const player = {
            bagSlots: prof.bagSlots || 0,
            slots: prof.slots.map(copySlot)
        };
        while (player.slots.length > slotCapacity(player)) expandBag(player, 4);
        normalizeSlots(player);
        prof.slots = player.slots;
        prof.bagSlots = player.bagSlots;
        return;
    }
    const pending = [];
    const push = (item) => { if ((item.qty || 0) > 0) pending.push(item); };
    push({ kind: 'wood', name: 'Wood', qty: prof.wood || 0 });
    push({ kind: 'stone', name: 'Stone', qty: prof.stone || 0 });
    push({ kind: 'coins', name: 'Coins', qty: prof.coins || 0 });
    push({ kind: 'junk', name: 'Junk', qty: prof.junk || 0 });
    for (const amount of prof.healthPotions || []) push({ kind: 'health', name: 'Health potion', qty: 1, amount });
    for (const amount of prof.manaPotions || []) push({ kind: 'mana', name: 'Mana potion', qty: 1, amount });
    const player = { slots: [], bagSlots: 0 };
    for (const item of pending) {
        let rest = addToSlots(player, item);
        while (rest) {
            expandBag(player, 4);
            rest = addToSlots(player, rest);
        }
    }
    prof.slots = player.slots;
    prof.bagSlots = player.bagSlots;
    prof.wood = 0;
    prof.stone = 0;
    prof.coins = 0;
    prof.junk = 0;
    prof.healthPotions = [];
    prof.manaPotions = [];
}

function inventoryOf(player) {
    return {
        slots: player.slots,
        capacity: slotCapacity(player),
        bagSlots: player.bagSlots || 0,
        baseSlots: BASE_SLOTS
    };
}

function savePlayer(player) {
    const prof = save.players[player.persistentId];
    prof.slots = player.slots;
    prof.bagSlots = player.bagSlots || 0;
    prof.armor = player.armor;
    prof.level = player.level;
    prof.xp = player.xp;
    prof.wood = 0;
    prof.stone = 0;
    prof.coins = 0;
    prof.junk = 0;
    prof.healthPotions = [];
    prof.manaPotions = [];
    scheduleSave();
}

const LOOT_WEIGHTS = [
    { kind: 'junk', weight: 46 },
    { kind: 'coins', weight: 22 },
    { kind: 'gather', weight: 14 },
    { kind: 'health', weight: 9 },
    { kind: 'mana', weight: 7 },
    { kind: 'armor', weight: 2 }
];
const JUNK_NAMES = ['Bent nail', 'Torn cloth', 'Cracked bead', 'Rusty buckle', 'Frayed rope'];

function rollKind() {
    const total = LOOT_WEIGHTS.reduce((sum, row) => sum + row.weight, 0);
    let roll = Math.random() * total;
    for (const row of LOOT_WEIGHTS) {
        roll -= row.weight;
        if (roll <= 0) return row.kind;
    }
    return 'junk';
}

function rollLoot(level) {
    const count = 1 + Math.floor((level - 1) / 2) + (Math.random() < 0.5 ? 1 : 0);
    const items = [];
    for (let i = 0; i < count; i++) {
        const kind = rollKind();
        if (kind === 'junk') {
            items.push({ kind, name: JUNK_NAMES[Math.floor(Math.random() * JUNK_NAMES.length)], qty: 1 });
        } else if (kind === 'coins') {
            items.push({ kind, name: 'Coins', qty: level * 4 + Math.floor(Math.random() * (level * 2 + 1)) });
        } else if (kind === 'gather') {
            const wood = Math.random() < 0.5;
            items.push({
                kind: wood ? 'wood' : 'stone',
                name: wood ? 'Wood' : 'Stone',
                qty: 1 + Math.floor(level / 2)
            });
        } else if (kind === 'health') {
            items.push({ kind, name: 'Health potion', qty: 1, amount: 8 + level * 3 });
        } else if (kind === 'mana') {
            items.push({ kind, name: 'Mana potion', qty: 1, amount: 6 + level * 2 });
        } else {
            items.push({ kind, name: 'Armor scrap', qty: 1, armor: 1 + Math.floor((level - 1) / 2) });
        }
    }
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
        items: rollLoot(npc.level),
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

    for (const npc of npcs.values()) {
        if (!npc.alive) {
            if (now >= npc.respawnAt) placeNpc(npc);
            continue;
        }
        const target = nearestPlayer(npc, AGGRO_RANGE);
        let tx = npc.wanderX;
        let tz = npc.wanderZ;
        let speed = 1.7;
        if (target) {
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
                send(target.ws, { type: 'hurt', damage, attacker: npc.level, ...statsOf(target) });
                if (target.hp <= 0) {
                    target.x = 0;
                    target.y = 0;
                    target.z = 0;
                    target.hp = target.maxHp;
                    target.invulnUntil = now + 2500;
                    send(target.ws, { type: 'respawn', x: 0, y: 0, z: 0, ...statsOf(target) });
                }
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

            const existing = players.get(persistentId);
            if (existing && existing.ws !== ws) {
                existing.ws._replaced = true;
                try { existing.ws.close(); } catch { /* already closing */ }
            }

            const player = {
                ws,
                persistentId,
                x: 0,
                y: 0,
                z: 0,
                rotY: 0,
                tool: 'axe',
                name: prof.name,
                color: prof.color,
                level: prof.level,
                xp: prof.xp,
                maxHp: maxHpFor(prof.level),
                hp: maxHpFor(prof.level),
                maxMana: 10 + (prof.level - 1) * 4,
                mana: 10 + (prof.level - 1) * 4,
                manaShown: -1,
                manaSent: 0,
                armor: prof.armor,
                bagSlots: prof.bagSlots || 0,
                slots: prof.slots.map(copySlot),
                invulnUntil: 0,
                lastGather: 0,
                lastAttack: 0
            };
            players.set(persistentId, player);
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
                chests: Array.from(chests.values()).map(publicChest),
                resources: save.resources,
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
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.y === 'number') player.y = data.y;
            if (typeof data.z === 'number') player.z = data.z;
            if (typeof data.rotY === 'number') player.rotY = data.rotY;
            if (data.tool === 'axe' || data.tool === 'pickaxe' || data.tool === 'sword') player.tool = data.tool;
            broadcast({ type: 'update', ...publicPlayer(sessionId, player) }, ws);
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
            const now = Date.now();
            if (now - player.lastGather < GATHER_COOLDOWN_MS) return;
            player.lastGather = now;
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            const tool = data.tool === 'pickaxe' ? 'pickaxe' : 'axe';
            player.tool = tool;

            const node = resourceById(data.id);
            if (!node) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'Unknown node' });
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
            if ((node.type === 'tree' && tool !== 'axe') || (node.type === 'rock' && tool !== 'pickaxe')) {
                send(ws, { type: 'gatherResult', ok: false, reason: 'Wrong tool' });
                return;
            }

            const next = hits - 1;
            let gained = null;
            if (next <= 0) {
                const item = node.type === 'tree'
                    ? { kind: 'wood', name: 'Wood', qty: 1 }
                    : { kind: 'stone', name: 'Stone', qty: 1 };
                if (addToSlots(player, item)) {
                    send(ws, { type: 'gatherResult', ok: false, reason: 'Inventory full', id: node.id, hits, inventory: inventoryOf(player) });
                    return;
                }
                gained = item.kind;
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
            const now = Date.now();
            if (now - player.lastAttack < 500) return;
            player.lastAttack = now;
            if (typeof data.x === 'number') player.x = data.x;
            if (typeof data.z === 'number') player.z = data.z;
            if (typeof data.rotY === 'number') player.rotY = data.rotY;
            if (data.tool === 'sword') player.tool = 'sword';
            if (player.tool !== 'sword') {
                send(ws, { type: 'attackResult', ok: false, reason: 'Need a sword' });
                return;
            }
            let best = null;
            let bestD = ATTACK_RANGE;
            for (const npc of npcs.values()) {
                if (!npc.alive) continue;
                const dist = Math.hypot(npc.x - player.x, npc.z - player.z);
                if (dist < bestD) {
                    best = npc;
                    bestD = dist;
                }
            }
            if (!best) {
                send(ws, { type: 'attackResult', ok: false, reason: 'No target' });
                return;
            }
            if (player.mana < 2) {
                send(ws, { type: 'attackResult', ok: false, reason: 'Not enough mana', ...statsOf(player) });
                return;
            }
            player.mana -= 2;
            const damage = 4 + player.level;
            best.hp -= damage;
            let gained = 0;
            let leveled = false;
            let chest = null;
            if (best.hp <= 0) {
                best.hp = 0;
                best.alive = false;
                best.respawnAt = now + 8000;
                gained = 20 * best.level;
                leveled = grantXp(player, gained);
                chest = spawnChest(best);
            }
            broadcast({
                type: 'npcHit',
                id: best.id,
                hp: best.hp,
                maxHp: best.maxHp,
                alive: best.alive,
                x: best.x,
                z: best.z,
                level: best.level
            });
            send(ws, {
                type: 'attackResult',
                ok: true,
                damage,
                npcId: best.id,
                killed: !best.alive,
                gained,
                leveled,
                chest: chest ? publicChest(chest) : null,
                ...statsOf(player)
            });
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
            } else if (slot.kind === 'armor') {
                player.armor += slot.armor || 1;
            } else {
                send(ws, { type: 'useResult', ok: false, reason: 'Cannot use that' });
                return;
            }
            slot.qty -= 1;
            if (slot.qty <= 0) player.slots[index] = null;
            savePlayer(player);
            send(ws, { type: 'useResult', ok: true, item: slot.kind, inventory: inventoryOf(player), ...statsOf(player) });
        }
    });

    ws.on('close', () => {
        if (ws._replaced || !sessionId) return;
        const current = players.get(sessionId);
        if (current && current.ws === ws) {
            players.delete(sessionId);
            broadcast({ type: 'leave', id: sessionId });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Open World server running on http://0.0.0.0:${PORT}`);
});
