import { BettingState, RaiseBounds } from '../../types';
import { BettingEngine } from './BettingEngine';

export class PotLimitEngine implements BettingEngine {
  readonly structureName = 'Pot Limit';

  getRaiseBounds(state: BettingState): RaiseBounds {
    // Pot-limit max: pot after calling + call amount
    // i.e. if pot=100, currentBet=20, player can raise to 100 + 20 + 20 = 140 total
    const potAfterCall = state.potSize + state.currentBet;
    const maxTotal = state.currentBet + potAfterCall;

    const raiseIncrement = Math.max(state.lastRaiseSize, state.bigBlind);
    const minTotal = state.currentBet + raiseIncrement;

    return {
      min: Math.min(minTotal, state.playerStack),
      max: Math.min(maxTotal, state.playerStack),
    };
  }

  isValidBetAmount(amount: number, state: BettingState): boolean {
    if (amount === state.playerStack) return true; // all-in always valid
    const bounds = this.getRaiseBounds(state);
    return amount >= bounds.min && amount <= bounds.max;
  }
}
