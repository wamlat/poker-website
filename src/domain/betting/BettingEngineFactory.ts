import { BettingStructure } from '../../types';
import { BettingEngine } from './BettingEngine';
import { NoLimitEngine } from './NoLimitEngine';
import { PotLimitEngine } from './PotLimitEngine';

export class BettingEngineFactory {
  static create(structure: BettingStructure): BettingEngine {
    switch (structure) {
      case 'no-limit':
        return new NoLimitEngine();
      case 'pot-limit':
        return new PotLimitEngine();
      default: {
        const _exhaustive: never = structure;
        throw new Error(`Unknown betting structure: ${_exhaustive}`);
      }
    }
  }
}
