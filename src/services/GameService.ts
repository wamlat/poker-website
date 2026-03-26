import { tableStateRepo } from '../repositories/TableStateRepository';
import { Card, HandSnapshot, PlayerAction, SeatState, TableState } from '../types';
import { getVariant } from '../domain/variants';
import { HandStateMachine } from '../domain/hand/HandStateMachine';

type EmitFn = (event: string, payload: unknown, privateToPlayerId?: string) => void;

interface PendingRITVote {
  handId: string;
  eligiblePlayerIds: string[];
  votes: Map<string, boolean>;
  timeout: ReturnType<typeof setTimeout>;
}

export class GameService {
  private machines = new Map<string, HandStateMachine>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private autoDealTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** tableId → playerId → hole cards from the most recently completed hand */
  private lastHandHoleCards = new Map<string, Record<string, Card[]>>();
  /** tableId → pending run-it-twice vote state */
  private pendingRITVotes = new Map<string, PendingRITVote>();

  startHand(tableId: string, emit: EmitFn): boolean {
    const state = tableStateRepo.getTableState(tableId);
    if (!state || state.status === 'running') return false;

    const readySeats = state.seats.filter(
      (s): s is NonNullable<typeof s> =>
        s !== null &&
        s.stack >= state.config.bigBlind &&
        s.status !== 'sitting-out' &&
        s.status !== 'waiting-for-bb',
    );

    // Advance waiting-for-bb players to active so they join the next hand
    for (const seat of state.seats) {
      if (seat?.status === 'waiting-for-bb') seat.status = 'active';
    }

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

    if (snapshot.phase === 'complete') {
      // Hand ended immediately (e.g. both players all-in from blinds) — skip timer
      for (const event of events) {
        emit(event.type, event.payload, event.privateToPlayerId);
      }
      this.onHandComplete(tableId, state, snapshot, emit);
    } else {
      const deadlineMs = Date.now() + state.settings.actionTimeoutSeconds * 1000;
      tableStateRepo.setActionTimer(snapshot.handId, deadlineMs);
      this.scheduleTimeout(tableId, snapshot.handId, emit);

      for (const event of events) {
        if (event.type === 'action_required') {
          (event.payload as Record<string, unknown>).deadlineMs = deadlineMs;
        }
        emit(event.type, event.payload, event.privateToPlayerId);
      }
    }

    return true;
  }

  processAction(tableId: string, action: PlayerAction, emit: EmitFn): void {
    const machine = this.machines.get(action.handId);
    if (!machine) {
      emit('hand:error', { code: 'NO_HAND', message: 'Hand not found' }, action.playerId);
      return;
    }

    // Verify the hand belongs to this table — prevents cross-table action injection
    const tableState = tableStateRepo.getTableState(tableId);
    if (tableState?.currentHandId !== action.handId) {
      emit('hand:error', { code: 'WRONG_TABLE', message: 'Hand does not belong to this table' }, action.playerId);
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

    // Preserve the existing deadline so invalid actions cannot reset the clock
    const existingDeadline = tableStateRepo.getActionTimer(action.handId);
    this.clearTimeout(action.handId);

    const events = machine.act(action);
    const snapshot = machine.getSnapshot();

    // If the FSM rejected the action, restore the original timer and bail out
    if (events.length === 1 && events[0].type === 'hand_error') {
      if (existingDeadline !== null) {
        tableStateRepo.setActionTimer(action.handId, existingDeadline);
        const remainingMs = Math.max(0, existingDeadline - Date.now());
        const handle = setTimeout(() => {
          const deadline = tableStateRepo.getActionTimer(action.handId);
          if (deadline === null) return;
          const snap = tableStateRepo.getHandSnapshot(action.handId);
          if (!snap || snap.currentActorSeatIndex === null) return;
          const actor = snap.seats[snap.currentActorSeatIndex] as SeatState;
          if (!actor) return;
          this.processAction(tableId, {
            handId: action.handId,
            playerId: actor.playerId,
            seatIndex: actor.seatIndex,
            action: snap.currentBet === actor.currentStreetBet ? 'check' : 'fold',
          }, emit);
        }, remainingMs);
        this.timeouts.set(action.handId, handle);
      }
      emit(events[0].type, events[0].payload, events[0].privateToPlayerId);
      return;
    }

    if (tableState) {
      this.syncStacks(tableState, snapshot);
      tableStateRepo.saveTableState(tableId, tableState);
    }
    tableStateRepo.saveHandSnapshot(snapshot.handId, snapshot);

    // Check if the action triggered an RIT vote pause
    const ritEvent = events.find((e) => e.type === 'rit_vote_needed');
    if (ritEvent) {
      // Emit all non-RIT events (e.g. action_taken) first
      for (const event of events) {
        if (event.type !== 'rit_vote_needed') {
          emit(event.type, event.payload, event.privateToPlayerId);
        }
      }
      const { handId, eligiblePlayerIds } = ritEvent.payload as {
        handId: string;
        eligiblePlayerIds: string[];
      };
      this.startRITVote(tableId, handId, eligiblePlayerIds, emit);
      return;
    }

    if (snapshot.phase === 'complete') {
      // Emit events before triggering auto-deal so the client receives them first
      for (const event of events) {
        emit(event.type, event.payload, event.privateToPlayerId);
      }
      this.onHandComplete(tableId, tableState, snapshot, emit);
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
    }
  }

  /** Called by TableNamespace when a player submits their RIT vote */
  recordRITVote(tableId: string, handId: string, playerId: string, yes: boolean, emit: EmitFn): void {
    const pending = this.pendingRITVotes.get(tableId);
    if (!pending || pending.handId !== handId) return;
    if (!pending.eligiblePlayerIds.includes(playerId)) return;

    pending.votes.set(playerId, yes);

    if (pending.votes.size >= pending.eligiblePlayerIds.length) {
      const runTwice = Array.from(pending.votes.values()).every((v) => v);
      clearTimeout(pending.timeout);
      this.pendingRITVotes.delete(tableId);
      this.resolveRITVote(tableId, handId, runTwice, emit);
    }
  }

  getLastHandHoleCards(tableId: string, playerId: string): Card[] | null {
    return this.lastHandHoleCards.get(tableId)?.[playerId] ?? null;
  }

  /** Returns the current hand snapshot for a table, or null if no hand is running. */
  getSnapshot(tableId: string): HandSnapshot | null {
    const state = tableStateRepo.getTableState(tableId);
    if (!state?.currentHandId) return null;
    return this.machines.get(state.currentHandId)?.getSnapshot() ?? null;
  }

  /** Returns data needed to resync a reconnecting player to an active hand. */
  getReconnectHandState(tableId: string): {
    snapshot: HandSnapshot;
    actionRequired: Record<string, unknown> | null;
    deadlineMs: number | null;
  } | null {
    const state = tableStateRepo.getTableState(tableId);
    if (!state?.currentHandId) return null;
    const machine = this.machines.get(state.currentHandId);
    if (!machine) return null;
    const snapshot = machine.getSnapshot();
    const actionRequired = machine.peekActionRequired();
    const deadlineMs = tableStateRepo.getActionTimer(state.currentHandId);
    if (actionRequired && deadlineMs !== null) {
      actionRequired.deadlineMs = deadlineMs;
    }
    return { snapshot, actionRequired, deadlineMs };
  }

  cancelAutoDeal(tableId: string): void {
    const handle = this.autoDealTimeouts.get(tableId);
    if (handle) {
      clearTimeout(handle);
      this.autoDealTimeouts.delete(tableId);
    }
  }

  /** Tear down all GameService state for a table that has been deleted. */
  cancelTable(tableId: string): void {
    this.cancelAutoDeal(tableId);

    const ritVote = this.pendingRITVotes.get(tableId);
    if (ritVote) {
      clearTimeout(ritVote.timeout);
      this.pendingRITVotes.delete(tableId);
    }

    this.lastHandHoleCards.delete(tableId);

    // Also clean up the active hand machine and its timer if one is running
    const state = tableStateRepo.getTableState(tableId);
    const handId = state?.currentHandId;
    if (handId) {
      this.clearTimeout(handId);
      this.machines.delete(handId);
      tableStateRepo.deleteHandSnapshot(handId);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private startRITVote(
    tableId: string,
    handId: string,
    eligiblePlayerIds: string[],
    emit: EmitFn,
  ): void {
    // Timeout: if players don't vote within 15s, default to run once
    const timeout = setTimeout(() => {
      if (this.pendingRITVotes.get(tableId)?.handId === handId) {
        this.pendingRITVotes.delete(tableId);
        this.resolveRITVote(tableId, handId, false, emit);
      }
    }, 15_000);

    this.pendingRITVotes.set(tableId, { handId, eligiblePlayerIds, votes: new Map(), timeout });

    emit('hand:rit_vote_request', { handId, eligiblePlayerIds });
  }

  private resolveRITVote(tableId: string, handId: string, runTwice: boolean, emit: EmitFn): void {
    const machine = this.machines.get(handId);
    if (!machine) return;

    const events = machine.resolveRIT(runTwice);
    const snapshot = machine.getSnapshot();

    const tableState = tableStateRepo.getTableState(tableId);
    if (tableState) {
      this.syncStacks(tableState, snapshot);
      tableStateRepo.saveTableState(tableId, tableState);
    }
    tableStateRepo.saveHandSnapshot(snapshot.handId, snapshot);

    // Emit all events first so the client starts processing before auto-deal fires
    for (const event of events) {
      emit(event.type, event.payload, event.privateToPlayerId);
    }

    if (snapshot.phase === 'complete') {
      // Add a 4 s buffer on top of the user-configured delay so auto-deal never
      // fires while the client is still animating the RIT run-out (~3 s total).
      this.onHandComplete(tableId, tableState, snapshot, emit, 4000);
    }
  }

  private onHandComplete(
    tableId: string,
    tableState: TableState | null,
    snapshot: HandSnapshot,
    emit: EmitFn,
    autoDealExtraDelayMs = 0,
  ): void {
    // Cache hole cards for post-hand reveal
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

      if (tableState.settings.autoDeal) {
        this.scheduleAutoDeal(tableId, tableState.settings.autoDealDelaySeconds * 1000 + autoDealExtraDelayMs, emit);
      }
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
      .map((s, i) => (s && s.stack >= state.config.bigBlind && s.status !== 'sitting-out' ? i : -1))
      .filter((i) => i !== -1);

    if (occupied.length === 0) return 0;

    const currentDealer = state.dealerSeatIndex;
    const next = occupied.find((i) => i > currentDealer);
    return next ?? occupied[0];
  }
}
