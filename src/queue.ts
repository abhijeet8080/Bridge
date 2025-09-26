import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.UPSTASH_REDIS_URL;

if (!redisUrl) throw new Error("UPSTASH_REDIS_URL not set");

export const connection = new IORedis(redisUrl, {
  tls: { rejectUnauthorized: false },
  maxRetriesPerRequest: null,
});

export const queueName = process.env.QUEUE_NAME || "bc-events";

export const producer = new Queue(queueName, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false
  }
});
