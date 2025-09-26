import { Queue } from "bullmq";
import { redisConnection } from "../utils/redis";

export const bcQueue = new Queue(process.env.QUEUE_NAME || "bc-sync", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5, // retry 5 times
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
