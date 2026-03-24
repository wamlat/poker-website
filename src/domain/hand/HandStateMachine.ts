const uuidv4 = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
import {
  Card,
  HandEvent,
  HandPhase,
  HandSnapshot,
  PlayerAction,
  SeatState,
  SidePot,
  TableConfig,
  TableSettings,
  ValidAction,
} from '../../types';
import { BettingEngineFactory } from '../betting/BettingEngineFactory';
import { Deck } from '../cards/Deck';
import { HandEvaluator } from '../cards/HandEvaluator';
import { GameVariant } from '../variants/GameVariant';
import { ActionValidator } from './ActionValidator';
import { PotManager } from './PotManager';

interface InitialSeat {
  seatIndex: number;
  playerId: string;
  displayName: string;
  stack: number;
}

export class HandStateMachine {
  private snapshot: HandSnapshot;
  private deck: Deck;
  private potManager: PotManager;
  private validator: ActionValidator;
  private variant: GameVariant;
  private settings: TableSettings;

  constructor(
    variant: GameVariant,
    config: TableConfig,
    seats: InitialSeat[],
    dealerButtonSeatIndex: number,
    handNumber: number,
    settings: TableSettings,
  ) {
    this.variant = variant;
    this.deck = new Deck();
    this.potManager = new PotManager();
    this.settings = settings;

    const bettingEngine = BettingEngineFactory.create(variant.bettingStructure);
    this.validator = new ActionValidator(bettingEngine);

    this.snapshot = this.buildInitialSnapshot(config, seats, dealerButtonSeatIndex, handNumber);
  }

  getSnapshot(): HandSnapshot {
    return { ...this.snapshot };
  }

  /** Start the hand: post blinds and deal hole cards */
  start(): HandEvent[] {
    const events: HandEvent[] = [];
    const seats = this.getActiveSeatStates();

    if (seats.length < 2) {
      throw new Error('Need at least 2 players to start a hand');
    }

    // Post small blind
    const sbSeat = this.snapshot.seats[this.snapshot.smallBlindSeatIndex] as SeatState;
    const sbAmount = Math.min(this.snapshot.smallBlind, sbSeat.stack);
    this.postBlind(sbSeat, sbAmount);

    // Post big blind
    const bbSeat = this.snapshot.seats[this.snapshot.bigBlindSeatIndex] as SeatState;
    const bbAmount = Math.min(this.snapshot.bigBlind, bbSeat.stack);
    this.postBlind(bbSeat, bbAmount);

    this.snapshot.currentBet = bbAmount;
    this.snapshot.lastRaiseSize = bbAmount;
    this.snapshot.phase = HandPhase.PREFLOP;

    // First to act preflop: seat after BB
    this.snapshot.currentActorSeatIndex = this.nextActiveAfter(this.snapshot.bigBlindSeatIndex);

    events.push({
      type: 'hand_started',
      payload: {
        handId: this.snapshot.handId,
        variant: this.snapshot.variant,
        dealerButtonSeatIndex: this.snapshot.dealerButtonSeatIndex,
        smallBlindSeatIndex: this.snapshot.smallBlindSeatIndex,
        bigBlindSeatIndex: this.snapshot.bigBlindSeatIndex,
        pot: this.snapshot.pot,
      },
    });

    // Deal hole cards
    for (const seat of this.getActiveSeatStates()) {
      seat.holeCards = this.deck.deal(this.variant.holeCardCount);
      events.push({
        type: 'cards_dealt',
        payload: { seatIndex: seat.seatIndex, holeCards: seat.holeCards },
        privateToPlayerId: seat.playerId,
      });
    }

    events.push(...this.emitActionRequired());

    return events;
  }

  /** Process a player action. Returns events to emit. */
  act(action: PlayerAction): HandEvent[] {
    const result = this.validator.validate(action, this.snapshot);
    if (!result.valid) {
      return [
        {
          type: 'action_taken',
          payload: { error: result.reason },
          privateToPlayerId: action.playerId,
        },
      ];
    }

    const events: HandEvent[] = [];
    const seat = this.snapshot.seats[action.seatIndex] as SeatState;

    switch (action.action) {
      case 'fold':
        seat.status = 'folded';
        break;

      case 'check':
        break;

      case 'call': {
        const callAmount = Math.min(
          this.snapshot.currentBet - seat.currentStreetBet,
          seat.stack,
        );
        this.addToPot(seat, callAmount);
        if (seat.stack === 0) seat.status = 'all-in';
        break;
      }

      case 'bet':
      case 'raise': {
        const amount = action.amount!;
        const raiseSize = amount - this.snapshot.currentBet;
        this.snapshot.lastRaiseSize = raiseSize;
        this.snapshot.currentBet = amount;
        this.addToPot(seat, amount - seat.currentStreetBet);
        if (seat.stack === 0) seat.status = 'all-in';
        this.snapshot.lastAggressorSeatIndex = seat.seatIndex;
        // Reset everyone else's acted flag so they must respond to the raise
        for (const s of this.getActiveSeatStates()) {
          if (s.seatIndex !== seat.seatIndex) s.hasActedThisStreet = false;
        }
        break;
      }

      case 'all-in': {
        const allInAmount = seat.stack;
        if (seat.currentStreetBet + allInAmount > this.snapshot.currentBet) {
          const raiseSize = seat.currentStreetBet + allInAmount - this.snapshot.currentBet;
          if (raiseSize > this.snapshot.lastRaiseSize) {
            this.snapshot.lastRaiseSize = raiseSize;
          }
          this.snapshot.currentBet = seat.currentStreetBet + allInAmount;
          this.snapshot.lastAggressorSeatIndex = seat.seatIndex;
          for (const s of this.getActiveSeatStates()) {
            if (s.seatIndex !== seat.seatIndex) s.hasActedThisStreet = false;
          }
        }
        this.addToPot(seat, allInAmount);
        seat.status = 'all-in';
        break;
      }
    }

    // Mark this player as having voluntarily acted
    seat.hasActedThisStreet = true;

    events.push({
      type: 'action_taken',
      payload: {
        seatIndex: seat.seatIndex,
        action: action.action,
        amount: action.amount,
        pot: this.snapshot.pot,
      },
    });

    // Check if hand should end early (only one player not folded)
    const notFolded = this.getActiveSeatStates().filter((s) => s.status !== 'folded');
    if (notFolded.length === 1) {
      events.push(...this.awardPotToLastPlayer(notFolded[0]));
      return events;
    }

    // Check if street is complete
    if (this.isStreetComplete()) {
      events.push(...this.advanceStreet());
    } else {
      this.snapshot.currentActorSeatIndex = this.nextActiveAfter(seat.seatIndex);
      events.push(...this.emitActionRequired());
    }

    return events;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private postBlind(seat: SeatState, amount: number): void {
    this.addToPot(seat, amount);
  }

  private addToPot(seat: SeatState, amount: number): void {
    seat.stack -= amount;
    seat.currentStreetBet += amount;
    seat.totalHandContribution += amount;
    this.potManager.contribute(seat.playerId, amount);
    this.snapshot.pot = this.potManager.totalPot();
  }

  private isStreetComplete(): boolean {
    const seats = this.getActiveSeatStates().filter(
      (s) => s.status === 'active',
    );

    if (seats.length === 0) return true;

    return seats.every(
      (s) => s.hasActedThisStreet && s.currentStreetBet === this.snapshot.currentBet,
    );
  }

  private advanceStreet(): HandEvent[] {
    const events: HandEvent[] = [];

    // Reset street bets and acted flags for the new street
    for (const seat of this.getActiveSeatStates()) {
      seat.currentStreetBet = 0;
      seat.hasActedThisStreet = false;
    }
    this.snapshot.currentBet = 0;
    this.snapshot.lastRaiseSize = this.snapshot.bigBlind;

    const nextPhase = this.nextPhase();

    if (nextPhase === HandPhase.SHOWDOWN || nextPhase === HandPhase.COMPLETE) {
      events.push(...this.runShowdown());
      return events;
    }

    this.snapshot.phase = nextPhase;
    const newCards = this.dealCommunityCards(nextPhase);
    this.snapshot.communityCards.push(...newCards);

    events.push({
      type: 'community_dealt',
      payload: { phase: nextPhase, cards: newCards },
    });

    const activePlayers = this.getActiveSeatStates().filter((s) => s.status === 'active');
    if (activePlayers.length === 0) {
      // All-in runout — check for run-it-twice
      if (this.settings.runItTwice && this.hasMultipleStreetsRemaining()) {
        events.push(...this.runItTwice());
      } else {
        events.push(...this.advanceStreet());
      }
    } else {
      this.snapshot.currentActorSeatIndex = this.firstActiveAfterDealer();
      events.push(...this.emitActionRequired());
    }

    return events;
  }

  /** True when we are before the river and all players are all-in */
  private hasMultipleStreetsRemaining(): boolean {
    const phase = this.snapshot.phase;
    return phase === HandPhase.PREFLOP || phase === HandPhase.FLOP;
  }

  /**
   * Run-it-twice: deal remaining board cards a second time and split the pot.
   * Called only when all players are all-in and ≥2 streets remain.
   * Emits community_dealt for remaining streets of board 2, then two showdown events.
   */
  private runItTwice(): HandEvent[] {
    const events: HandEvent[] = [];

    // Finish dealing board 1 (remaining streets after current)
    const board1Extra = this.dealRemainingBoard();
    for (const { phase, cards } of board1Extra) {
      this.snapshot.communityCards.push(...cards);
      events.push({ type: 'community_dealt', payload: { phase, cards } });
    }

    // Board 1 community cards (full board)
    const board1 = [...this.snapshot.communityCards];

    // Deal board 2 from remaining deck
    const board2 = this.buildSecondBoard();

    events.push({
      type: 'run_two_board',
      payload: { board: board2 },
    });

    // Evaluate both boards and split pot
    const contenders = this.getActiveSeatStates().filter(
      (s) => s.status === 'active' || s.status === 'all-in',
    );

    const halfPot = Math.floor(this.snapshot.pot / 2);
    const remainder = this.snapshot.pot % 2;

    const board1Winners = this.evaluateBoard(board1, contenders);
    const board2Winners = this.evaluateBoard(board2, contenders);

    // Award half pot to board 1 winners
    const b1Each = Math.floor(halfPot / board1Winners.length);
    for (const w of board1Winners) w.stack += b1Each;

    // Award half pot (+ remainder chip) to board 2 winners
    const b2Share = halfPot + remainder;
    const b2Each = Math.floor(b2Share / board2Winners.length);
    for (const w of board2Winners) w.stack += b2Each;

    events.push({
      type: 'showdown',
      payload: {
        runItTwice: true,
        board1,
        board2,
        players: contenders.map((s) => ({
          seatIndex: s.seatIndex,
          playerId: s.playerId,
          holeCards: this.settings.showdownReveal !== 'never' ? s.holeCards : [],
        })),
        board1Winners: board1Winners.map((w) => ({ seatIndex: w.seatIndex, playerId: w.playerId, amount: b1Each })),
        board2Winners: board2Winners.map((w) => ({ seatIndex: w.seatIndex, playerId: w.playerId, amount: b2Each + (board2Winners.length === 1 ? remainder : 0) })),
        sidePots: [],
      },
    });

    events.push(...this.completeHand());
    return events;
  }

  /** Deal all remaining streets (after current phase) and return them as {phase, cards}[] */
  private dealRemainingBoard(): { phase: HandPhase; cards: Card[] }[] {
    const result: { phase: HandPhase; cards: Card[] }[] = [];
    let phase = this.nextPhase();
    while (phase !== HandPhase.SHOWDOWN && phase !== HandPhase.COMPLETE) {
      const cards = this.dealCommunityCards(phase);
      result.push({ phase, cards });
      this.snapshot.phase = phase;
      phase = this.nextPhase();
    }
    return result;
  }

  /** Build a second board of the same total length as board1 but with fresh cards */
  private buildSecondBoard(): Card[] {
    // Re-use the first 3 cards (flop) if we're past the flop, else deal fresh full board
    const communityLen = this.snapshot.communityCards.length; // after board1 dealt
    const remaining = 5 - communityLen + this.countPhaseCards();
    // Actually: second board is always 5 cards from remaining deck
    return this.deck.deal(5);
  }

  /** Cards already on board before current street was dealt */
  private countPhaseCards(): number {
    switch (this.snapshot.phase) {
      case HandPhase.FLOP: return 3;
      case HandPhase.TURN: return 4;
      default: return 0;
    }
  }

  private evaluateBoard(board: Card[], contenders: SeatState[]): SeatState[] {
    const evaluated = contenders.map((seat) => ({
      seat,
      hand: this.variant.selectBestHand(seat.holeCards, board),
    }));
    const ranks = evaluated.map((e) => e.hand);
    const winnerIndices = HandEvaluator.findWinners(ranks);
    return winnerIndices.map((i) => evaluated[i].seat);
  }

  private nextPhase(): HandPhase {
    switch (this.snapshot.phase) {
      case HandPhase.PREFLOP:
        return HandPhase.FLOP;
      case HandPhase.FLOP:
        return HandPhase.TURN;
      case HandPhase.TURN:
        return HandPhase.RIVER;
      case HandPhase.RIVER:
        return HandPhase.SHOWDOWN;
      default:
        return HandPhase.COMPLETE;
    }
  }

  private dealCommunityCards(phase: HandPhase): Card[] {
    switch (phase) {
      case HandPhase.FLOP:
        return this.deck.deal(3);
      case HandPhase.TURN:
      case HandPhase.RIVER:
        return this.deck.deal(1);
      default:
        return [];
    }
  }

  private runShowdown(): HandEvent[] {
    const events: HandEvent[] = [];
    this.snapshot.phase = HandPhase.SHOWDOWN;

    const contenders = this.getActiveSeatStates().filter(
      (s) => s.status === 'active' || s.status === 'all-in',
    );

    const evaluated = contenders.map((seat) => ({
      seat,
      hand: this.variant.selectBestHand(seat.holeCards, this.snapshot.communityCards),
    }));

    const ranks = evaluated.map((e) => e.hand);
    const winnerIndices = HandEvaluator.findWinners(ranks);
    const winners = winnerIndices.map((i) => evaluated[i]);

    const sidePots = this.potManager.calculatePots(
      contenders.filter((s) => s.status === 'active').map((s) => s.playerId),
    );

    const potPerWinner = Math.floor(this.snapshot.pot / winners.length);
    for (const winner of winners) {
      winner.seat.stack += potPerWinner;
    }
    const remainder = this.snapshot.pot % winners.length;
    if (remainder > 0) {
      winners[0].seat.stack += remainder;
    }

    // Apply showdown reveal rule
    const revealRule = this.settings.showdownReveal;
    const lastAggressor = this.snapshot.lastAggressorSeatIndex;

    const playersPayload = evaluated.map((e) => {
      let reveal = false;
      if (revealRule === 'always') {
        reveal = true;
      } else if (revealRule === 'standard') {
        const isWinner = winners.some((w) => w.seat.seatIndex === e.seat.seatIndex);
        const isAggressor = lastAggressor === e.seat.seatIndex;
        reveal = isWinner || isAggressor;
      }
      // 'never' reveals nothing
      return {
        seatIndex: e.seat.seatIndex,
        playerId: e.seat.playerId,
        holeCards: reveal ? e.seat.holeCards : [],
        bestHand: reveal ? e.hand : { rank: 0, name: '' },
        mustShow: reveal,
      };
    });

    events.push({
      type: 'showdown',
      payload: {
        players: playersPayload,
        winners: winners.map((w) => ({
          seatIndex: w.seat.seatIndex,
          playerId: w.seat.playerId,
          amount: potPerWinner + (winners[0].seat.seatIndex === w.seat.seatIndex ? remainder : 0),
          handName: w.hand.name,
        })),
        sidePots: sidePots.sidePots,
      },
    });

    events.push(...this.completeHand());
    return events;
  }

  private awardPotToLastPlayer(winner: SeatState): HandEvent[] {
    winner.stack += this.snapshot.pot;

    const events: HandEvent[] = [
      {
        type: 'showdown',
        payload: {
          players: [],
          winners: [
            {
              seatIndex: winner.seatIndex,
              playerId: winner.playerId,
              amount: this.snapshot.pot,
              handName: null,
            },
          ],
          sidePots: [],
        },
      },
    ];

    // Rabbit hunting — reveal what would have come next
    if (this.settings.rabbitHunting) {
      const rabbitCards = this.getRabbitCards();
      if (rabbitCards.length > 0) {
        events.push({
          type: 'rabbit_cards',
          payload: { cards: rabbitCards },
        });
      }
    }

    events.push(...this.completeHand());
    return events;
  }

  /** Returns the cards that would have come out next (up to remaining community cards needed) */
  private getRabbitCards(): Card[] {
    const needed = 5 - this.snapshot.communityCards.length;
    if (needed <= 0) return [];
    return this.deck.deal(Math.min(needed, this.deck.remaining()));
  }

  private completeHand(): HandEvent[] {
    this.snapshot.phase = HandPhase.COMPLETE;
    this.snapshot.currentActorSeatIndex = null;

    return [
      {
        type: 'hand_complete',
        payload: {
          handId: this.snapshot.handId,
          finalSeats: this.snapshot.seats.map((s) =>
            s ? { seatIndex: s.seatIndex, playerId: s.playerId, stack: s.stack } : null,
          ),
        },
      },
    ];
  }

  private emitActionRequired(): HandEvent[] {
    if (this.snapshot.currentActorSeatIndex === null) return [];

    const seat = this.snapshot.seats[this.snapshot.currentActorSeatIndex] as SeatState;
    const validActions: ValidAction[] = this.validator.computeValidActions(this.snapshot, seat);

    return [
      {
        type: 'action_required',
        payload: {
          seatIndex: seat.seatIndex,
          playerId: seat.playerId,
          validActions,
          deadlineMs: this.snapshot.actionDeadlineMs,
        },
      },
    ];
  }

  private nextActiveAfter(seatIndex: number): number {
    const len = this.snapshot.seats.length;
    for (let i = 1; i <= len; i++) {
      const idx = (seatIndex + i) % len;
      const seat = this.snapshot.seats[idx];
      if (seat && seat.status === 'active') return idx;
    }
    return seatIndex;
  }

  private firstActiveAfterDealer(): number {
    return this.nextActiveAfter(this.snapshot.dealerButtonSeatIndex);
  }

  private getActiveSeatStates(): SeatState[] {
    return this.snapshot.seats.filter(
      (s): s is SeatState => s !== null && s.status !== 'sitting-out',
    );
  }

  private buildInitialSnapshot(
    config: TableConfig,
    seats: InitialSeat[],
    dealerButtonSeatIndex: number,
    handNumber: number,
  ): HandSnapshot {
    const seatStates: (SeatState | null)[] = Array(config.maxSeats).fill(null);

    for (const seat of seats) {
      seatStates[seat.seatIndex] = {
        seatIndex: seat.seatIndex,
        playerId: seat.playerId,
        displayName: seat.displayName,
        holeCards: [],
        stack: seat.stack,
        currentStreetBet: 0,
        totalHandContribution: 0,
        status: 'active',
        hasActedThisStreet: false,
      };
    }

    const activeSeatIndices = seats.map((s) => s.seatIndex).sort((a, b) => a - b);
    const dealerPos = activeSeatIndices.indexOf(dealerButtonSeatIndex);
    const isHeadsUp = activeSeatIndices.length === 2;

    let sbIdx: number;
    let bbIdx: number;

    if (isHeadsUp) {
      sbIdx = dealerButtonSeatIndex;
      bbIdx = activeSeatIndices[(dealerPos + 1) % activeSeatIndices.length];
    } else {
      sbIdx = activeSeatIndices[(dealerPos + 1) % activeSeatIndices.length];
      bbIdx = activeSeatIndices[(dealerPos + 2) % activeSeatIndices.length];
    }

    return {
      handId: `${config.tableId}-hand-${handNumber}-${uuidv4().slice(0, 8)}`,
      tableId: config.tableId,
      phase: HandPhase.WAITING,
      variant: config.variant,
      communityCards: [],
      pot: 0,
      sidePots: [] as SidePot[],
      seats: seatStates,
      currentActorSeatIndex: null,
      dealerButtonSeatIndex,
      smallBlindSeatIndex: sbIdx,
      bigBlindSeatIndex: bbIdx,
      currentBet: 0,
      lastRaiseSize: config.bigBlind,
      lastAggressorSeatIndex: bbIdx, // BB is the initial "aggressor" preflop
      actionDeadlineMs: null,
      bigBlind: config.bigBlind,
      smallBlind: config.smallBlind,
    };
  }
}
