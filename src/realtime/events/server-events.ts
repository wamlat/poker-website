import { Card, SidePot, TableState, ValidAction } from '../../types';

export interface HandStartedPayload {
  handId: string;
  variant: string;
  dealerButtonSeatIndex: number;
  smallBlindSeatIndex: number;
  bigBlindSeatIndex: number;
  pot: number;
}

export interface CardsDealtPayload {
  seatIndex: number;
  holeCards: Card[];
}

export interface CommunityDealtPayload {
  phase: 'flop' | 'turn' | 'river';
  cards: Card[];
}

export interface ActionRequiredPayload {
  seatIndex: number;
  playerId: string;
  validActions: ValidAction[];
  deadlineMs: number | null;
}

export interface ActionTakenPayload {
  seatIndex: number;
  action: string;
  amount?: number;
  pot: number;
}

export interface ShowdownPayload {
  players: {
    seatIndex: number;
    playerId: string;
    holeCards: Card[];
    bestHand: { rank: number; name: string };
  }[];
  winners: {
    seatIndex: number;
    playerId: string;
    amount: number;
    handName: string | null;
  }[];
  sidePots: SidePot[];
}

export interface HandCompletePayload {
  handId: string;
  finalSeats: ({ seatIndex: number; playerId: string; stack: number } | null)[];
}

export interface ServerToClientEvents {
  'lobby:table_list': (tables: TableState[]) => void;
  'lobby:table_created': (table: TableState) => void;
  'lobby:table_updated': (table: TableState) => void;
  'table:state': (state: TableState) => void;
  'table:player_joined': (data: { seatIndex: number; playerId: string; displayName: string; stack: number }) => void;
  'table:player_left': (data: { seatIndex: number; playerId: string }) => void;
  'hand:started': (payload: HandStartedPayload) => void;
  'hand:cards_dealt': (payload: CardsDealtPayload) => void;
  'hand:community_dealt': (payload: CommunityDealtPayload) => void;
  'hand:action_required': (payload: ActionRequiredPayload) => void;
  'hand:action_taken': (payload: ActionTakenPayload) => void;
  'hand:showdown': (payload: ShowdownPayload) => void;
  'hand:complete': (payload: HandCompletePayload) => void;
  'hand:error': (payload: { code: string; message: string }) => void;
}
