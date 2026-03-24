import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { config } from './config';
import { PlayerService } from './services/PlayerService';
import { HandRepository } from './repositories/HandRepository';
import { createSocketServer } from './realtime/SocketServer';
import { registerLobbyHandlers } from './realtime/LobbyNamespace';
import { registerTableHandlers } from './realtime/TableNamespace';

const app = express();
app.use(express.json());

const playerService = new PlayerService();
const handRepo = new HandRepository();

// ─── REST API ─────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const result = await playerService.register(username, email, password);
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const token = await playerService.login(username, password);
    res.json({ token });
  } catch (err: unknown) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed' });
  }
});

app.get('/api/profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = playerService.verifyToken(token);
    const profile = await playerService.getProfile(payload.userId);
    res.json(profile);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/hands/:handId', async (req, res) => {
  try {
    const hand = await handRepo.getHandById(req.params.handId);
    if (!hand) return res.status(404).json({ error: 'Hand not found' });
    res.json(hand);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tables/:tableId/hands', async (req, res) => {
  try {
    const hands = await handRepo.getHandsForTable(req.params.tableId);
    res.json(hands);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const io = createSocketServer(httpServer);

registerLobbyHandlers(io);
registerTableHandlers(io);

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`);
  console.log(`[Server] WebSocket ready`);
});

export { app, io };
