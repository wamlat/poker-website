import { v4 as uuidv4 } from 'uuid';
import {
  Card,
  HandEvent,
  HandPhase,
  HandSnapshot,
  PlayerAction,
  SeatState,
  SidePot,
  TableConfig,
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

  constructor(
    variant: GameVariant,
    config: TableConfig,
    seats: InitialSeat[],
    dealerButtonSeatIndex: number,
    handNumber: number,
  ) {
    this.variant = variant;
    this.deck = new Deck();
    this.potManager = new PotManager();

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

    // Deal hole cards
    for (const seat of this.getActiveSeatStates()) {
      seat.holeCards = this.deck.deal(this.variant.holeCardCount);
      events.push({
        type: 'cards_dealt',
        payload: { seatIndex: seat.seatIndex, holeCards: seat.holeCards },
        privateToPlayerId: seat.playerId,
      });
    }

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
        // No state change needed
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
        }
        this.addToPot(seat, allInAmount);
        seat.status = 'all-in';
        break;
      }
    }

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

    // If all remaining active players are all-in, street is done
    if (seats.length === 0) return true;

    // All active players have matched the current bet (or acted)
    return seats.every((s) => s.currentStreetBet === this.snapshot.currentBet);
  }

  private advanceStreet(): HandEvent[] {
    const events: HandEvent[] = [];

    // Reset street bets
    for (const seat of this.getActiveSeatStates()) {
      seat.currentStreetBet = 0;
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

    // Check if all remaining players are all-in — skip betting, just deal remaining streets
    const activePlayers = this.getActiveSeatStates().filter((s) => s.status === 'active');
    if (activePlayers.length === 0) {
      events.push(...this.advanceStreet());
    } else {
      this.snapshot.currentActorSeatIndex = this.firstActiveAfterDealer();
      events.push(...this.emitActionRequired());
    }

    return events;
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

    // Distribute pot(s) to winners
    const potPerWinner = Math.floor(this.snapshot.pot / winners.length);
    for (const winner of winners) {
      winner.seat.stack += potPerWinner;
    }
    // Remainder chip goes to first winner (closest to left of dealer)
    const remainder = this.snapshot.pot % winners.length;
    if (remainder > 0) {
      winners[0].seat.stack += remainder;
    }

    events.push({
      type: 'showdown',
      payload: {
        players: evaluated.map((e) => ({
          seatIndex: e.seat.seatIndex,
          playerId: e.seat.playerId,
          holeCards: e.seat.holeCards,
          bestHand: e.hand,
        })),
        winners: winners.map((w) => ({
          seatIndex: w.seat.seatIndex,
          playerId: w.seat.playerId,
          amount: potPerWinner,
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

    events.push(...this.completeHand());
    return events;
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
      };
    }

    // Determine blind positions (heads-up rules differ from full table)
    const activeSeatIndices = seats.map((s) => s.seatIndex).sort((a, b) => a - b);
    const dealerPos = activeSeatIndices.indexOf(dealerButtonSeatIndex);
    const isHeadsUp = activeSeatIndices.length === 2;

    let sbIdx: number;
    let bbIdx: number;

    if (isHeadsUp) {
      // Heads-up: dealer posts SB, other player posts BB
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
      actionDeadlineMs: null,
      bigBlind: config.bigBlind,
      smallBlind: config.smallBlind,
    };
  }
}
