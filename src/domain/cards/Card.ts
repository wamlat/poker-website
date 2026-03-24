import { Card, Rank, Suit } from '../../types';

export const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS: Suit[] = ['c', 'd', 'h', 's'];

/** Formats a card as a string for pokersolver (e.g. "Ah", "Kd", "2c") */
export function cardToString(card: Card): string {
  const suitMap: Record<Suit, string> = { c: 'c', d: 'd', h: 'h', s: 's' };
  return `${card.rank}${suitMap[card.suit]}`;
}

/** Parses a pokersolver-style string back to a Card */
export function stringToCard(str: string): Card {
  const rank = str.slice(0, -1) as Rank;
  const suit = str.slice(-1) as Suit;
  return { rank, suit };
}

export function cardEquals(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}
