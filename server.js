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

function talentRank(player, id) {
    if (!player || !player.talents) return 0;
    return player.talents[id] || 0;
}

function maxManaFor(player) {
    return 10 + ((player.level || 1) - 1) * 4 + talentRank(player, 'meditation') * 2;
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
const ACTION_IDS = new Set(['sword', 'power-strike', 'cleave', 'staff', 'arcane-bolt', 'arcane-surge', 'mend', 'gather']);

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
        points: talentPoints(player),
        known: knownSpells(player),
        spells: SPELLS,
        talentsDef: TALENTS
    };
}

function coinCount(player) {
    return player.slots.reduce((sum, slot) => sum + (slot && slot.kind === 'coins' ? slot.qty : 0), 0);
}

function spendCoins(player, amount) {
    if (amount <= 0) return true;
    if (coinCount(player) < amount) return false;
    let left = amount;
    for (let i = 0; i < player.slots.length && left > 0; i++) {
        const slot = player.slots[i];
        if (!slot || slot.kind !== 'coins') continue;
        const take = Math.min(slot.qty, left);
        slot.qty -= take;
        left -= take;
        if (slot.qty <= 0) player.slots[i] = null;
    }
    return left === 0;
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
    if (item.kind === 'wood' || item.kind === 'stone') return 20;
    if (item.kind === 'junk') return 10;
    if (item.kind === 'health' || item.kind === 'mana' || item.kind === 'armor') return 5;
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
            slot: source.slot || ''
        };
        qty -= take;
        if (qty <= 0) return null;
    }
    return { kind: source.kind, name: source.name, qty, amount: source.amount || 0, armor: source.armor || 0, weapon: source.weapon || '', slot: source.slot || '' };
}

function copySlot(slot) {
    if (!slot) return null;
    return { kind: slot.kind, name: slot.name, qty: slot.qty || 1, amount: slot.amount || 0, armor: slot.armor || 0, weapon: slot.weapon || '', slot: slot.slot || '' };
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
    prof.legacyArmor = player.legacyArmor || 0;
    prof.class = player.class || null;
    prof.equipment = player.equipment;
    prof.trained = player.trained;
    prof.talents = player.talents;
    prof.spellRanks = player.spellRanks || {};
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
            const armorSlots = ['head', 'neck', 'shoulders', 'cloak', 'chest', 'hands', 'waist', 'legs', 'feet', 'offhand'];
            const wear = armorSlots[Math.floor(Math.random() * armorSlots.length)];
            const wearName = {
                head: 'Helm scrap', neck: 'Pendant', shoulders: 'Pauldrons', cloak: 'Cloak scrap',
                chest: 'Armor scrap', hands: 'Gloves', waist: 'Belt', legs: 'Leggings',
                feet: 'Boot scrap', offhand: 'Buckler'
            };
            items.push({ kind: 'armor', slot: wear, name: wearName[wear], qty: 1, armor: 1 + Math.floor((level - 1) / 2) });
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
            loadCharacter(prof);
            prof.actionbar = sanitizeActionBar(prof.actionbar);

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
                bagSlots: prof.bagSlots || 0,
                slots: prof.slots.map(copySlot),
                actionbar: prof.actionbar,
                invulnUntil: 0,
                lastGather: 0,
                lastAttack: 0
            };
            players.set(persistentId, player);
            refreshDerived(player);
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
                actionbar: player.actionbar,
                character: publicCharacter(player),
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
            if (data.tool === 'axe' || data.tool === 'pickaxe' || data.tool === 'sword' || data.tool === 'staff') player.tool = data.tool;
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
                const healed = spec.heal(player.level);
                player.hp = Math.min(player.maxHp, player.hp + healed);
                player.lastAttack = now;
                broadcast({
                    type: 'cast',
                    casterId: sessionId,
                    ability: data.ability,
                    bolts: 1,
                    travel: 0,
                    x: player.x,
                    z: player.z,
                    tx: player.x,
                    tz: player.z
                });
                send(ws, { type: 'attackResult', ok: true, ability: data.ability, heal: healed, ...statsOf(player) });
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
                    ...statsOf(player)
                });
            };
            const land = () => {
                if (!npc.alive) return { dealt: 0, killed: false, gained: 0, leveled: false, chest: null };
                npc.hp -= per;
                let gained = 0;
                let leveled = false;
                let chest = null;
                if (npc.hp <= 0) {
                    npc.hp = 0;
                    npc.alive = false;
                    npc.respawnAt = Date.now() + 8000;
                    gained = 20 * npc.level;
                    leveled = grantXp(player, gained);
                    chest = spawnChest(npc);
                }
                broadcast({
                    type: 'npcHit',
                    id: npc.id,
                    hp: npc.hp,
                    maxHp: npc.maxHp,
                    alive: npc.alive,
                    x: npc.x,
                    z: npc.z,
                    level: npc.level
                });
                return { dealt: per, killed: !npc.alive, gained, leveled, chest };
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

        if (data.type === 'chooseClass') {
            const error = chooseClass(player, data.class);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'train') {
            const error = trainSpell(player, data.spell);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
            return;
        }

        if (data.type === 'talent') {
            const error = spendTalent(player, data.id);
            send(ws, { type: 'character', ok: !error, reason: error, character: publicCharacter(player), inventory: inventoryOf(player), ...statsOf(player) });
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
