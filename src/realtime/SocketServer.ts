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

  // No auth — just require a username in the handshake
  io.use((socket, next) => {
    const username = socket.handshake.auth?.username as string | undefined;
    if (!username || username.trim() === '') {
      return next(new Error('A username is required to connect'));
    }
    socket.data.userId = socket.id; // use socket ID as player ID for simplicity
    socket.data.username = username.trim();
    next();
  });

  return io;
}
