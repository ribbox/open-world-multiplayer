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