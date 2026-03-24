import { BettingState, RaiseBounds } from '../../types';
import { BettingEngine } from './BettingEngine';

export class NoLimitEngine implements BettingEngine {
  readonly structureName = 'No Limit';

  getRaiseBounds(state: BettingState): RaiseBounds {
    // Min raise = current bet + max(lastRaiseSize, bigBlind)
    const raiseIncrement = Math.max(state.lastRaiseSize, state.bigBlind);
    const minTotal = state.currentBet + raiseIncrement;

    return {
      min: Math.min(minTotal, state.playerStack),
      max: state.playerStack, // can go all-in for any amount
    };
  }

  isValidBetAmount(amount: number, state: BettingState): boolean {
    if (amount === state.playerStack) return true; // all-in always valid
    const bounds = this.getRaiseBounds(state);
    return amount >= bounds.min && amount <= bounds.max;
  }
}
