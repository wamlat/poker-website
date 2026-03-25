import { Server } from 'socket.io';
import { tableService } from '../services';
import { AuthenticatedSocket } from './SocketServer';

/** Strip pendingJoinRequests for non-host recipients */
function tableStateFor(state: ReturnType<typeof tableService.getTableState>, recipientId: string) {
  if (!state) return state;
  const { pendingJoinRequests, ...rest } = state;
  return recipientId === state.hostPlayerId
    ? { ...rest, pendingJoinRequests }
    : { ...rest, pendingJoinRequests: [] };
}

export function registerLobbyHandlers(io: Server): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.data.userId;

    // ── Auto-restore: player reconnected while still seated ─────────────────
    const seatedTable = tableService.listTables().find((t) =>
      t.seats.some((s) => s?.playerId === userId),
    );
    if (seatedTable) {
      const tableId = seatedTable.config.tableId;
      tableService.cancelLeave(tableId, userId);
      socket.join(`table:${tableId}`);
      socket.data.currentTableId = tableId;
      const stateForClient = tableStateFor(seatedTable, userId);
      socket.emit('table:state', { ...stateForClient, isYouHost: userId === seatedTable.hostPlayerId });
      return; // skip lobby
    }

    socket.join('lobby');
    socket.emit('lobby:table_list', tableService.listTables().map((t) => tableStateFor(t, userId)));

    socket.on('lobby:list_tables', () => {
      socket.emit('lobby:table_list', tableService.listTables().map((t) => tableStateFor(t, userId)));
    });

    socket.on('lobby:create_table', (payload) => {
      try {
        const state = tableService.createTable(payload, userId);
        const tableId = state.config.tableId;

        // Auto-seat the host
        const { state: seatedState, seatIndex } = tableService.joinTable(
          tableId, userId, socket.data.username, payload.buyIn ?? state.config.minBuyIn,
        );

        socket.join(`table:${tableId}`);
        socket.data.currentTableId = tableId;

        socket.emit('table:state', {
          ...tableStateFor(seatedState, userId),
          isYouHost: true,
        });

        // Also emit player_joined so other lobby observers can update seat counts
        socket.to(`table:${tableId}`).emit('table:player_joined', {
          seatIndex,
          playerId: userId,
          displayName: socket.data.username,
          stack: seatedState.seats[seatIndex]!.stack,
        });

        io.to('lobby').emit('lobby:table_updated', tableStateFor(seatedState, ''));
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'CREATE_TABLE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to create table',
        });
      }
    });

    // Direct join kept for backward-compat / host re-join edge cases
    socket.on('lobby:join_table', (payload) => {
      try {
        const { state, seatIndex } = tableService.joinTable(
          payload.tableId,
          userId,
          socket.data.username,
          payload.buyIn,
          payload.seatIndex,
        );

        socket.join(`table:${payload.tableId}`);
        socket.data.currentTableId = payload.tableId;

        socket.emit('table:state', {
          ...tableStateFor(state, userId),
          isYouHost: userId === state.hostPlayerId,
        });
        socket.to(`table:${payload.tableId}`).emit('table:player_joined', {
          seatIndex,
          playerId: userId,
          displayName: socket.data.username,
          stack: payload.buyIn,
        });

        io.to('lobby').emit('lobby:table_updated', tableStateFor(state, ''));
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'JOIN_TABLE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to join table',
        });
      }
    });

    // ── Join request flow ────────────────────────────────────────────────────

    socket.on('lobby:request_join', (payload: {
      tableId: string;
      buyIn: number;
      preferredSeatIndex: number | null;
    }) => {
      try {
        const request = tableService.addJoinRequest(
          payload.tableId,
          userId,
          socket.data.username,
          payload.buyIn,
          payload.preferredSeatIndex,
        );

        // Tell requester their request was received
        socket.emit('table:join_requested', { request, tableId: payload.tableId });

        // Notify the host
        const state = tableService.getTableState(payload.tableId);
        if (state) {
          for (const s of Array.from(io.sockets.sockets.values())) {
            const sock = s as AuthenticatedSocket;
            if (sock.data.userId === state.hostPlayerId) {
              sock.emit('table:join_request_received', { request, tableId: payload.tableId });
            }
          }
        }
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'JOIN_REQUEST_FAILED',
          message: err instanceof Error ? err.message : 'Failed to submit request',
        });
      }
    });

    socket.on('lobby:cancel_join_request', (payload: { tableId: string }) => {
      tableService.cancelJoinRequest(payload.tableId, userId);
      // Notify host
      const state = tableService.getTableState(payload.tableId);
      if (state) {
        for (const s of Array.from(io.sockets.sockets.values())) {
          const sock = s as AuthenticatedSocket;
          if (sock.data.userId === state.hostPlayerId) {
            sock.emit('table:join_request_cancelled', { tableId: payload.tableId, playerId: userId });
          }
        }
      }
    });
  });
}
