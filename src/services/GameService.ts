import { tableStateRepo } from '../repositories/TableStateRepository';
import { Card, HandSnapshot, PlayerAction, SeatState, TableState } from '../types';
import { getVariant } from '../domain/variants';
import { HandStateMachine } from '../domain/hand/HandStateMachine';

type EmitFn = (event: string, payload: unknown, privateToPlayerId?: string) => void;

export class GameService {
  private machines = new Map<string, HandStateMachine>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private autoDealTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** tableId → playerId → hole cards from the most recently completed hand */
  private lastHandHoleCards = new Map<string, Record<string, Card[]>>();

  startHand(tableId: string, emit: EmitFn): boolean {
    const state = tableStateRepo.getTableState(tableId);
    if (!state || state.status === 'running') return false;

    const readySeats = state.seats.filter(
      (s): s is NonNullable<typeof s> => s !== null && s.stack >= state.config.bigBlind,
    );

    if (readySeats.length < 2) return false;

    const dealerSeatIndex = this.nextDealerButton(state);
    state.dealerSeatIndex = dealerSeatIndex;
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
      state.settings,
    );

    const events = machine.start();
    const snapshot = machine.getSnapshot();

    state.currentHandId = snapshot.handId;
    this.syncStacks(state, snapshot);
    tableStateRepo.saveTableState(tableId, state);
    tableStateRepo.saveHandSnapshot(snapshot.handId, snapshot);
    this.machines.set(snapshot.handId, machine);

    const deadlineMs = Date.now() + state.settings.actionTimeoutSeconds * 1000;
    tableStateRepo.setActionTimer(snapshot.handId, deadlineMs);
    this.scheduleTimeout(tableId, snapshot.handId, emit);

    for (const event of events) {
      if (event.type === 'action_required') {
        (event.payload as Record<string, unknown>).deadlineMs = deadlineMs;
      }
      emit(event.type, event.payload, event.privateToPlayerId);
    }

    return true;
  }

  processAction(tableId: string, action: PlayerAction, emit: EmitFn): void {
    const machine = this.machines.get(action.handId);
    if (!machine) {
      emit('hand:error', { code: 'NO_HAND', message: 'Hand not found' }, action.playerId);
      return;
    }

    if (action.seatIndex === -1) {
      const snap = machine.getSnapshot();
      const idx = snap.seats.findIndex((s) => s && s.playerId === action.playerId);
      if (idx === -1) {
        emit('hand:error', { code: 'NOT_IN_HAND', message: 'Player not in hand' }, action.playerId);
        return;
      }
      action.seatIndex = idx;
    }

    this.clearTimeout(action.handId);

    const events = machine.act(action);
    const snapshot = machine.getSnapshot();

    const tableState = tableStateRepo.getTableState(tableId);
    if (tableState) {
      this.syncStacks(tableState, snapshot);
      tableStateRepo.saveTableState(tableId, tableState);
    }

    tableStateRepo.saveHandSnapshot(snapshot.handId, snapshot);

    if (snapshot.phase === 'complete') {
      // Cache hole cards so players can reveal them post-hand
      const holeCards: Record<string, Card[]> = {};
      for (const seat of snapshot.seats) {
        if (seat && seat.holeCards.length > 0) holeCards[seat.playerId] = seat.holeCards;
      }
      this.lastHandHoleCards.set(tableId, holeCards);

      this.machines.delete(snapshot.handId);
      tableStateRepo.deleteHandSnapshot(snapshot.handId);

      if (tableState) {
        tableState.status = 'waiting';
        tableState.currentHandId = null;
        tableStateRepo.saveTableState(tableId, tableState);

        // Auto-deal next hand if enabled
        if (tableState.settings.autoDeal) {
          this.scheduleAutoDeal(tableId, tableState.settings.autoDealDelaySeconds * 1000, emit);
        }
      }
    } else {
      const timeoutSeconds = tableState?.settings.actionTimeoutSeconds ?? 20;
      const deadlineMs = Date.now() + timeoutSeconds * 1000;
      tableStateRepo.setActionTimer(snapshot.handId, deadlineMs);
      this.scheduleTimeout(tableId, snapshot.handId, emit);

      for (const event of events) {
        if (event.type === 'action_required') {
          (event.payload as Record<string, unknown>).deadlineMs = deadlineMs;
        }
        emit(event.type, event.payload, event.privateToPlayerId);
      }
      return;
    }

    for (const event of events) {
      emit(event.type, event.payload, event.privateToPlayerId);
    }
  }

  private scheduleAutoDeal(tableId: string, delayMs: number, emit: EmitFn): void {
    const existing = this.autoDealTimeouts.get(tableId);
    if (existing) clearTimeout(existing);

    const handle = setTimeout(() => {
      this.autoDealTimeouts.delete(tableId);
      this.startHand(tableId, emit);
    }, delayMs);

    this.autoDealTimeouts.set(tableId, handle);
  }

  getLastHandHoleCards(tableId: string, playerId: string): Card[] | null {
    return this.lastHandHoleCards.get(tableId)?.[playerId] ?? null;
  }

  cancelAutoDeal(tableId: string): void {
    const handle = this.autoDealTimeouts.get(tableId);
    if (handle) {
      clearTimeout(handle);
      this.autoDealTimeouts.delete(tableId);
    }
  }

  private scheduleTimeout(tableId: string, handId: string, emit: EmitFn): void {
    this.clearTimeout(handId);

    const state = tableStateRepo.getTableState(tableId);
    const timeoutMs = (state?.settings.actionTimeoutSeconds ?? 20) * 1000;

    const handle = setTimeout(() => {
      const deadline = tableStateRepo.getActionTimer(handId);
      if (deadline === null) return;

      const snapshot = tableStateRepo.getHandSnapshot(handId);
      if (!snapshot || snapshot.currentActorSeatIndex === null) return;

      const actor = snapshot.seats[snapshot.currentActorSeatIndex] as SeatState;
      if (!actor) return;

      const action: PlayerAction = {
        handId,
        playerId: actor.playerId,
        seatIndex: actor.seatIndex,
        action: snapshot.currentBet === actor.currentStreetBet ? 'check' : 'fold',
      };

      this.processAction(tableId, action, emit);
    }, timeoutMs);

    this.timeouts.set(handId, handle);
  }

  private clearTimeout(handId: string): void {
    const handle = this.timeouts.get(handId);
    if (handle) {
      clearTimeout(handle);
      this.timeouts.delete(handId);
    }
    tableStateRepo.clearActionTimer(handId);
  }

  private syncStacks(state: TableState, snapshot: HandSnapshot): void {
    for (const seat of snapshot.seats) {
      if (!seat) continue;
      const tableSeat = state.seats[seat.seatIndex];
      if (tableSeat) tableSeat.stack = seat.stack;
    }
  }

  private nextDealerButton(state: TableState): number {
    const occupied = state.seats
      .map((s, i) => (s && s.stack >= state.config.bigBlind ? i : -1))
      .filter((i) => i !== -1);

    if (occupied.length === 0) return 0;

    const currentDealer = state.dealerSeatIndex;
    const next = occupied.find((i) => i > currentDealer);
    return next ?? occupied[0];
  }
}
