const randomUUID = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
import { tableStateRepo } from '../repositories/TableStateRepository';
import { config } from '../config';
import { getVariant } from '../domain/variants';
import { DEFAULT_TABLE_SETTINGS, Seat, TableConfig, TableSettings, TableState, VariantName } from '../types';

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
      preferredSeat !== undefined && state.seats[preferredSeat] === null
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

  leaveTable(tableId: string, playerId: string): void {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) return;

    const seatIndex = state.seats.findIndex((s) => s?.playerId === playerId);
    if (seatIndex === -1) return;

    state.seats[seatIndex] = null;
    tableStateRepo.saveTableState(tableId, state);
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
    seat.stack = newStack;

    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  changeVariant(tableId: string, requesterPlayerId: string, variant: VariantName): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can change the variant');
    if (state.status === 'running') throw new Error('Cannot change variant during a hand');

    state.config.variant = variant;
    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  updateSettings(tableId: string, requesterPlayerId: string, patch: Partial<TableSettings>): TableState {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can change settings');

    state.settings = { ...state.settings, ...patch };

    // Keep config.actionTimeoutSeconds in sync
    if (patch.actionTimeoutSeconds !== undefined) {
      state.config.actionTimeoutSeconds = patch.actionTimeoutSeconds;
    }

    tableStateRepo.saveTableState(tableId, state);
    return state;
  }

  removePlayer(tableId: string, requesterPlayerId: string, targetPlayerId: string): { state: TableState; seatIndex: number } {
    const state = tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');
    if (state.hostPlayerId !== requesterPlayerId) throw new Error('Only the host can remove players');
    if (state.status === 'running') throw new Error('Cannot remove players during a hand');

    const seatIndex = state.seats.findIndex((s) => s?.playerId === targetPlayerId);
    if (seatIndex === -1) throw new Error('Player not found at table');

    state.seats[seatIndex] = null;
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

  getTableState(tableId: string): TableState | null {
    return tableStateRepo.getTableState(tableId);
  }

  listTables(): TableState[] {
    return tableStateRepo.getAllTableStates();
  }
}
