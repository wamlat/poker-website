import { config } from '../config';
import { TableStateRepository } from '../repositories/TableStateRepository';
import { HandSnapshot, PlayerAction, SeatState, TableState } from '../types';
import { getVariant } from '../domain/variants';
import { HandStateMachine } from '../domain/hand/HandStateMachine';
import { HandHistoryService } from './HandHistoryService';

const tableStateRepo = new TableStateRepository();
const handHistoryService = new HandHistoryService();

type EmitFn = (event: string, payload: unknown, privateToPlayerId?: string) => void;

export class GameService {
  private machines: Map<string, HandStateMachine> = new Map();
  private handStartTimes: Map<string, Date> = new Map();

  /**
   * Attempt to start a new hand at the given table.
   * Requires a lock — returns false if lock cannot be acquired.
   */
  async startHand(tableId: string, emit: EmitFn): Promise<boolean> {
    const locked = await tableStateRepo.acquireLock(tableId);
    if (!locked) return false;

    try {
      const state = await tableStateRepo.getTableState(tableId);
      if (!state || state.status === 'running') return false;

      const readySeats = state.seats
        .filter((s): s is NonNullable<typeof s> => s !== null && s.status !== 'sitting-out')
        .filter((s) => s.stack >= state.config.bigBlind);

      if (readySeats.length < 2) return false;

      // Advance dealer button
      const lastDealerIdx = state.seats.findIndex((s) => s !== null);
      const dealerSeatIndex = this.nextDealerButton(state, lastDealerIdx);

      state.handNumber += 1;
      state.status = 'running';

      const variant = getVariant(state.config.variant);
      const machine = new HandStateMachine(
        variant,
        state.config,
        readySeats.map((s) => ({
          seatIndex: s.seatIndex,
          playerId: s.playerId,
          displayName: s.displayName,
          stack: s.stack,
        })),
        dealerSeatIndex,
        state.handNumber,
      );

      const events = machine.start();
      const snapshot = machine.getSnapshot();

      state.currentHandId = snapshot.handId;

      // Sync stacks from FSM into table state
      this.syncStacks(state, snapshot);

      await tableStateRepo.saveTableState(tableId, state);
      await tableStateRepo.saveHandSnapshot(snapshot.handId, snapshot);
      this.machines.set(snapshot.handId, machine);
      this.handStartTimes.set(snapshot.handId, new Date());

      // Set action timer
      const deadlineMs = Date.now() + state.config.actionTimeoutSeconds * 1000;
      snapshot.actionDeadlineMs = deadlineMs;
      await tableStateRepo.setActionTimer(
        snapshot.handId,
        deadlineMs,
        state.config.actionTimeoutSeconds + 2,
      );

      // Schedule auto-action on timeout
      this.scheduleActionTimeout(tableId, snapshot.handId, emit);

      // Emit all events
      for (const event of events) {
        emit(event.type, event.payload, event.privateToPlayerId);
      }

      return true;
    } finally {
      await tableStateRepo.releaseLock(tableId);
    }
  }

  async processAction(tableId: string, action: PlayerAction, emit: EmitFn): Promise<void> {
    const locked = await tableStateRepo.acquireLock(tableId);
    if (!locked) {
      emit('hand:error', { code: 'SERVER_BUSY', message: 'Server busy, please retry' }, action.playerId);
      return;
    }

    try {
      const machine = this.machines.get(action.handId);
      if (!machine) {
        emit('hand:error', { code: 'NO_HAND', message: 'Hand not found' }, action.playerId);
        return;
      }

      // Clear the action timer since player acted
      await tableStateRepo.clearActionTimer(action.handId);

      const events = machine.act(action);
      const snapshot = machine.getSnapshot();

      const tableState = await tableStateRepo.getTableState(tableId);
      if (tableState) {
        this.syncStacks(tableState, snapshot);
        await tableStateRepo.saveTableState(tableId, tableState);
      }

      await tableStateRepo.saveHandSnapshot(snapshot.handId, snapshot);

      // If hand complete, persist history and clean up
      if (snapshot.phase === 'complete') {
        this.machines.delete(snapshot.handId);
        const startedAt = this.handStartTimes.get(snapshot.handId) ?? new Date();
        this.handStartTimes.delete(snapshot.handId);

        if (tableState) {
          tableState.status = 'waiting';
          tableState.currentHandId = null;
          await tableStateRepo.saveTableState(tableId, tableState);
        }

        // Async persist — does not block event emission
        handHistoryService.persistAsync(snapshot, startedAt);
      } else {
        // Set new action timer
        const cfg = tableState?.config;
        if (cfg) {
          const deadlineMs = Date.now() + cfg.actionTimeoutSeconds * 1000;
          await tableStateRepo.setActionTimer(snapshot.handId, deadlineMs, cfg.actionTimeoutSeconds + 2);
          this.scheduleActionTimeout(tableId, snapshot.handId, emit);
        }
      }

      for (const event of events) {
        emit(event.type, event.payload, event.privateToPlayerId);
      }
    } finally {
      await tableStateRepo.releaseLock(tableId);
    }
  }

  private scheduleActionTimeout(tableId: string, handId: string, emit: EmitFn): void {
    const tableStateCopy = { tableId, handId };

    tableStateRepo.getTableState(tableId).then((state) => {
      if (!state) return;
      const timeoutMs = state.config.actionTimeoutSeconds * 1000;

      setTimeout(async () => {
        const deadline = await tableStateRepo.getActionTimer(handId);
        if (deadline === null) return; // player already acted

        const snapshot = await tableStateRepo.getHandSnapshot(handId);
        if (!snapshot || snapshot.currentActorSeatIndex === null) return;

        const actor = snapshot.seats[snapshot.currentActorSeatIndex] as SeatState;
        if (!actor) return;

        // Auto-check if possible, otherwise auto-fold
        const action: PlayerAction = {
          handId,
          playerId: actor.playerId,
          seatIndex: actor.seatIndex,
          action: snapshot.currentBet === actor.currentStreetBet ? 'check' : 'fold',
        };

        await this.processAction(tableId, action, emit);
      }, timeoutMs);
    });
  }

  private syncStacks(state: TableState, snapshot: HandSnapshot): void {
    for (const seatState of snapshot.seats) {
      if (!seatState) continue;
      const tableSeat = state.seats[seatState.seatIndex];
      if (tableSeat) {
        tableSeat.stack = seatState.stack;
      }
    }
  }

  private nextDealerButton(state: TableState, currentIdx: number): number {
    const len = state.seats.length;
    for (let i = 1; i <= len; i++) {
      const idx = (currentIdx + i) % len;
      const seat = state.seats[idx];
      if (seat && seat.stack >= state.config.bigBlind) return idx;
    }
    return currentIdx;
  }
}
