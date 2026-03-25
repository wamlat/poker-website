import { BasePLOVariant } from './BasePLOVariant';

export class PLO5Variant extends BasePLOVariant {
  readonly name = 'PLO5' as const;
  readonly holeCardCount = 5;
  // 5*8 + 5 community + 5 RIT = 50 ≤ 52
  readonly maxPlayers = 8;
}
