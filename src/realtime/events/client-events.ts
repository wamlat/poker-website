import { ActionType, TableSettings, VariantName } from '../../types';

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

export interface AdjustChipsPayload {
  targetPlayerId: string;
  amount: number; // positive = add, negative = remove
}

export interface UpdateSettingsPayload {
  patch: Partial<TableSettings>;
}

export interface ClientToServerEvents {
  'lobby:list_tables': () => void;
  'lobby:create_table': (payload: CreateTablePayload) => void;
  'lobby:join_table': (payload: JoinTablePayload) => void;
  'table:sit_out': () => void;
  'table:sit_in': () => void;
  'table:leave': () => void;
  'table:start_hand': () => void;
  'table:adjust_chips': (payload: AdjustChipsPayload) => void;
  'table:change_variant': (payload: { variant: VariantName }) => void;
  'table:update_settings': (payload: UpdateSettingsPayload) => void;
  'hand:action': (payload: HandActionPayload) => void;
  'hand:reveal_cards': (payload: { handId: string }) => void;
  'hand:rit_vote': (payload: { handId: string; yes: boolean }) => void;
}
