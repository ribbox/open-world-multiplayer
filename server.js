const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files (index.html with embedded model)
app.use(express.static(path.join(__dirname)));

// Simple multiplayer state
const players = new Map(); // id -> { x, y, z, rotY, tool, name }

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 10);
  players.set(id, { x: 0, y: 0, z: 0, rotY: 0, tool: 'axe', name: 'Player' });

  // Send welcome + current players
  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    players: Array.from(players.entries()).map(([pid, p]) => ({ id: pid, ...p }))
  }));

  // Notify others
  broadcast({ type: 'join', id, ...players.get(id) }, ws);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'update' && players.has(id)) {
        const p = players.get(id);
        p.x = data.x ?? p.x;
        p.y = data.y ?? p.y;
        p.z = data.z ?? p.z;
        p.rotY = data.rotY ?? p.rotY;
        p.tool = data.tool ?? p.tool;
        // Broadcast to others
        broadcast({ type: 'update', id, ...p }, ws);
      }
    } catch (e) {
      console.error('Bad message', e);
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id });
  });
});

server.listen(PORT, () => {
  console.log(`Open World server running on http://0.0.0.0:${PORT}`);
});
