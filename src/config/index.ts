export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://poker:poker@localhost:5432/poker',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-prod',
  actionTimeoutSeconds: parseInt(process.env.ACTION_TIMEOUT_SECONDS ?? '30', 10),
  startingChips: parseInt(process.env.STARTING_CHIPS ?? '10000', 10),
};
