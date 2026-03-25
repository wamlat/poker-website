import { BettingState, RaiseBounds } from '../../types';
import { BettingEngine } from './BettingEngine';

export class PotLimitEngine implements BettingEngine {
  readonly structureName = 'Pot Limit';

  getRaiseBounds(state: BettingState): RaiseBounds {
    // Pot-limit formula: player calls first, then raises by the resulting pot size.
    // call = amount player still needs to put in to match currentBet
    const callAmount = state.currentBet - state.playerStreetBet;
    const potAfterCall = state.potSize + callAmount;
    const maxTotal = state.currentBet + potAfterCall;

    const raiseIncrement = Math.max(state.lastRaiseSize, state.bigBlind);
    const minTotal = state.currentBet + raiseIncrement;

    // Cap at player's total stack commitment this street
    const allIn = state.playerStreetBet + state.playerStack;

    return {
      min: Math.min(minTotal, allIn),
      max: Math.min(maxTotal, allIn),
    };
  }

  isValidBetAmount(amount: number, state: BettingState): boolean {
    const allIn = state.playerStreetBet + state.playerStack;
    if (amount === allIn) return true; // all-in always valid
    const bounds = this.getRaiseBounds(state);
    return amount >= bounds.min && amount <= bounds.max;
  }
}
