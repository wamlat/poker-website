import { Server } from 'socket.io';
import { GameService } from '../services/GameService';
import { TableService } from '../services/TableService';
import { HandEvent } from '../types';
import { AuthenticatedSocket } from './SocketServer';

const gameService = new GameService();
const tableService = new TableService();

/** Maps hand event types from the FSM to Socket.io event names */
const EVENT_MAP: Record<string, string> = {
  hand_started:    'hand:started',
  cards_dealt:     'hand:cards_dealt',
  community_dealt: 'hand:community_dealt',
  run_two_board:   'hand:run_two_board',
  action_required: 'hand:action_required',
  action_taken:    'hand:action_taken',
  showdown:        'hand:showdown',
  rabbit_cards:    'hand:rabbit',
  hand_complete:   'hand:complete',
  rit_vote_needed: 'hand:rit_vote_request',
  hand_error:      'hand:error',
};

/**
 * Creates a table-scoped emit function that does NOT depend on any individual
 * socket's connection state. Safe to capture in delayed callbacks (auto-deal,
 * action timers, RIT vote timeouts) because it reads tableId from its closure,
 * not from socket.data.currentTableId at call time.
 */
function makeTableEmit(io: Server, tableId: string) {
  return (eventType: string, payload: unknown, privateToPlayerId?: string) => {
    const socketEvent = EVENT_MAP[eventType] ?? eventType;
    if (privateToPlayerId) {
      const targetSockets = Array.from(io.sockets.sockets.values()).filter(
        (s) => (s as AuthenticatedSocket).data.userId === privateToPlayerId,
      );
      for (const s of targetSockets) s.emit(socketEvent, payload);
    } else {
      io.to(`table:${tableId}`).emit(socketEvent, payload);
    }
  };
}

export function registerTableHandlers(io: Server): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.data.userId;

    socket.on('hand:action', async (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      await gameService.processAction(
        tableId,
        {
          handId: payload.handId,
          playerId: userId,
          seatIndex: -1,
          action: payload.action,
          amount: payload.amount,
        },
        makeTableEmit(io, tableId),
      );
    });

    socket.on('hand:reveal_cards', () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      const holeCards = gameService.getLastHandHoleCards(tableId, userId);
      if (!holeCards?.length) return;

      const state = tableService.getTableState(tableId);
      if (!state) return;

      const seat = state.seats.find((s) => s?.playerId === userId);
      if (!seat) return;

      io.to(`table:${tableId}`).emit('hand:cards_revealed', {
        seatIndex: seat.seatIndex,
        playerId: userId,
        holeCards,
      });
    });

    socket.on('table:start_hand', () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      const state = tableService.getTableState(tableId);
      if (!state || state.hostPlayerId !== userId) return;
      // Cancel any pending auto-deal when host manually starts
      gameService.cancelAutoDeal(tableId);
      const started = gameService.startHand(tableId, makeTableEmit(io, tableId));
      if (!started) {
        socket.emit('hand:error', { code: 'CANNOT_START', message: 'Need at least 2 players with enough chips' });
      }
    });

    socket.on('table:adjust_chips', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      try {
        const state = tableService.adjustChips(tableId, userId, payload.targetPlayerId, payload.amount);
        const seat = state.seats.find((s) => s?.playerId === payload.targetPlayerId);
        if (!seat) return;

        io.to(`table:${tableId}`).emit('table:chips_adjusted', {
          targetPlayerId: payload.targetPlayerId,
          seatIndex: seat.seatIndex,
          newStack: seat.stack,
        });
        io.to('lobby').emit('lobby:table_updated', state);
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'ADJUST_CHIPS_FAILED',
          message: err instanceof Error ? err.message : 'Failed to adjust chips',
        });
      }
    });

    socket.on('table:change_variant', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      try {
        const state = tableService.changeVariant(tableId, userId, payload.variant);
        // Send personalised table:state so each socket gets the correct isYouHost flag
        for (const s of Array.from(io.sockets.sockets.values())) {
          const sock = s as AuthenticatedSocket;
          if (sock.data.currentTableId === tableId) {
            sock.emit('table:state', { ...state, isYouHost: sock.data.userId === state.hostPlayerId });
          }
        }
        io.to('lobby').emit('lobby:table_updated', state);
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'CHANGE_VARIANT_FAILED',
          message: err instanceof Error ? err.message : 'Failed to change variant',
        });
      }
    });

    socket.on('table:update_settings', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      try {
        const state = tableService.updateSettings(tableId, userId, payload.patch);
        io.to(`table:${tableId}`).emit('table:settings_updated', state.settings);
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'UPDATE_SETTINGS_FAILED',
          message: err instanceof Error ? err.message : 'Failed to update settings',
        });
      }
    });

    socket.on('table:remove_player', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const { state, seatIndex } = tableService.removePlayer(tableId, userId, payload.targetPlayerId);

        // Evict the removed player's socket(s) from the table room
        for (const s of Array.from(io.sockets.sockets.values())) {
          const sock = s as AuthenticatedSocket;
          if (sock.data.userId === payload.targetPlayerId && sock.data.currentTableId === tableId) {
            sock.leave(`table:${tableId}`);
            sock.data.currentTableId = undefined;
          }
        }

        io.to(`table:${tableId}`).emit('table:player_left', { playerId: payload.targetPlayerId, seatIndex });
        io.to('lobby').emit('lobby:table_updated', state);
      } catch (err: unknown) {
        socket.emit('hand:error', { code: 'REMOVE_PLAYER_FAILED', message: err instanceof Error ? err.message : 'Failed' });
      }
    });

    socket.on('table:transfer_host', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const state = tableService.transferHost(tableId, userId, payload.newHostPlayerId);
        io.to(`table:${tableId}`).emit('table:host_changed', { newHostPlayerId: payload.newHostPlayerId });
        io.to('lobby').emit('lobby:table_updated', state);
      } catch (err: unknown) {
        socket.emit('hand:error', { code: 'TRANSFER_HOST_FAILED', message: err instanceof Error ? err.message : 'Failed' });
      }
    });

    socket.on('hand:rit_vote', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      gameService.recordRITVote(tableId, payload.handId, userId, payload.yes, makeTableEmit(io, tableId));
    });

    socket.on('table:leave', async () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      try {
        const state = tableService.getTableState(tableId);
        const seatIndex = state ? state.seats.findIndex((s) => s?.playerId === userId) : -1;
        const { newHostPlayerId } = tableService.leaveTable(tableId, userId);
        socket.leave(`table:${tableId}`);
        io.to(`table:${tableId}`).emit('table:player_left', { playerId: userId, seatIndex });
        if (newHostPlayerId) {
          io.to(`table:${tableId}`).emit('table:host_changed', { newHostPlayerId });
        }
        socket.data.currentTableId = undefined;
        const updated = tableService.getTableState(tableId);
        if (updated) io.to('lobby').emit('lobby:table_updated', updated);
      } catch (err) {
        console.error('[Table] leave error:', err);
      }
    });

    socket.on('disconnect', async () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (tableId) {
        const state = tableService.getTableState(tableId);
        const seatIndex = state ? state.seats.findIndex((s) => s?.playerId === userId) : -1;
        let newHostPlayerId: string | undefined;
        try {
          ({ newHostPlayerId } = tableService.leaveTable(tableId, userId));
        } catch { /* ignore */ }
        io.to(`table:${tableId}`).emit('table:player_left', { seatIndex, playerId: userId });
        if (newHostPlayerId) {
          io.to(`table:${tableId}`).emit('table:host_changed', { newHostPlayerId });
        }
        const updated = tableService.getTableState(tableId);
        if (updated) io.to('lobby').emit('lobby:table_updated', updated);
      }
    });
  });
}
