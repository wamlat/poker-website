import { Server } from 'socket.io';
import { gameService, tableService } from '../services';
import { AuthenticatedSocket } from './SocketServer';

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

/** Strip pendingJoinRequests for non-host recipients */
function tableStateFor(state: ReturnType<typeof tableService.getTableState>, recipientId: string) {
  if (!state) return state;
  const { pendingJoinRequests, ...rest } = state;
  return recipientId === state.hostPlayerId
    ? { ...rest, pendingJoinRequests }
    : { ...rest, pendingJoinRequests: [] };
}

export function registerTableHandlers(io: Server): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.data.userId;

    socket.on('hand:action', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      gameService.processAction(
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
        io.to('lobby').emit('lobby:table_updated', tableStateFor(state, ''));
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'ADJUST_CHIPS_FAILED',
          message: err instanceof Error ? err.message : 'Failed to adjust chips',
        });
      }
    });

    socket.on('table:rebuy_request', (payload: { amount: number }) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const state = tableService.selfRebuy(tableId, userId, payload.amount);
        const seat = state.seats.find((s) => s?.playerId === userId);
        if (!seat) return;
        io.to(`table:${tableId}`).emit('table:chips_adjusted', {
          targetPlayerId: userId,
          seatIndex: seat.seatIndex,
          newStack: seat.stack,
        });
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'REBUY_FAILED',
          message: err instanceof Error ? err.message : 'Failed to rebuy',
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
            sock.emit('table:state', {
              ...tableStateFor(state, sock.data.userId),
              isYouHost: sock.data.userId === state.hostPlayerId,
            });
          }
        }
        io.to('lobby').emit('lobby:table_updated', tableStateFor(state, ''));
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
        const { state, seatIndex, deleted } = tableService.removePlayer(tableId, userId, payload.targetPlayerId);

        // Evict the removed player's socket(s) from the table room
        for (const s of Array.from(io.sockets.sockets.values())) {
          const sock = s as AuthenticatedSocket;
          if (sock.data.userId === payload.targetPlayerId && sock.data.currentTableId === tableId) {
            sock.leave(`table:${tableId}`);
            sock.data.currentTableId = undefined;
          }
        }

        io.to(`table:${tableId}`).emit('table:player_left', { playerId: payload.targetPlayerId, seatIndex });
        if (deleted) {
          gameService.cancelTable(tableId);
          io.to('lobby').emit('lobby:table_removed', { tableId });
        } else {
          // Notify room if host changed (host removed themselves)
          if (state.hostPlayerId !== userId) {
            io.to(`table:${tableId}`).emit('table:host_changed', { newHostPlayerId: state.hostPlayerId });
          }
          io.to('lobby').emit('lobby:table_updated', tableStateFor(state, ''));
        }
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
        io.to('lobby').emit('lobby:table_updated', tableStateFor(state, ''));
      } catch (err: unknown) {
        socket.emit('hand:error', { code: 'TRANSFER_HOST_FAILED', message: err instanceof Error ? err.message : 'Failed' });
      }
    });

    socket.on('hand:rit_vote', (payload) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      gameService.recordRITVote(tableId, payload.handId, userId, payload.yes, makeTableEmit(io, tableId));
    });

    // ── Join request approve / reject (host only) ────────────────────────────

    socket.on('table:approve_join', (payload: { requestId: string; finalBuyIn: number }) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const { state, seatIndex, approvedRequest } = tableService.approveJoinRequest(
          tableId, userId, payload.requestId, payload.finalBuyIn,
        );

        // Seat the approved player's socket(s) in the table room
        for (const s of Array.from(io.sockets.sockets.values())) {
          const sock = s as AuthenticatedSocket;
          if (sock.data.userId === approvedRequest.playerId) {
            sock.join(`table:${tableId}`);
            sock.data.currentTableId = tableId;
            sock.emit('table:state', { ...tableStateFor(state, approvedRequest.playerId), isYouHost: false });
          }
        }

        // Notify existing table members (excluding the new player who just got table:state)
        io.to(`table:${tableId}`).emit('table:player_joined', {
          seatIndex,
          playerId: approvedRequest.playerId,
          displayName: approvedRequest.displayName,
          stack: payload.finalBuyIn,
        });

        // Tell host the request is resolved
        socket.emit('table:join_request_resolved', { requestId: payload.requestId, resolution: 'approved' });

        io.to('lobby').emit('lobby:table_updated', tableStateFor(state, ''));
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'APPROVE_JOIN_FAILED',
          message: err instanceof Error ? err.message : 'Failed to approve',
        });
      }
    });

    socket.on('table:reject_join', (payload: { requestId: string }) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const rejected = tableService.rejectJoinRequest(tableId, userId, payload.requestId);

        // Notify rejected player
        for (const s of Array.from(io.sockets.sockets.values())) {
          const sock = s as AuthenticatedSocket;
          if (sock.data.userId === rejected.playerId) {
            sock.emit('table:join_rejected', { tableId, reason: 'Host declined your request' });
          }
        }

        socket.emit('table:join_request_resolved', { requestId: payload.requestId, resolution: 'rejected' });
      } catch (err: unknown) {
        socket.emit('hand:error', {
          code: 'REJECT_JOIN_FAILED',
          message: err instanceof Error ? err.message : 'Failed to reject',
        });
      }
    });

    // ── Sit out / come back ───────────────────────────────────────────────────

    socket.on('table:sit_out', () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const state = tableService.sitOut(tableId, userId);
        const seat = state.seats.find((s) => s?.playerId === userId);
        if (seat) {
          io.to(`table:${tableId}`).emit('table:player_updated', {
            seatIndex: seat.seatIndex,
            playerId: userId,
            status: seat.status,
          });
        }
      } catch { /* ignore */ }
    });

    socket.on('table:come_back', () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      try {
        const state = tableService.comeBack(tableId, userId);
        const seat = state.seats.find((s) => s?.playerId === userId);
        if (seat) {
          io.to(`table:${tableId}`).emit('table:player_updated', {
            seatIndex: seat.seatIndex,
            playerId: userId,
            status: seat.status,
          });
        }
      } catch { /* ignore */ }
    });

    // ── Chat ─────────────────────────────────────────────────────────────────

    socket.on('table:chat', (payload: { message: string }) => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;
      const state = tableService.getTableState(tableId);
      if (!state) return;
      const seat = state.seats.find((s) => s?.playerId === userId);
      if (!seat) return; // must be seated to chat

      const raw = String(payload?.message ?? '').trim();
      if (!raw) return;
      const escape = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const message = escape(raw).slice(0, 200);
      const displayName = escape(seat.displayName);
      io.to(`table:${tableId}`).emit('table:chat_message', {
        playerId: userId,
        displayName,
        message,
        timestamp: Date.now(),
      });
    });

    // ── Leave / disconnect ────────────────────────────────────────────────────

    socket.on('table:leave', () => {
      const tableId = socket.data.currentTableId as string | undefined;
      if (!tableId) return;

      tableService.cancelLeave(tableId, userId);

      try {
        const state = tableService.getTableState(tableId);
        const seatIndex = state ? state.seats.findIndex((s) => s?.playerId === userId) : -1;
        const { newHostPlayerId, deleted } = tableService.leaveTable(tableId, userId);
        socket.leave(`table:${tableId}`);
        io.to(`table:${tableId}`).emit('table:player_left', { playerId: userId, seatIndex });
        if (newHostPlayerId) {
          io.to(`table:${tableId}`).emit('table:host_changed', { newHostPlayerId });
        }
        socket.data.currentTableId = undefined;
        if (deleted) {
          gameService.cancelTable(tableId);
          io.to('lobby').emit('lobby:table_removed', { tableId });
        } else {
          const updated = tableService.getTableState(tableId);
          if (updated) io.to('lobby').emit('lobby:table_updated', tableStateFor(updated, ''));
        }
      } catch (err) {
        console.error('[Table] leave error:', err);
      }
    });

    socket.on('table:rejoin', (payload: { tableId: string }) => {
      const tableId = payload?.tableId;
      if (!tableId) return;
      const state = tableService.getTableState(tableId);
      if (!state) return;
      const seated = state.seats.some((s) => s?.playerId === userId);
      if (!seated) return;

      tableService.cancelLeave(tableId, userId);
      socket.join(`table:${tableId}`);
      socket.data.currentTableId = tableId;
      socket.emit('table:state', { ...tableStateFor(state, userId), isYouHost: userId === state.hostPlayerId });

      // Resync active hand state
      const handState = gameService.getReconnectHandState(tableId);
      if (handState) {
        const { snapshot, actionRequired } = handState;
        // Re-send hand:started so the client knows the hand context
        socket.emit('hand:started', {
          handId: snapshot.handId,
          variant: snapshot.variant,
          dealerButtonSeatIndex: snapshot.dealerButtonSeatIndex,
          smallBlindSeatIndex: snapshot.smallBlindSeatIndex,
          bigBlindSeatIndex: snapshot.bigBlindSeatIndex,
          pot: snapshot.pot,
        });
        // Re-send community cards if any have been dealt
        if (snapshot.communityCards.length > 0) {
          socket.emit('hand:community_dealt', {
            cards: snapshot.communityCards,
            phase: snapshot.phase,
          });
        }
        // Re-send this player's hole cards (private)
        const mySeat = snapshot.seats.find((s) => s?.playerId === userId);
        if (mySeat?.holeCards?.length) {
          socket.emit('hand:cards_dealt', { seatIndex: mySeat.seatIndex, holeCards: mySeat.holeCards });
        }
        // Re-send action_required if it's currently someone's turn
        if (actionRequired) {
          socket.emit('hand:action_required', actionRequired);
        }
        // Re-send each player's current street bet so chips display correctly
        const seatBets: Record<number, number> = {};
        for (const seat of snapshot.seats) {
          if (seat && seat.currentStreetBet > 0) seatBets[seat.seatIndex] = seat.currentStreetBet;
        }
        if (Object.keys(seatBets).length > 0) {
          socket.emit('hand:seat_bets', { seatBets });
        }
      }
    });

    socket.on('disconnect', () => {
      const tableId = socket.data.currentTableId as string | undefined;

      // Cancel any pending join requests from this player
      for (const t of tableService.listTables()) {
        const pending = t.pendingJoinRequests.find((r) => r.playerId === userId);
        if (pending) {
          tableService.cancelJoinRequest(t.config.tableId, userId);
          for (const s of Array.from(io.sockets.sockets.values())) {
            const sock = s as AuthenticatedSocket;
            if (sock.data.userId === t.hostPlayerId) {
              sock.emit('table:join_request_cancelled', {
                tableId: t.config.tableId,
                playerId: userId,
                requestId: pending.requestId,
              });
            }
          }
          break;
        }
      }

      if (tableId) {
        // Grace period: give the player 15 s to reconnect before evicting their seat
        tableService.scheduleLeave(tableId, userId, () => {
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
          if (updated) io.to('lobby').emit('lobby:table_updated', tableStateFor(updated, ''));
        });
      }
    });
  });
}
