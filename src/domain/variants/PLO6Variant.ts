import { BasePLOVariant } from './BasePLOVariant';

export class PLO6Variant extends BasePLOVariant {
  readonly name = 'PLO6' as const;
  readonly holeCardCount = 6;
}
