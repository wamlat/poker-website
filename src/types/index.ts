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
  currentBet: number;       // total street bet to call/beat
  playerStack: number;      // chips remaining in stack
  playerStreetBet: number;  // chips already committed this street by this player
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

// ─── Table Settings ───────────────────────────────────────────────────────────

export type ShowdownRevealRule = 'standard' | 'always' | 'never';

export interface TableSettings {
  autoDeal: boolean;
  autoDealDelaySeconds: 2 | 4 | 6;
  runItTwice: boolean;
  rabbitHunting: boolean;
  showdownReveal: ShowdownRevealRule;
  actionTimeoutSeconds: number;
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
  hasActedThisStreet: boolean;
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
  lastAggressorSeatIndex: number | null;
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
  | 'run_two_board'        // second board in run-it-twice
  | 'action_required'
  | 'action_taken'
  | 'pot_updated'
  | 'showdown'
  | 'rabbit_cards'         // rabbit hunting — future cards revealed after fold win
  | 'hand_complete'
  | 'rit_vote_needed'      // pause before all-in runout to collect run-it-twice votes
  | 'hand_error';          // validation failure — private to acting player

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

export const DEFAULT_TABLE_SETTINGS: TableSettings = {
  autoDeal: false,
  autoDealDelaySeconds: 4,
  runItTwice: false,
  rabbitHunting: false,
  showdownReveal: 'standard',
  actionTimeoutSeconds: 20,
};

export interface PendingJoinRequest {
  requestId: string;
  playerId: string;
  displayName: string;
  requestedBuyIn: number;
  preferredSeatIndex: number | null;
  requestedAt: number;
}

export interface TableState {
  config: TableConfig;
  seats: (Seat | null)[];
  status: 'waiting' | 'running' | 'paused';
  currentHandId: string | null;
  handNumber: number;
  /** Seat index of the last dealer button (-1 before first hand) */
  dealerSeatIndex: number;
  hostPlayerId: string;
  settings: TableSettings;
  pendingJoinRequests: PendingJoinRequest[];
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  playerId: string;
  displayName: string;
  totalBuyIn: number;
  currentStack: number;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}
