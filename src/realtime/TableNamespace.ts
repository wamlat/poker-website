import { Server, Socket } from 'socket.io';
import { GameService } from '../services/GameService';
import { TableService } from '../services/TableService';
import { HandEvent } from '../types';
import { AuthenticatedSocket } from './SocketServer';

const gameService = new GameService();
const tableService = new TableService();

/** Maps hand event types from the FSM to Socket.io event names */
const EVENT_MAP: Record<string, string> = {
  hand_started: 'hand:started',
  cards_dealt: 'hand:cards_dealt',
  community_dealt: 'hand:community_dealt',
  action_required: 'hand:action_required',
  action_taken: 'hand:action_taken',
  showdown: 'hand:showdown',
  hand_complete: 'hand:complete',
};

export function registerTableHandlers(io: Server): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.data.userId;

    /** Emit FSM events to the appropriate recipients */
    const emit = (eventType: string, payload: unknown, privateToPlayerId?: string) => {
      const socketEvent = EVENT_MAP[eventType] ?? eventType;
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      if (privateToPlayerId) {
        // Send only to the specific player's socket(s)
        const targetSockets = Array.from(io.sockets.sockets.values()).filter(
          (s) => (s as AuthenticatedSocket).data.userId === privateToPlayerId,
        );
        for (const s of targetSockets) {
          s.emit(socketEvent, payload);
        }
      } else {
        io.to(`table:${tableId}`).emit(socketEvent, payload);
      }
    };

    socket.on('hand:action', async (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      await gameService.processAction(
        tableId,
        {
          handId: payload.handId,
          playerId: userId,
          seatIndex: -1, // will be resolved from snapshot in GameService
          action: payload.action,
          amount: payload.amount,
        },
        emit,
      );
    });

    socket.on('table:leave', async () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      try {
        await tableService.leaveTable(tableId, userId);
        socket.leave(`table:${tableId}`);
        io.to(`table:${tableId}`).emit('table:player_left', { playerId: userId });
        socket.data.currentTableId = undefined;
      } catch (err) {
        console.error('[Table] leave error:', err);
      }
    });

    socket.on('disconnect', async () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (tableId) {
        // Don't auto-leave on disconnect — timer keeps the hand going
        // Player can reconnect and resume
        io.to(`table:${tableId}`).emit('table:player_left', {
          seatIndex: -1,
          playerId: userId,
        });
      }
    });

    // Allow the game to be started from any table event (e.g., after enough players join)
    // In practice you'd call this after checking player count — here it's a simple trigger
    socket.on('table:start_hand', async () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      await gameService.startHand(tableId, emit);
    });
  });
}
