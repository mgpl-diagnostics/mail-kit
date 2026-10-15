import { parseMail } from "./parse";
import { mailVariables, renderMail, type RenderOptions } from "./render";
import type { MailDocument, RenderedMail } from "./types";

export interface MailTemplate<D extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  description: string;
  /** The `.mail` source. */
  source: string;
  document: MailDocument;
  /** Every variable path the template reads. */
  variables: string[];
  /** Fictional data that renders the template completely (previews and tests). */
  sample: D;
  render(data: D, opts?: RenderOptions): RenderedMail;
}

/** A template of any data shape (for registries such as MAIL_TEMPLATES). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMailTemplate = MailTemplate<any>;

/**
 * Declares a mail. The source is parsed here, so a syntax error fails at startup (and in tests),
 * never while sending.
 */
export function defineMail<D extends Record<string, unknown>>(def: { id: string; description: string; source: string; sample: D }): MailTemplate<D> {
  const document = parseMail(def.source, def.id);
  return {
    ...def,
    document,
    variables: mailVariables(document),
    render: (data, opts) => renderMail(document, data, opts),
  };
}
