import { NoLimitEngine } from '../../../src/domain/betting/NoLimitEngine';
import { PotLimitEngine } from '../../../src/domain/betting/PotLimitEngine';
import { BettingState } from '../../../src/types';

const baseState: BettingState = {
  potSize: 100,
  currentBet: 20,
  playerStack: 500,
  bigBlind: 20,
  lastRaiseSize: 20,
};

describe('NoLimitEngine', () => {
  const engine = new NoLimitEngine();

  it('min raise = current bet + last raise size', () => {
    const bounds = engine.getRaiseBounds(baseState);
    expect(bounds.min).toBe(40); // 20 + 20
  });

  it('max raise = player stack (all-in)', () => {
    const bounds = engine.getRaiseBounds(baseState);
    expect(bounds.max).toBe(500);
  });

  it('min raise capped at player stack if short-stacked', () => {
    const shortStack = { ...baseState, playerStack: 30 };
    const bounds = engine.getRaiseBounds(shortStack);
    expect(bounds.min).toBe(30);
    expect(bounds.max).toBe(30);
  });

  it('all-in is always valid', () => {
    expect(engine.isValidBetAmount(500, baseState)).toBe(true);
  });
});

describe('PotLimitEngine', () => {
  const engine = new PotLimitEngine();

  it('calculates pot-limit max correctly', () => {
    // pot=100, currentBet=20 → potAfterCall=120, max = 20 + 120 = 140
    const bounds = engine.getRaiseBounds(baseState);
    expect(bounds.max).toBe(140);
  });

  it('min raise uses big blind as floor', () => {
    const bounds = engine.getRaiseBounds(baseState);
    expect(bounds.min).toBe(40); // 20 + 20
  });

  it('caps max at player stack', () => {
    const shortStack = { ...baseState, playerStack: 50 };
    const bounds = engine.getRaiseBounds(shortStack);
    expect(bounds.max).toBe(50);
  });

  it('rejects bet above pot limit', () => {
    expect(engine.isValidBetAmount(200, baseState)).toBe(false); // 200 > max 140
  });
});
