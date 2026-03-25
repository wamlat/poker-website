import { Card, SidePot, TableSettings, TableState, ValidAction } from '../../types';

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

export interface ShowdownPlayer {
  seatIndex: number;
  playerId: string;
  holeCards: Card[];
  bestHand: { rank: number; name: string };
  mustShow: boolean;
}

export interface ShowdownPayload {
  players: ShowdownPlayer[];
  winners: {
    seatIndex: number;
    playerId: string;
    amount: number;
    handName: string | null;
  }[];
  sidePots: SidePot[];
  runItTwice?: boolean;
  board1?: Card[];
  board2?: Card[];
  board1Winners?: { seatIndex: number; playerId: string; amount: number }[];
  board2Winners?: { seatIndex: number; playerId: string; amount: number }[];
}

export interface HandCompletePayload {
  handId: string;
  finalSeats: ({ seatIndex: number; playerId: string; stack: number } | null)[];
}

export interface CardsRevealedPayload {
  seatIndex: number;
  playerId: string;
  holeCards: Card[];
}

export interface RabbitCardsPayload {
  cards: Card[];
}

export interface RunTwoBoardPayload {
  board: Card[];
}

export interface ChipsAdjustedPayload {
  targetPlayerId: string;
  seatIndex: number;
  newStack: number;
}

export interface RITVoteRequestPayload {
  handId: string;
  eligiblePlayerIds: string[];
}

export interface ServerToClientEvents {
  'lobby:table_list': (tables: TableState[]) => void;
  'lobby:table_created': (table: TableState) => void;
  'lobby:table_updated': (table: TableState) => void;
  'table:state': (state: TableState) => void;
  'table:player_joined': (data: { seatIndex: number; playerId: string; displayName: string; stack: number }) => void;
  'table:player_left': (data: { seatIndex: number; playerId: string }) => void;
  'table:settings_updated': (settings: TableSettings) => void;
  'table:host_changed': (payload: { newHostPlayerId: string }) => void;
  'table:chips_adjusted': (payload: ChipsAdjustedPayload) => void;
  'hand:started': (payload: HandStartedPayload) => void;
  'hand:cards_dealt': (payload: CardsDealtPayload) => void;
  'hand:community_dealt': (payload: CommunityDealtPayload) => void;
  'hand:run_two_board': (payload: RunTwoBoardPayload) => void;
  'hand:action_required': (payload: ActionRequiredPayload) => void;
  'hand:action_taken': (payload: ActionTakenPayload) => void;
  'hand:showdown': (payload: ShowdownPayload) => void;
  'hand:cards_revealed': (payload: CardsRevealedPayload) => void;
  'hand:rabbit': (payload: RabbitCardsPayload) => void;
  'hand:complete': (payload: HandCompletePayload) => void;
  'hand:rit_vote_request': (payload: RITVoteRequestPayload) => void;
  'hand:error': (payload: { code: string; message: string }) => void;
}
