# AGENTS.md — @mgpl-diagnostics/mail-kit

Mail for the MGPL Diagnostics backend: the **mail design language** (`.mail` sources), its compiler to
email-safe HTML + plain text, built-in mails, an SMTP transport, and a mailer that sends through the
worker's queue when available and directly otherwise. **A library: no server, no queue library, no
runtime dependencies.** The api repo wires it (container + worker).

## Map

```
src/types.ts       AST (Block, Inline, Expr), Theme, Brand, RenderedMail, OutgoingMessage, Transport
src/parse.ts       .mail parser: front matter, blocks, inline markup, {{ }} with filters; parseMail, checkMail
src/render.ts      renderMail → { subject, preheader, html, text }; escaping, safeUrl, filters (IST), mailVariables
src/theme.ts       DEFAULT_THEME ("Saffron & Neel" tokens), DEFAULT_BRAND, createTheme
src/define.ts      defineMail (parses at definition), MailTemplate
src/templates.ts   built-in mails + MAIL_TEMPLATES (fictional samples)
src/mime.ts        addresses, RFC 2047 headers, quoted-printable, buildMessage (multipart/alternative)
src/smtp.ts        smtpTransport (TLS 465 / STARTTLS 587, AUTH PLAIN/LOGIN), parseSmtpUrl
src/transports.ts  memoryTransport, fileTransport
src/mailer.ts      createMailer: send (queue → direct fallback), deliver (worker), MailJob, MailQueue
src/queue.ts       queueAdapter (BullMQ-shaped Queue), mailProcessor (BullMQ-shaped Worker)
docs/language.md   the language reference (keep it in step with parse.ts)
scripts/test.ts    language, safety, filters, built-ins, MIME, SMTP (in-process server), mailer
scripts/examples.ts  renders every built-in to examples/ (git-ignored)
```

## Rules

1. **No HTML in mail sources.** Mails are written in the language; the renderer owns all markup. Add a
   block or an inline style to the language (parser + both renderers + docs + tests) instead of an escape hatch.
2. **Everything printed is escaped**, and every URL goes through `safeUrl` (links: http(s)/mailto/tel;
   images: https). A test sends hostile data through every block; keep it passing.
3. **HTML and text say the same thing.** Every block renders in `Html` and `Text` in `render.ts`.
4. **Email-safe HTML only:** tables, inline styles, `bgcolor`; no scripts, external CSS, web fonts, SVG,
   flexbox or grid. Colours and sizes come from the theme, never hard-coded in a template.
5. **Errors are thorough:** syntax errors list every problem with line:col; missing data lists every
   path. Error codes (`MailError.code`) are a public contract: add, never rename.
6. **Queue jobs hold data, not HTML**, survive JSON (dates as ISO strings), and are removed on
   completion (they can hold reset links). `send` validates before enqueueing.
7. **Never send in clear to a remote SMTP host** (`requireTLS` defaults on except localhost).
   Never log message bodies or SMTP credentials.
8. Zero runtime dependencies. Queue and worker types are structural (no bullmq import).
9. Samples use fictional people and `example.com` addresses. The lab's real contact details live only in
   report-kit's `lab.ts`; the api passes them in as the brand.
10. Dates print in IST; money is integer paise (`money` filter).

## Commands

```bash
npm run typecheck && npm test && npm run build
npm run examples   # look at the HTML after changing the renderer or theme
npm run llms       # regenerate llms-full.txt (CI fails when it is stale)
```

## Licence

All rights reserved (see LICENSE).
