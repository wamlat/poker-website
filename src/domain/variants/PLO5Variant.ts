import { BasePLOVariant } from './BasePLOVariant';

export class PLO5Variant extends BasePLOVariant {
  readonly name = 'PLO5' as const;
  readonly holeCardCount = 5;
}
