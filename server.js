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
                save.players[persistentId] = { name, wood: 0, stone: 0, color: colorFor(persistentId) };
            } else if (data.name) {
                save.players[persistentId].name = name;
            }
            const prof = save.players[persistentId];
            if (!prof.color) prof.color = colorFor(persistentId);

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
                wood: prof.wood || 0,
                stone: prof.stone || 0,
                lastGather: 0
            };
            players.set(persistentId, player);
            sessionId = persistentId;
            scheduleSave();

            send(ws, {
                type: 'welcome',
                id: persistentId,
                name: player.name,
                color: player.color,
                inventory: { wood: player.wood, stone: player.stone },
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
            if (data.tool === 'axe' || data.tool === 'pickaxe') player.tool = data.tool;
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
                send(ws, { type: 'gatherResult', ok: false, reason: 'Already gone', id: node.id, hits: 0, inventory: { wood: player.wood, stone: player.stone } });
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
            save.resources[node.id] = next;
            let gained = null;
            if (next <= 0) {
                if (node.type === 'tree') {
                    player.wood += 1;
                    gained = 'wood';
                } else {
                    player.stone += 1;
                    gained = 'stone';
                }
                save.players[player.persistentId].wood = player.wood;
                save.players[player.persistentId].stone = player.stone;
            }
            scheduleSave();
            broadcast({ type: 'resource', id: node.id, hits: next });
            send(ws, {
                type: 'gatherResult',
                ok: true,
                id: node.id,
                hits: next,
                gained,
                inventory: { wood: player.wood, stone: player.stone }
            });
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
