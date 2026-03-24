import prisma from '../db/postgres';

export class UserRepository {
  async findById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  async findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  async create(data: { username: string; email: string; passwordHash: string }) {
    return prisma.user.create({
      data: {
        ...data,
        stats: { create: {} },
      },
    });
  }

  async updateChipBalance(userId: string, delta: number) {
    return prisma.user.update({
      where: { id: userId },
      data: { chipBalance: { increment: delta } },
    });
  }

  async getChipBalance(userId: string): Promise<bigint> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return user.chipBalance;
  }
}
