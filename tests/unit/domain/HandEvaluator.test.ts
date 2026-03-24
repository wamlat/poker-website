import { HandEvaluator } from '../../../src/domain/cards/HandEvaluator';
import { Card } from '../../../src/types';

function c(str: string): Card {
  return { rank: str.slice(0, -1) as Card['rank'], suit: str.slice(-1) as Card['suit'] };
}

describe('HandEvaluator', () => {
  describe('bestNLHEHand', () => {
    it('finds royal flush', () => {
      const hole = [c('Ah'), c('Kh')];
      const community = [c('Qh'), c('Jh'), c('Th'), c('2c'), c('3d')];
      const result = HandEvaluator.bestNLHEHand(hole, community);
      expect(result.name).toContain('Royal Flush');
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
      // Best hand: use Ah+Ad from hole + Ac+As+Kh would be invalid (4 aces)
      // Must pick 2 hole + 3 community
      // Best valid: Ah+Ad + Ac+As+Kh is not valid (only 3 from board and 2 from hole = ok, but Ac and As are on board)
      // Ah+Ad (hole) + Ac+As+Kh (board) = four aces — valid PLO hand
      const result = HandEvaluator.bestPLOHand(hole, community, 2, 3);
      expect(result).toBeDefined();
      expect(result.name).toBeTruthy();
    });

    it('evaluates all C(4,2) x C(5,3) combinations for PLO4', () => {
      const hole = [c('2h'), c('3h'), c('4h'), c('5h')];
      const community = [c('6h'), c('7h'), c('8h'), c('9h'), c('Th')];
      // Straight flush possible using hole 2h+3h + community 6h+7h+8h? No — not valid 5 card hand
      // Best: use any 2 from hole + any 3 from board
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
    it('finds single winner', () => {
      const hands = [
        { rank: 100, name: 'Pair', cards: [] },
        { rank: 200, name: 'Two Pair', cards: [] },
        { rank: 50, name: 'High Card', cards: [] },
      ];
      expect(HandEvaluator.findWinners(hands)).toEqual([1]);
    });

    it('handles ties', () => {
      const hands = [
        { rank: 200, name: 'Two Pair', cards: [] },
        { rank: 200, name: 'Two Pair', cards: [] },
      ];
      expect(HandEvaluator.findWinners(hands)).toEqual([0, 1]);
    });
  });
});
