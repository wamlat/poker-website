import { HandSnapshot, TableState } from '../types';

/**
 * In-memory store for table and hand state.
 * No Redis, no persistence — everything lives in process memory.
 */
export class TableStateRepository {
  private tables = new Map<string, TableState>();
  private hands = new Map<string, HandSnapshot>();
  private timers = new Map<string, number>(); // handId → deadline timestamp

  saveTableState(tableId: string, state: TableState): void {
    this.tables.set(tableId, state);
  }

  getTableState(tableId: string): TableState | null {
    return this.tables.get(tableId) ?? null;
  }

  deleteTableState(tableId: string): void {
    this.tables.delete(tableId);
  }

  getAllTableStates(): TableState[] {
    return Array.from(this.tables.values());
  }

  saveHandSnapshot(handId: string, snapshot: HandSnapshot): void {
    this.hands.set(handId, snapshot);
  }

  getHandSnapshot(handId: string): HandSnapshot | null {
    return this.hands.get(handId) ?? null;
  }

  deleteHandSnapshot(handId: string): void {
    this.hands.delete(handId);
  }

  setActionTimer(handId: string, deadlineMs: number): void {
    this.timers.set(handId, deadlineMs);
  }

  clearActionTimer(handId: string): void {
    this.timers.delete(handId);
  }

  getActionTimer(handId: string): number | null {
    return this.timers.get(handId) ?? null;
  }
}

// Singleton — shared across services
export const tableStateRepo = new TableStateRepository();
