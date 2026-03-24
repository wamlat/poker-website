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
    // Use .cards (best 5) not .cardPool (all inputs) so findWinners can re-solve them
    cards: solverHand.cards.map((c) => ({
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

    const candidates: ReturnType<typeof SolverHand.solve>[] = [];

    for (const hCombo of holeCombos) {
      for (const bCombo of boardCombos) {
        const fiveCards = [...hCombo, ...bCombo].map(cardToString);
        candidates.push(SolverHand.solve(fiveCards));
      }
    }

    if (candidates.length === 0) throw new Error('Could not evaluate PLO hand — insufficient cards');

    // Use Hand.winners() for proper rank+kicker comparison across all combinations
    const best = SolverHand.winners(candidates)[0];
    return solverHandToEvaluated(best);
  }

  /**
   * Determines the winner(s) among multiple evaluated hands.
   * Returns indices of winners (handles ties including kicker comparison).
   *
   * Re-solves each hand's best-5 cards via pokersolver so that Hand.winners()
   * does full rank+kicker comparison rather than just integer rank.
   */
  static findWinners(hands: EvaluatedHand[]): number[] {
    if (hands.length === 0) return [];
    const solverHands = hands.map((h) => SolverHand.solve(h.cards.map(cardToString)));
    const winners = SolverHand.winners(solverHands);
    return solverHands.reduce<number[]>((acc, h, i) => {
      if (winners.includes(h)) acc.push(i);
      return acc;
    }, []);
  }
}
