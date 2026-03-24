import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { PlayerService } from '../services/PlayerService';
import { JwtPayload } from '../types';

const playerService = new PlayerService();

export interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
    username: string;
  };
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: '*', // tighten this in production
      methods: ['GET', 'POST'],
    },
  });

  // Auth middleware — requires a valid JWT in handshake auth
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload: JwtPayload = playerService.verifyToken(token);
      socket.data.userId = payload.userId;
      socket.data.username = payload.username;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  return io;
}
