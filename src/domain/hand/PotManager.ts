import { SidePot } from '../../types';
import { calculateSidePots } from '../betting/SidePotCalculator';

export class PotManager {
  private contributions: Map<string, number> = new Map();
  private mainPot = 0;

  contribute(playerId: string, amount: number): void {
    const current = this.contributions.get(playerId) ?? 0;
    this.contributions.set(playerId, current + amount);
    this.mainPot += amount;
  }

  totalPot(): number {
    return this.mainPot;
  }

  /**
   * Returns side pots only when at least one player is all-in.
   * Otherwise returns a single pot with all active players eligible.
   */
  calculatePots(activePlayerIds: string[]): { mainPot: number; sidePots: SidePot[] } {
    const contribArray = Array.from(this.contributions.entries()).map(
      ([playerId, total]) => ({ playerId, totalContribution: total }),
    );

    const allInPlayers = contribArray.filter((c) => !activePlayerIds.includes(c.playerId));

    if (allInPlayers.length === 0) {
      return {
        mainPot: this.mainPot,
        sidePots: [],
      };
    }

    const sidePots = calculateSidePots(contribArray);
    return {
      mainPot: this.mainPot,
      sidePots,
    };
  }

  reset(): void {
    this.contributions.clear();
    this.mainPot = 0;
  }
}
