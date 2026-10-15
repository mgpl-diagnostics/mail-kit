// The mailer: renders a template and sends it through the worker's queue when one is available,
// otherwise (no queue, queue unavailable, or enqueue failed) straight through the transport.
import type { AnyMailTemplate } from "./define";
import { MailError } from "./errors";
import { addressList, parseAddress } from "./mime";
import type { RenderOptions } from "./render";
import { MAIL_TEMPLATES } from "./templates";
import type { Address, Brand, Envelope, RenderedMail, SendResult, Theme, Transport } from "./types";

/**
 * What goes on the queue: the template id, its data and the envelope, never rendered HTML.
 * Data crosses JSON, so Dates arrive as ISO strings (the date filters accept both).
 */
export interface MailJob {
  v: 1;
  template: string;
  data: Record<string, unknown>;
  envelope: Envelope;
}

/** The worker's queue, seen from the mailer. Structural, so mail-kit needs no queue library. */
export interface MailQueue {
  /** Adds the job; resolves with its id. Rejecting makes the mailer send directly instead. */
  enqueue(job: MailJob): Promise<string | undefined>;
  /** Cheap check before enqueueing (e.g. the Redis connection is "ready"). Default: assume yes. */
  available?(): boolean | Promise<boolean>;
}

export type SendOutcome = { via: "queue"; jobId: string | undefined } | ({ via: "direct" } & SendResult);

export interface MailerOptions {
  transport: Transport;
  /** Default sender, e.g. `"Maa Gayatri Path Lab <no-reply@example.com>"`. */
  from: Address;
  replyTo?: Address;
  /** The worker's queue. Leave it out to always send directly (standalone). */
  queue?: MailQueue;
  /**
   * When the queue is set but unavailable or enqueueing fails: "direct" (default) sends straight
   * away; "throw" raises MailError MAIL_QUEUE so the caller decides.
   */
  whenQueueFails?: "direct" | "throw";
  /** Called whenever a queued send fell back to sending directly (log it). */
  onFallback?: (reason: unknown, job: MailJob) => void;
  /** Templates by id. Default: the built-in MAIL_TEMPLATES; spread them to add your own. */
  templates?: Record<string, AnyMailTemplate>;
  brand?: Brand;
  theme?: Theme;
}

export interface Mailer {
  /**
   * Renders `template` with `data` (so bad data fails here, in the request, not in the worker)
   * and queues it, or sends it directly when there is no usable queue.
   */
  send(template: string, data: Record<string, unknown>, envelope: Envelope): Promise<SendOutcome>;
  /** Renders and sends now, ignoring the queue. The worker calls this for each job. */
  deliver(job: MailJob): Promise<SendResult>;
  /** Renders without sending (previews). */
  render(template: string, data: Record<string, unknown>): RenderedMail;
  /** The template ids this mailer knows. */
  templates(): string[];
  close(): Promise<void>;
}

export function createMailer(o: MailerOptions): Mailer {
  const templates: Record<string, AnyMailTemplate> = o.templates ?? MAIL_TEMPLATES;
  const renderOpts: RenderOptions = { ...(o.brand ? { brand: o.brand } : {}), ...(o.theme ? { theme: o.theme } : {}) };
  parseAddress(o.from);

  const get = (id: string): AnyMailTemplate => {
    const t = Object.hasOwn(templates, id) ? templates[id] : undefined;
    if (!t) throw new MailError("MAIL_UNKNOWN_TEMPLATE", `Unknown mail template "${id}" (known: ${Object.keys(templates).join(", ")})`);
    return t;
  };
  const render = (id: string, data: Record<string, unknown>) => get(id).render(data, renderOpts);
  const checkEnvelope = (e: Envelope) => {
    const n = addressList(e.to).length + addressList(e.cc).length + addressList(e.bcc).length;
    if (!n) throw new MailError("MAIL_BAD_ADDRESS", "A mail needs at least one recipient");
    if (e.replyTo) parseAddress(e.replyTo);
    if (e.from) parseAddress(e.from);
  };

  const deliver = async (job: MailJob): Promise<SendResult> => {
    if (job.v !== 1) throw new MailError("MAIL_QUEUE", `Unsupported mail job version ${String(job.v)}`);
    const mail = render(job.template, job.data);
    const replyTo = job.envelope.replyTo ?? o.replyTo;
    return o.transport.send({
      ...job.envelope,
      from: job.envelope.from ?? o.from,
      ...(replyTo ? { replyTo } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  };

  return {
    async send(template, data, envelope) {
      render(template, data);
      checkEnvelope(envelope);
      const job: MailJob = { v: 1, template, data, envelope };
      if (o.queue) {
        let reason: unknown;
        try {
          if ((await (o.queue.available?.() ?? true)) === true) {
            return { via: "queue", jobId: await o.queue.enqueue(job) };
          }
          reason = new MailError("MAIL_QUEUE", "Mail queue is not available");
        } catch (e) {
          reason = e;
        }
        if (o.whenQueueFails === "throw") {
          throw reason instanceof MailError ? reason : new MailError("MAIL_QUEUE", `Could not queue the mail: ${reason instanceof Error ? reason.message : String(reason)}`);
        }
        o.onFallback?.(reason, job);
      }
      return { via: "direct", ...(await deliver(job)) };
    },
    deliver,
    render,
    templates: () => Object.keys(templates),
    close: async () => {
      await o.transport.close?.();
    },
  };
}
