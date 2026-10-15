# @mgpl-diagnostics/mail-kit

Mail for the MGPL Diagnostics backend. Mails are written in **our own mail design language**
(`.mail` sources, see [docs/language.md](docs/language.md)), never in hand-written HTML. mail-kit
checks them and compiles each one to email-safe HTML plus a plain-text part, in one consistent
design. It then sends them **through the worker's queue when one is available, or directly over
SMTP when it is not** (standalone).

- Zero runtime dependencies (its own SMTP client on `node:net`/`node:tls`, its own MIME builder).
- Every value is escaped; links, buttons and images accept safe URLs only.
- Syntax errors list every problem with `line:col`; missing data lists every missing variable.
- Built-in mails: password reset, password changed, staff invite, report ready, payment receipt.

## Install

```bash
# .npmrc: @mgpl-diagnostics:registry=https://npm.pkg.github.com
npm install @mgpl-diagnostics/mail-kit
```

## Use

```ts
import { createMailer, smtpTransport, queueAdapter, mailProcessor } from "@mgpl-diagnostics/mail-kit";

const mailer = createMailer({
  transport: smtpTransport(process.env.SMTP_URL!), // smtps://user:pass@smtp.example.com:465
  from: "Maa Gayatri Path Lab <no-reply@example.com>",
  brand: { name: "Maa Gayatri Path Lab", addressLines: ["Arang, Raipur, Chhattisgarh"] },
  // optional: the worker's BullMQ queue. Without it, or while Redis is down, mail goes out directly.
  queue: queueAdapter(mailQueue, { available: () => redis.status === "ready" }),
});

await mailer.send("password-reset", { name, email, link, expiresAt }, { to: { name, email } });
// → { via: "queue", jobId } or { via: "direct", messageId, accepted }

// in the worker process:
new Worker("mail", mailProcessor(mailer), { connection });
```

`send` renders first, so bad data or an unknown template fails in the request, not in the worker.
Jobs carry the template id, data and envelope (not HTML); finished jobs are removed at once
because a job can hold a single-use link.

### Your own mails

```ts
import { defineMail, MAIL_TEMPLATES } from "@mgpl-diagnostics/mail-kit";

const sampleReady = defineMail({
  id: "sample-collected",
  description: "Sample collected at home",
  source: `---
subject: We collected your sample
---
# Sample collected

Dear {{ patientName }}, your sample was collected at {{ at | time }}.
`,
  sample: { patientName: "Kavita Sharma", at: "2026-10-14T04:30:00Z" },
});

createMailer({ ..., templates: { ...MAIL_TEMPLATES, "sample-collected": sampleReady } });
```

### Transports

| Transport | Use |
| --- | --- |
| `smtpTransport(url \| options)` | Any SMTP server (Gmail, Zoho, Amazon SES, Brevo, Postfix). Implicit TLS on 465 or STARTTLS on 587; refuses to send in clear to a remote host. |
| `memoryTransport()` | Tests: `transport.sent` holds every message. |
| `fileTransport(dir)` | Local development: writes `.eml` files. |
| your own | Any `{ send(message) }`, e.g. a provider's HTTP API. |

## Commands

```bash
npm run typecheck && npm test && npm run build
npm run examples   # every built-in mail as .html / .txt / .eml in examples/ (git-ignored)
npm run llms       # regenerate llms-full.txt (CI fails when it is stale)
```

## Licence

All rights reserved. See [LICENSE](LICENSE).
