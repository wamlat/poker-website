import { VariantName } from '../../types';
import { GameVariant } from './GameVariant';
import { NLHEVariant } from './NLHEVariant';
import { PLO4Variant } from './PLO4Variant';
import { PLO5Variant } from './PLO5Variant';
import { PLO6Variant } from './PLO6Variant';

export { GameVariant } from './GameVariant';
export { NLHEVariant } from './NLHEVariant';
export { BasePLOVariant } from './BasePLOVariant';
export { PLO4Variant } from './PLO4Variant';
export { PLO5Variant } from './PLO5Variant';
export { PLO6Variant } from './PLO6Variant';

const VARIANT_MAP: Record<VariantName, GameVariant> = {
  NLHE: new NLHEVariant(),
  PLO4: new PLO4Variant(),
  PLO5: new PLO5Variant(),
  PLO6: new PLO6Variant(),
};

export function getVariant(name: VariantName): GameVariant {
  return VARIANT_MAP[name];
}
