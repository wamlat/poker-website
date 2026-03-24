import prisma from '../db/postgres';
import { HandRepository } from '../repositories/HandRepository';
import { TableStateRepository } from '../repositories/TableStateRepository';
import { HandSnapshot, SeatState } from '../types';

const handRepo = new HandRepository();
const tableStateRepo = new TableStateRepository();

interface ActionRecord {
  sequence: number;
  phase: string;
  seatIndex: number;
  userId: string;
  action: string;
  amount?: number;
  potAfter: number;
}

export class HandHistoryService {
  private actionLog: Map<string, ActionRecord[]> = new Map();

  /** Called after every action to build up the log in memory */
  recordAction(handId: string, record: ActionRecord): void {
    if (!this.actionLog.has(handId)) {
      this.actionLog.set(handId, []);
    }
    this.actionLog.get(handId)!.push(record);
  }

  /** Asynchronously persist the hand after it completes. Non-blocking for game flow. */
  async persistAsync(snapshot: HandSnapshot, startedAt: Date): Promise<void> {
    try {
      await this.persist(snapshot, startedAt);
    } catch (err) {
      console.error('[HandHistory] Failed to persist hand:', snapshot.handId, err);
    }
  }

  private async persist(snapshot: HandSnapshot, startedAt: Date): Promise<void> {
    const tableState = await tableStateRepo.getTableState(snapshot.tableId);
    if (!tableState) return;

    const players = snapshot.seats
      .filter((s): s is SeatState => s !== null)
      .map((seat) => ({
        userId: seat.playerId,
        seatIndex: seat.seatIndex,
        holeCards: seat.holeCards,
        startingStack: seat.stack + seat.totalHandContribution, // stack before hand
        endingStack: seat.stack,
        netChips: seat.stack - (seat.stack + seat.totalHandContribution),
        wentToShowdown: snapshot.phase === 'showdown',
        wonPot: false, // TODO: track winners in snapshot
        winningHand: undefined,
      }));

    const actions = this.actionLog.get(snapshot.handId) ?? [];

    await handRepo.saveHand({
      tableId: snapshot.tableId,
      variant: snapshot.variant,
      handNumber: tableState.handNumber,
      dealerSeat: snapshot.dealerButtonSeatIndex,
      smallBlindSeat: snapshot.smallBlindSeatIndex,
      bigBlindSeat: snapshot.bigBlindSeatIndex,
      communityCards: {
        flop: snapshot.communityCards.slice(0, 3),
        turn: snapshot.communityCards[3] ?? null,
        river: snapshot.communityCards[4] ?? null,
      },
      finalPot: snapshot.pot,
      startedAt,
      completedAt: new Date(),
      players,
      actions,
    });

    // Update player stats
    for (const player of players) {
      await prisma.playerStats.upsert({
        where: { userId: player.userId },
        update: {
          handsPlayed: { increment: 1 },
          totalNetChips: { increment: player.netChips },
        },
        create: {
          userId: player.userId,
          handsPlayed: 1,
          totalNetChips: player.netChips,
        },
      });
    }

    // Clean up action log
    this.actionLog.delete(snapshot.handId);

    // Expire Redis hand state
    await tableStateRepo.expireHandSnapshot(snapshot.handId);
  }
}
