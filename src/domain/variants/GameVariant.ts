import { BettingStructure, Card, EvaluatedHand, VariantName } from '../../types';

/**
 * The central extensibility interface. Every game variant must satisfy this contract.
 * The hand state machine, betting engine, and deal logic are all parameterized through it.
 */
export interface GameVariant {
  readonly name: VariantName;
  readonly holeCardCount: number;
  readonly bettingStructure: BettingStructure;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /**
   * Returns the best possible hand for this variant given hole cards and community cards.
   * NLHE: any combination. PLO: must use exactly 2 hole + 3 community.
   */
  selectBestHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand;

  /**
   * Validates that the cards used to construct a 5-card hand are legal for this variant.
   */
  validateHandConstruction(usedHoleCards: Card[], usedCommunityCards: Card[]): boolean;
}
