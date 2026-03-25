import {
  BettingState,
  HandSnapshot,
  PlayerAction,
  SeatState,
  ValidAction,
  ValidationResult,
} from '../../types';
import { BettingEngine } from '../betting/BettingEngine';

export class ActionValidator {
  constructor(private bettingEngine: BettingEngine) {}

  validate(action: PlayerAction, snapshot: HandSnapshot): ValidationResult {
    // 1. Must be this player's turn
    if (snapshot.currentActorSeatIndex === null) {
      return { valid: false, reason: 'NO_ACTOR' };
    }
    const actorSeat = snapshot.seats[snapshot.currentActorSeatIndex] as SeatState;
    if (!actorSeat || actorSeat.playerId !== action.playerId) {
      return { valid: false, reason: 'NOT_YOUR_TURN' };
    }

    // 2. handId must match current hand (prevents stale actions)
    if (action.handId !== snapshot.handId) {
      return { valid: false, reason: 'STALE_HAND_ID' };
    }

    // 3. Action must be in the valid set
    const validActions = this.computeValidActions(snapshot, actorSeat);
    const validTypes = validActions.map((a) => a.type);
    if (!validTypes.includes(action.action)) {
      return { valid: false, reason: 'INVALID_ACTION' };
    }

    // 4. Validate amount for bet/raise
    if (action.action === 'bet' || action.action === 'raise') {
      if (action.amount === undefined) {
        return { valid: false, reason: 'AMOUNT_REQUIRED' };
      }
      const bettingState = this.toBettingState(snapshot, actorSeat);
      if (!this.bettingEngine.isValidBetAmount(action.amount, bettingState)) {
        return { valid: false, reason: 'INVALID_AMOUNT' };
      }
    }

    return { valid: true };
  }

  computeValidActions(snapshot: HandSnapshot, seat: SeatState): ValidAction[] {
    const actions: ValidAction[] = [];
    const callAmount = Math.min(snapshot.currentBet - seat.currentStreetBet, seat.stack);
    const bettingState = this.toBettingState(snapshot, seat);

    // Fold is always available
    actions.push({ type: 'fold' });

    if (snapshot.currentBet === seat.currentStreetBet) {
      // No bet to call — can check
      actions.push({ type: 'check' });
    } else if (callAmount > 0) {
      // Always show call; callAmount is already capped at seat.stack so it handles
      // the all-in-call case naturally (callAmount === seat.stack).
      actions.push({ type: 'call', amount: callAmount });
    }

    // Explicit all-in shove: available in any betting structure when it would be
    // aggressive (total commitment exceeds current bet). In pot-limit this covers the
    // short-shove case where stack < minRaise so the raise action isn't available.
    if (seat.currentStreetBet + seat.stack > snapshot.currentBet) {
      actions.push({ type: 'all-in', amount: seat.stack });
    }

    // Bet (no current bet) or Raise (responding to a bet).
    // Only show when the player can actually raise *above* the current bet.
    const hasBet = snapshot.currentBet > 0;
    const bounds = this.bettingEngine.getRaiseBounds(bettingState);
    if (bounds.min > 0 && bounds.min <= bounds.max && bounds.max > snapshot.currentBet) {
      if (hasBet) {
        actions.push({ type: 'raise', minAmount: bounds.min, maxAmount: bounds.max });
      } else {
        actions.push({ type: 'bet', minAmount: bounds.min, maxAmount: bounds.max });
      }
    }

    return actions;
  }

  private toBettingState(snapshot: HandSnapshot, seat: SeatState): BettingState {
    return {
      potSize: snapshot.pot,
      currentBet: snapshot.currentBet,
      playerStack: seat.stack,
      playerStreetBet: seat.currentStreetBet,
      bigBlind: snapshot.bigBlind,
      lastRaiseSize: snapshot.lastRaiseSize,
    };
  }
}
