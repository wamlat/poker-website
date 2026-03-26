import { randomUUID as uuidv4 } from 'crypto';
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
  /** True when waiting for RIT votes before advancing the all-in runout */
  private ritPending = false;

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

  /** Returns the current action_required payload without advancing state. Used for reconnect resync. */
  peekActionRequired(): Record<string, unknown> | null {
    if (this.snapshot.currentActorSeatIndex === null) return null;
    const seat = this.snapshot.seats[this.snapshot.currentActorSeatIndex] as SeatState;
    if (!seat) return null;
    return {
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      validActions: this.validator.computeValidActions(this.snapshot, seat),
      pot: this.snapshot.pot,
      playerStreetBet: seat.currentStreetBet,
    };
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
    if (sbSeat.stack === 0) sbSeat.status = 'all-in';

    // Post big blind
    const bbSeat = this.snapshot.seats[this.snapshot.bigBlindSeatIndex] as SeatState;
    const bbAmount = Math.min(this.snapshot.bigBlind, bbSeat.stack);
    this.postBlind(bbSeat, bbAmount);
    if (bbSeat.stack === 0) bbSeat.status = 'all-in';

    this.snapshot.currentBet = bbAmount;
    this.snapshot.lastRaiseSize = bbAmount;
    this.snapshot.phase = HandPhase.PREFLOP;

    // Optional straddle: UTG (seat after BB) posts 2×BB voluntarily
    let straddleSeatIndex: number | null = null;
    if (this.settings.straddleEnabled && seats.length >= 3) {
      const utgSeatIndex = this.nextActiveAfter(this.snapshot.bigBlindSeatIndex);
      const utgSeat = this.snapshot.seats[utgSeatIndex] as SeatState | null;
      const straddleAmount = this.snapshot.bigBlind * 2;
      if (utgSeat && utgSeat.stack >= straddleAmount) {
        this.postBlind(utgSeat, straddleAmount);
        if (utgSeat.stack === 0) utgSeat.status = 'all-in';
        this.snapshot.currentBet = straddleAmount;
        this.snapshot.lastRaiseSize = straddleAmount;
        straddleSeatIndex = utgSeatIndex;
        this.snapshot.straddleSeatIndex = utgSeatIndex;
      }
    }

    // First to act preflop: seat after straddle (if any), else after BB
    // Skip if everyone is already all-in
    const activeSeatCount = this.getActiveSeatStates().filter((s) => s.status === 'active').length;
    const lastBlindSeat = straddleSeatIndex ?? this.snapshot.bigBlindSeatIndex;
    this.snapshot.currentActorSeatIndex =
      activeSeatCount > 0 ? this.nextActiveAfter(lastBlindSeat) : null;

    events.push({
      type: 'hand_started',
      payload: {
        handId: this.snapshot.handId,
        variant: this.snapshot.variant,
        dealerButtonSeatIndex: this.snapshot.dealerButtonSeatIndex,
        smallBlindSeatIndex: this.snapshot.smallBlindSeatIndex,
        bigBlindSeatIndex: this.snapshot.bigBlindSeatIndex,
        straddleSeatIndex,
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

    if (this.snapshot.currentActorSeatIndex === null) {
      // Both players all-in from their blinds — run the board immediately
      events.push(...this.advanceStreet());
    } else {
      events.push(...this.emitActionRequired());
    }

    return events;
  }

  /** Process a player action. Returns events to emit. */
  act(action: PlayerAction): HandEvent[] {
    const result = this.validator.validate(action, this.snapshot);
    if (!result.valid) {
      return [
        {
          type: 'hand_error',
          payload: { code: result.reason, message: `Invalid action: ${result.reason}` },
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
          this.snapshot.currentBet = seat.currentStreetBet + allInAmount;
          this.snapshot.lastAggressorSeatIndex = seat.seatIndex;
          // Only a full raise (>= lastRaiseSize) reopens action for players who
          // already acted. A short all-in increases the call amount but does NOT
          // give those players another chance to re-raise.
          if (raiseSize >= this.snapshot.lastRaiseSize) {
            this.snapshot.lastRaiseSize = raiseSize;
            for (const s of this.getActiveSeatStates()) {
              if (s.seatIndex !== seat.seatIndex) s.hasActedThisStreet = false;
            }
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
        stack: seat.stack,
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
      // Check for run-it-twice vote before starting the all-in runout
      const activePlayers = this.getActiveSeatStates().filter((s) => s.status === 'active');
      const contenders = this.getActiveSeatStates().filter(
        (s) => s.status === 'active' || s.status === 'all-in',
      );
      if (
        activePlayers.length <= 1 &&
        this.settings.runItTwice &&
        this.hasCardsRemaining() &&
        contenders.length >= 2
      ) {
        // Pause the hand and ask players to vote
        this.ritPending = true;
        this.snapshot.currentActorSeatIndex = null;
        events.push({
          type: 'rit_vote_needed',
          payload: {
            handId: this.snapshot.handId,
            eligiblePlayerIds: contenders.map((s) => s.playerId),
          },
        });
      } else {
        events.push(...this.advanceStreet());
      }
    } else {
      this.snapshot.currentActorSeatIndex = this.nextActiveAfter(seat.seatIndex);
      events.push(...this.emitActionRequired());
    }

    return events;
  }

  /**
   * Called by GameService once all eligible players have cast their RIT vote.
   * `runItTwice` reflects the unanimous decision (true only if all said yes).
   */
  resolveRIT(runItTwice: boolean): HandEvent[] {
    if (!this.ritPending) return [];
    this.ritPending = false;
    const saved = this.settings.runItTwice;
    this.settings.runItTwice = runItTwice;
    const events = this.advanceStreet();
    this.settings.runItTwice = saved;
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
    if (activePlayers.length <= 1) {
      // All-in runout (0 active, or 1 active with no one to bet into) — check for run-it-twice
      if (this.settings.runItTwice && this.hasCardsRemaining()) {
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

  /** True when there is at least one community card still to come */
  private hasCardsRemaining(): boolean {
    const phase = this.snapshot.phase;
    return (
      phase === HandPhase.PREFLOP ||
      phase === HandPhase.FLOP ||
      phase === HandPhase.TURN
    );
  }

  /**
   * Run-it-twice: deal remaining board cards a second time and split the pot.
   * Called only when all players are all-in and ≥1 card remains.
   * Board 2 shares the already-dealt community cards and gets fresh remaining cards.
   * Each side pot is split independently between both boards.
   */
  private runItTwice(): HandEvent[] {
    const events: HandEvent[] = [];

    // Cards already on board are shared between both runouts
    const sharedCount = this.snapshot.communityCards.length;

    // Finish dealing board 1 (remaining streets after current)
    const board1Extra = this.dealRemainingBoard();
    for (const { phase, cards } of board1Extra) {
      this.snapshot.communityCards.push(...cards);
      events.push({ type: 'community_dealt', payload: { phase, cards } });
    }

    // Board 1 community cards (full board)
    const board1 = [...this.snapshot.communityCards];

    // Board 2: re-use shared cards + deal fresh cards for the remaining streets
    const board2 = [...board1.slice(0, sharedCount), ...this.deck.deal(5 - sharedCount)];

    events.push({
      type: 'run_two_board',
      payload: { board: board2 },
    });

    const contenders = this.getActiveSeatStates().filter(
      (s) => s.status === 'active' || s.status === 'all-in',
    );

    // Calculate side pots — handles players all-in for different amounts
    const potResult = this.potManager.calculatePots(
      contenders.filter((s) => s.status === 'active').map((s) => s.playerId),
    );
    const potsToAward =
      potResult.sidePots.length > 0
        ? potResult.sidePots
        : [{ amount: this.snapshot.pot, eligiblePlayerIds: contenders.map((s) => s.playerId) }];

    const board1WinnersPayload: { seatIndex: number; playerId: string; amount: number }[] = [];
    const board2WinnersPayload: { seatIndex: number; playerId: string; amount: number }[] = [];

    for (const pot of potsToAward) {
      const eligible = contenders.filter((s) => pot.eligiblePlayerIds.includes(s.playerId));
      if (eligible.length === 0) continue;

      const halfPot = Math.floor(pot.amount / 2);
      const potOdd = pot.amount % 2; // odd chip goes to the board-1 first winner

      // Board 1 gets halfPot + any odd chip from this pot
      const b1Total = halfPot + potOdd;
      const b1Winners = this.evaluateBoard(board1, eligible);
      const b1Share = Math.floor(b1Total / b1Winners.length);
      const b1Odd = b1Total % b1Winners.length;
      for (let i = 0; i < b1Winners.length; i++) {
        const award = b1Share + (i === 0 ? b1Odd : 0);
        b1Winners[i].stack += award;
        board1WinnersPayload.push({ seatIndex: b1Winners[i].seatIndex, playerId: b1Winners[i].playerId, amount: award });
      }

      // Board 2 gets halfPot exactly
      const b2Winners = this.evaluateBoard(board2, eligible);
      const b2Share = Math.floor(halfPot / b2Winners.length);
      const b2Odd = halfPot % b2Winners.length;
      for (let i = 0; i < b2Winners.length; i++) {
        const award = b2Share + (i === 0 ? b2Odd : 0);
        b2Winners[i].stack += award;
        board2WinnersPayload.push({ seatIndex: b2Winners[i].seatIndex, playerId: b2Winners[i].playerId, amount: award });
      }
    }

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
        board1Winners: board1WinnersPayload,
        board2Winners: board2WinnersPayload,
        sidePots: potResult.sidePots,
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

    // Calculate pots — players still active (not all-in) are eligible for all pots
    const potResult = this.potManager.calculatePots(
      contenders.filter((s) => s.status === 'active').map((s) => s.playerId),
    );

    // Determine which pots to award
    const potsToAward =
      potResult.sidePots.length > 0
        ? potResult.sidePots
        : [{ amount: this.snapshot.pot, eligiblePlayerIds: contenders.map((s) => s.playerId) }];

    // Award each pot to the best hand(s) among eligible players
    const totalWon = new Map<number, number>(); // seatIndex → total chips won

    for (const pot of potsToAward) {
      const eligible = evaluated.filter((e) => pot.eligiblePlayerIds.includes(e.seat.playerId));
      if (eligible.length === 0) continue;

      const winnerIndices = HandEvaluator.findWinners(eligible.map((e) => e.hand));
      const potWinners = winnerIndices.map((i) => eligible[i]);

      const share = Math.floor(pot.amount / potWinners.length);
      const remainder = pot.amount % potWinners.length;

      for (let i = 0; i < potWinners.length; i++) {
        const w = potWinners[i];
        const award = share + (i === 0 ? remainder : 0);
        w.seat.stack += award;
        totalWon.set(w.seat.seatIndex, (totalWon.get(w.seat.seatIndex) ?? 0) + award);
      }
    }

    // Apply showdown reveal rule
    const revealRule = this.settings.showdownReveal;
    const lastAggressor = this.snapshot.lastAggressorSeatIndex;

    const playersPayload = evaluated.map((e) => {
      let reveal = false;
      if (revealRule === 'always') {
        reveal = true;
      } else if (revealRule === 'standard') {
        const isWinner = totalWon.has(e.seat.seatIndex);
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
        winners: Array.from(totalWon.entries()).map(([seatIndex, amount]) => {
          const e = evaluated.find((ev) => ev.seat.seatIndex === seatIndex)!;
          return {
            seatIndex,
            playerId: e.seat.playerId,
            amount,
            handName: e.hand.name,
          };
        }),
        sidePots: potResult.sidePots,
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
          pot: this.snapshot.pot,
          playerStreetBet: seat.currentStreetBet,
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
      straddleSeatIndex: null,
    };
  }
}
