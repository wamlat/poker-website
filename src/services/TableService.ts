import prisma from '../db/postgres';
import { TableStateRepository } from '../repositories/TableStateRepository';
import { UserRepository } from '../repositories/UserRepository';
import { Seat, TableConfig, TableState, VariantName } from '../types';

const tableStateRepo = new TableStateRepository();
const userRepo = new UserRepository();

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
  async createTable(options: CreateTableOptions): Promise<TableState> {
    const record = await prisma.table.create({
      data: {
        name: options.name,
        variant: options.variant,
        bettingStructure: options.variant === 'NLHE' ? 'no-limit' : 'pot-limit',
        maxSeats: options.maxSeats,
        smallBlind: options.smallBlind,
        bigBlind: options.bigBlind,
        minBuyIn: options.minBuyIn,
        maxBuyIn: options.maxBuyIn,
        actionTimeoutSecs: options.actionTimeoutSeconds ?? 30,
      },
    });

    const config: TableConfig = {
      tableId: record.id,
      name: record.name,
      variant: record.variant as VariantName,
      maxSeats: record.maxSeats,
      smallBlind: record.smallBlind,
      bigBlind: record.bigBlind,
      minBuyIn: record.minBuyIn,
      maxBuyIn: record.maxBuyIn,
      actionTimeoutSeconds: record.actionTimeoutSecs,
    };

    const state: TableState = {
      config,
      seats: Array(options.maxSeats).fill(null),
      status: 'waiting',
      currentHandId: null,
      handNumber: 0,
    };

    await tableStateRepo.saveTableState(record.id, state);
    return state;
  }

  async joinTable(
    tableId: string,
    userId: string,
    displayName: string,
    buyIn: number,
    preferredSeat?: number,
  ): Promise<{ state: TableState; seatIndex: number }> {
    const state = await tableStateRepo.getTableState(tableId);
    if (!state) throw new Error('Table not found');

    if (buyIn < state.config.minBuyIn || buyIn > state.config.maxBuyIn) {
      throw new Error(`Buy-in must be between ${state.config.minBuyIn} and ${state.config.maxBuyIn}`);
    }

    const chipBalance = await userRepo.getChipBalance(userId);
    if (Number(chipBalance) < buyIn) throw new Error('Insufficient chip balance');

    // Find an empty seat
    const seatIndex =
      preferredSeat !== undefined && state.seats[preferredSeat] === null
        ? preferredSeat
        : state.seats.findIndex((s) => s === null);

    if (seatIndex === -1) throw new Error('Table is full');

    // Deduct chips from balance
    await userRepo.updateChipBalance(userId, -buyIn);

    const seat: Seat = {
      seatIndex,
      playerId: userId,
      displayName,
      stack: buyIn,
      status: 'waiting-for-bb',
    };

    state.seats[seatIndex] = seat;
    await tableStateRepo.saveTableState(tableId, state);

    return { state, seatIndex };
  }

  async leaveTable(tableId: string, userId: string): Promise<void> {
    const state = await tableStateRepo.getTableState(tableId);
    if (!state) return;

    const seatIndex = state.seats.findIndex((s) => s?.playerId === userId);
    if (seatIndex === -1) return;

    const seat = state.seats[seatIndex] as Seat;

    // Return remaining stack to balance
    if (seat.stack > 0) {
      await userRepo.updateChipBalance(userId, seat.stack);
    }

    state.seats[seatIndex] = null;
    await tableStateRepo.saveTableState(tableId, state);
  }

  async getTableState(tableId: string): Promise<TableState | null> {
    return tableStateRepo.getTableState(tableId);
  }

  async listTables(): Promise<TableState[]> {
    const records = await prisma.table.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    const states = await Promise.all(
      records.map((r) => tableStateRepo.getTableState(r.id)),
    );

    return states.filter((s): s is TableState => s !== null);
  }
}
