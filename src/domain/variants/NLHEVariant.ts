import { Card, EvaluatedHand } from '../../types';
import { HandEvaluator } from '../cards/HandEvaluator';
import { GameVariant } from './GameVariant';

export class NLHEVariant implements GameVariant {
  readonly name = 'NLHE' as const;
  readonly holeCardCount = 2;
  readonly bettingStructure = 'no-limit' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 9;

  selectBestHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
    return HandEvaluator.bestNLHEHand(holeCards, communityCards);
  }

  validateHandConstruction(usedHoleCards: Card[], usedCommunityCards: Card[]): boolean {
    // NLHE: any combination as long as total = 5 cards
    return usedHoleCards.length + usedCommunityCards.length === 5;
  }
}
