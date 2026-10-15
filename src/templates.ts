// Built-in MGPL mails, written in the mail design language. Samples use fictional people only.
import { defineMail, type AnyMailTemplate } from "./define";

export const passwordReset = defineMail({
  id: "password-reset",
  description: "Link to choose a new password (auth-kit requestPasswordReset).",
  source: String.raw`---
subject: Reset your password
preheader: This link works until {{ expiresAt | time }}. If you did not ask for it, ignore this mail.
---
# Reset your password

Hi {{ name }}, we received a request to reset the password of your MGPL account.

::button href="{{ link }}"
Choose a new password
::

::rows
Account | {{ email }}
Link valid until | {{ expiresAt | datetime }}
::

::callout tone="warning" title="Didn't ask for this?"
Ignore this mail. Your password stays the same, and the link stops working on its own.
::

If the button does not work, copy this address into your browser:\
[{{ link }}]({{ link }})
`,
  sample: {
    name: "Kavita Sharma",
    email: "kavita.sharma@example.com",
    link: "https://lab.example.com/reset-password?token=sample-token",
    expiresAt: "2026-10-14T16:30:00.000Z",
  },
});

export const passwordChanged = defineMail({
  id: "password-changed",
  description: "Confirms a password change or reset.",
  source: String.raw`---
subject: Your password was changed
---
# Your password was changed

Hi {{ name }}, the password of your MGPL account ({{ email }}) was changed on {{ changedAt | datetime }}.

::callout tone="danger" title="Wasn't you?"
Contact your lab administrator straight away so they can lock the account.
::
`,
  sample: { name: "Kavita Sharma", email: "kavita.sharma@example.com", changedAt: "2026-10-14T10:05:00.000Z" },
});

export const staffInvite = defineMail({
  id: "staff-invite",
  description: "Invites a staff member to the lab panel.",
  source: String.raw`---
subject: {{ invitedBy }} invited you to {{ orgName }}
preheader: Set your password to start using the MGPL lab panel.
---
# Welcome to {{ orgName }}

Hi {{ name }}, **{{ invitedBy }}** has added you to the lab panel.

::if roles
Your access:

::each roles as role
- **{{ role.name }}**{{ role.branch | default: "" }}
::
::

::button href="{{ link }}"
Set your password
::

This invitation expires on {{ expiresAt | datetime }}.
`,
  sample: {
    name: "Rohit Verma",
    orgName: "Maa Gayatri Path Lab",
    invitedBy: "Anita Patel",
    roles: [
      { name: "Front desk", branch: " (Arang)" },
      { name: "Phlebotomist", branch: " (Raipur)" },
    ],
    link: "https://lab.example.com/invite?token=sample-token",
    expiresAt: "2026-10-21T12:00:00.000Z",
  },
});

export const reportReady = defineMail({
  id: "report-ready",
  description: "Tells a patient their report is ready, with a download link.",
  source: String.raw`---
subject: Your report is ready ({{ reportNo }})
preheader: {{ tests.length }} test results from {{ collectedOn | date }} are ready to view.
footer: This report is for the patient named above. Please do not forward it.
---
# Your report is ready

Dear {{ patientName }}, the results of your tests are ready.

::rows
Report no. | {{ reportNo }}
Collected on | {{ collectedOn | date }}
Tests | {{ tests.length }}
::

::each tests as test
- {{ test }}
::

::button href="{{ link }}"
View report
::

::if expiresAt
The link works until {{ expiresAt | datetime }}. After that, ask the lab for a new one.
::

::callout tone="info"
Please discuss your results with your doctor.
::
`,
  sample: {
    patientName: "Kavita Sharma",
    reportNo: "RPT-2026-000123",
    collectedOn: "2026-10-14",
    tests: ["Complete Blood Count", "Lipid Profile", "HbA1c"],
    link: "https://lab.example.com/r/sample",
    expiresAt: "2026-10-21T12:00:00.000Z",
  },
});

export const paymentReceipt = defineMail({
  id: "payment-receipt",
  description: "Receipt for a patient payment, with the invoice lines and what is still due.",
  source: String.raw`---
subject: Receipt for invoice {{ invoiceNo }}
preheader: We received {{ paid | money }}. Thank you.
---
# Thank you for your payment

Dear {{ patientName }}, we received **{{ paid | money }}** on {{ paidAt | datetime }} by {{ mode }}.

::table align="l r" footer
Item | Amount
@each items as item: {{ item.name }} | {{ item.amount | money }}
Total | {{ total | money }}
::

::if due
::callout tone="warning" title="Balance due: {{ due | money }}"
Reports are released after full payment.
::
::else
::callout tone="success" title="Paid in full"
Your reports will be released as soon as they are verified.
::
::

::if link
::button href="{{ link }}" tone="secondary"
Download invoice
::
::
`,
  sample: {
    patientName: "Kavita Sharma",
    invoiceNo: "INV-2026-27-000045",
    paid: 120000,
    paidAt: "2026-10-14T05:20:00.000Z",
    mode: "UPI",
    items: [
      { name: "Complete Blood Count", amount: 39900 },
      { name: "Lipid Profile", amount: 59900 },
      { name: "HbA1c", amount: 44900 },
    ],
    total: 144700,
    due: 24700,
    link: "https://lab.example.com/i/sample",
  },
});

/** Every built-in mail by id. */
export const MAIL_TEMPLATES = {
  "password-reset": passwordReset,
  "password-changed": passwordChanged,
  "staff-invite": staffInvite,
  "report-ready": reportReady,
  "payment-receipt": paymentReceipt,
} satisfies Record<string, AnyMailTemplate>;

export type BuiltinMailId = keyof typeof MAIL_TEMPLATES;
