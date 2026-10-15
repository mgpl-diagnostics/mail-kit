import type { Pos } from "./types";

/** Error codes are a public contract: add new ones, never rename. */
export type MailErrorCode =
  | "MAIL_SYNTAX"
  | "MAIL_MISSING_VARIABLE"
  | "MAIL_BAD_VALUE"
  | "MAIL_UNSAFE_URL"
  | "MAIL_UNKNOWN_TEMPLATE"
  | "MAIL_BAD_ADDRESS"
  | "MAIL_TRANSPORT"
  | "MAIL_QUEUE";

export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailError";
  }
}

export interface Diagnostic {
  message: string;
  line: number;
  col: number;
}

/** A `.mail` source that does not parse. Lists every problem with its line and column. */
export class MailSyntaxError extends MailError {
  constructor(
    readonly diagnostics: Diagnostic[],
    readonly file?: string,
  ) {
    super("MAIL_SYNTAX", diagnostics.map((d) => `${file ?? "mail"}:${d.line}:${d.col} ${d.message}`).join("\n"));
    this.name = "MailSyntaxError";
  }
}

/** Data passed to a template is missing values it uses. `paths` lists each one once. */
export class MissingVariableError extends MailError {
  constructor(readonly paths: string[]) {
    super("MAIL_MISSING_VARIABLE", `Missing mail variable${paths.length > 1 ? "s" : ""}: ${paths.join(", ")}`);
    this.name = "MissingVariableError";
  }
}

/** SMTP or provider failure. `status` is the SMTP reply code when there is one. */
export class TransportError extends MailError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super("MAIL_TRANSPORT", message);
    this.name = "TransportError";
  }
}

export const at = (pos: Pos, message: string): Diagnostic => ({ message, line: pos.line, col: pos.col });
