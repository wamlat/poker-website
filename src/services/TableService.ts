const randomUUID = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
import { tableStateRepo } from '../repositories/TableStateRepository';
import { config } from '../config';
import { Seat, TableConfig, TableState, VariantName } from '../types';

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
  createTable(options: CreateTableOptions): TableState {
    const tableId = randomUUID();

    const tableConfig: TableConfig = {
      tableId,
      name: options.name,
      variant: options.variant,
      maxSeats: options.maxSeats,
      smallBlind: options.smallBlind,
      bigBlind: options.bigBlind,
      minBuyIn: options.minBuyIn,
      maxBuyIn: options.maxBuyIn,
      actionTimeoutSeconds: options.actionTimeoutSeconds ?? config.actionTimeoutSeconds,
    };

    const state: TableState = {
      config: tableConfig,
      seats: Array(options.maxSeats).fill(null),
      status: 'waiting',
      currentHandId: null,
      handNumber: 0,
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

  getTableState(tableId: string): TableState | null {
    return tableStateRepo.getTableState(tableId);
  }

  listTables(): TableState[] {
    return tableStateRepo.getAllTableStates();
  }
}
