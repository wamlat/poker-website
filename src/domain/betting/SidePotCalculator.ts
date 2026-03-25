import { SidePot } from '../../types';

interface PlayerContribution {
  playerId: string;
  totalContribution: number;
}

/**
 * Calculates side pots when one or more players are all-in.
 *
 * Algorithm: sort by contribution ascending, sweep through creating pots at each
 * distinct contribution level.
 *
 * Example: contributions = [{A, 100}, {B, 200}, {C, 500}]
 * Pot 1: 100 × 3 = 300  — A, B, C eligible
 * Pot 2: (200-100) × 2 = 200  — B, C eligible
 * Pot 3: (500-200) × 1 = 300  — C eligible
 */
export function calculateSidePots(contributions: PlayerContribution[]): SidePot[] {
  if (contributions.length === 0) return [];

  const sorted = [...contributions].sort((a, b) => a.totalContribution - b.totalContribution);
  const sidePots: SidePot[] = [];
  let previousLevel = 0;

  for (let i = 0; i < sorted.length; i++) {
    const currentLevel = sorted[i].totalContribution;
    if (currentLevel === previousLevel) continue;

    const levelSize = currentLevel - previousLevel;
    const eligiblePlayers = sorted.slice(i).map((p) => p.playerId);
    const contributors = contributions.filter((p) => p.totalContribution >= currentLevel);
    sidePots.push({
      amount: levelSize * contributors.length,
      eligiblePlayerIds: eligiblePlayers,
    });

    previousLevel = currentLevel;
  }

  return sidePots;
}
