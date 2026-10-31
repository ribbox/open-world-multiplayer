export const CHUNK_SIZE = 50;

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
        items.push({
            id: `${cx},${cz},${i}`,
            type,
            x: cx * CHUNK_SIZE + px,
            z: cz * CHUNK_SIZE + pz,
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
