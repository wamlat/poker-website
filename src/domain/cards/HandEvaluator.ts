import { Hand as SolverHand } from 'pokersolver';
import { Card, EvaluatedHand } from '../../types';
import { cardToString } from './Card';

/** Returns all k-combinations from an array */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map((combo) => [first, ...combo]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function solverHandToEvaluated(solverHand: ReturnType<typeof SolverHand.solve>): EvaluatedHand {
  return {
    rank: solverHand.rank,
    name: solverHand.name,
    cards: (solverHand.cardPool as { value: string; suit: string }[]).map((c) => ({
      rank: c.value as Card['rank'],
      suit: c.suit as Card['suit'],
    })),
  };
}

export class HandEvaluator {
  /**
   * NLHE: best 5 cards from any combination of hole + community cards.
   * Standard best-of-7 evaluation.
   */
  static bestNLHEHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
    const all = [...holeCards, ...communityCards].map(cardToString);
    const solved = SolverHand.solve(all);
    return solverHandToEvaluated(solved);
  }

  /**
   * PLO: MUST use exactly `holeRequired` cards from hole and `boardRequired`
   * from community. For standard PLO: holeRequired=2, boardRequired=3.
   *
   * Enumerates all valid combinations and returns the best.
   * Max combos for PLO6: C(6,2) × C(5,3) = 15 × 10 = 150 — trivially fast.
   */
  static bestPLOHand(
    holeCards: Card[],
    communityCards: Card[],
    holeRequired = 2,
    boardRequired = 3,
  ): EvaluatedHand {
    const holeCombos = combinations(holeCards, holeRequired);
    const boardCombos = combinations(communityCards, boardRequired);

    let best: EvaluatedHand | null = null;

    for (const hCombo of holeCombos) {
      for (const bCombo of boardCombos) {
        const fiveCards = [...hCombo, ...bCombo].map(cardToString);
        const solved = SolverHand.solve(fiveCards);
        const candidate = solverHandToEvaluated(solved);
        if (best === null || candidate.rank > best.rank) {
          best = candidate;
        }
      }
    }

    if (!best) throw new Error('Could not evaluate PLO hand — insufficient cards');
    return best;
  }

  /**
   * Determines the winner(s) among multiple evaluated hands.
   * Returns indices of winners (handles ties).
   */
  static findWinners(hands: EvaluatedHand[]): number[] {
    if (hands.length === 0) return [];
    const maxRank = Math.max(...hands.map((h) => h.rank));
    return hands.reduce<number[]>((acc, h, i) => {
      if (h.rank === maxRank) acc.push(i);
      return acc;
    }, []);
  }
}
