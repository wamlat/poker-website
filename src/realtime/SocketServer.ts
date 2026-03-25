import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

export interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
    username: string;
    currentTableId?: string;
  };
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.use((socket, next) => {
    const username = socket.handshake.auth?.username as string | undefined;
    const playerId = socket.handshake.auth?.playerId as string | undefined;
    if (!username || username.trim() === '') {
      return next(new Error('A username is required to connect'));
    }
    if (!playerId || !/^[a-zA-Z0-9_-]{8,64}$/.test(playerId)) {
      return next(new Error('A valid playerId is required'));
    }
    socket.data.userId = playerId;
    socket.data.username = username.trim();
    next();
  });

  return io;
}
