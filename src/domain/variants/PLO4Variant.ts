import { BasePLOVariant } from './BasePLOVariant';

export class PLO4Variant extends BasePLOVariant {
  readonly name = 'PLO4' as const;
  readonly holeCardCount = 4;
}
