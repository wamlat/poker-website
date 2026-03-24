import { ActionType, VariantName } from '../../types';

export interface CreateTablePayload {
  name: string;
  variant: VariantName;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  actionTimeoutSeconds?: number;
}

export interface JoinTablePayload {
  tableId: string;
  seatIndex?: number;
  buyIn: number;
}

export interface HandActionPayload {
  handId: string;
  action: ActionType;
  amount?: number;
}

export interface ClientToServerEvents {
  'lobby:list_tables': () => void;
  'lobby:create_table': (payload: CreateTablePayload) => void;
  'lobby:join_table': (payload: JoinTablePayload) => void;
  'table:sit_out': () => void;
  'table:sit_in': () => void;
  'table:leave': () => void;
  'hand:action': (payload: HandActionPayload) => void;
}
