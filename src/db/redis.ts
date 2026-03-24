import Redis from 'ioredis';
import { config } from '../config';

const redis = new Redis(config.redisUrl);

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err);
});

export default redis;
