export const CHUNK_SIZE = 50;
export const WATER_LEVEL = 0.35;

export function chunkSeed(cx, cz) {
    let h = Math.imul(cx | 0, 374761393) + Math.imul(cz | 0, 668265263) + 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hills(x, z) {
    return 4.2
        + Math.sin(x * 0.021) * Math.cos(z * 0.018) * 3.4
        + Math.sin((x * 0.65 + z) * 0.011) * 5.4
        + Math.cos(x * 0.006 - z * 0.009) * 4.2
        + Math.sin(x * 0.046) * Math.sin(z * 0.041) * 1.3;
}

function riverMask(x, z) {
    const center = 78 + Math.sin(z * 0.02) * 36 + Math.sin(z * 0.0055) * 14;
    const width = 7;
    const d = Math.abs(x - center);
    if (d >= width) return 0;
    const t = 1 - d / width;
    return t * t;
}

function lakeDepth(x, z) {
    const cell = 240;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let depth = 0;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
            const rand = mulberry32(chunkSeed(ix + 401, iz - 77));
            const roll = rand();
            const lx = (ix + 0.5) * cell + (rand() - 0.5) * 50;
            const lz = (iz + 0.5) * cell + (rand() - 0.5) * 50;
            const radius = 16 + rand() * 18;
            if (roll > 0.55) continue;
            if (Math.hypot(lx, lz) < 60) continue;
            const d = Math.hypot(x - lx, z - lz);
            if (d >= radius) continue;
            const bowl = 1 - d / radius;
            depth = Math.max(depth, bowl * bowl * 4.8);
        }
    }
    return depth;
}

export function terrainHeight(x, z) {
    let h = hills(x, z);
    const river = riverMask(x, z);
    if (river > 0) h = h * (1 - river) + (WATER_LEVEL - 1.7) * river;
    const lake = lakeDepth(x, z);
    if (lake > 0) h = Math.min(h, WATER_LEVEL - lake);
    const dist = Math.hypot(x, z);
    const flat = Math.min(1, Math.max(0, (dist - 12) / 28));
    return h * flat + 0.9 * (1 - flat);
}

// Same sequence the client uses to place trees and rocks.
export function chunkResources(cx, cz) {
    const rand = mulberry32(chunkSeed(cx, cz));
    const n = 6 + Math.floor(rand() * 7);
    const items = [];
    for (let i = 0; i < n; i++) {
        const type = rand() > 0.65 ? 'tree' : 'rock';
        const px = (rand() - 0.5) * CHUNK_SIZE * 0.85;
        const pz = (rand() - 0.5) * CHUNK_SIZE * 0.85;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        if (type === 'rock') {
            sx = 0.8 + rand() * 1.2;
            sy = 0.4 + rand() * 0.8;
            sz = 0.8 + rand() * 1.2;
        }
        const x = cx * CHUNK_SIZE + px;
        const z = cz * CHUNK_SIZE + pz;
        if (terrainHeight(x, z) < WATER_LEVEL + 0.2) continue;
        items.push({
            id: `${cx},${cz},${i}`,
            type,
            x,
            z,
            px,
            pz,
            sx,
            sy,
            sz,
            hits: type === 'tree' ? 3 : 4
        });
    }
    const extra = mulberry32(chunkSeed(cx + 91, cz - 13));
    const herbs = 1 + Math.floor(extra() * 2);
    for (let n = 0; n < herbs; n++) {
        const px = (extra() - 0.5) * CHUNK_SIZE * 0.8;
        const pz = (extra() - 0.5) * CHUNK_SIZE * 0.8;
        const x = cx * CHUNK_SIZE + px;
        const z = cz * CHUNK_SIZE + pz;
        if (terrainHeight(x, z) < WATER_LEVEL + 0.35) continue;
        const index = items.length;
        items.push({ id: `${cx},${cz},${index}`, type: 'herb', x, z, px, pz, sx: 0, sy: 0, sz: 0, hits: 2 });
    }
    if (extra() < 0.45) {
        const px = (extra() - 0.5) * CHUNK_SIZE * 0.8;
        const pz = (extra() - 0.5) * CHUNK_SIZE * 0.8;
        const x = cx * CHUNK_SIZE + px;
        const z = cz * CHUNK_SIZE + pz;
        if (terrainHeight(x, z) >= WATER_LEVEL + 0.35) {
            const index = items.length;
            items.push({ id: `${cx},${cz},${index}`, type: 'sulfur', x, z, px, pz, sx: 0.45, sy: 0.7, sz: 0.45, hits: 3 });
        }
    }
    return items;
}

export const ZONE_SIZE = 200;

const ZONE_A = ['Ash', 'Briar', 'Cedar', 'Fern', 'Moss', 'Oak', 'Willow', 'Yarrow', 'Heath', 'Glen'];
const ZONE_B = ['Fields', 'Reach', 'Hollow', 'Ridge', 'Vale', 'Wood', 'March', 'Shore', 'Hills', 'Watch'];

export function zoneName(zx, zz) {
    if (zx === 0 && zz === 0) return 'Camp Glade';
    const rand = mulberry32(chunkSeed(zx + 17, zz - 3));
    return ZONE_A[Math.floor(rand() * ZONE_A.length)] + ' ' + ZONE_B[Math.floor(rand() * ZONE_B.length)];
}

export function zoneAt(x, z) {
    const zx = Math.floor((x + ZONE_SIZE / 2) / ZONE_SIZE);
    const zz = Math.floor((z + ZONE_SIZE / 2) / ZONE_SIZE);
    const originX = zx * ZONE_SIZE - ZONE_SIZE / 2;
    const originZ = zz * ZONE_SIZE - ZONE_SIZE / 2;
    return {
        zx,
        zz,
        name: zoneName(zx, zz),
        x: ((x - originX) / ZONE_SIZE) * 100,
        z: ((z - originZ) / ZONE_SIZE) * 100
    };
}

const ZONE_PACKS = [
    ['boar'],
    ['wolf', 'spider', 'bandit'],
    ['ogre', 'spider', 'bandit'],
    ['knight', 'ogre', 'wisp'],
    ['cultist', 'knight', 'wisp']
];

export const WORLD_RADIUS = 4;

export function worldBounds() {
    const edge = WORLD_RADIUS * ZONE_SIZE + ZONE_SIZE / 2;
    return { min: -edge, max: edge };
}

export function clampWorld(x, z, margin = 2) {
    const { min, max } = worldBounds();
    const lo = min + margin;
    const hi = max - margin;
    return {
        x: Math.max(lo, Math.min(hi, x)),
        z: Math.max(lo, Math.min(hi, z))
    };
}

export function zoneInWorld(zx, zz) {
    return Math.abs(zx) <= WORLD_RADIUS && Math.abs(zz) <= WORLD_RADIUS;
}

export function zoneCamp(zx, zz) {
    if (zx === 0 && zz === 0) return { x: 0, z: 6 };
    const rand = mulberry32(chunkSeed(zx + 53, zz + 91));
    let x = zx * ZONE_SIZE + (rand() - 0.5) * ZONE_SIZE * 0.36;
    let z = zz * ZONE_SIZE + (rand() - 0.5) * ZONE_SIZE * 0.36;
    for (let i = 0; i < 5; i++) {
        if (terrainHeight(x, z) > WATER_LEVEL + 0.8) break;
        x += 14;
        z -= 10;
    }
    const half = ZONE_SIZE / 2 - 28;
    x = Math.max(zx * ZONE_SIZE - half, Math.min(zx * ZONE_SIZE + half, x));
    z = Math.max(zz * ZONE_SIZE - half, Math.min(zz * ZONE_SIZE + half, z));
    return clampWorld(x, z, 24);
}

const CAMP_NAMES = ['Ada', 'Bex', 'Cal', 'Dax', 'Eve', 'Faye', 'Gil', 'Hana', 'Ivo', 'Jem', 'Kit', 'Len', 'Mae', 'Nim', 'Ora', 'Pim', 'Quill', 'Ren', 'Siv', 'Tor', 'Una', 'Vik', 'Wyn', 'Yara', 'Zed'];

export function zoneCampFolk(zx, zz) {
    const camp = zoneCamp(zx, zz);
    const place = zoneName(zx, zz);
    const h = chunkSeed(zx + 3, zz + 9);
    const shopName = CAMP_NAMES[h % CAMP_NAMES.length];
    let trainName = CAMP_NAMES[(h >>> 8) % CAMP_NAMES.length];
    if (trainName === shopName) trainName = CAMP_NAMES[(h + 7) % CAMP_NAMES.length];
    return [
        { id: 'shop-' + zx + '-' + zz, name: shopName, role: 'shop', title: 'Shop', tint: '#f1c40f', x: camp.x + 2.4, z: camp.z - 1.2, text: 'I buy goods and sell crafting skills in ' + place + '.' },
        { id: 'train-' + zx + '-' + zz, name: trainName, role: 'trainer', title: 'Trainer', tint: '#5dade2', x: camp.x - 2.4, z: camp.z - 1.2, text: 'I train spells in ' + place + '.' }
    ];
}

const SELL_RARITY = {
    junk: 1, wood: 1, stone: 1, herb: 1, powder: 1,
    cloth: 2, leather: 2, health: 2, mana: 2, bomb: 2,
    ore: 3, armor: 3, weapon: 3, recipe: 4, gem: 5
};

export function itemRarity(item) {
    if (!item) return 1;
    return SELL_RARITY[item.kind] || 1;
}

export function sellPrice(item) {
    if (!item) return 0;
    const rarity = itemRarity(item);
    let quality = 1 + (item.armor || 0);
    if (item.magic) quality += 2;
    if (item.amount) quality += Math.floor(item.amount / 12);
    return Math.max(1, rarity * quality);
}

export function zoneNpc(zx, zz) {
    const ring = Math.max(Math.abs(zx), Math.abs(zz));
    const row = ZONE_PACKS[Math.min(ring, ZONE_PACKS.length - 1)];
    const h = chunkSeed(zx + 11, zz - 5);
    return {
        kind: row[h % row.length],
        level: 1 + ring * 2 + (h % 2),
        ring
    };
}