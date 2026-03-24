import { NLHEVariant } from '../../../src/domain/variants/NLHEVariant';
import { PLO4Variant } from '../../../src/domain/variants/PLO4Variant';
import { PLO5Variant } from '../../../src/domain/variants/PLO5Variant';
import { PLO6Variant } from '../../../src/domain/variants/PLO6Variant';

describe('Game Variants', () => {
  describe('NLHEVariant', () => {
    const variant = new NLHEVariant();

    it('has correct properties', () => {
      expect(variant.name).toBe('NLHE');
      expect(variant.holeCardCount).toBe(2);
      expect(variant.bettingStructure).toBe('no-limit');
    });

    it('validates any combo of 5 cards', () => {
      expect(variant.validateHandConstruction([{rank:'A',suit:'h'},{rank:'K',suit:'h'}], [{rank:'Q',suit:'h'},{rank:'J',suit:'h'},{rank:'T',suit:'h'}])).toBe(true);
      expect(variant.validateHandConstruction([], [{rank:'A',suit:'h'},{rank:'K',suit:'h'},{rank:'Q',suit:'h'},{rank:'J',suit:'h'},{rank:'T',suit:'h'}])).toBe(true);
    });
  });

  describe('PLO4Variant', () => {
    const variant = new PLO4Variant();

    it('has correct properties', () => {
      expect(variant.name).toBe('PLO4');
      expect(variant.holeCardCount).toBe(4);
      expect(variant.bettingStructure).toBe('pot-limit');
    });

    it('only allows exactly 2 hole + 3 board', () => {
      const two = [{rank:'A',suit:'h'},{rank:'K',suit:'h'}] as any;
      const three = [{rank:'Q',suit:'h'},{rank:'J',suit:'h'},{rank:'T',suit:'h'}] as any;
      expect(variant.validateHandConstruction(two, three)).toBe(true);
      expect(variant.validateHandConstruction([...two, {rank:'2',suit:'c'}] as any, three)).toBe(false);
      expect(variant.validateHandConstruction(two, [{rank:'Q',suit:'h'},{rank:'J',suit:'h'}] as any)).toBe(false);
    });
  });

  describe('PLO5Variant', () => {
    const variant = new PLO5Variant();

    it('inherits PLO rules, only holeCardCount differs', () => {
      expect(variant.name).toBe('PLO5');
      expect(variant.holeCardCount).toBe(5);
      expect(variant.bettingStructure).toBe('pot-limit');
      // Same 2+3 constraint as PLO4
      const two = [{rank:'A',suit:'h'},{rank:'K',suit:'h'}] as any;
      const three = [{rank:'Q',suit:'h'},{rank:'J',suit:'h'},{rank:'T',suit:'h'}] as any;
      expect(variant.validateHandConstruction(two, three)).toBe(true);
    });
  });

  describe('PLO6Variant', () => {
    const variant = new PLO6Variant();

    it('has holeCardCount=6 and inherits PLO rules', () => {
      expect(variant.name).toBe('PLO6');
      expect(variant.holeCardCount).toBe(6);
      expect(variant.bettingStructure).toBe('pot-limit');
    });
  });
});
