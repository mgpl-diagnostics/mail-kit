// The mail design language as data: what the parser produces and the renderers consume.

/** Where a node came from in the `.mail` source (1-based). */
export interface Pos {
  line: number;
  col: number;
}

/** `{{ path | filter: arg | filter }}` */
export interface Expr {
  path: string[];
  filters: { name: string; arg?: string }[];
  pos: Pos;
}

/** Text with `{{ }}` holes, used for attribute values and front matter. */
export type Template = (string | Expr)[];

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "var"; expr: Expr }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: Template; children: Inline[]; pos: Pos }
  | { kind: "br" };

/** `@each items as item:` in front of a table or rows line repeats that line per item. */
export interface Repeat {
  list: Expr;
  as: string;
}

export type Tone = "info" | "success" | "warning" | "danger";
export type Align = "left" | "right" | "center";

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[]; pos: Pos }
  | { kind: "paragraph"; content: Inline[]; pos: Pos }
  | { kind: "list"; ordered: boolean; items: Inline[][]; pos: Pos }
  | { kind: "button"; href: Template; tone: "primary" | "secondary"; label: Inline[]; pos: Pos }
  | { kind: "callout"; tone: Tone; title?: Template; children: Block[]; pos: Pos }
  | { kind: "card"; children: Block[]; pos: Pos }
  | { kind: "rows"; rows: { label: Inline[]; value: Inline[]; each?: Repeat }[]; pos: Pos }
  | { kind: "table"; align: Align[]; head: Inline[][]; body: { cells: Inline[][]; each?: Repeat }[]; foot: Inline[][] | null; pos: Pos }
  | { kind: "code"; lines: Template[]; pos: Pos }
  | { kind: "divider"; pos: Pos }
  | { kind: "spacer"; size: number; pos: Pos }
  | { kind: "image"; src: Template; alt: Template; width: number; pos: Pos }
  | { kind: "if"; negate: boolean; test: Expr; then: Block[]; else: Block[]; pos: Pos }
  | { kind: "each"; list: Expr; as: string; children: Block[]; pos: Pos };

/** A parsed `.mail` document. */
export interface MailDocument {
  subject: Template;
  preheader: Template | null;
  /** Extra line printed above the brand footer. */
  footer: Template | null;
  body: Block[];
}

/** The lab (or any sender) shown in the header and footer of every mail. */
export interface Brand {
  name: string;
  /** https URL of a PNG/JPG logo. SVG is not shown by most mail apps. */
  logoUrl?: string;
  addressLines?: string[];
  phone?: string;
  email?: string;
  website?: string;
}

/** Design tokens. Every colour and size in a rendered mail comes from here. */
export interface Theme {
  colors: {
    brand: string;
    brandText: string;
    accent: string;
    accentText: string;
    ink: string;
    muted: string;
    line: string;
    canvas: string;
    surface: string;
    subtle: string;
    info: string;
    infoBg: string;
    success: string;
    successBg: string;
    warning: string;
    warningBg: string;
    danger: string;
    dangerBg: string;
  };
  font: string;
  monoFont: string;
  /** Body text size in px; headings scale from it. */
  fontSize: number;
  radius: number;
  /** Content width in px (600 is the safe maximum for mail apps). */
  width: number;
}

/** A rendered mail, ready for a transport. */
export interface RenderedMail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

export type Address = string | { name?: string; email: string };

export interface Envelope {
  to: Address | Address[];
  cc?: Address | Address[];
  bcc?: Address | Address[];
  replyTo?: Address;
  /** Overrides the mailer's default sender. */
  from?: Address;
}

/** Everything a transport needs to deliver one message. */
export interface OutgoingMessage extends Envelope {
  from: Address;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
}

/** Delivers a message (SMTP, a provider API, memory for tests…). */
export interface Transport {
  send(message: OutgoingMessage): Promise<SendResult>;
  close?(): Promise<void>;
}
