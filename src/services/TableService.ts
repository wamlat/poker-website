import { randomUUID } from 'crypto';
import { tableStateRepo } from '../repositories/TableStateRepository';
import { config } from '../config';
import { getVariant } from '../domain/variants';
import { DEFAULT_TABLE_SETTINGS, PendingJoinRequest, Seat, TableConfig, TableSettings, TableState, VariantName } from '../types';

export interface CreateTableOptions {
  name: string;
  variant: VariantName;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  actionTimeoutSeconds?: number;
}

export class TableService {
  createTable(options: CreateTableOptions, creatorPlayerId: string): TableState {
    const tableId = randomUUID();

    const variant = getVariant(options.variant);
    const maxSeats = Math.min(options.maxSeats, variant.maxPlayers);

    const tableConfig: TableConfig = {
      tableId,
      name: options.name,
      variant: options.variant,
      maxSeats,
      smallBlind: options.smallBlind,
      bigBlind: options.bigBlind,
      minBuyIn: options.minBuyIn,
      maxBuyIn: options.maxBuyIn,
      actionTimeoutSeconds: options.actionTimeoutSeconds ?? config.actionTimeoutSeconds,
    };

    const state: TableState = {
      config: tableConfig,
      seats: Array(maxSeats).fill(null),
      status: 'waiting',
      currentHandId: null,
      handNumber: 0,
      dealerSeatIndex: -1,
      hostPlayerId: creatorPlayerId,
      settings: {
        ...DEFAULT_TABLE_SETTINGS,
        actionTimeoutSeconds: options.actionTimeoutSeconds ?? config.actionTimeoutSeconds,
      },
      pendingJoinRequests: [],
    };

    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  joinTable(
    tableId: string,
    playerId: string,
    displayName: string,
    buyIn: number,
    preferredSeat?: number,
  ): { state: TableState; seatIndex: number } {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');

    if (buyIn < state.config.minBuyIn || buyIn > state.config.maxBuyIn) {
      throw new Error(`Buy-in must be between ${state.config.minBuyIn} and ${state.config.maxBuyIn}`);
    }

    // Check player isn't already seated
    if (state.seats.some((s) => s?.playerId === playerId)) {
      throw new Error('Already seated at this table');
    }

    const seatIndex =
      preferredSeat !== undefined &&
      preferredSeat >= 0 &&
      preferredSeat < state.seats.length &&
      state.seats[preferredSeat] === null
        ? preferredSeat
        : state.seats.findIndex((s) => s === null);

    if (seatIndex === -1) throw new Error('Table is full');

    const seat: Seat = {
      seatIndex,
      playerId,
      displayName,
      stack: buyIn,
      status: 'waiting-for-bb',
    };

    state.seats[seatIndex] = seat;
    tableStateRepo.saveTableState(tableId, state);

    return { state, seatIndex };
  }

  leaveTable(tableId: string, playerId: string): { newHostPlayerId?: string; deleted?: boolean } {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) return {};

    const seatIndex = state.seats.findIndex((s) => s?.playerId === playerId);
    if (seatIndex === -1) return {};

    state.seats[seatIndex] = null;

    // Delete the table when the last player leaves
    if (state.seats.every((s) => s === null)) {
      tableStateRepo.deleteTableState(tableId);
      return { deleted: true };
    }

    let newHostPlayerId: string | undefined;
    if (state.hostPlayerId === playerId) {
      const nextHost = state.seats.find((s) => s !== null);
      if (nextHost) {
        state.hostPlayerId = nextHost.playerId;
        newHostPlayerId = nextHost.playerId;
      }
    }

    tableStateRepo.saveTableState(tableId, state);
    return { newHostPlayerId };
  }

  adjustChips(tableId: string, requesterPlayerId: string, targetPlayerId: string, amount: number): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can adjust chips');
    if (state.status === 'running') throw new Error('Cannot adjust chips during a hand');

    const seat = state.seats.find((s) => s?.playerId === targetPlayerId);
    if (!seat) throw new Error('Player not found at table');

    const newStack = seat.stack + amount;
    if (newStack < 0) throw new Error('Cannot reduce stack below zero');
    if (newStack > state.config.maxBuyIn) throw new Error('Cannot exceed max buy-in');
    seat.stack = newStack;

    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  changeVariant(tableId: string, requesterPlayerId: string, variant: VariantName): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can change the variant');
    if (state.status === 'running') throw new Error('Cannot change variant during a hand');

    const newVariant = getVariant(variant);
    const seatedCount = state.seats.filter((s) => s !== null).length;
    if (seatedCount > newVariant.maxPlayers) {
      throw new Error(
        `Cannot switch to ${variant}: ${seatedCount} players are seated but the variant only allows ${newVariant.maxPlayers}`,
      );
    }

    state.config.variant = variant;
    if (state.config.maxSeats > newVariant.maxPlayers) {
      // Ensure no seated player would be silently evicted by the truncation
      const hasPlayerInRemovedSeats = state.seats
        .slice(newVariant.maxPlayers)
        .some((s) => s !== null);
      if (hasPlayerInRemovedSeats) {
        throw new Error(
          `Cannot switch to ${variant}: a player is seated beyond the new seat limit of ${newVariant.maxPlayers}`,
        );
      }
      state.config.maxSeats = newVariant.maxPlayers;
      state.seats = state.seats.slice(0, newVariant.maxPlayers);
    }
    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  updateSettings(tableId: string, requesterPlayerId: string, patch: Partial<TableSettings>): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can change settings');

    if (patch.actionTimeoutSeconds !== undefined) {
      if (!Number.isInteger(patch.actionTimeoutSeconds) || patch.actionTimeoutSeconds < 5 || patch.actionTimeoutSeconds > 120) {
        throw new Error('actionTimeoutSeconds must be an integer between 5 and 120');
      }
    }
    if (patch.autoDealDelaySeconds !== undefined && ![2, 4, 6].includes(patch.autoDealDelaySeconds)) {
      throw new Error('autoDealDelaySeconds must be 2, 4, or 6');
    }
    if (patch.showdownReveal !== undefined && !['standard', 'always', 'never'].includes(patch.showdownReveal)) {
      throw new Error('Invalid showdownReveal value');
    }

    state.settings = { ...state.settings, ...patch };

    // Keep config.actionTimeoutSeconds in sync
    if (patch.actionTimeoutSeconds !== undefined) {
      state.config.actionTimeoutSeconds = patch.actionTimeoutSeconds;
    }

    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  removePlayer(tableId: string, requesterPlayerId: string, targetPlayerId: string): { state: TableState; seatIndex: number; deleted?: boolean } {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can remove players');
    if (state.status === 'running') throw new Error('Cannot remove players during a hand');

    const seatIndex = state.seats.findIndex((s) => s?.playerId === targetPlayerId);
    if (seatIndex === -1) throw new Error('Player not found at table');

    state.seats[seatIndex] = null;

    // Delete the table if no players remain
    if (state.seats.every((s) => s === null)) {
      tableStateRepo.deleteTableState(tableId);
      return { state, seatIndex, deleted: true };
    }

    // Reassign host if the removed player was the host
    if (state.hostPlayerId === targetPlayerId) {
      const nextHost = state.seats.find((s) => s !== null);
      if (nextHost) state.hostPlayerId = nextHost.playerId;
    }

    tableStateRepo.saveTableState(tableId, state);
    return { state, seatIndex };
  }

  transferHost(tableId: string, requesterPlayerId: string, newHostPlayerId: string): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can transfer ownership');
    if (!state.seats.some((s) => s?.playerId === newHostPlayerId)) throw new Error('New host must be seated at the table');

    state.hostPlayerId = newHostPlayerId;
    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  // ── Join request flow ────────────────────────────────────────────────────

  addJoinRequest(
    tableId: string,
    playerId: string,
    displayName: string,
    requestedBuyIn: number,
    preferredSeatIndex: number | null,
  ): PendingJoinRequest {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (requestedBuyIn < state.config.minBuyIn || requestedBuyIn > state.config.maxBuyIn) {
      throw new Error(`Buy-in must be between ${state.config.minBuyIn} and ${state.config.maxBuyIn}`);
    }
    if (state.seats.some((s) => s?.playerId === playerId)) {
      throw new Error('Already seated at this table');
    }
    // Replace any existing pending request from the same player
    state.pendingJoinRequests = state.pendingJoinRequests.filter((r) => r.playerId !== playerId);

    const request: PendingJoinRequest = {
      requestId: randomUUID(),
      playerId,
      displayName,
      requestedBuyIn,
      preferredSeatIndex,
      requestedAt: Date.now(),
    };
    state.pendingJoinRequests.push(request);
    tableStateRepo.saveTableState(tableId, state);
    return request;
  }

  cancelJoinRequest(tableId: string, playerId: string): void {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) return;
    state.pendingJoinRequests = state.pendingJoinRequests.filter((r) => r.playerId !== playerId);
    tableStateRepo.saveTableState(tableId, state);
  }

  approveJoinRequest(
    tableId: string,
    hostPlayerId: string,
    requestId: string,
    finalBuyIn: number,
  ): { state: TableState; seatIndex: number; approvedRequest: PendingJoinRequest } {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== hostPlayerId) throw new Error('Only the host can approve requests');

    const req = state.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (!req) throw new Error('Request not found');

    state.pendingJoinRequests = state.pendingJoinRequests.filter((r) => r.requestId !== requestId);
    tableStateRepo.saveTableState(tableId, state);

    const result = this.joinTable(tableId, req.playerId, req.displayName, finalBuyIn, req.preferredSeatIndex ?? undefined);
    return { ...result, approvedRequest: req };
  }

  rejectJoinRequest(
    tableId: string,
    hostPlayerId: string,
    requestId: string,
  ): PendingJoinRequest {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== hostPlayerId) throw new Error('Only the host can reject requests');

    const req = state.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (!req) throw new Error('Request not found');

    state.pendingJoinRequests = state.pendingJoinRequests.filter((r) => r.requestId !== requestId);
    tableStateRepo.saveTableState(tableId, state);
    return req;
  }

  // ── Disconnect grace period ───────────────────────────────────────────────

  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  scheduleLeave(tableId: string, playerId: string, onLeave: () => void, delayMs = 15_000): void {
    this.cancelLeave(tableId, playerId);
    this.disconnectTimers.set(
      `${tableId}:${playerId}`,
      setTimeout(onLeave, delayMs),
    );
  }

  cancelLeave(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const t = this.disconnectTimers.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.disconnectTimers.delete(key);
    }
  }

  // ── Self rebuy ────────────────────────────────────────────────────────────

  selfRebuy(tableId: string, playerId: string, amount: number): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.status === 'running') throw new Error('Cannot rebuy during a hand');
    const seat = state.seats.find((s) => s?.playerId === playerId);
    if (!seat) throw new Error('Not seated at this table');
    if (seat.stack > 0) throw new Error('Can only rebuy when stack is 0');
    if (amount < state.config.minBuyIn || amount > state.config.maxBuyIn) {
      throw new Error(`Rebuy amount must be between ${state.config.minBuyIn} and ${state.config.maxBuyIn}`);
    }
    seat.stack = amount;
    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  // ── Sit out / come back ───────────────────────────────────────────────────

  sitOut(tableId: string, playerId: string): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.status === 'running') throw new Error('Cannot sit out during a hand');
    const seat = state.seats.find((s) => s?.playerId === playerId);
    if (!seat) throw new Error('Not seated at this table');
    seat.status = 'sitting-out';
    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  comeBack(tableId: string, playerId: string): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    const seat = state.seats.find((s) => s?.playerId === playerId);
    if (!seat) throw new Error('Not seated at this table');
    seat.status = 'active';
    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  getTableState(tableId: string): TableState | null {
    return tableStateRepo.getTableState(tableId);
  }

  listTables(): TableState[] {
    return tableStateRepo.getAllTableStates();
  }
}
