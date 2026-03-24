import { calculateSidePots } from '../../../src/domain/betting/SidePotCalculator';

describe('calculateSidePots', () => {
  it('returns empty array for no contributions', () => {
    expect(calculateSidePots([])).toEqual([]);
  });

  it('creates correct side pots for 3-way all-in at different levels', () => {
    // A put in 100, B put in 200, C put in 500
    const contribs = [
      { playerId: 'A', totalContribution: 100 },
      { playerId: 'B', totalContribution: 200 },
      { playerId: 'C', totalContribution: 500 },
    ];
    const pots = calculateSidePots(contribs);

    // Pot 1: 100 × 3 = 300, A,B,C eligible
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligiblePlayerIds).toContain('A');
    expect(pots[0].eligiblePlayerIds).toContain('B');
    expect(pots[0].eligiblePlayerIds).toContain('C');

    // Pot 2: (200-100) × 2 = 200, B,C eligible
    expect(pots[1].amount).toBe(200);
    expect(pots[1].eligiblePlayerIds).not.toContain('A');
    expect(pots[1].eligiblePlayerIds).toContain('B');
    expect(pots[1].eligiblePlayerIds).toContain('C');

    // Pot 3: (500-200) × 1 = 300, C eligible
    expect(pots[2].amount).toBe(300);
    expect(pots[2].eligiblePlayerIds).toEqual(['C']);

    // Total should equal sum of contributions
    const total = pots.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(100 + 200 + 500);
  });

  it('handles equal contributions (no side pots needed)', () => {
    const contribs = [
      { playerId: 'A', totalContribution: 100 },
      { playerId: 'B', totalContribution: 100 },
    ];
    const pots = calculateSidePots(contribs);
    expect(pots.length).toBe(1);
    expect(pots[0].amount).toBe(200);
  });
});
