import { Redis } from "ioredis";
export const redisConnection = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL) // Upstash URL
  : new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    });
