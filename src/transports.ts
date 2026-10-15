import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMessage } from "./mime";
import type { OutgoingMessage, SendResult, Transport } from "./types";

export interface MemoryTransport extends Transport {
  /** Every message sent so far, newest last. */
  readonly sent: (OutgoingMessage & { messageId: string })[];
  clear(): void;
}

/** Keeps messages in memory. For tests and local development. */
export function memoryTransport(): MemoryTransport {
  const sent: (OutgoingMessage & { messageId: string })[] = [];
  return {
    sent,
    clear: () => void sent.splice(0),
    async send(message) {
      const built = buildMessage(message);
      sent.push({ ...message, messageId: built.messageId });
      return { messageId: built.messageId, accepted: built.recipients };
    },
  };
}

/**
 * Writes each message as an `.eml` file in `dir` (open it in any mail app to see it rendered).
 * For local development only: the files contain whatever the mail contains, reset links included.
 */
export function fileTransport(dir: string): Transport {
  return {
    async send(message): Promise<SendResult> {
      const built = buildMessage(message);
      await mkdir(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${built.messageId.slice(1, 9)}.eml`;
      await writeFile(join(dir, name), built.raw);
      return { messageId: built.messageId, accepted: built.recipients };
    },
  };
}
