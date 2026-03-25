import { BettingState, RaiseBounds } from '../../types';
import { BettingEngine } from './BettingEngine';

export class NoLimitEngine implements BettingEngine {
  readonly structureName = 'No Limit';

  getRaiseBounds(state: BettingState): RaiseBounds {
    // Min raise = current bet + max(lastRaiseSize, bigBlind)
    const raiseIncrement = Math.max(state.lastRaiseSize, state.bigBlind);
    const minTotal = state.currentBet + raiseIncrement;
    // Max total street commitment = already committed + remaining stack
    const maxTotal = state.playerStreetBet + state.playerStack;

    return {
      min: Math.min(minTotal, maxTotal),
      max: maxTotal,
    };
  }

  isValidBetAmount(amount: number, state: BettingState): boolean {
    const allIn = state.playerStreetBet + state.playerStack;
    if (amount === allIn) return true; // all-in always valid
    const bounds = this.getRaiseBounds(state);
    return amount >= bounds.min && amount <= bounds.max;
  }
}
