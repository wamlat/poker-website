import { Card, EvaluatedHand } from '../../types';
import { HandEvaluator } from '../cards/HandEvaluator';
import { GameVariant } from './GameVariant';

/**
 * Shared base for all PLO variants (PLO4, PLO5, PLO6).
 * The must-use-exactly-2-from-hole / 3-from-board constraint is identical
 * across all PLO variants. Only holeCardCount differs.
 */
export abstract class BasePLOVariant implements GameVariant {
  abstract readonly name: 'PLO4' | 'PLO5' | 'PLO6';
  abstract readonly holeCardCount: number;

  readonly bettingStructure = 'pot-limit' as const;
  readonly minPlayers = 2;
  // Overridden by subclasses — PLO6 needs fewer seats to avoid deck exhaustion
  readonly maxPlayers: number = 9;

  selectBestHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
    return HandEvaluator.bestPLOHand(holeCards, communityCards, 2, 3);
  }

  validateHandConstruction(usedHoleCards: Card[], usedCommunityCards: Card[]): boolean {
    return usedHoleCards.length === 2 && usedCommunityCards.length === 3;
  }
}
