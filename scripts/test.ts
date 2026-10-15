// mail-kit checks: language (parse errors with positions, inline markup, blocks, control flow),
// rendering safety (escaping, URLs), filters, every built-in mail, MIME, SMTP against an
// in-process server, and the mailer's queue / direct fallback.
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import {
  buildMessage,
  checkMail,
  createMailer,
  createTheme,
  defineMail,
  encodeWord,
  MAIL_TEMPLATES,
  mailProcessor,
  MailError,
  MailSyntaxError,
  memoryTransport,
  MissingVariableError,
  parseAddress,
  parseMail,
  parseSmtpUrl,
  quotedPrintable,
  queueAdapter,
  renderMail,
  smtpTransport,
  TransportError,
  type MailJob,
} from "../src/index";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`✗ ${name}\n    ${(e as Error).stack?.split("\n").slice(0, 3).join("\n    ")}`);
  }
}

const mail = (body: string, front = "subject: Hi") => `---\n${front}\n---\n${body}`;
const render = (src: string, data: Record<string, unknown> = {}) => renderMail(parseMail(src), data);
const syntaxErrors = (src: string) => {
  try {
    parseMail(src);
  } catch (e) {
    assert.ok(e instanceof MailSyntaxError, String(e));
    return e.diagnostics;
  }
  assert.fail("expected a syntax error");
};

// ---- language ----------------------------------------------------------------------------------

await check("headings, paragraphs, lists and hard breaks", () => {
  const doc = parseMail(mail("# Title\n\nline one\nline two\\\nafter break\n\n- a\n- b\n\n1. x\n2. y\n\n## Sub\n### Small"));
  assert.deepEqual(doc.body.map((b) => b.kind), ["heading", "paragraph", "list", "list", "heading", "heading"]);
  const p = doc.body[1]!;
  assert.ok(p.kind === "paragraph" && p.content.some((n) => n.kind === "br"));
  const l = doc.body[3]!;
  assert.ok(l.kind === "list" && l.ordered && l.items.length === 2);
});

await check("inline markup: strong, em, code, link, variables, escapes", () => {
  const r = render(mail("**bold** *em* _em2_ `x<y` [site](https://a.example/{{ id }}) {{ name }} \\*not em\\* snake_case_word"), { id: 7, name: "A" });
  assert.match(r.html, /<strong[^>]*>bold<\/strong>/);
  assert.match(r.html, /<em[^>]*>em<\/em>/);
  assert.match(r.html, /<em[^>]*>em2<\/em>/);
  assert.match(r.html, /<code[^>]*>x&lt;y<\/code>/);
  assert.match(r.html, /<a href="https:\/\/a\.example\/7"[^>]*>site<\/a>/);
  assert.match(r.html, /\*not em\*/);
  assert.match(r.html, /snake_case_word/);
  assert.match(r.text, /site \(https:\/\/a\.example\/7\)/);
});

await check("front matter: subject required, unknown keys refused", () => {
  assert.match(syntaxErrors("# no front matter")[0]!.message, /subject/);
  const d = syntaxErrors("---\nsubject: x\ncolour: red\n---\nhi");
  assert.equal(d[0]!.line, 3);
  assert.match(syntaxErrors("---\nsubject: x\nhello")[0]!.message, /not closed/);
});

await check("errors carry line and column, and all are reported at once", () => {
  const d = syntaxErrors(mail("ok\n\n::buton href=x\nGo\n::\n\n{{ name | shout }}\n\n::callout tone=loud\nx\n::"));
  assert.equal(d.length, 3, JSON.stringify(d));
  assert.deepEqual([d[0]!.line, d[0]!.col], [6, 1]);
  assert.match(d[0]!.message, /Unknown block "::buton"/);
  assert.match(d[1]!.message, /Unknown filter "shout"/);
  assert.equal(d[1]!.line, 10);
  assert.match(d[2]!.message, /tone must be/);
  // error messages name the file
  try {
    parseMail(mail("::nope"), "welcome.mail");
  } catch (e) {
    assert.match((e as Error).message, /^welcome\.mail:4:1 /);
  }
});

await check("block rules: required and unknown attributes, unclosed blocks, stray closers", () => {
  assert.match(syntaxErrors(mail("::button\nGo\n::"))[0]!.message, /needs href/);
  assert.match(syntaxErrors(mail("::button href=x size=2\nGo\n::"))[0]!.message, /no attribute "size"/);
  assert.match(syntaxErrors(mail("::card\ntext"))[0]!.message, /"::card" is not closed/);
  assert.match(syntaxErrors(mail("text\n::"))[0]!.message, /closes nothing/);
  assert.match(syntaxErrors(mail("::else"))[0]!.message, /only allowed inside/);
  assert.match(syntaxErrors(mail("::button href=x\nOne\nTwo\n::"))[0]!.message, /exactly one line/);
  assert.match(syntaxErrors(mail("::table\nA | B\n1 | 2 | 3\n::"))[0]!.message, /3 cells; the header has 2/);
  assert.match(syntaxErrors(mail("::table align=\"l\"\nA | B\n1 | 2\n::"))[0]!.message, /align/);
  assert.match(syntaxErrors(mail("::spacer size=999"))[0]!.message, /4 to 96/);
  assert.match(syntaxErrors(mail("::each items\nx\n::"))[0]!.message, /items as item/);
  assert.match(syntaxErrors(mail("::rows\n@each x y: a | b\n::"))[0]!.message, /@each items as item/);
});

await check("checkMail returns diagnostics without throwing", () => {
  assert.deepEqual(checkMail(mail("fine")), []);
  assert.equal(checkMail(mail("::nope")).length, 1);
});

await check("::if / ::else / negation and ::each with loop variables", () => {
  const src = mail("::if vip\nVIP\n::else\nRegular\n::\n\n::if !items\nNone\n::\n\n::each items as it\n{{ loop.index }}. {{ it.name }}{{ loop.last | default: \"\" }}\n::");
  const a = render(src, { vip: true, items: [{ name: "A" }, { name: "B" }] });
  assert.match(a.text, /VIP/);
  assert.doesNotMatch(a.text, /Regular|None/);
  assert.match(a.text, /1\. A/);
  assert.match(a.text, /2\. B/);
  const b = render(src, { vip: false, items: [] });
  assert.match(b.text, /Regular/);
  assert.match(b.text, /None/);
});

await check("lists built by ::each are one list", () => {
  const r = render(mail("::each xs as x\n- {{ x }}\n::"), { xs: ["a", "b", "c"] });
  assert.equal((r.html.match(/<ul /g) ?? []).length, 1);
  assert.equal((r.html.match(/<li /g) ?? []).length, 3);
  assert.match(r.text, /- a\n- b\n- c/);
});

await check("tables and rows: alignment, @each rows, footer, pipes inside variables", () => {
  const src = mail("::table align=\"l r\" footer\nItem | Amount\n@each items as i: {{ i.name }} | {{ i.p | money }}\nTotal | {{ total | money | default: \"0\" }}\n::\n\n::rows\nA \\| B | {{ x }}\n@each extra as e: {{ e.k }} | {{ e.v }}\n::");
  const r = render(src, { items: [{ name: "CBC", p: 39900 }, { name: "TSH", p: 29900 }], total: 69800, x: "1", extra: [{ k: "K", v: "V" }] });
  assert.match(r.html, /<th align="right"[^>]*>Amount<\/th>/);
  assert.match(r.html, /₹698\.00/);
  assert.match(r.text, /CBC\s+₹399\.00\nTSH\s+₹299\.00\n-+\s+-+\nTotal\s+₹698\.00/);
  assert.match(r.text, /A \| B: 1/);
  assert.match(r.text, /K:\s+V/);
});

await check("code, divider, spacer, image, card, callout", () => {
  const r = render(mail("::code\n{{ otp }}\n::\n\n::divider\n::spacer size=12\n::image src=\"https://cdn.example/x.png\" alt=\"Logo\" width=120\n\n::card\nIn a card\n::\n\n::callout tone=success title=\"Done {{ n }}\"\nok\n::"), { otp: "482913", n: 2 });
  assert.match(r.html, /482913/);
  assert.match(r.html, /<img src="https:\/\/cdn\.example\/x\.png" alt="Logo" width="120"/);
  assert.match(r.html, /Done 2/);
  assert.match(r.text, /^ {4}482913$/m);
  assert.match(r.text, /\| Done 2\n\|\n\| ok/);
  assert.match(r.text, /\[Logo\]/);
});

// ---- safety ------------------------------------------------------------------------------------

await check("every value is escaped (no HTML injection through data)", () => {
  const evil = `<script>alert(1)</script>"'&`;
  const r = render(mail("# {{ x }}\n\n{{ x }}\n\n::rows\n{{ x }} | {{ x }}\n::\n\n::callout title=\"{{ x }}\"\n{{ x }}\n::", "subject: {{ x }}"), { x: evil });
  assert.ok(!r.html.includes("<script>"));
  assert.ok(r.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;"));
  assert.equal(r.subject, evil);
  // source text is escaped too: the language has no raw HTML
  assert.ok(!render(mail("<b>hi</b>")).html.includes("<b>hi</b>"));
});

await check("unsafe URLs are refused in links, buttons and images", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example", "/relative", "https://a b"]) {
    assert.throws(() => render(mail("::button href=\"{{ u }}\"\nGo\n::"), { u: href }), (e: unknown) => e instanceof MailError && e.code === "MAIL_UNSAFE_URL", href);
    assert.throws(() => render(mail("[x]({{ u }})"), { u: href }), MailError, href);
  }
  assert.throws(() => render(mail("::image src=\"http://a.example/x.png\" alt=x")), /https/);
  for (const ok of ["https://a.example/?q=1&b=2", "http://localhost:3000/reset", "mailto:a@b.in", "tel:+91-9000000000"]) {
    const r = render(mail("::button href=\"{{ u }}\"\nGo\n::"), { u: ok });
    assert.ok(r.html.includes(`href="${ok.replace(/&/g, "&amp;")}"`), ok);
  }
});

await check("missing variables are all reported at once; defaults and empty strings are fine", () => {
  const src = mail("{{ a }} {{ b.c }} {{ d | default: \"-\" }} {{ e }}", "subject: {{ s }}");
  try {
    render(src, { e: "" });
    assert.fail("expected MissingVariableError");
  } catch (e) {
    assert.ok(e instanceof MissingVariableError);
    assert.deepEqual(e.paths.sort(), ["a", "b.c", "s"]);
    assert.equal(e.code, "MAIL_MISSING_VARIABLE");
  }
  assert.throws(() => render(mail("::each xs as x\n{{ x }}\n::")), MissingVariableError);
  assert.throws(() => render(mail("{{ o }}"), { o: { a: 1 } }), /cannot be printed/);
});

// ---- filters -----------------------------------------------------------------------------------

await check("filters: money (paise, Indian grouping), number, dates in IST, case, default", () => {
  const r = render(
    mail("{{ m | money }}|{{ big | money }}|{{ n | number }}|{{ d | date }}|{{ d | time }}|{{ d | datetime }}|{{ day | date }}|{{ s | upper }}|{{ s | lower }}|{{ dd | datetime }}"),
    { m: 39950, big: 12345678900, n: 1234567, d: "2026-10-14T18:45:00Z", day: "2026-10-14", s: "MiXeD", dd: new Date("2026-03-31T18:30:00Z") },
  );
  const first = r.text.split("\n\n")[0]!;
  assert.equal(first.replace(/\s+/g, " "), "₹399.50|₹12,34,56,789.00|12,34,567|15 Oct 2026|12:15 am IST|15 Oct 2026, 12:15 am IST|14 Oct 2026|MIXED|mixed|1 Apr 2026, 12:00 am IST");
  assert.throws(() => render(mail("{{ m | money }}"), { m: 10.5 }), /integer paise/);
  assert.throws(() => render(mail("{{ d | time }}"), { d: "2026-10-14" }), /needs a time/);
  assert.throws(() => render(mail("{{ d | date }}"), { d: "not a date" }), /Date or an ISO/);
});

// ---- layout and theme --------------------------------------------------------------------------

await check("layout: brand header and footer, preheader, theme tokens, mobile CSS", () => {
  const brand = { name: "Test Lab", logoUrl: "https://cdn.example/logo.png", addressLines: ["Line 1"], phone: "+91-1", email: "lab@example.com", website: "https://lab.example" };
  const theme = createTheme({ colors: { accent: "#0B7285" } });
  const r = renderMail(parseMail(mail("Body text here.\n\n::button href=\"https://x.example\"\nGo\n::", "subject: S\nfooter: Note {{ n }}")), { n: 1 }, { brand, theme });
  assert.match(r.html, /<img src="https:\/\/cdn\.example\/logo\.png" alt="Test Lab"/);
  assert.match(r.html, /Line 1<br>\+91-1  \|  lab@example\.com  \|  https:\/\/lab\.example/);
  assert.match(r.html, /background-color:#0B7285/);
  assert.match(r.html, /@media \(max-width:620px\)/);
  assert.equal(r.preheader, "Body text here.");
  assert.match(r.html, /display:none[^>]*>Body text here\./);
  assert.match(r.text, /--\nNote 1\n\nTest Lab\nLine 1\n/);
  assert.ok(r.html.startsWith("<!DOCTYPE html>"));
  assert.ok(!/<script|<link|<style[^>]*@import/i.test(r.html), "no scripts or external CSS");
});

await check("plain text wraps at 76 columns (URLs stay whole)", () => {
  const long = "word ".repeat(60).trim();
  const r = render(mail(`${long}\n\n[x](https://example.com/${"a".repeat(100)})`));
  for (const line of r.text.split("\n")) if (!line.includes("https://")) assert.ok(line.length <= 76, line);
  assert.ok(r.text.includes(`https://example.com/${"a".repeat(100)}`));
});

// ---- built-in mails ----------------------------------------------------------------------------

for (const t of Object.values(MAIL_TEMPLATES)) {
  await check(`built-in "${t.id}" renders its sample and its sample covers every variable`, () => {
    const r = t.render(t.sample as never);
    assert.ok(r.subject && r.html.length > 1000 && r.text.length > 50);
    const body = r.html.slice(r.html.indexOf("<body"));
    assert.ok(!/\{\{|\}\}|::/.test(r.text + body), "no unrendered markup");
    const sample = t.sample as Record<string, unknown>;
    for (const v of t.variables) {
      const [head] = v.split(".");
      assert.ok(head! in sample, `sample lacks ${v}`);
    }
    // each mail fails loudly without its data
    assert.throws(() => t.render({} as never), MissingVariableError);
    // no real contact details in the package
    assert.ok(!/@gmail\.com|\+91-9\d{9}/.test(t.source));
  });
}

await check("defineMail fails at definition on a syntax error", () => {
  assert.throws(() => defineMail({ id: "bad", description: "", source: mail("::nope"), sample: {} }), /bad:4:1/);
});

// ---- MIME --------------------------------------------------------------------------------------

await check("addresses: forms, validation, no header injection", () => {
  assert.deepEqual(parseAddress("Kavita Sharma <kavita@example.com>"), { name: "Kavita Sharma", email: "kavita@example.com" });
  assert.deepEqual(parseAddress({ email: "a@b.in" }), { email: "a@b.in" });
  for (const bad of ["no-at", "a@b", "a@b.in\r\nBcc: x@y.in", "<a@b.in>\nX: y", "a b@c.in"]) {
    assert.throws(() => parseAddress(bad), (e: unknown) => e instanceof MailError && e.code === "MAIL_BAD_ADDRESS", bad);
  }
  assert.throws(() => buildMessage({ from: "a@b.in", to: "c@d.in", subject: "x\r\nBcc: e@f.in", html: "", text: "" }), /line breaks/);
  assert.throws(() => buildMessage({ from: "a@b.in", to: "c@d.in", subject: "x", html: "", text: "", headers: { "X-A": "1\nB: 2" } }), /line breaks/);
  assert.throws(() => buildMessage({ from: "a@b.in", to: "c@d.in", subject: "x", html: "", text: "", headers: { Bcc: "e@f.in" } }), /set by mail-kit/);
});

await check("quoted-printable: line length, '=' and UTF-8, trailing space", () => {
  const qp = quotedPrintable(`${"x".repeat(200)}\n₹ 1 = 1 \nend`);
  for (const l of qp.split("\r\n")) assert.ok(l.length <= 76, l);
  assert.ok(qp.includes("=E2=82=B9"));
  assert.ok(qp.includes("=3D"));
  assert.ok(qp.includes("1=20\r\nend"));
  const decoded = Buffer.from(qp.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  assert.equal(decoded, `${"x".repeat(200)}\r\n₹ 1 = 1 \r\nend`);
});

await check("encoded headers: UTF-8 subjects and names, each word under 76", () => {
  const w = encodeWord("रिपोर्ट तैयार है — आपकी जाँच के नतीजे देखें ₹399");
  for (const part of w.split("\r\n ")) assert.ok(part.length <= 75 && /^=\?UTF-8\?B\?.+\?=$/.test(part), part);
  const decoded = w.split("\r\n ").map((p) => Buffer.from(p.slice(10, -2), "base64").toString("utf8")).join("");
  assert.equal(decoded, "रिपोर्ट तैयार है — आपकी जाँच के नतीजे देखें ₹399");
  const m = buildMessage({ from: { name: "लैब", email: "a@b.in" }, to: "c@d.in", bcc: ["e@f.in", "c@d.in"], subject: "Hi", html: "<p>x</p>", text: "x" });
  assert.match(m.raw, /^From: =\?UTF-8\?B\?/);
  assert.ok(!/^Bcc:/im.test(m.raw), "Bcc never appears in headers");
  assert.deepEqual(m.recipients, ["c@d.in", "e@f.in"]);
  assert.match(m.raw, /Content-Type: multipart\/alternative; boundary="mk_[0-9a-f]+"/);
  assert.match(m.messageId, /^<[^@]+@b\.in>$/);
});

// ---- SMTP --------------------------------------------------------------------------------------

interface FakeOpts {
  auth?: "PLAIN" | "LOGIN";
  rejectRcpt?: string;
  startTls?: boolean;
}
interface Received {
  from: string;
  rcpt: string[];
  data: string;
  auth: string[];
}
async function fakeSmtp(o: FakeOpts = {}) {
  const received: Received[] = [];
  const server = createServer((sock: Socket) => {
    const cur: Received = { from: "", rcpt: [], data: "", auth: [] };
    let mode: "cmd" | "data" | "login-user" | "login-pass" = "cmd";
    let buf = "";
    const say = (s: string) => sock.write(s + "\r\n");
    say("220 fake ESMTP");
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (mode === "data") {
          if (line === ".") {
            mode = "cmd";
            received.push({ ...cur, rcpt: [...cur.rcpt] });
            say("250 2.0.0 queued");
          } else cur.data += line + "\r\n";
          continue;
        }
        if (mode === "login-user") {
          cur.auth.push(Buffer.from(line, "base64").toString());
          mode = "login-pass";
          say("334 UGFzc3dvcmQ6");
          continue;
        }
        if (mode === "login-pass") {
          cur.auth.push(Buffer.from(line, "base64").toString());
          mode = "cmd";
          say(cur.auth[1] === "secret" ? "235 ok" : "535 bad credentials");
          continue;
        }
        const [verb] = line.split(" ");
        switch (verb!.toUpperCase()) {
          case "EHLO":
            sock.write(`250-fake\r\n${o.startTls ? "250-STARTTLS\r\n" : ""}${o.auth ? `250-AUTH ${o.auth}\r\n` : ""}250 8BITMIME\r\n`);
            break;
          case "AUTH": {
            const [, mech, arg] = line.split(" ");
            if (mech === "LOGIN") {
              mode = "login-user";
              say("334 VXNlcm5hbWU6");
            } else {
              const [, u, p] = Buffer.from(arg!, "base64").toString().split("\0");
              cur.auth.push(u!, p!);
              say(p === "secret" ? "235 ok" : "535 bad credentials");
            }
            break;
          }
          case "MAIL":
            cur.from = /<(.*)>/.exec(line)![1]!;
            say("250 ok");
            break;
          case "RCPT": {
            const r = /<(.*)>/.exec(line)![1]!;
            if (r === o.rejectRcpt) say("550 no such user");
            else {
              cur.rcpt.push(r);
              say("250 ok");
            }
            break;
          }
          case "DATA":
            mode = "data";
            say("354 go ahead");
            break;
          case "QUIT":
            say("221 bye");
            sock.end();
            break;
          default:
            say("502 not implemented");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const msg = (extra: Partial<Parameters<typeof buildMessage>[0]> = {}) => ({
  from: "MGPL <no-reply@example.com>",
  to: "Kavita Sharma <kavita@example.com>",
  subject: "Résumé of your tests",
  html: "<p>Hello</p>",
  text: "Hello\n.leading dot line\n..two dots",
  ...extra,
});

await check("SMTP: AUTH PLAIN, envelope, dot-stuffing, message arrives intact", async () => {
  const s = await fakeSmtp({ auth: "PLAIN" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, user: "lab", pass: "secret" });
    const res = await t.send(msg({ cc: "cc@example.com", bcc: "hidden@example.com" }));
    assert.deepEqual(res.accepted, ["kavita@example.com", "cc@example.com", "hidden@example.com"]);
    const got = s.received[0]!;
    assert.equal(got.from, "no-reply@example.com");
    assert.deepEqual(got.auth, ["lab", "secret"]);
    assert.ok(got.data.includes("\r\n..leading dot line\r\n...two dots"), "dot-stuffed");
    const unstuffed = got.data.replace(/^\.\./gm, ".");
    assert.ok(unstuffed.includes(".leading dot line\r\n..two dots"));
    assert.ok(!/^Bcc:/im.test(got.data));
    assert.match(got.data, /^Subject: =\?UTF-8\?B\?/m);
    assert.ok(got.data.includes(`Message-ID: ${res.messageId}`));
  } finally {
    await s.close();
  }
});

await check("SMTP: AUTH LOGIN, wrong password is a TransportError with status, password not in message", async () => {
  const s = await fakeSmtp({ auth: "LOGIN" });
  try {
    await smtpTransport({ host: "127.0.0.1", port: s.port, user: "lab", pass: "secret" }).send(msg());
    assert.equal(s.received.length, 1);
    await assert.rejects(
      smtpTransport({ host: "127.0.0.1", port: s.port, user: "lab", pass: "wrong" }).send(msg()),
      (e: unknown) => e instanceof TransportError && e.status === 535 && !e.message.includes("wrong") && e.message.includes("(credentials)"),
    );
  } finally {
    await s.close();
  }
});

await check("SMTP: a refused recipient is skipped; all refused fails", async () => {
  const s = await fakeSmtp({ rejectRcpt: "nobody@example.com" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port });
    const r = await t.send(msg({ to: ["kavita@example.com", "nobody@example.com"] }));
    assert.deepEqual(r.accepted, ["kavita@example.com"]);
    await assert.rejects(t.send(msg({ to: "nobody@example.com" })), (e: unknown) => e instanceof TransportError && e.status === 550);
  } finally {
    await s.close();
  }
});

await check("SMTP: refuses to send in clear when TLS is required", async () => {
  const s = await fakeSmtp({ auth: "PLAIN" });
  try {
    await assert.rejects(smtpTransport({ host: "127.0.0.1", port: s.port, requireTLS: true, user: "u", pass: "secret" }).send(msg()), /does not offer TLS/);
    assert.equal(s.received.length, 0);
  } finally {
    await s.close();
  }
});

await check("SMTP: connection refused is a TransportError; URLs parse", async () => {
  const s = await fakeSmtp();
  const port = s.port;
  await s.close();
  await assert.rejects(smtpTransport({ host: "127.0.0.1", port }).send(msg()), (e: unknown) => e instanceof TransportError && /Cannot connect/.test(e.message));
  assert.deepEqual(parseSmtpUrl("smtps://u%40x.in:p%2Fw@smtp.example.com"), { host: "smtp.example.com", port: 465, secure: true, user: "u@x.in", pass: "p/w" });
  assert.deepEqual(parseSmtpUrl("smtp://smtp.example.com:2525"), { host: "smtp.example.com", port: 2525, secure: false });
  assert.throws(() => parseSmtpUrl("http://x"), /smtp:\/\//);
});

// ---- mailer ------------------------------------------------------------------------------------

const resetData = MAIL_TEMPLATES["password-reset"].sample;

await check("mailer without a queue sends directly (standalone)", async () => {
  const transport = memoryTransport();
  const mailer = createMailer({ transport, from: "MGPL <no-reply@example.com>" });
  const out = await mailer.send("password-reset", resetData, { to: "kavita@example.com" });
  assert.equal(out.via, "direct");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]!.subject, "Reset your password");
  assert.match(transport.sent[0]!.text, /sample-token/);
});

await check("mailer with an available queue enqueues; the worker processor delivers the job", async () => {
  const transport = memoryTransport();
  const added: { name: string; data: MailJob; opts?: Record<string, unknown> }[] = [];
  const fakeQueue = { add: async (name: string, data: MailJob, opts?: Record<string, unknown>) => (added.push({ name, data, opts }), { id: "42" }) };
  const mailer = createMailer({ transport, from: "no-reply@example.com", queue: queueAdapter(fakeQueue, { available: () => true }) });
  const out = await mailer.send("password-reset", resetData, { to: "kavita@example.com" });
  assert.deepEqual(out, { via: "queue", jobId: "42" });
  assert.equal(transport.sent.length, 0);
  assert.equal(added[0]!.name, "mail");
  assert.equal(added[0]!.opts!.removeOnComplete, true, "jobs holding reset links do not linger");
  // the job survives JSON (as in Redis) and the worker sends it
  const job = JSON.parse(JSON.stringify(added[0]!.data)) as MailJob;
  const result = await mailProcessor(mailer)({ data: job });
  assert.deepEqual(result.accepted, ["kavita@example.com"]);
  assert.equal(transport.sent.length, 1);
});

await check("mailer falls back to direct when the queue is down or enqueue fails", async () => {
  const transport = memoryTransport();
  const reasons: unknown[] = [];
  const down = createMailer({ transport, from: "no-reply@example.com", queue: { enqueue: async () => "x", available: () => false }, onFallback: (r) => reasons.push(r) });
  assert.equal((await down.send("password-reset", resetData, { to: "a@example.com" })).via, "direct");
  const failing = createMailer({ transport, from: "no-reply@example.com", queue: { enqueue: () => Promise.reject(new Error("ECONNREFUSED")) }, onFallback: (r) => reasons.push(r) });
  assert.equal((await failing.send("password-reset", resetData, { to: "a@example.com" })).via, "direct");
  assert.equal(transport.sent.length, 2);
  assert.equal(reasons.length, 2);
  const strict = createMailer({ transport, from: "no-reply@example.com", queue: { enqueue: () => Promise.reject(new Error("down")) }, whenQueueFails: "throw" });
  await assert.rejects(strict.send("password-reset", resetData, { to: "a@example.com" }), (e: unknown) => e instanceof MailError && e.code === "MAIL_QUEUE");
});

await check("mailer validates before queueing: unknown template, missing data, bad address", async () => {
  const added: unknown[] = [];
  const mailer = createMailer({ transport: memoryTransport(), from: "no-reply@example.com", queue: { enqueue: async (j) => (added.push(j), "1") } });
  await assert.rejects(mailer.send("nope", {}, { to: "a@example.com" }), (e: unknown) => e instanceof MailError && e.code === "MAIL_UNKNOWN_TEMPLATE");
  await assert.rejects(mailer.send("toString", {}, { to: "a@example.com" }), /Unknown mail template/);
  await assert.rejects(mailer.send("password-reset", { name: "x" }, { to: "a@example.com" }), MissingVariableError);
  await assert.rejects(mailer.send("password-reset", resetData, { to: "not an address" }), /Not an email address/);
  await assert.rejects(mailer.send("password-reset", resetData, { to: [] }), /at least one recipient/);
  assert.equal(added.length, 0);
  assert.throws(() => createMailer({ transport: memoryTransport(), from: "bad" }), /Not an email address/);
});

await check("mailer: custom templates, brand, reply-to and per-mail sender", async () => {
  const transport = memoryTransport();
  const hello = defineMail({ id: "hello", description: "", source: mail("Hello {{ who }}", "subject: Hi {{ who }}"), sample: { who: "Lab" } });
  const mailer = createMailer({ transport, from: "a@example.com", replyTo: "desk@example.com", templates: { ...MAIL_TEMPLATES, hello }, brand: { name: "Branch Lab" } });
  await mailer.send("hello", { who: "Asha" }, { to: "b@example.com", from: "Branch <branch@example.com>" });
  const m = transport.sent[0]!;
  assert.equal(m.subject, "Hi Asha");
  assert.equal(m.from, "Branch <branch@example.com>");
  assert.equal(m.replyTo, "desk@example.com");
  assert.match(m.text, /Branch Lab/);
  assert.ok(mailer.templates().includes("hello") && mailer.templates().includes("password-reset"));
});

// ---- report ------------------------------------------------------------------------------------

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`mail-kit: ${passed} checks passed`);
