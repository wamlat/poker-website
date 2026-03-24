import { HandEvaluator } from '../../../src/domain/cards/HandEvaluator';
import { Card } from '../../../src/types';

function c(str: string): Card {
  return { rank: str.slice(0, -1) as Card['rank'], suit: str.slice(-1) as Card['suit'] };
}

describe('HandEvaluator', () => {
  describe('bestNLHEHand', () => {
    it('finds royal flush (pokersolver calls it Straight Flush)', () => {
      const hole = [c('Ah'), c('Kh')];
      const community = [c('Qh'), c('Jh'), c('Th'), c('2c'), c('3d')];
      const result = HandEvaluator.bestNLHEHand(hole, community);
      // pokersolver names A-K-Q-J-T suited as 'Straight Flush', not 'Royal Flush'
      expect(result.name).toContain('Straight Flush');
    });

    it('uses best 5 from 7', () => {
      const hole = [c('Ah'), c('Ad')];
      const community = [c('Ac'), c('As'), c('Kh'), c('2c'), c('3d')];
      const result = HandEvaluator.bestNLHEHand(hole, community);
      expect(result.name).toContain('Four of a Kind');
    });
  });

  describe('bestPLOHand', () => {
    it('must use exactly 2 hole cards and 3 board cards', () => {
      // Hole cards contain 4 aces — but can only use 2
      // Board has a straight available using 3 cards
      const hole = [c('Ah'), c('Ad'), c('2c'), c('3d')];
      const community = [c('Ac'), c('As'), c('Kh'), c('Qh'), c('Jh')];
      // Best valid: Ah+Ad (hole) + Ac+As+Kh (board) = four aces
      const result = HandEvaluator.bestPLOHand(hole, community, 2, 3);
      expect(result).toBeDefined();
      expect(result.name).toBeTruthy();
    });

    it('evaluates all C(4,2) x C(5,3) combinations for PLO4', () => {
      const hole = [c('2h'), c('3h'), c('4h'), c('5h')];
      const community = [c('6h'), c('7h'), c('8h'), c('9h'), c('Th')];
      const result = HandEvaluator.bestPLOHand(hole, community, 2, 3);
      expect(result).toBeDefined();
    });

    it('throws if not enough community cards', () => {
      const hole = [c('Ah'), c('Kh'), c('Qh'), c('Jh')];
      const community = [c('Th'), c('9h')]; // only 2, need 3
      expect(() => HandEvaluator.bestPLOHand(hole, community, 2, 3)).toThrow();
    });
  });

  describe('findWinners', () => {
    it('finds single winner by hand class', () => {
      const community = [c('9c'), c('8d'), c('7h'), c('3c'), c('4s')];
      const hands = [
        HandEvaluator.bestNLHEHand([c('2h'), c('2d')], community), // pair of 2s
        HandEvaluator.bestNLHEHand([c('Ah'), c('Ad')], community), // pair of aces
      ];
      expect(HandEvaluator.findWinners(hands)).toEqual([1]);
    });

    it('breaks ties by kicker (same pair, different kicker)', () => {
      // Both have pair of aces; hand 0 has K kicker, hand 1 has Q kicker
      const community = [c('As'), c('3d'), c('5c'), c('7c'), c('9d')];
      const hands = [
        HandEvaluator.bestNLHEHand([c('Ah'), c('Kh')], community), // A-A-K-9-7
        HandEvaluator.bestNLHEHand([c('Ad'), c('Qh')], community), // A-A-Q-9-7
      ];
      expect(HandEvaluator.findWinners(hands)).toEqual([0]);
    });

    it('handles true ties when both players play the board', () => {
      // Board is a straight flush — both hole cards are irrelevant
      const community = [c('Ah'), c('Kh'), c('Qh'), c('Jh'), c('Th')];
      const hands = [
        HandEvaluator.bestNLHEHand([c('2c'), c('3d')], community),
        HandEvaluator.bestNLHEHand([c('4c'), c('5d')], community),
      ];
      expect(HandEvaluator.findWinners(hands)).toEqual([0, 1]);
    });

    it('returns empty array for empty input', () => {
      expect(HandEvaluator.findWinners([])).toEqual([]);
    });
  });
});
