declare module 'pokersolver' {
  export class Hand {
    rank: number;
    name: string;
    /** The best 5 cards selected for this hand */
    cards: { value: string; suit: string }[];
    /** All input cards passed to solve() */
    cardPool: { value: string; suit: string }[];

    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
  }
}
