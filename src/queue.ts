import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.UPSTASH_REDIS_URL;

if (!redisUrl) throw new Error("UPSTASH_REDIS_URL not set");

export const connection = new IORedis(redisUrl, {
  tls: { rejectUnauthorized: false },
  maxRetriesPerRequest: null,
});

export const queueName = process.env.PG_QUEUE_NAME || "pg-events";

export const producer = new Queue(queueName, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// Add RFQ queue for RFQ-specific jobs
export const rfqQueue = new Queue("rfq", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 500,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      count: 500,
    },
  },
});