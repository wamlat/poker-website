// ─── Card Types ──────────────────────────────────────────────────────────────

export type Suit = 'c' | 'd' | 'h' | 's'; // clubs, diamonds, hearts, spades
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: Rank;
  suit: Suit;
}

// ─── Hand Evaluation ─────────────────────────────────────────────────────────

export interface EvaluatedHand {
  rank: number;         // higher = better
  name: string;         // e.g. "Full House"
  cards: Card[];        // best 5 cards
}

// ─── Game Variants ───────────────────────────────────────────────────────────

export type BettingStructure = 'no-limit' | 'pot-limit';
export type VariantName = 'NLHE' | 'PLO4' | 'PLO5' | 'PLO6';

// ─── Betting ─────────────────────────────────────────────────────────────────

export interface BettingState {
  potSize: number;
  currentBet: number;       // amount to call
  playerStack: number;
  bigBlind: number;
  lastRaiseSize: number;
}

export interface RaiseBounds {
  min: number;
  max: number;
}

export interface SidePot {
  amount: number;
  eligiblePlayerIds: string[];
}

// ─── Hand State Machine ───────────────────────────────────────────────────────

export enum HandPhase {
  WAITING   = 'waiting',
  DEALING   = 'dealing',
  PREFLOP   = 'preflop',
  FLOP      = 'flop',
  TURN      = 'turn',
  RIVER     = 'river',
  SHOWDOWN  = 'showdown',
  COMPLETE  = 'complete',
}

export type PlayerStatus = 'active' | 'folded' | 'all-in' | 'sitting-out';

export interface SeatState {
  seatIndex: number;
  playerId: string;
  displayName: string;
  holeCards: Card[];
  stack: number;
  currentStreetBet: number;
  totalHandContribution: number;
  status: PlayerStatus;
}

export interface HandSnapshot {
  handId: string;
  tableId: string;
  phase: HandPhase;
  variant: VariantName;
  communityCards: Card[];
  pot: number;
  sidePots: SidePot[];
  seats: (SeatState | null)[];
  currentActorSeatIndex: number | null;
  dealerButtonSeatIndex: number;
  smallBlindSeatIndex: number;
  bigBlindSeatIndex: number;
  currentBet: number;
  lastRaiseSize: number;
  actionDeadlineMs: number | null;
  bigBlind: number;
  smallBlind: number;
}

// ─── Player Actions ───────────────────────────────────────────────────────────

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in';

export interface PlayerAction {
  handId: string;
  playerId: string;
  seatIndex: number;
  action: ActionType;
  amount?: number;
}

export interface ValidAction {
  type: ActionType;
  amount?: number;    // exact amount for call
  minAmount?: number; // for bet/raise
  maxAmount?: number; // for bet/raise
}

// ─── Hand Events (emitted by FSM) ─────────────────────────────────────────────

export type HandEventType =
  | 'hand_started'
  | 'cards_dealt'          // private — per-player hole cards
  | 'community_dealt'
  | 'action_required'
  | 'action_taken'
  | 'pot_updated'
  | 'showdown'
  | 'hand_complete';

export interface HandEvent {
  type: HandEventType;
  payload: Record<string, unknown>;
  privateToPlayerId?: string; // if set, only emit to this player
}

// ─── Table ────────────────────────────────────────────────────────────────────

export interface TableConfig {
  tableId: string;
  name: string;
  variant: VariantName;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  actionTimeoutSeconds: number;
}

export interface Seat {
  seatIndex: number;
  playerId: string;
  displayName: string;
  stack: number;
  status: 'active' | 'sitting-out' | 'waiting-for-bb';
}

export interface TableState {
  config: TableConfig;
  seats: (Seat | null)[];
  status: 'waiting' | 'running' | 'paused';
  currentHandId: string | null;
  handNumber: number;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  username: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}
