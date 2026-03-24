import { Server } from 'socket.io';
import { TableService } from '../services/TableService';
import { AuthenticatedSocket } from './SocketServer';

const tableService = new TableService();

export function registerLobbyHandlers(io: Server): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    socket.join('lobby');

    socket.emit('lobby:table_list', tableService.listTables());

    socket.on('lobby:list_tables', () => {
      socket.emit('lobby:table_list', tableService.listTables());
    });

    socket.on('lobby:create_table', (payload) => {
      try {
        const state = tableService.createTable(payload, socket.data.userId);
        socket.emit('lobby:table_created', state);
        io.to('lobby').emit('lobby:table_updated', state);
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'CREATE_TABLE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to create table',
        });
      }
    });

    socket.on('lobby:join_table', (payload) => {
      try {
        const { state, seatIndex } = tableService.joinTable(
          payload.tableId,
          socket.data.userId,
          socket.data.username,
          payload.buyIn,
          payload.seatIndex,
        );

        socket.join(`table:${payload.tableId}`);
        socket.data.currentTableId = payload.tableId;

        socket.emit('table:state', { ...state, isYouHost: socket.data.userId === state.hostPlayerId });
        socket.to(`table:${payload.tableId}`).emit('table:player_joined', {
          seatIndex,
          playerId: socket.data.userId,
          displayName: socket.data.username,
          stack: payload.buyIn,
        });

        io.to('lobby').emit('lobby:table_updated', state);
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'JOIN_TABLE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to join table',
        });
      }
    });
  });
}
