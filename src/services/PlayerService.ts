import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { UserRepository } from '../repositories/UserRepository';
import { JwtPayload } from '../types';

export class PlayerService {
  private userRepo = new UserRepository();

  async register(username: string, email: string, password: string) {
    const existing = await this.userRepo.findByUsername(username);
    if (existing) throw new Error('Username already taken');

    const existingEmail = await this.userRepo.findByEmail(email);
    if (existingEmail) throw new Error('Email already registered');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.userRepo.create({ username, email, passwordHash });
    return { userId: user.id, username: user.username };
  }

  async login(username: string, password: string): Promise<string> {
    const user = await this.userRepo.findByUsername(username);
    if (!user) throw new Error('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new Error('Invalid credentials');

    const payload: JwtPayload = { userId: user.id, username: user.username };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' });
  }

  async getProfile(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new Error('User not found');
    return {
      userId: user.id,
      username: user.username,
      chipBalance: user.chipBalance.toString(),
    };
  }

  verifyToken(token: string): JwtPayload {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  }

  async addChips(userId: string, amount: number) {
    return this.userRepo.updateChipBalance(userId, amount);
  }
}
