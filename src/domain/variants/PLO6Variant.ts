import { BasePLOVariant } from './BasePLOVariant';

export class PLO6Variant extends BasePLOVariant {
  readonly name = 'PLO6' as const;
  readonly holeCardCount = 6;
  // 6*7 + 5 community + 5 RIT = 52 ≤ 52
  readonly maxPlayers = 7;
}
