// Adapters between the mailer and a BullMQ-style queue/worker. Structural types only: mail-kit
// does not import bullmq; any object with the same methods works.
import type { Mailer, MailJob, MailQueue } from "./mailer";
import type { SendResult } from "./types";

/** The part of a BullMQ `Queue` the mailer uses. */
export interface QueueLike {
  add(name: string, data: MailJob, opts?: Record<string, unknown>): Promise<{ id?: string | undefined }>;
}

export interface QueueAdapterOptions {
  /** Job name. Default "mail". */
  name?: string;
  /** Retries with exponential backoff. Default 5 attempts from 10 s. */
  attempts?: number;
  backoffMs?: number;
  /**
   * Whether the queue can take jobs right now. Pass a check of the Redis connection, e.g.
   * `() => connection.status === "ready"`: with ioredis's offline queue, `add` on a dead
   * connection waits instead of failing, so without this check the mail would wait too.
   */
  available?: () => boolean | Promise<boolean>;
}

/**
 * A MailQueue on a BullMQ Queue. Finished jobs are removed at once and failed ones after a day,
 * because a job's data can hold a single-use link (password reset) that should not linger in Redis.
 */
export function queueAdapter(queue: QueueLike, o: QueueAdapterOptions = {}): MailQueue {
  const adapter: MailQueue = {
    async enqueue(job) {
      const added = await queue.add(o.name ?? "mail", job, {
        attempts: o.attempts ?? 5,
        backoff: { type: "exponential", delay: o.backoffMs ?? 10_000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600 },
      });
      return added.id;
    },
  };
  if (o.available) adapter.available = o.available;
  return adapter;
}

/** The job processor for the worker: `new Worker("mail", mailProcessor(mailer), { connection })`. */
export function mailProcessor(mailer: Mailer): (job: { data: MailJob }) => Promise<SendResult> {
  return (job) => mailer.deliver(job.data);
}
