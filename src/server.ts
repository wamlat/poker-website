import express from 'express';
import { createServer } from 'http';
import { config } from './config';
import { createSocketServer } from './realtime/SocketServer';
import { registerLobbyHandlers } from './realtime/LobbyNamespace';
import { registerTableHandlers } from './realtime/TableNamespace';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const httpServer = createServer(app);
const io = createSocketServer(httpServer);

registerLobbyHandlers(io);
registerTableHandlers(io);

httpServer.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`);
});

export { app, io };
