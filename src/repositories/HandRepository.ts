import prisma from '../db/postgres';
import { HandSnapshot, SeatState } from '../types';

interface HandRecord {
  tableId: string;
  variant: string;
  handNumber: number;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  communityCards: object;
  finalPot: number;
  startedAt: Date;
  completedAt?: Date;
  players: {
    userId: string;
    seatIndex: number;
    holeCards: object;
    startingStack: number;
    endingStack: number;
    netChips: number;
    wentToShowdown: boolean;
    wonPot: boolean;
    winningHand?: object;
  }[];
  actions: {
    sequence: number;
    phase: string;
    seatIndex: number;
    userId: string;
    action: string;
    amount?: number;
    potAfter: number;
  }[];
}

export class HandRepository {
  async saveHand(record: HandRecord) {
    return prisma.hand.create({
      data: {
        tableId: record.tableId,
        variant: record.variant,
        handNumber: record.handNumber,
        dealerSeat: record.dealerSeat,
        smallBlindSeat: record.smallBlindSeat,
        bigBlindSeat: record.bigBlindSeat,
        communityCards: record.communityCards,
        finalPot: record.finalPot,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        players: { create: record.players },
        actions: { create: record.actions },
      },
    });
  }

  async getHandsForTable(tableId: string, limit = 50) {
    return prisma.hand.findMany({
      where: { tableId },
      orderBy: { handNumber: 'desc' },
      take: limit,
      include: { players: true, actions: { orderBy: { sequence: 'asc' } } },
    });
  }

  async getHandById(handId: string) {
    return prisma.hand.findUnique({
      where: { id: handId },
      include: { players: true, actions: { orderBy: { sequence: 'asc' } } },
    });
  }
}
