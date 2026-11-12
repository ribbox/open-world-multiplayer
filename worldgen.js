export const CHUNK_SIZE = 50;
export const WATER_LEVEL = 0.35;

let shape = {
    half: 900,
    edge: 'hills',
    swim: 14,
    maxSlope: 0.7,
    points: [],
    edges: [],
    samples: null
};

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
    const n = 4.2
        + Math.sin(x * 0.021) * Math.cos(z * 0.018) * 3.4
        + Math.sin((x * 0.65 + z) * 0.011) * 5.4
        + Math.cos(x * 0.006 - z * 0.009) * 4.2
        + Math.sin(x * 0.046) * Math.sin(z * 0.041) * 1.3;
    return Math.max(WATER_LEVEL + 1.6, n);
}

function rawHeight(x, z) {
    let h = hills(x, z);
    const dist = Math.hypot(x, z);
    const flat = Math.min(1, Math.max(0, (dist - 12) / 28));
    h = h * flat + 0.9 * (1 - flat);
    return h;
}

const ROAD_BED = 1.55;
const ROAD_SHOULDER = 2.9;
let designedRoads = [];
let roadSamples = [];

function limitRoadGrade(dense) {
    const grade = Math.max(0.12, Math.min(0.32, shape.maxSlope * 0.42));
    for (let pass = 0; pass < 8; pass++) {
        for (let i = 1; i < dense.length; i++) {
            const dist = Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z) || 1;
            const rise = dist * grade;
            const dy = dense[i].y - dense[i - 1].y;
            if (dy > rise) dense[i].y = dense[i - 1].y + rise;
            else if (dy < -rise) dense[i].y = dense[i - 1].y - rise;
        }
        for (let i = dense.length - 2; i >= 0; i--) {
            const dist = Math.hypot(dense[i].x - dense[i + 1].x, dense[i].z - dense[i + 1].z) || 1;
            const rise = dist * grade;
            const dy = dense[i].y - dense[i + 1].y;
            if (dy > rise) dense[i].y = dense[i + 1].y + rise;
            else if (dy < -rise) dense[i].y = dense[i + 1].y - rise;
        }
    }
}

function rebuildRoads() {
    roadSamples = [];
    for (const road of designedRoads) {
        const curve = curvePoints(road.points, road.edges, false);
        if (curve.length < 2) continue;
        const dense = [];
        for (let i = 0; i < curve.length - 1; i++) {
            const ax = curve[i][0];
            const az = curve[i][1];
            const bx = curve[i + 1][0];
            const bz = curve[i + 1][1];
            const len = Math.hypot(bx - ax, bz - az);
            const steps = Math.max(1, Math.ceil(len / 2));
            for (let s = 0; s < steps; s++) {
                const t = s / steps;
                dense.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, y: 0 });
            }
        }
        const last = curve[curve.length - 1];
        dense.push({ x: last[0], z: last[1], y: 0 });
        for (const point of dense) point.y = rawHeight(point.x, point.z);
        limitRoadGrade(dense);
        roadSamples.push(dense);
    }
}

export function roadAt(x, z, reach = ROAD_SHOULDER) {
    let best = null;
    for (const road of roadSamples) {
        for (let i = 1; i < road.length; i++) {
            const a = road[i - 1];
            const b = road[i];
            const abx = b.x - a.x;
            const abz = b.z - a.z;
            const len2 = abx * abx + abz * abz || 1e-6;
            let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const px = a.x + abx * t;
            const pz = a.z + abz * t;
            const dx = x - px;
            const dz = z - pz;
            if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
            const dist = Math.hypot(dx, dz);
            if (dist > reach) continue;
            if (!best || dist < best.dist) best = { dist, y: a.y + (b.y - a.y) * t };
        }
    }
    return best;
}

export function listRoads() {
    return designedRoads.map(road => ({ id: road.id, points: road.points, edges: road.edges }));
}

function shapedHeight(x, z) {
    const dry = rawHeight(x, z);
    let h = dry;
    const road = roadAt(x, z);
    if (road && road.dist < ROAD_SHOULDER) {
        const edge = road.dist <= ROAD_BED ? 1 : 1 - (road.dist - ROAD_BED) / (ROAD_SHOULDER - ROAD_BED);
        const blend = edge * edge * (3 - 2 * edge);
        const span = Math.max(0.8, ROAD_SHOULDER - road.dist);
        const bed = Math.max(road.y, dry - shape.maxSlope * span);
        h = h * (1 - blend) + bed * blend;
    }
    return applyBoundary(x, z, h);
}

let heightCache = new Map();

export function terrainHeight(x, z) {
    const key = Math.round(x * 50) * 131071 + Math.round(z * 50);
    const hit = heightCache.get(key);
    if (hit !== undefined) return hit;
    const h = shapedHeight(x, z);
    heightCache.set(key, h);
    return h;
}

// Same sequence the client uses to place trees and rocks.
export function chunkResources(cx, cz) {
    const items = [];
    const rand = mulberry32(chunkSeed(cx, cz));
    const n = 6 + Math.floor(rand() * 7);
    for (let i = 0; i < n; i++) {
        const roll = rand();
        const type = roll > 0.7 ? 'plain-tree' : roll > 0.035 ? 'boulder' : 'plain-rock';
        const px = (rand() - 0.5) * CHUNK_SIZE * 0.85;
        const pz = (rand() - 0.5) * CHUNK_SIZE * 0.85;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        if (type !== 'plain-tree') {
            sx = 0.8 + rand() * 1.2;
            sy = 0.4 + rand() * 0.8;
            sz = 0.8 + rand() * 1.2;
        }
        const x = cx * CHUNK_SIZE + px;
        const z = cz * CHUNK_SIZE + pz;
        if (terrainHeight(x, z) < WATER_LEVEL + 0.2 || boundaryInset(x, z) < 8) continue;
        if (roadAt(x, z) && roadAt(x, z).dist < 1.9) continue;
        items.push({
            id: 's-' + cx + '-' + cz + '-' + i,
            type,
            x,
            z,
            px,
            pz,
            sx,
            sy,
            sz,
            hits: 0
        });
    }
    const decor = mulberry32(chunkSeed(cx + 17, cz + 41));
    const boulders = 5 + Math.floor(decor() * 4);
    for (let i = 0; i < boulders; i++) {
        const px = (decor() - 0.5) * CHUNK_SIZE * 0.9;
        const pz = (decor() - 0.5) * CHUNK_SIZE * 0.9;
        const x = cx * CHUNK_SIZE + px;
        const z = cz * CHUNK_SIZE + pz;
        if (terrainHeight(x, z) < WATER_LEVEL + 0.45 || boundaryInset(x, z) < 8) continue;
        if (roadAt(x, z) && roadAt(x, z).dist < 1.9) continue;
        items.push({
            id: 'b-' + cx + '-' + cz + '-' + i,
            type: 'boulder',
            x,
            z,
            px,
            pz,
            sx: 1.1 + decor() * 1.4,
            sy: 0,
            sz: 0,
            hits: 0
        });
    }
    if (!customMap()) {
        const extra = mulberry32(chunkSeed(cx + 91, cz - 13));
        const herbs = 1 + Math.floor(extra() * 2);
        for (let n = 0; n < herbs; n++) {
            const px = (extra() - 0.5) * CHUNK_SIZE * 0.8;
            const pz = (extra() - 0.5) * CHUNK_SIZE * 0.8;
            const x = cx * CHUNK_SIZE + px;
            const z = cz * CHUNK_SIZE + pz;
            if (terrainHeight(x, z) < WATER_LEVEL + 0.35 || boundaryInset(x, z) < 8 || (roadAt(x, z) && roadAt(x, z).dist < 1.9)) continue;
            const index = items.length;
            items.push({ id: `${cx},${cz},${index}`, type: 'herb', x, z, px, pz, sx: 0, sy: 0, sz: 0, hits: 2 });
        }
        if (extra() < 0.45) {
            const px = (extra() - 0.5) * CHUNK_SIZE * 0.8;
            const pz = (extra() - 0.5) * CHUNK_SIZE * 0.8;
            const x = cx * CHUNK_SIZE + px;
            const z = cz * CHUNK_SIZE + pz;
            if (terrainHeight(x, z) >= WATER_LEVEL + 0.35 && boundaryInset(x, z) >= 8 && !(roadAt(x, z) && roadAt(x, z).dist < 1.9)) {
                const index = items.length;
                items.push({ id: `${cx},${cz},${index}`, type: 'sulfur', x, z, px, pz, sx: 0.45, sy: 0.7, sz: 0.45, hits: 3 });
            }
        }
    }
    appendDesignedNodes(cx, cz, items);
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
    const grid = {
        zx,
        zz,
        name: zoneName(zx, zz),
        x: ((x - originX) / ZONE_SIZE) * 100,
        z: ((z - originZ) / ZONE_SIZE) * 100
    };
    const drawn = designedZoneAt(x, z);
    if (drawn) grid.name = drawn.name;
    else if (designedZones.length) grid.name = 'Wilderness';
    return grid;
}

const ZONE_PACKS = [
    ['boar'],
    ['wolf', 'spider', 'bandit'],
    ['ogre', 'spider', 'bandit'],
    ['knight', 'ogre', 'wisp'],
    ['cultist', 'knight', 'wisp']
];

export const WORLD_RADIUS = 4;

function organicAt(a, b, t) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    const sign = ((Math.round(a[0] * 0.17 + b[1]) ^ Math.round(a[1] - b[0])) & 1) ? 1 : -1;
    const bow = Math.sin(t * Math.PI) * len * 0.22 + Math.sin(t * Math.PI * 3) * len * 0.06;
    return [a[0] + dx * t + px * bow * sign, a[1] + dz * t + pz * bow * sign];
}

export function segmentCurve(a, b, style) {
    if (style !== 'organic') return [a, b];
    const points = [];
    for (let step = 0; step <= 8; step++) points.push(organicAt(a, b, step / 8));
    return points;
}

export function curvePoints(points, edges, closed = true) {
    const count = points.length;
    if (count < 2) return points.map(point => point.slice());
    const segments = closed ? count : count - 1;
    const out = [];
    for (let i = 0; i < segments; i++) {
        const part = segmentCurve(points[i], points[(i + 1) % count], edges && edges[i]);
        if (i === 0) out.push(...part);
        else out.push(...part.slice(1));
    }
    return out;
}

function polyArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return area / 2;
}

function ccwRing(points) {
    const ring = points.map(point => [point[0], point[1]]);
    if (polyArea(ring) < 0) ring.reverse();
    return ring;
}

function sideOf(a, b, p) {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function lineCross(s, e, a, b) {
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((a[0] - s[0]) * ey - (a[1] - s[1]) * ex) / den;
    return [s[0] + dx * t, s[1] + dy * t];
}

function clipToConvex(subject, clip) {
    let output = subject.map(point => [point[0], point[1]]);
    for (let i = 0; i < clip.length; i++) {
        const a = clip[i];
        const b = clip[(i + 1) % clip.length];
        const input = output;
        output = [];
        if (!input.length) return [];
        for (let j = 0; j < input.length; j++) {
            const start = input[j];
            const end = input[(j + 1) % input.length];
            const startIn = sideOf(a, b, start) >= -1e-6;
            const endIn = sideOf(a, b, end) >= -1e-6;
            if (endIn) {
                if (!startIn) {
                    const hit = lineCross(start, end, a, b);
                    if (hit) output.push(hit);
                }
                output.push(end);
            } else if (startIn) {
                const hit = lineCross(start, end, a, b);
                if (hit) output.push(hit);
            }
        }
    }
    return output;
}

function triangulate(points) {
    const ring = ccwRing(points).filter((point, index, all) => {
        const prev = all[(index - 1 + all.length) % all.length];
        return Math.hypot(point[0] - prev[0], point[1] - prev[1]) > 0.05;
    });
    const verts = ring.map(point => ({ x: point[0], y: point[1] }));
    const tris = [];
    const turn = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const contains = (p, a, b, c) => turn(a, b, p) >= -1e-6 && turn(b, c, p) >= -1e-6 && turn(c, a, p) >= -1e-6;
    let guard = verts.length * verts.length + 8;
    while (verts.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let i = 0; i < verts.length; i++) {
            const a = verts[(i + verts.length - 1) % verts.length];
            const b = verts[i];
            const c = verts[(i + 1) % verts.length];
            if (turn(a, b, c) <= 1e-6) continue;
            let ear = true;
            for (const point of verts) {
                if (point === a || point === b || point === c) continue;
                if (contains(point, a, b, c)) { ear = false; break; }
            }
            if (!ear) continue;
            tris.push([[a.x, a.y], [b.x, b.y], [c.x, c.y]]);
            verts.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped) break;
    }
    if (verts.length === 3) tris.push(verts.map(point => [point.x, point.y]));
    return tris;
}

function pointKey(point) {
    return (Math.round(point[0] * 100) / 100) + ',' + (Math.round(point[1] * 100) / 100);
}

function traceBoundary(pieces) {
    const count = new Map();
    const add = (a, b) => {
        const forward = pointKey(a) + '>' + pointKey(b);
        const back = pointKey(b) + '>' + pointKey(a);
        if ((count.get(back) || 0) > 0) {
            count.set(back, count.get(back) - 1);
            if (count.get(back) === 0) count.delete(back);
            return;
        }
        count.set(forward, (count.get(forward) || 0) + 1);
    };
    for (const piece of pieces) {
        if (piece.length < 3) continue;
        for (let i = 0; i < piece.length; i++) add(piece[i], piece[(i + 1) % piece.length]);
    }
    const next = new Map();
    for (const [edge, times] of count) {
        if (times <= 0) continue;
        const [from, to] = edge.split('>');
        if (!next.has(from)) next.set(from, []);
        next.get(from).push(to);
    }
    const used = new Set();
    const loops = [];
    for (const [from, tos] of next) {
        for (const to of tos) {
            if (used.has(from + '>' + to)) continue;
            const loop = [];
            let current = from;
            let upcoming = to;
            let guard = 0;
            while (guard++ < 5000 && !used.has(current + '>' + upcoming)) {
                used.add(current + '>' + upcoming);
                loop.push(current.split(',').map(Number));
                const choices = next.get(upcoming) || [];
                const step = choices.find(candidate => !used.has(upcoming + '>' + candidate));
                if (!step) break;
                current = upcoming;
                upcoming = step;
            }
            if (loop.length >= 3) loops.push(loop);
        }
    }
    loops.sort((p, q) => Math.abs(polyArea(q)) - Math.abs(polyArea(p)));
    return loops.length ? loops[0] : [];
}

export function polygonIntersection(subject, clip) {
    const zone = ccwRing(subject);
    const land = ccwRing(clip);
    if (zone.length < 3 || land.length < 3) return [];
    const pieces = [];
    for (const triangle of triangulate(land)) {
        const piece = clipToConvex(zone, triangle);
        if (piece.length >= 3) pieces.push(piece);
    }
    return traceBoundary(pieces);
}

export function downsampleRing(points, max = 80) {
    if (points.length <= max) return points.map(point => point.slice());
    const out = [];
    for (let i = 0; i < max; i++) out.push(points[Math.floor(i * points.length / max)].slice());
    return out;
}

function distToSeg(x, z, a, b) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len));
    return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

export function boundaryInset(x, z) {
    if (shape.samples && shape.samples.length >= 3) {
        let best = Infinity;
        const samples = shape.samples;
        for (let i = 0, j = samples.length - 1; i < samples.length; j = i++) {
            best = Math.min(best, distToSeg(x, z, samples[j], samples[i]));
        }
        return pointInPoly(x, z, samples) ? best : -best;
    }
    return Math.min(shape.half - x, shape.half + x, shape.half - z, shape.half + z);
}

function pullInside(x, z, minInset) {
    const samples = shape.samples;
    let cx = 0;
    let cz = 0;
    for (const point of samples) {
        cx += point[0];
        cz += point[1];
    }
    cx /= samples.length;
    cz /= samples.length;
    let px = x;
    let pz = z;
    for (let i = 0; i < 16; i++) {
        if (boundaryInset(px, pz) >= minInset) break;
        px += (cx - px) * 0.35;
        pz += (cz - pz) * 0.35;
    }
    return { x: px, z: pz };
}

function applyBoundary(x, z, h) {
    const inset = boundaryInset(x, z);
    if (shape.edge === 'sea') {
        if (inset >= 0) return h;
        const out = -inset;
        const beach = 10;
        const lip = WATER_LEVEL + 0.02;
        const bed = WATER_LEVEL - 2.2;
        if (out <= beach) {
            const t = out / beach;
            const s = t * t * (3 - 2 * t);
            return h * (1 - s) + lip * s;
        }
        const t = Math.min(1, (out - beach) / 12);
        const s = t * t * (3 - 2 * t);
        return lip * (1 - s) + bed * s;
    }
    if (inset < 42) {
        const u = Math.min(1, (42 - inset) / 42);
        const gentle = Math.min(u, 0.62);
        const cliff = Math.max(0, u - 0.62) / 0.38;
        return h + gentle * 5.5 + cliff * cliff * 26;
    }
    return h;
}

export function blocksClimb(x0, z0, x1, z1) {
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if (dist < 0.0001) return false;
    const steps = Math.max(1, Math.ceil(dist / 0.45));
    let prev = terrainHeight(x0, z0);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const y = terrainHeight(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
        if ((y - prev) / (dist / steps) > shape.maxSlope) return true;
        prev = y;
    }
    return false;
}

export function waterAt(x, z) {
    return terrainHeight(x, z) < WATER_LEVEL + 0.05;
}

export function swimRange() {
    return shape.swim;
}

export function swimTooFar(x, z) {
    if (!waterAt(x, z)) return false;
    const reach = shape.swim;
    const step = 4;
    for (let dz = -reach; dz <= reach; dz += step) {
        for (let dx = -reach; dx <= reach; dx += step) {
            if (dx * dx + dz * dz > reach * reach) continue;
            if (!waterAt(x + dx, z + dz)) return false;
        }
    }
    return true;
}

export function worldShape() {
    return {
        half: shape.half,
        edge: shape.edge,
        swim: shape.swim,
        maxSlope: shape.maxSlope,
        points: shape.points.map(point => point.slice()),
        edges: shape.edges.slice()
    };
}

export function worldBounds() {
    let half = shape.half;
    if (shape.samples) {
        for (const point of shape.samples) {
            half = Math.max(half, Math.abs(point[0]), Math.abs(point[1]));
        }
    }
    if (shape.edge === 'sea') half += shape.swim + 16;
    return { min: -half, max: half };
}

export function clampWorld(x, z, margin = 2) {
    if (shape.samples && shape.samples.length >= 3) {
        const allow = shape.edge === 'sea' ? -shape.swim : -margin;
        if (boundaryInset(x, z) >= allow) return { x, z };
        return pullInside(x, z, allow);
    }
    const limit = shape.half + (shape.edge === 'sea' ? shape.swim : -margin);
    return {
        x: Math.max(-limit, Math.min(limit, x)),
        z: Math.max(-limit, Math.min(limit, z))
    };
}

export function zoneInWorld(zx, zz) {
    return Math.abs(zx) <= WORLD_RADIUS && Math.abs(zz) <= WORLD_RADIUS;
}

export const FOG_CELL = 20;
export const FOG_RADIUS = 34;

export function fogKey(x, z) {
    const { min } = worldBounds();
    const ix = Math.floor((x - min) / FOG_CELL);
    const iz = Math.floor((z - min) / FOG_CELL);
    return ix + ',' + iz;
}

export function fogCellsAround(x, z, radius = FOG_RADIUS) {
    const { min, max } = worldBounds();
    const reach = Math.ceil(radius / FOG_CELL);
    const cx = Math.floor((x - min) / FOG_CELL);
    const cz = Math.floor((z - min) / FOG_CELL);
    const keys = [];
    const r2 = radius * radius;
    for (let iz = cz - reach; iz <= cz + reach; iz++) {
        for (let ix = cx - reach; ix <= cx + reach; ix++) {
            const wx = min + (ix + 0.5) * FOG_CELL;
            const wz = min + (iz + 0.5) * FOG_CELL;
            if (wx < min || wz < min || wx > max || wz > max) continue;
            if ((wx - x) ** 2 + (wz - z) ** 2 <= r2) keys.push(ix + ',' + iz);
        }
    }
    return keys;
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

export const CAMP_LAYOUTS = ['hamlet', 'outpost', 'market', 'shrine', 'ruin', 'ashes'];

const ROLE_OFFSET = {
    hamlet: { shop: [3.5, -2.4], trainer: [-3.6, -2.2], quest: [0.2, 3.5], inn: [0.4, 1.3], broker: [-1.8, -3.1] },
    outpost: { shop: [3.2, -2.8], trainer: [-0.6, -3.4], quest: [3.4, 2.2], inn: [-3.2, 0.4], broker: [2.2, 1.8] },
    market: { shop: [0.2, -3.1], trainer: [-3.4, 2.4], quest: [3.6, 2.2], inn: [0.1, 1.7], broker: [2.8, -0.6] },
    shrine: { shop: [4.4, 0.2], trainer: [-4.4, 0.6], quest: [0, 4.6], inn: [0.2, -4.2], broker: [-2.2, -3.2] },
    ruin: { shop: [3.4, -2.6], trainer: [-3.4, -2.2], quest: [0.6, 3.4], inn: [-0.2, 2.6], broker: [1.6, -3.8] },
    ashes: { shop: [2.8, -1.8], trainer: [-2.8, -1.4], quest: [0.2, 2.8], inn: [1.5, 1.5], broker: [-1.8, 2.4] }
};

export function campYaw(x, z) {
    return (chunkSeed(Math.round(x), Math.round(z)) % 4) * (Math.PI / 2);
}

export function campSpot(layout, role, x, z) {
    const table = ROLE_OFFSET[layout] || ROLE_OFFSET.hamlet;
    const local = table[role] || [0, 2.5];
    const yaw = campYaw(x, z);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return { x: x + local[0] * c - local[1] * s, z: z + local[0] * s + local[1] * c };
}

export function zoneCampPlan(zx, zz) {
    const camp = zoneCamp(zx, zz);
    const place = zoneName(zx, zz);
    const h = chunkSeed(zx + 3, zz + 9);
    const layout = CAMP_LAYOUTS[h % CAMP_LAYOUTS.length];
    const roll = (h >>> 4) % 6;
    const shopName = CAMP_NAMES[h % CAMP_NAMES.length];
    let trainName = CAMP_NAMES[(h >>> 8) % CAMP_NAMES.length];
    if (trainName === shopName) trainName = CAMP_NAMES[(h + 7) % CAMP_NAMES.length];
    const questName = CAMP_NAMES[(h >>> 16) % CAMP_NAMES.length];
    let innName = CAMP_NAMES[(h >>> 12) % CAMP_NAMES.length];
    if (innName === shopName || innName === trainName || innName === questName) innName = CAMP_NAMES[(h + 11) % CAMP_NAMES.length];
    let brokerName = CAMP_NAMES[(h >>> 20) % CAMP_NAMES.length];
    if (brokerName === shopName || brokerName === trainName || brokerName === questName || brokerName === innName) brokerName = CAMP_NAMES[(h + 5) % CAMP_NAMES.length];
    const folk = [];
    folk.push({ id: 'inn-' + zx + '-' + zz, name: innName, role: 'inn', title: 'Innkeeper', tint: '#e67e22', text: 'I keep the inn in ' + place + '. Set your rest here, then press H to return.' });
    folk.push({ id: 'broker-' + zx + '-' + zz, name: brokerName, role: 'broker', title: 'Market broker', tint: '#d4a017', text: 'I keep the market board in ' + place + '. List bag goods, or buy what others have listed.' });
    if (roll === 0 || roll === 3) {
        folk.push({ id: 'shop-' + zx + '-' + zz, name: shopName, role: 'shop', title: 'Shop', tint: '#f1c40f', text: 'I buy goods and sell crafting skills in ' + place + '.' });
    }
    if (roll === 1 || roll === 3 || roll === 5) {
        folk.push({ id: 'train-' + zx + '-' + zz, name: trainName, role: 'trainer', title: 'Trainer', tint: '#5dade2', text: 'I train spells and crafting tiers in ' + place + '.' });
    }
    if (roll === 2 || roll === 5) {
        folk.push({ id: 'quest-' + zx + '-' + zz, name: questName, role: 'quest', title: 'Quest giver', tint: '#2ecc71', text: 'Travelers still stop in ' + place + '.', quest: '' });
    }
    for (const person of folk) {
        const spot = campSpot(layout, person.role, camp.x, camp.z);
        person.x = spot.x;
        person.z = spot.z;
    }
    return { id: 'camp-' + zx + '-' + zz, x: camp.x, z: camp.z, layout, folk };
}

const SELL_RARITY = {
    junk: 1, wood: 1, stone: 1, herb: 1, powder: 1,
    cloth: 2, leather: 2, health: 2, mana: 2, bomb: 2,
    ore: 3, armor: 3, weapon: 3, silk: 3, bag: 4, recipe: 4, gem: 5
};

export function itemRarity(item) {
    if (!item) return 1;
    return SELL_RARITY[item.kind] || 1;
}

export function sellPrice(item) {
    if (!item) return 0;
    const rarity = itemRarity(item);
    const stats = item.stats || {};
    const bonus = (stats.strength || 0) + (stats.stamina || 0) + (stats.intellect || 0);
    let quality = 1 + (item.armor || 0) + bonus;
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

const MOB_IDS = ['boar', 'wolf', 'spider', 'bandit', 'ogre', 'wisp', 'knight', 'cultist'];
const NODE_TYPES = ['tree', 'rock', 'plain-tree', 'plain-rock', 'herb', 'sulfur'];
let designedZones = [];
let designedNodes = [];

function pointInPoly(x, z, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i][0];
        const zi = points[i][1];
        const xj = points[j][0];
        const zj = points[j][1];
        const crosses = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi;
        if (crosses) inside = !inside;
    }
    return inside;
}

export function applyWorldConfig(config) {
    heightCache.clear();
    const bounds = config && config.bounds && typeof config.bounds === 'object' ? config.bounds : {};
    const half = Number(bounds.half);
    shape.half = Number.isFinite(half) ? Math.max(200, Math.min(2000, half)) : 900;
    shape.edge = bounds.edge === 'sea' ? 'sea' : 'hills';
    const swim = Number(bounds.swim);
    shape.swim = Number.isFinite(swim) ? Math.max(4, Math.min(40, swim)) : 14;
    const slope = Number(bounds.maxSlope);
    shape.maxSlope = Number.isFinite(slope) ? Math.max(0.3, Math.min(1.4, slope)) : 0.7;
    const rawPoints = Array.isArray(bounds.points) ? bounds.points : [];
    shape.points = rawPoints.slice(0, 80).map(point => [Number(point[0]), Number(point[1])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (shape.points.length < 3) shape.points = [];
    shape.edges = shape.points.map((_, index) => (bounds.edges && bounds.edges[index] === 'organic' ? 'organic' : 'line'));
    shape.samples = shape.points.length >= 3 ? curvePoints(shape.points, shape.edges, true) : null;
    designedZones = [];
    designedNodes = [];
    designedRoads = [];
    const zones = Array.isArray(config && config.zones) ? config.zones : [];
    for (const zone of zones.slice(0, 24)) {
        const points = (Array.isArray(zone.points) ? zone.points : []).slice(0, 80).map(point => [Number(point[0]), Number(point[1])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (points.length < 3) continue;
        const edges = points.map((_, index) => (zone.edges && zone.edges[index] === 'organic' ? 'organic' : 'line'));
        const entry = {
            id: String(zone.id || ('zone-' + designedZones.length)).slice(0, 24),
            name: String(zone.name || 'Zone').slice(0, 32),
            points,
            edges,
            samples: curvePoints(points, edges, true),
            minX: Infinity,
            maxX: -Infinity,
            minZ: Infinity,
            maxZ: -Infinity,
            mob: MOB_IDS.includes(zone.mob) ? zone.mob : 'boar',
            level: Math.max(1, Math.min(30, Math.round(Number(zone.level) || 1))),
            hp: Math.max(0, Math.min(500, Math.round(Number(zone.hp) || 0))),
            loot: String(zone.loot || 'hide').slice(0, 24),
            elite: !!zone.elite,
            perMin: Number.isFinite(Number(zone.perMin)) ? Math.max(0, Math.min(30, Math.round(Number(zone.perMin)))) : 4,
            cap: Number.isFinite(Number(zone.cap)) ? Math.max(0, Math.min(40, Math.round(Number(zone.cap)))) : 8,
            camps: [],
            nodes: []
        };
        for (const point of entry.samples) {
            if (point[0] < entry.minX) entry.minX = point[0];
            if (point[0] > entry.maxX) entry.maxX = point[0];
            if (point[1] < entry.minZ) entry.minZ = point[1];
            if (point[1] > entry.maxZ) entry.maxZ = point[1];
        }
        for (const camp of (Array.isArray(zone.camps) ? zone.camps : []).slice(0, 6)) {
            const x = Number(camp.x);
            const z = Number(camp.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            entry.camps.push({
                x, z,
                layout: CAMP_LAYOUTS.includes(camp.layout) ? camp.layout : 'hamlet',
                shop: String(camp.shop || '').trim().slice(0, 16),
                trainer: String(camp.trainer || '').trim().slice(0, 16),
                quest: String(camp.quest || '').trim().slice(0, 16),
                inn: String(camp.inn || 'Innkeeper').trim().slice(0, 16) || 'Innkeeper',
                broker: camp.broker == null ? 'Broker' : String(camp.broker).trim().slice(0, 16),
                travel: !!camp.travel
            });
        }
        for (const node of (Array.isArray(zone.nodes) ? zone.nodes : []).slice(0, 160)) {
            const x = Number(node.x);
            const z = Number(node.z);
            if (!Number.isFinite(x) || !Number.isFinite(z) || !NODE_TYPES.includes(node.type)) continue;
            const placed = { type: node.type, x, z };
            entry.nodes.push(placed);
            designedNodes.push(placed);
        }
        designedZones.push(entry);
    }
    if (!designedZones.some(zone => zone.camps.some(camp => camp.travel))) {
        for (const zone of designedZones) {
            if (!zone.camps.length) continue;
            zone.camps[0].travel = true;
            break;
        }
    }
    const roads = Array.isArray(config && config.roads) ? config.roads : [];
    for (const road of roads.slice(0, 40)) {
        const points = (Array.isArray(road.points) ? road.points : []).slice(0, 24).map(point => [Number(point[0]), Number(point[1])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (points.length < 2) continue;
        const edges = [];
        for (let i = 0; i < points.length - 1; i++) edges.push(road.edges && road.edges[i] === 'organic' ? 'organic' : 'line');
        designedRoads.push({
            id: String(road.id || ('road-' + designedRoads.length)).slice(0, 24),
            points,
            edges
        });
    }
    rebuildRoads();
    loadDungeons(config);
}

let mapBook = [];
let activeMapId = '';

function captureMap() {
    return {
        shape: {
            half: shape.half,
            edge: shape.edge,
            swim: shape.swim,
            maxSlope: shape.maxSlope,
            points: shape.points,
            edges: shape.edges,
            samples: shape.samples
        },
        designedZones,
        designedNodes,
        designedRoads,
        roadSamples,
        designedDungeons,
        heightCache
    };
}

function restoreMap(snap) {
    shape.half = snap.shape.half;
    shape.edge = snap.shape.edge;
    shape.swim = snap.shape.swim;
    shape.maxSlope = snap.shape.maxSlope;
    shape.points = snap.shape.points;
    shape.edges = snap.shape.edges;
    shape.samples = snap.shape.samples;
    designedZones = snap.designedZones;
    designedNodes = snap.designedNodes;
    designedRoads = snap.designedRoads;
    roadSamples = snap.roadSamples;
    designedDungeons = snap.designedDungeons;
    heightCache = snap.heightCache;
}

export function installMaps(entries) {
    const list = Array.isArray(entries) ? entries : [];
    mapBook = [];
    activeMapId = '';
    for (const entry of list) {
        if (!entry || !entry.id) continue;
        heightCache = new Map();
        applyWorldConfig(entry);
        mapBook.push({
            id: String(entry.id),
            name: String(entry.name || 'Lands'),
            minLevel: Math.max(1, Math.min(60, Math.round(Number(entry.minLevel) || 1))),
            maxLevel: Math.max(0, Math.min(60, Math.round(Number(entry.maxLevel) || 0))),
            snap: captureMap()
        });
    }
    if (mapBook.length) activateMap(mapBook[0].id);
}

export function activateMap(id) {
    const map = mapBook.find(entry => entry.id === id) || mapBook[0];
    if (!map) return '';
    if (map.id === activeMapId) return map.id;
    restoreMap(map.snap);
    activeMapId = map.id;
    return map.id;
}

export function currentMapId() {
    return activeMapId;
}

export function mapBriefs() {
    return mapBook.map(map => ({
        id: map.id,
        name: map.name,
        minLevel: map.minLevel,
        maxLevel: map.maxLevel
    }));
}

export function customMap() {
    return designedZones.length > 0;
}

export function designedZoneAt(x, z) {
    for (let i = designedZones.length - 1; i >= 0; i--) {
        if (pointInPoly(x, z, designedZones[i].samples || designedZones[i].points)) return designedZones[i];
    }
    return null;
}

export function listDesignedZones() {
    return designedZones.map(zone => ({
        id: zone.id,
        name: zone.name,
        points: zone.points,
        edges: zone.edges,
        mob: zone.mob,
        level: zone.level,
        hp: zone.hp,
        loot: zone.loot,
        elite: !!zone.elite,
        perMin: zone.perMin,
        cap: zone.cap,
        camps: zone.camps,
        nodes: zone.nodes
    }));
}

const DUNGEON_SHIFT = 90000;
export const DUNGEON_HALF = 3.6;
let designedDungeons = [];

function loadDungeons(config) {
    designedDungeons = [];
    const list = Array.isArray(config && config.dungeons) ? config.dungeons : [];
    for (const raw of list.slice(0, 12)) {
        const points = (Array.isArray(raw.points) ? raw.points : []).slice(0, 18).map(point => [Number(point[0]), Number(point[1])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
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
            props.push({ type, x, z });
        }
        const id = String(raw.id || ('dungeon-' + designedDungeons.length)).slice(0, 24);
        designedDungeons.push({
            id,
            name: String(raw.name || 'Cavern').slice(0, 32),
            mob: MOB_IDS.includes(raw.mob) ? raw.mob : 'spider',
            level: Math.max(1, Math.min(30, Math.round(Number(raw.level) || 1))),
            elite: !!raw.elite,
            endName: String(raw.endName || 'Warden').slice(0, 24),
            portal: { x: px, z: pz },
            points,
            edges,
            props,
            samples: curvePoints(points, edges, false),
            index: designedDungeons.length
        });
    }
    ensureStoryDungeon();
}

function ensureStoryDungeon() {
    if (customMap()) return;
    if (designedDungeons.some(dungeon => dungeon.id === 'chapel')) return;
    const points = [[0, 0], [0, 16], [5, 28], [5, 42], [0, 54]];
    const edges = ['line', 'line', 'line', 'line'];
    const props = [
        { type: 'pillar', x: -2.2, z: 8 },
        { type: 'pillar', x: 2.2, z: 8 },
        { type: 'root', x: -2.3, z: 22 },
        { type: 'rock', x: 2.3, z: 34 },
        { type: 'pillar', x: -2.2, z: 46 },
        { type: 'pillar', x: 2.2, z: 46 }
    ];
    designedDungeons.push({
        id: 'chapel',
        name: 'Drowned Chapel',
        mob: 'cultist',
        level: 6,
        elite: true,
        endName: 'Drowned Prior',
        instanced: true,
        portal: { x: 168, z: 24 },
        points,
        edges,
        props,
        samples: curvePoints(points, edges, false),
        index: designedDungeons.length
    });
}

export function listDungeons() {
    return designedDungeons.map(dungeon => ({
        id: dungeon.id,
        name: dungeon.name,
        mob: dungeon.mob,
        level: dungeon.level,
        elite: dungeon.elite,
        endName: dungeon.endName,
        instanced: !!dungeon.instanced,
        portal: { x: dungeon.portal.x, z: dungeon.portal.z },
        points: dungeon.points,
        edges: dungeon.edges,
        props: dungeon.props,
        index: dungeon.index
    }));
}

export function dungeonById(id) {
    return designedDungeons.find(dungeon => dungeon.id === id) || null;
}

export function dungeonWorld(dungeon, x, z) {
    return { x: DUNGEON_SHIFT + dungeon.index * 700 + x, z };
}

export function dungeonLocal(dungeon, x, z) {
    return { x: x - (DUNGEON_SHIFT + dungeon.index * 700), z };
}

function projectSamples(samples, x, z) {
    let best = null;
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        const abx = b[0] - a[0];
        const abz = b[1] - a[1];
        const len2 = abx * abx + abz * abz || 1e-6;
        const rawT = ((x - a[0]) * abx + (z - a[1]) * abz) / len2;
        let t = rawT;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const px = a[0] + abx * t;
        const pz = a[1] + abz * t;
        const dist = Math.hypot(x - px, z - pz);
        if (!best || dist < best.dist) best = { dist, x: px, z: pz, rawT, abx, abz };
    }
    return best;
}

export function dungeonClamp(dungeon, x, z, pad = 0.75) {
    const local = dungeonLocal(dungeon, x, z);
    const samples = dungeon.samples && dungeon.samples.length ? dungeon.samples : dungeon.points;
    const best = projectSamples(samples, local.x, local.z);
    if (!best) return dungeonWorld(dungeon, samples[0][0], samples[0][1]);
    let lx = local.x;
    let lz = local.z;
    const px = best.x;
    const pz = best.z;
    if (best.rawT < 0 || best.rawT > 1) {
        const len = Math.hypot(best.abx, best.abz) || 1;
        const fx = best.abx / len;
        const fz = best.abz / len;
        const relx = lx - px;
        const relz = lz - pz;
        const along = relx * fx + relz * fz;
        lx = px + relx - fx * along;
        lz = pz + relz - fz * along;
    }
    const dx = lx - px;
    const dz = lz - pz;
    const dist = Math.hypot(dx, dz);
    const limit = Math.max(1.2, DUNGEON_HALF - pad);
    if (dist <= limit) return dungeonWorld(dungeon, lx, lz);
    return dungeonWorld(dungeon, px + (dx / dist) * limit, pz + (dz / dist) * limit);
}

export function dungeonTravel(dungeon, x, z) {
    const local = dungeonLocal(dungeon, x, z);
    const samples = dungeon.samples && dungeon.samples.length ? dungeon.samples : dungeon.points;
    let best = null;
    let walked = 0;
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        const abx = b[0] - a[0];
        const abz = b[1] - a[1];
        const len = Math.hypot(abx, abz);
        const len2 = abx * abx + abz * abz || 1e-6;
        let t = ((local.x - a[0]) * abx + (local.z - a[1]) * abz) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const px = a[0] + abx * t;
        const pz = a[1] + abz * t;
        const dist = Math.hypot(local.x - px, local.z - pz);
        const along = walked + len * t;
        if (!best || dist < best.dist) best = { dist, along };
        walked += len;
    }
    return best ? best.along : 0;
}

export function dungeonBlocked(dungeon, x0, z0, x1, z1) {
    const end = dungeonLocal(dungeon, x1, z1);
    for (const prop of dungeon.props || []) {
        const dx = end.x - prop.x;
        const dz = end.z - prop.z;
        if (dx * dx + dz * dz < 0.85 * 0.85) return true;
    }
    const kept = dungeonClamp(dungeon, x1, z1);
    return Math.hypot(kept.x - x1, kept.z - z1) > 0.35;
}

function appendDesignedNodes(cx, cz, items) {
    for (const node of designedNodes) {
        if (Math.floor(node.x / CHUNK_SIZE) !== cx || Math.floor(node.z / CHUNK_SIZE) !== cz) continue;
        if (terrainHeight(node.x, node.z) < WATER_LEVEL + 0.35) continue;
        if (boundaryInset(node.x, node.z) < 4) continue;
        if (!designedZoneAt(node.x, node.z)) continue;
        const index = items.length;
        const bulky = node.type === 'rock' || node.type === 'plain-rock';
        const sulfur = node.type === 'sulfur';
        const hits = node.type === 'tree' ? 3 : node.type === 'herb' ? 2 : node.type === 'sulfur' ? 3 : node.type === 'rock' ? 4 : 0;
        items.push({
            id: `${cx},${cz},${index}`,
            type: node.type,
            x: node.x,
            z: node.z,
            px: node.x - cx * CHUNK_SIZE,
            pz: node.z - cz * CHUNK_SIZE,
            sx: bulky ? 1.1 : sulfur ? 0.45 : 0,
            sy: bulky ? 0.7 : sulfur ? 0.7 : 0,
            sz: bulky ? 1.1 : sulfur ? 0.45 : 0,
            hits,
            placed: hits > 0
        });
    }
}