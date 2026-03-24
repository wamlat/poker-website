import { BettingState, RaiseBounds } from '../../types';

export interface BettingEngine {
  readonly structureName: string;

  /** Min and max amounts a player can bet/raise to (total, not raise-by) */
  getRaiseBounds(state: BettingState): RaiseBounds;

  /** Whether a given total bet amount is valid */
  isValidBetAmount(amount: number, state: BettingState): boolean;
}
