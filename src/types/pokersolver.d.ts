declare module 'pokersolver' {
  export class Hand {
    rank: number;
    name: string;
    cardPool: { value: string; suit: string }[];

    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
  }
}
