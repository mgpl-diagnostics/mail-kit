// RFC 5322 / MIME message builder: multipart/alternative (text + HTML), quoted-printable UTF-8,
// RFC 2047 encoded headers. Header values are checked for CR/LF so nothing can inject headers.
import { randomBytes } from "node:crypto";
import { MailError } from "./errors";
import type { Address, OutgoingMessage } from "./types";

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export interface ParsedAddress {
  name?: string;
  email: string;
}

/** Accepts "a@b.in", "Name <a@b.in>" or { name, email }. Throws MAIL_BAD_ADDRESS otherwise. */
export function parseAddress(a: Address): ParsedAddress {
  let name: string | undefined;
  let email: string;
  if (typeof a === "string") {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/.exec(a);
    if (m) {
      name = m[1]?.trim() || undefined;
      email = m[2]!.trim();
    } else email = a.trim();
  } else {
    name = a.name?.trim() || undefined;
    email = a.email.trim();
  }
  if (!EMAIL.test(email) || email.length > 254) throw new MailError("MAIL_BAD_ADDRESS", `Not an email address: "${email}"`);
  if (name && /[\r\n]/.test(name)) throw new MailError("MAIL_BAD_ADDRESS", "Address names cannot contain line breaks");
  return name ? { name, email } : { email };
}

export const addressList = (a: Address | Address[] | undefined): ParsedAddress[] => (a === undefined ? [] : (Array.isArray(a) ? a : [a]).map(parseAddress));

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 "B" encoded-words, split so each stays under 75 characters and never cuts a character. */
export function encodeWord(s: string): string {
  if (ascii(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

export function formatAddress(a: ParsedAddress): string {
  if (!a.name) return a.email;
  const name = ascii(a.name) ? (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(a.name) ? a.name : `"${a.name.replace(/(["\\])/g, "\\$1")}"`) : encodeWord(a.name);
  return `${name} <${a.email}>`;
}

/** Quoted-printable (RFC 2045) with CRLF line ends and soft breaks at 76 characters. */
export function quotedPrintable(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  return lines
    .map((line) => {
      let out = "";
      let len = 0;
      const bytes = Buffer.from(line, "utf8");
      for (let k = 0; k < bytes.length; k++) {
        const b = bytes[k]!;
        const last = k === bytes.length - 1;
        let enc: string;
        if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)) enc = String.fromCharCode(b);
        else enc = "=" + b.toString(16).toUpperCase().padStart(2, "0");
        if (len + enc.length > 75) {
          out += "=\r\n";
          len = 0;
        }
        out += enc;
        len += enc.length;
      }
      return out;
    })
    .join("\r\n");
}

function checkHeader(name: string, value: string): void {
  if (/[\r\n]/.test(value) || !/^[A-Za-z0-9-]+$/.test(name)) throw new MailError("MAIL_BAD_VALUE", `Header ${name} cannot contain line breaks`);
}

export interface BuiltMessage {
  /** The whole message, CRLF line ends, ready for SMTP DATA (before dot-stuffing). */
  raw: string;
  messageId: string;
  from: string;
  /** Every envelope recipient (to + cc + bcc), deduplicated. */
  recipients: string[];
}

/** Builds the MIME message for `msg`. `domain` is used for the Message-ID. */
export function buildMessage(msg: OutgoingMessage, opts: { date?: Date } = {}): BuiltMessage {
  const from = parseAddress(msg.from);
  const to = addressList(msg.to);
  const cc = addressList(msg.cc);
  const bcc = addressList(msg.bcc);
  if (!to.length && !cc.length && !bcc.length) throw new MailError("MAIL_BAD_ADDRESS", "A message needs at least one recipient");
  const replyTo = msg.replyTo ? parseAddress(msg.replyTo) : null;
  checkHeader("Subject", msg.subject);
  const domain = from.email.split("@")[1]!;
  const messageId = `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain}>`;
  const boundary = `mk_${randomBytes(12).toString("hex")}`;

  const headers: [string, string][] = [
    ["From", formatAddress(from)],
    ...(to.length ? ([["To", to.map(formatAddress).join(",\r\n ")]] as [string, string][]) : []),
    ...(cc.length ? ([["Cc", cc.map(formatAddress).join(",\r\n ")]] as [string, string][]) : []),
    ...(replyTo ? ([["Reply-To", formatAddress(replyTo)]] as [string, string][]) : []),
    ["Subject", encodeWord(msg.subject)],
    ["Date", (opts.date ?? new Date()).toUTCString().replace("GMT", "+0000")],
    ["Message-ID", messageId],
    ["MIME-Version", "1.0"],
  ];
  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    checkHeader(k, v);
    if (/^(from|to|cc|bcc|subject|date|message-id|mime-version|content-type|content-transfer-encoding|reply-to)$/i.test(k)) {
      throw new MailError("MAIL_BAD_VALUE", `Header ${k} is set by mail-kit`);
    }
    headers.push([k, encodeWord(v)]);
  }
  headers.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);

  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable", "", quotedPrintable(body)].join("\r\n");
  const raw = [headers.map(([k, v]) => `${k}: ${v}`).join("\r\n"), "", part("text/plain", msg.text), part("text/html", msg.html), `--${boundary}--`, ""].join("\r\n");
  const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => a.email))];
  return { raw, messageId, from: from.email, recipients };
}
