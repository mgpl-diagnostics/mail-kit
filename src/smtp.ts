// A small SMTP client on node:net / node:tls (no dependencies): implicit TLS (465) or STARTTLS (587),
// AUTH PLAIN / LOGIN, one connection per message. Works with Gmail, Zoho, Amazon SES, Brevo, Postfix…
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { TransportError } from "./errors";
import { buildMessage } from "./mime";
import type { OutgoingMessage, SendResult, Transport } from "./types";

export interface SmtpOptions {
  host: string;
  /** Default 465 when `secure`, else 587. */
  port?: number;
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is used when offered. */
  secure?: boolean;
  user?: string;
  pass?: string;
  /**
   * Refuse to send without TLS. Default true, except for localhost (a local relay or test server).
   * Never turn it off for a remote server: the password and the mail would cross the network in clear.
   */
  requireTLS?: boolean;
  /** Name sent with EHLO. Default: this machine's hostname. */
  name?: string;
  /** Socket inactivity timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Extra TLS options (ca, servername, rejectUnauthorized for a private relay…). */
  tls?: ConnectionOptions;
}

/**
 * Options from a URL: `smtps://user:pass@smtp.example.com:465` (implicit TLS) or
 * `smtp://user:pass@smtp.example.com:587` (STARTTLS). User and password are URL-decoded.
 */
export function parseSmtpUrl(url: string): SmtpOptions {
  const u = new URL(url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new TransportError(`SMTP URL must start with smtp:// or smtps:// (got ${u.protocol})`);
  const secure = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    ...(u.username ? { user: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { pass: decodeURIComponent(u.password) } : {}),
  };
}

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1";

interface Reply {
  code: number;
  lines: string[];
}

/** Line-oriented SMTP conversation over a socket that can be upgraded to TLS. */
class Conversation {
  private buf = "";
  private lines: string[] = [];
  private replies: Reply[] = [];
  private waiting: ((r: Reply | Error) => void) | null = null;
  private failure: Error | null = null;

  constructor(
    public socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.setTimeout(this.timeoutMs);
    socket.on("data", (d: Buffer) => this.onData(d.toString("latin1")));
    socket.on("timeout", () => this.fail(new TransportError("SMTP server timed out")));
    socket.on("error", (e) => this.fail(new TransportError(`SMTP connection failed: ${e.message}`)));
    socket.on("close", () => this.fail(new TransportError("SMTP connection closed")));
  }

  detach(): void {
    this.socket.removeAllListeners("data").removeAllListeners("timeout").removeAllListeners("error").removeAllListeners("close");
  }

  private fail(e: Error): void {
    this.failure ??= e;
    const w = this.waiting;
    this.waiting = null;
    w?.(e);
  }

  private onData(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const r: Reply = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) };
        this.lines = [];
        const w = this.waiting;
        this.waiting = null;
        if (w) w(r);
        else this.replies.push(r);
      }
    }
  }

  read(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = (r) => (r instanceof Error ? reject(r) : resolve(r));
    });
  }

  /** Sends one command and checks the reply code. `secret` hides the command in errors. */
  async cmd(line: string, expect: number[], secret = false): Promise<Reply> {
    const reply = this.read();
    this.socket.write(line + "\r\n");
    const r = await reply;
    if (!expect.includes(r.code)) {
      const shown = secret ? "(credentials)" : line.split(" ")[0];
      throw new TransportError(`SMTP ${shown} failed: ${r.code} ${r.lines.join(" ")}`.trim(), r.code);
    }
    return r;
  }
}

/** SMTP transport. One connection per message; `send` resolves once the server accepts the DATA. */
export function smtpTransport(options: SmtpOptions | string): Transport {
  const o = typeof options === "string" ? parseSmtpUrl(options) : options;
  const secure = o.secure ?? false;
  const port = o.port ?? (secure ? 465 : 587);
  const requireTLS = o.requireTLS ?? !isLocal(o.host);
  const timeoutMs = o.timeoutMs ?? 30_000;
  const name = o.name ?? (hostname() || "localhost");

  return {
    async send(message: OutgoingMessage): Promise<SendResult> {
      const built = buildMessage(message);
      if ([built.from, ...built.recipients].some((a) => !/^[\x21-\x7e]+$/.test(a))) {
        throw new TransportError("Non-ASCII email addresses are not supported");
      }
      const socket = await open(o.host, port, secure, { servername: o.host, ...o.tls });
      const conv = new Conversation(socket, timeoutMs);
      try {
        await expectReply(conv, 220);
        let ehlo = await conv.cmd(`EHLO ${name}`, [250]);
        let tls = secure;
        if (!tls && ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
          await conv.cmd("STARTTLS", [220]);
          conv.detach();
          const upgraded = await upgrade(conv.socket as Socket, { servername: o.host, ...o.tls });
          conv.attach(upgraded);
          tls = true;
          ehlo = await conv.cmd(`EHLO ${name}`, [250]);
        }
        if (!tls && requireTLS) throw new TransportError(`${o.host} does not offer TLS; refusing to send in clear (set requireTLS: false only for a local relay)`);
        if (o.user) {
          const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) ?? "";
          if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
            await conv.cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass ?? ""}`).toString("base64")}`, [235], true);
          } else {
            await conv.cmd("AUTH LOGIN", [334]);
            await conv.cmd(Buffer.from(o.user).toString("base64"), [334], true);
            await conv.cmd(Buffer.from(o.pass ?? "").toString("base64"), [235], true);
          }
        }
        await conv.cmd(`MAIL FROM:<${built.from}>`, [250]);
        const accepted: string[] = [];
        let lastRefusal: TransportError | null = null;
        for (const rcpt of built.recipients) {
          try {
            await conv.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
            accepted.push(rcpt);
          } catch (e) {
            if (!(e instanceof TransportError) || !e.status || e.status < 500) throw e;
            lastRefusal = e;
          }
        }
        if (!accepted.length) throw lastRefusal ?? new TransportError("No recipient was accepted");
        await conv.cmd("DATA", [354]);
        // dot-stuffing (RFC 5321 4.5.2), then the terminating "."
        const body = built.raw.replace(/(^|\r\n)\./g, "$1..");
        await conv.cmd(`${body.endsWith("\r\n") ? body : body + "\r\n"}.`, [250]);
        await conv.cmd("QUIT", [221]).catch(() => undefined);
        return { messageId: built.messageId, accepted };
      } finally {
        conv.detach();
        conv.socket.destroy();
      }
    },
  };
}

async function expectReply(conv: Conversation, code: number): Promise<void> {
  const r = await conv.read();
  if (r.code !== code) throw new TransportError(`SMTP server refused the connection: ${r.code} ${r.lines.join(" ")}`, r.code);
}

function open(host: string, port: number, secure: boolean, tls: ConnectionOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = secure ? tlsConnect({ host, port, ...tls }) : netConnect({ host, port });
    const ok = () => {
      s.removeListener("error", bad);
      resolve(s);
    };
    const bad = (e: Error) => reject(new TransportError(`Cannot connect to ${host}:${port}: ${e.message}`));
    s.once(secure ? "secureConnect" : "connect", ok);
    s.once("error", bad);
  });
}

function upgrade(socket: Socket, tls: ConnectionOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ socket, ...tls });
    s.once("secureConnect", () => {
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (e) => reject(new TransportError(`STARTTLS failed: ${e.message}`)));
  });
}
