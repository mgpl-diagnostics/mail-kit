# The MGPL mail design language

Mails are written in `.mail` sources, not HTML. mail-kit checks them, then compiles each one to
**email-safe HTML** (tables and inline styles, which every mail app understands) and a **plain-text
part**. The design (colours, spacing, header, footer, buttons) comes from the theme, so every mail
looks the same and nobody hand-writes HTML. The source cannot contain HTML: `<b>` prints as text.

```text
---
subject: Reset your password
preheader: This link works until {{ expiresAt | time }}.
---
# Reset your password

Hi {{ name }}, we received a request to reset the password of your MGPL account.

::button href="{{ link }}"
Choose a new password
::

::callout tone="warning" title="Didn't ask for this?"
Ignore this mail. Your password stays the same.
::
```

## Front matter

Between two `---` lines at the top. `subject` is required.

| Key | Meaning |
| --- | --- |
| `subject` | Subject line. Variables allowed. |
| `preheader` | Preview text shown next to the subject in the inbox. Default: the first paragraph. |
| `footer` | A note printed above the brand footer (e.g. "Please do not forward this report"). |

## Text

| Write | Result |
| --- | --- |
| `# Title`, `## Section`, `### Small` | Headings (brand colour) |
| Lines separated by a blank line | Paragraphs. A line ending in `\` keeps a line break. |
| `- item` or `* item`; `1. item` | Lists. Indented lines continue the item. |
| `**bold**`, `*italic*`, `_italic_`, `` `code` `` | Inline styles |
| `[label](https://…)` | Link (http, https, mailto or tel only) |
| `{{ name }}`, `{{ patient.name }}` | A value from the data, always escaped |
| `\*`, `\[`, `\|` | The character itself |
| `// note` | A comment line (not printed) |

## Blocks

A block starts with `::name attr="value"` and ends with a line holding only `::`. Blocks marked
"single line" have no body and no closing `::`.

| Block | Attributes | Body |
| --- | --- | --- |
| `::button` | `href` (required), `tone="primary"\|"secondary"` | One line: the label |
| `::callout` | `tone="info"\|"success"\|"warning"\|"danger"`, `title` | Any blocks |
| `::card` | — | Any blocks, on a tinted panel |
| `::rows` | — | `Label \| value` per line: a summary list |
| `::table` | `align="l r c…"` (one per column), `footer` (last line is a total row) | First line is the header; cells split by `\|` |
| `::code` | — | Lines shown large and monospaced (OTPs, codes) |
| `::divider` | — | single line |
| `::spacer` | `size` (4–96 px, default 24) | single line |
| `::image` | `src` (https), `alt` (required), `width` (16–600) | single line |

### Repeating rows

In `::table` and `::rows`, a line starting with `@each list as item:` is repeated for each item:

```text
::table align="l r" footer
Item | Amount
@each items as item: {{ item.name }} | {{ item.amount | money }}
Total | {{ total | money }}
::
```

## Conditions and loops

```text
::if due
::callout tone="warning" title="Balance due: {{ due | money }}"
Reports are released after full payment.
::
::else
Paid in full.
::

::if !items
Nothing to show.
::

::each roles as role
- **{{ role.name }}** ({{ loop.index }} of many)
::
```

`::if` is true for a non-empty value or list, `!` negates. Inside `::each`, `loop.index` (from 1),
`loop.first` and `loop.last` are available. Lists produced by `::each` join into one list.

## Filters

`{{ value | filter }}`, chained left to right.

| Filter | Input | Output |
| --- | --- | --- |
| `money` | integer paise | `₹1,23,456.50` (Indian grouping) |
| `number` | number | `12,34,567` |
| `date` | Date, ISO string or IST day `"2026-10-14"` | `14 Oct 2026` |
| `time` | Date or ISO string | `9:30 pm IST` |
| `datetime` | Date or ISO string | `14 Oct 2026, 9:30 pm IST` |
| `upper`, `lower` | text | case changed |
| `default: "text"` | anything | used when the value is missing or empty |

All dates are shown in IST. Queued mails cross JSON, so Dates arrive as ISO strings; the filters
accept both.

## Errors

- **Syntax** (`MailSyntaxError`, code `MAIL_SYNTAX`): every problem in the source with
  `file:line:col`. `defineMail` parses at startup, so a broken template fails the build and tests,
  never a send. `checkMail(source)` returns the same list without throwing (editors, CI).
- **Missing data** (`MissingVariableError`, `MAIL_MISSING_VARIABLE`): all missing paths at once.
  Values inside a false `::if` are not needed.
- **Unsafe URL** (`MAIL_UNSAFE_URL`): links and buttons take http(s), mailto and tel; images take https.
- **Bad value** (`MAIL_BAD_VALUE`): e.g. `money` on a non-integer, or printing an object.

## Design tokens

`DEFAULT_THEME` is "Saffron & Neel" (the website palette): navy header and headings, saffron
buttons and accent rule, sandstone canvas. `createTheme({ colors: { accent: "#…" } })` changes
tokens. The brand (name, logo URL, address lines, phone, email, website) is passed by the caller;
the api passes the lab profile from report-kit, the only place the lab's contact details live.
