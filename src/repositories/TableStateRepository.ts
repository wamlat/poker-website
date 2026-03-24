import redis from '../db/redis';
import { HandSnapshot, TableState } from '../types';

const TABLE_STATE_KEY = (tableId: string) => `table:${tableId}:state`;
const HAND_STATE_KEY = (handId: string) => `hand:${handId}:state`;
const HAND_TIMER_KEY = (handId: string) => `hand:${handId}:action_timer`;
const TABLE_LOCK_KEY = (tableId: string) => `lock:table:${tableId}`;

const HAND_TTL_SECONDS = 3600; // 1 hour after completion

export class TableStateRepository {
  async saveTableState(tableId: string, state: TableState): Promise<void> {
    await redis.set(TABLE_STATE_KEY(tableId), JSON.stringify(state));
  }

  async getTableState(tableId: string): Promise<TableState | null> {
    const raw = await redis.get(TABLE_STATE_KEY(tableId));
    return raw ? (JSON.parse(raw) as TableState) : null;
  }

  async deleteTableState(tableId: string): Promise<void> {
    await redis.del(TABLE_STATE_KEY(tableId));
  }

  async saveHandSnapshot(handId: string, snapshot: HandSnapshot): Promise<void> {
    await redis.set(HAND_STATE_KEY(handId), JSON.stringify(snapshot));
  }

  async getHandSnapshot(handId: string): Promise<HandSnapshot | null> {
    const raw = await redis.get(HAND_STATE_KEY(handId));
    return raw ? (JSON.parse(raw) as HandSnapshot) : null;
  }

  async expireHandSnapshot(handId: string): Promise<void> {
    await redis.expire(HAND_STATE_KEY(handId), HAND_TTL_SECONDS);
  }

  async setActionTimer(handId: string, deadlineMs: number, ttlSeconds: number): Promise<void> {
    await redis.set(HAND_TIMER_KEY(handId), String(deadlineMs), 'EX', ttlSeconds);
  }

  async clearActionTimer(handId: string): Promise<void> {
    await redis.del(HAND_TIMER_KEY(handId));
  }

  async getActionTimer(handId: string): Promise<number | null> {
    const raw = await redis.get(HAND_TIMER_KEY(handId));
    return raw ? parseInt(raw, 10) : null;
  }

  /** Simple spin-lock using SET NX for table-level concurrency control */
  async acquireLock(tableId: string, ttlMs = 5000): Promise<boolean> {
    const result = await redis.set(TABLE_LOCK_KEY(tableId), '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(tableId: string): Promise<void> {
    await redis.del(TABLE_LOCK_KEY(tableId));
  }
}
