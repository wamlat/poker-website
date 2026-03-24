import { Card } from '../../types';
import { RANKS, SUITS } from './Card';

export class Deck {
  private cards: Card[];

  constructor() {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({ rank, suit });
      }
    }
    this.shuffle();
  }

  private shuffle(): void {
    // Fisher-Yates shuffle
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  deal(count: number): Card[] {
    if (count > this.cards.length) {
      throw new Error(`Cannot deal ${count} cards — only ${this.cards.length} remaining`);
    }
    return this.cards.splice(0, count);
  }

  remaining(): number {
    return this.cards.length;
  }
}
