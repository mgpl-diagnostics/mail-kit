// Turns a parsed mail + data into email-safe HTML (tables, inline styles) and a plain-text part.
// Every value is escaped; links and images only accept safe URLs; nothing in the source is raw HTML.
import { MailError, MissingVariableError } from "./errors";
import { DEFAULT_BRAND, DEFAULT_THEME } from "./theme";
import type { Block, Brand, Expr, Inline, MailDocument, RenderedMail, Repeat, Template, Theme, Tone } from "./types";

export interface RenderOptions {
  brand?: Brand;
  theme?: Theme;
}

const TZ = "Asia/Kolkata";
const fmtMoney = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const fmtNumber = new Intl.NumberFormat("en-IN");
const fmtDate = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const fmtTime = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

// ---- values ------------------------------------------------------------------------------------

type Scope = Record<string, unknown>;

class Ctx {
  constructor(
    private readonly scopes: Scope[],
    readonly missing = new Set<string>(),
    private readonly misses = { n: 0 },
  ) {}

  with(scope: Scope): Ctx {
    return new Ctx([scope, ...this.scopes], this.missing, this.misses);
  }

  /** Counts every missing lookup (unlike `missing`, which lists each path once). */
  get missCount(): number {
    return this.misses.n;
  }

  private miss(path: string[]): void {
    this.missing.add(path.join("."));
    this.misses.n++;
  }

  lookup(path: string[]): unknown {
    const [head, ...rest] = path;
    const scope = this.scopes.find((s) => head! in s);
    let v: unknown = scope?.[head!];
    for (const p of rest) {
      if (v === null || v === undefined || typeof v !== "object") return undefined;
      v = (v as Record<string, unknown>)[p];
    }
    return v;
  }

  /** The string for `{{ expr }}`; records it as missing when there is no value and no default. */
  str(e: Expr): string {
    let v = this.lookup(e.path);
    const def = e.filters.find((f) => f.name === "default");
    if (v === undefined || v === null || v === "") {
      if (def) return def.arg ?? "";
      if (v !== "") {
        this.miss(e.path);
        return "";
      }
    }
    let typed = false;
    for (const f of e.filters) {
      switch (f.name) {
        case "money":
          if (typeof v !== "number" || !Number.isInteger(v)) bad(e, "money takes integer paise");
          v = fmtMoney.format((v as number) / 100);
          typed = true;
          break;
        case "number":
          if (typeof v !== "number" || !Number.isFinite(v)) bad(e, "number takes a number");
          v = fmtNumber.format(v as number);
          typed = true;
          break;
        case "date":
        case "time":
        case "datetime":
          v = formatWhen(v, f.name, e);
          typed = true;
          break;
        case "upper":
          v = text(v, e).toUpperCase();
          break;
        case "lower":
          v = text(v, e).toLowerCase();
          break;
      }
    }
    return typed ? String(v) : text(v, e);
  }

  tpl(t: Template): string {
    return t.map((p) => (typeof p === "string" ? p : this.str(p))).join("");
  }

  truthy(e: Expr): boolean {
    const v = this.lookup(e.path);
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  }

  list(e: Expr): unknown[] {
    const v = this.lookup(e.path);
    if (v === undefined || v === null) {
      this.miss(e.path);
      return [];
    }
    if (!Array.isArray(v)) bad(e, "::each needs a list");
    return v as unknown[];
  }
}

function bad(e: Expr, why: string): never {
  throw new MailError("MAIL_BAD_VALUE", `{{ ${e.path.join(".")} }} at line ${e.pos.line}: ${why}`);
}

function text(v: unknown, e: Expr): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : bad(e, "not a finite number");
  if (typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return formatWhen(v, "datetime", e);
  return bad(e, "objects and lists cannot be printed; pick a field (patient.name) or use ::each");
}

function formatWhen(v: unknown, kind: "date" | "time" | "datetime", e: Expr): string {
  // IST day keys ("2026-10-14") are dates without a time
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (kind !== "date") bad(e, `${kind} needs a time; "${v}" is a day`);
    v = new Date(`${v}T00:00:00+05:30`);
  }
  const d = v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) bad(e, `${kind} takes a Date or an ISO date string`);
  const time = () => fmtTime.format(d).replace(/\s?(am|pm)$/i, (_, x: string) => ` ${x.toLowerCase()}`);
  if (kind === "date") return fmtDate.format(d);
  if (kind === "time") return `${time()} IST`;
  return `${fmtDate.format(d)}, ${time()} IST`;
}

/** Repeats `@each` lines once per item, each with its own scope. */
function expand<R extends { each?: Repeat }>(rows: R[], ctx: Ctx): [R, Ctx][] {
  return rows.flatMap((r): [R, Ctx][] => {
    if (!r.each) return [[r, ctx]];
    const items = ctx.list(r.each.list);
    return items.map((item, k): [R, Ctx] => [r, ctx.with({ [r.each!.as]: item, loop: { index: k + 1, first: k === 0, last: k === items.length - 1 } })]);
  });
}

type Flat = { kind: "block"; block: Block; ctx: Ctx } | { kind: "list"; ordered: boolean; items: [Inline[], Ctx][] };

/**
 * Resolves ::if / ::each into the blocks they produce, and joins neighbouring lists, so
 * "::each roles as role / - {{ role.name }} / ::" renders as one list, not one list per item.
 */
function flatten(blocks: Block[], ctx: Ctx, out: Flat[] = []): Flat[] {
  for (const b of blocks) {
    if (b.kind === "if") flatten(ctx.truthy(b.test) !== b.negate ? b.then : b.else, ctx, out);
    else if (b.kind === "each") {
      const items = ctx.list(b.list);
      items.forEach((item, k) => flatten(b.children, ctx.with({ [b.as]: item, loop: { index: k + 1, first: k === 0, last: k === items.length - 1 } }), out));
    } else if (b.kind === "list") {
      const prev = out[out.length - 1];
      const items = b.items.map((i): [Inline[], Ctx] => [i, ctx]);
      if (prev?.kind === "list" && prev.ordered === b.ordered) prev.items.push(...items);
      else out.push({ kind: "list", ordered: b.ordered, items });
    } else out.push({ kind: "block", block: b, ctx });
  }
  return out;
}

// ---- safety ------------------------------------------------------------------------------------

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Evaluates a URL template; skips the safety check when a variable in it is missing (reported later). */
function urlOf(ctx: Ctx, t: Template, kind: "link" | "image", line: number): string {
  const before = ctx.missCount;
  const u = ctx.tpl(t);
  return ctx.missCount > before ? "" : safeUrl(u, kind, line);
}

/** Links may be http(s), mailto or tel. Images must be https. Anything else is refused. */
export function safeUrl(url: string, kind: "link" | "image", line: number): string {
  const u = url.trim();
  const ok = kind === "image" ? /^https:\/\/[^\s]+$/i.test(u) : /^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d][\d\s-]*)$/i.test(u);
  // eslint-disable-next-line no-control-regex
  if (!ok || /[\u0000-\u001f\u007f]/.test(u)) {
    throw new MailError("MAIL_UNSAFE_URL", `line ${line}: ${kind === "image" ? "image src must be an https URL" : "links must be http(s), mailto or tel"} (got "${u.slice(0, 60)}")`);
  }
  return u;
}

// ---- HTML --------------------------------------------------------------------------------------

class Html {
  constructor(
    private readonly t: Theme,
    private readonly ctx: Ctx,
  ) {}
  private get c() {
    return this.t.colors;
  }

  inline(nodes: Inline[], ctx = this.ctx): string {
    return nodes
      .map((n) => {
        switch (n.kind) {
          case "text":
            return escapeHtml(n.value);
          case "var":
            return escapeHtml(ctx.str(n.expr));
          case "strong":
            return `<strong style="font-weight:700;">${this.inline(n.children, ctx)}</strong>`;
          case "em":
            return `<em style="font-style:italic;">${this.inline(n.children, ctx)}</em>`;
          case "code":
            return `<code style="font-family:${this.t.monoFont};font-size:90%;background-color:${this.c.subtle};padding:1px 4px;border-radius:4px;">${escapeHtml(n.value)}</code>`;
          case "link":
            return `<a href="${escapeHtml(urlOf(ctx, n.href, "link", n.pos.line))}" target="_blank" style="color:${this.c.accent};text-decoration:underline;">${this.inline(n.children, ctx)}</a>`;
          case "br":
            return "<br>";
        }
      })
      .join("");
  }

  blocks(blocks: Block[], ctx = this.ctx): string {
    const { t, c } = this;
    return flatten(blocks, ctx)
      .map((f) => {
        if (f.kind === "block") return this.block(f.block, f.ctx);
        const tag = f.ordered ? "ol" : "ul";
        return `<${tag} style="margin:0 0 16px;padding:0 0 0 22px;font-family:${t.font};font-size:${t.fontSize}px;line-height:1.6;color:${c.ink};">${f.items.map(([i, x]) => `<li style="margin:0 0 6px;">${this.inline(i, x)}</li>`).join("")}</${tag}>`;
      })
      .join("\n");
  }

  private tone(t: Tone): [string, string] {
    return [this.c[t], this.c[`${t}Bg`]];
  }

  private block(b: Block, ctx: Ctx): string {
    const { c, t } = this;
    const fs = t.fontSize;
    const box = (inner: string, gap = 16) =>
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${gap}px;"><tr><td>${inner}</td></tr></table>`;
    switch (b.kind) {
      case "heading": {
        const size = [0, Math.round(fs * 1.6), Math.round(fs * 1.27), fs + 1][b.level];
        return `<h${b.level} style="margin:0 0 ${b.level === 1 ? 14 : 10}px;font-family:${t.font};font-size:${size}px;line-height:1.3;font-weight:700;color:${c.brand};">${this.inline(b.content, ctx)}</h${b.level}>`;
      }
      case "paragraph":
        return `<p style="margin:0 0 16px;font-family:${t.font};font-size:${fs}px;line-height:1.6;color:${c.ink};">${this.inline(b.content, ctx)}</p>`;
      case "button": {
        const href = escapeHtml(urlOf(ctx, b.href, "link", b.pos.line));
        const primary = b.tone === "primary";
        const bg = primary ? c.accent : c.surface;
        const fg = primary ? c.accentText : c.brand;
        const border = primary ? c.accent : c.brand;
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;"><tr><td align="center" bgcolor="${bg}" style="border-radius:${t.radius}px;background-color:${bg};"><a href="${href}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${t.font};font-size:${fs + 1}px;line-height:1.2;font-weight:700;color:${fg};text-decoration:none;border:2px solid ${border};border-radius:${t.radius}px;background-color:${bg};">${this.inline(b.label, ctx)}</a></td></tr></table>`;
      }
      case "callout": {
        const [fg, bg] = this.tone(b.tone);
        const title = b.title ? `<p style="margin:0 0 6px;font-family:${t.font};font-size:${fs}px;line-height:1.4;font-weight:700;color:${fg};">${escapeHtml(ctx.tpl(b.title))}</p>` : "";
        return box(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:${bg};border-left:4px solid ${fg};border-radius:${t.radius}px;padding:14px 16px 0;">${title}${this.blocks(b.children, ctx)}</td></tr></table>`);
      }
      case "card":
        return box(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:${c.subtle};border:1px solid ${c.line};border-radius:${t.radius}px;padding:20px 20px 4px;">${this.blocks(b.children, ctx)}</td></tr></table>`);
      case "rows":
        return box(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${t.font};font-size:${fs}px;line-height:1.4;">${expand(b.rows, ctx)
            .map(
              ([r, x], k) =>
                `<tr><td style="padding:9px 12px 9px 0;color:${c.muted};vertical-align:top;${k ? `border-top:1px solid ${c.line};` : ""}">${this.inline(r.label, x)}</td><td align="right" style="padding:9px 0;color:${c.ink};font-weight:600;text-align:right;vertical-align:top;${k ? `border-top:1px solid ${c.line};` : ""}">${this.inline(r.value, x)}</td></tr>`,
            )
            .join("")}</table>`,
          20,
        );
      case "table": {
        const cell = (tag: "th" | "td", cells: Inline[][], style: string, x = ctx) =>
          cells.map((v, k) => `<${tag} align="${b.align[k]}" style="padding:8px ${k === cells.length - 1 ? 0 : 10}px 8px 0;text-align:${b.align[k]};vertical-align:top;${style}">${this.inline(v, x)}</${tag}>`).join("");
        const head = `<tr>${cell("th", b.head, `font-size:${fs - 3}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${c.muted};border-bottom:2px solid ${c.brand};`)}</tr>`;
        const body = expand(b.body, ctx).map(([r, x], k) => `<tr>${cell("td", r.cells, `color:${c.ink};${k ? `border-top:1px solid ${c.line};` : ""}`, x)}</tr>`).join("");
        const foot = b.foot ? `<tr>${cell("td", b.foot, `color:${c.brand};font-weight:700;border-top:2px solid ${c.line};`)}</tr>` : "";
        return box(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${t.font};font-size:${fs}px;line-height:1.4;">${head}${body}${foot}</table>`, 20);
      }
      case "code":
        return box(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="background-color:${c.subtle};border:1px dashed ${c.line};border-radius:${t.radius}px;padding:16px;font-family:${t.monoFont};font-size:${fs + 7}px;line-height:1.4;letter-spacing:3px;font-weight:700;color:${c.brand};text-align:center;">${b.lines.map((l) => escapeHtml(ctx.tpl(l))).join("<br>")}</td></tr></table>`,
          20,
        );
      case "divider":
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="border-top:1px solid ${c.line};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
      case "spacer":
        return `<div style="height:${b.size}px;line-height:${b.size}px;font-size:1px;">&nbsp;</div>`;
      case "image": {
        const src = escapeHtml(urlOf(ctx, b.src, "image", b.pos.line));
        return box(`<img src="${src}" alt="${escapeHtml(ctx.tpl(b.alt))}" width="${b.width}" style="display:block;width:100%;max-width:${b.width}px;height:auto;border:0;border-radius:${t.radius}px;">`);
      }
      case "list":
      case "if":
      case "each":
        return ""; // resolved by flatten()
    }
  }
}

// ---- plain text --------------------------------------------------------------------------------

const WIDTH = 76;

function wrap(s: string, width = WIDTH, indent = ""): string {
  return s
    .split("\n")
    .map((para) => {
      const words = para.split(/ +/).filter(Boolean);
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        if (cur && (indent + cur + " " + w).length > width) {
          lines.push(cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      lines.push(cur);
      return lines.map((l) => indent + l).join("\n");
    })
    .join("\n");
}

class Text {
  constructor(private readonly ctx: Ctx) {}

  inline(nodes: Inline[], ctx = this.ctx): string {
    return nodes
      .map((n) => {
        switch (n.kind) {
          case "text":
          case "code":
            return n.value;
          case "var":
            return ctx.str(n.expr);
          case "strong":
          case "em":
            return this.inline(n.children, ctx);
          case "link": {
            const href = urlOf(ctx, n.href, "link", n.pos.line);
            const label = this.inline(n.children, ctx);
            const bare = href.replace(/^mailto:|^tel:/i, "");
            return label === href || label === bare ? label : `${label} (${bare})`;
          }
          case "br":
            return "\n";
        }
      })
      .join("");
  }

  blocks(blocks: Block[], ctx = this.ctx): string[] {
    return flatten(blocks, ctx)
      .flatMap((f) => {
        if (f.kind === "block") return this.block(f.block, f.ctx);
        return [
          f.items
            .map(([i, x], k) => {
              const mark = f.ordered ? `${k + 1}. ` : "- ";
              return mark + wrap(this.inline(i, x), WIDTH, " ".repeat(mark.length)).trimStart();
            })
            .join("\n"),
        ];
      })
      .filter((s) => s !== "");
  }

  private block(b: Block, ctx: Ctx): string[] {
    const pad = (s: string, n: number, right: boolean) => (right ? s.padStart(n) : s.padEnd(n));
    switch (b.kind) {
      case "heading": {
        const s = this.inline(b.content, ctx);
        if (b.level === 3) return [s];
        return [`${s}\n${(b.level === 1 ? "=" : "-").repeat(Math.min(s.length, WIDTH))}`];
      }
      case "paragraph":
        return [wrap(this.inline(b.content, ctx))];
      case "button":
        return [`${this.inline(b.label, ctx)}:\n${urlOf(ctx, b.href, "link", b.pos.line)}`];
      case "callout": {
        const inner = [...(b.title ? [ctx.tpl(b.title)] : []), ...this.blocks(b.children, ctx)].join("\n\n");
        return [inner.split("\n").map((l) => `| ${l}`.trimEnd()).join("\n")];
      }
      case "card":
        return this.blocks(b.children, ctx);
      case "rows": {
        const rows = expand(b.rows, ctx).map(([r, x]) => [this.inline(r.label, x), this.inline(r.value, x)] as const);
        const w = Math.min(28, Math.max(...rows.map((r) => r[0].length)));
        return [rows.map(([l, v]) => `${(l + ":").padEnd(w + 1)} ${v}`).join("\n")];
      }
      case "table": {
        const all = [
          b.head.map((v) => this.inline(v, ctx)),
          ...expand(b.body, ctx).map(([r, x]) => r.cells.map((v) => this.inline(v, x))),
          ...(b.foot ? [b.foot.map((v) => this.inline(v, ctx))] : []),
        ];
        const widths = b.head.map((_, k) => Math.max(...all.map((r) => r[k]!.length)));
        const line = (r: string[]) => r.map((x, k) => pad(x, widths[k]!, b.align[k] === "right")).join("  ").trimEnd();
        const rule = widths.map((w) => "-".repeat(w)).join("  ");
        const out = [line(all[0]!), rule, ...all.slice(1, b.foot ? -1 : undefined).map(line)];
        if (b.foot) out.push(rule, line(all[all.length - 1]!));
        return [out.join("\n")];
      }
      case "code":
        return [b.lines.map((l) => `    ${ctx.tpl(l)}`.trimEnd()).join("\n")];
      case "divider":
        return ["-".repeat(40)];
      case "spacer":
        return [];
      case "image": {
        urlOf(ctx, b.src, "image", b.pos.line);
        const alt = ctx.tpl(b.alt);
        return alt ? [`[${alt}]`] : [];
      }
      case "list":
      case "if":
      case "each":
        return []; // resolved by flatten()
    }
  }
}

// ---- document ----------------------------------------------------------------------------------

function firstText(blocks: Block[], ctx: Ctx, t: Text): string {
  for (const b of blocks) {
    if (b.kind === "paragraph") return t.inline(b.content, ctx).replace(/\s+/g, " ").trim();
  }
  return "";
}

function brandFooter(brand: Brand): string[] {
  const contact = [brand.phone, brand.email, brand.website].filter(Boolean) as string[];
  return [brand.name, ...(brand.addressLines ?? []), ...(contact.length ? [contact.join("  |  ")] : [])];
}

/**
 * Renders a parsed mail with `data`. Throws MissingVariableError (every missing path at once)
 * when the data lacks a value the mail prints, and MailError MAIL_UNSAFE_URL for unsafe links.
 */
export function renderMail(doc: MailDocument, data: Record<string, unknown>, opts: RenderOptions = {}): RenderedMail {
  const theme = opts.theme ?? DEFAULT_THEME;
  const brand = opts.brand ?? DEFAULT_BRAND;
  const ctx = new Ctx([data]);
  const html = new Html(theme, ctx);
  const text = new Text(ctx);

  const subject = ctx.tpl(doc.subject).replace(/\s+/g, " ").trim();
  const bodyHtml = html.blocks(doc.body);
  const bodyText = text.blocks(doc.body);
  const footerNote = doc.footer ? ctx.tpl(doc.footer) : "";
  const preheader = (doc.preheader ? ctx.tpl(doc.preheader) : firstText(doc.body, ctx, text)).replace(/\s+/g, " ").trim().slice(0, 140);
  if (ctx.missing.size) throw new MissingVariableError([...ctx.missing]);

  const c = theme.colors;
  const lines = brandFooter(brand);
  const contactLinks = (s: string) => escapeHtml(s);
  const footerHtml = [
    footerNote ? `<p style="margin:0 0 10px;">${escapeHtml(footerNote)}</p>` : "",
    `<p style="margin:0;"><strong style="color:${c.brand};">${escapeHtml(lines[0]!)}</strong>${lines.slice(1).map((l) => `<br>${contactLinks(l)}`).join("")}</p>`,
  ].join("");
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(safeUrl(brand.logoUrl, "image", 0))}" alt="${escapeHtml(brand.name)}" height="36" style="display:block;height:36px;width:auto;border:0;">`
    : `<span style="font-family:${theme.font};font-size:18px;line-height:1.2;font-weight:700;color:${c.brandText};letter-spacing:.02em;">${escapeHtml(brand.name)}</span>`;
  // Invisible spacers after the preheader keep mail apps from pulling body text into the preview.
  const filler = "&#847;&zwnj;&nbsp;".repeat(60);
  const w = theme.width;
  const r = theme.radius;

  const out = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
@media (max-width:${w + 20}px){.mk-wrap{width:100%!important;}.mk-pad{padding-left:20px!important;padding-right:20px!important;}}
</style>
</head>
<body style="margin:0;padding:0;background-color:${c.canvas};">
${preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;opacity:0;color:${c.canvas};">${escapeHtml(preheader)}${filler}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${c.canvas};"><tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="${w}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="mk-wrap" width="${w}" cellpadding="0" cellspacing="0" border="0" style="width:${w}px;max-width:${w}px;">
<tr><td class="mk-pad" bgcolor="${c.brand}" style="background-color:${c.brand};padding:20px 32px;border-radius:${r}px ${r}px 0 0;">${logo}</td></tr>
<tr><td style="background-color:${c.accent};height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td class="mk-pad" bgcolor="${c.surface}" style="background-color:${c.surface};padding:32px 32px 16px;border-radius:0 0 ${r}px ${r}px;font-family:${theme.font};font-size:${theme.fontSize}px;line-height:1.6;color:${c.ink};">
${bodyHtml}
</td></tr>
<tr><td class="mk-pad" align="center" style="padding:20px 32px 8px;font-family:${theme.font};font-size:12px;line-height:1.6;color:${c.muted};text-align:center;">${footerHtml}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>
`;
  const textOut = [...bodyText, ["--", ...(footerNote ? [wrap(footerNote), ""] : []), ...lines].join("\n")].join("\n\n") + "\n";
  return { subject, preheader, html: out, text: textOut };
}

/** Every variable path a mail reads (`name`, `patient.name`; loop variables excluded). */
export function mailVariables(doc: MailDocument): string[] {
  const found = new Set<string>();
  const visitExpr = (e: Expr, locals: Set<string>) => {
    if (!locals.has(e.path[0]!)) found.add(e.path.join("."));
  };
  const visitTpl = (t: Template | null | undefined, locals: Set<string>) => t?.forEach((p) => typeof p !== "string" && visitExpr(p, locals));
  const visitInline = (ns: Inline[], locals: Set<string>): void =>
    ns.forEach((n) => {
      if (n.kind === "var") visitExpr(n.expr, locals);
      else if (n.kind === "strong" || n.kind === "em") visitInline(n.children, locals);
      else if (n.kind === "link") {
        visitTpl(n.href, locals);
        visitInline(n.children, locals);
      }
    });
  const visit = (bs: Block[], locals: Set<string>): void =>
    bs.forEach((b) => {
      switch (b.kind) {
        case "heading":
        case "paragraph":
          return visitInline(b.content, locals);
        case "list":
          return b.items.forEach((i) => visitInline(i, locals));
        case "button":
          visitTpl(b.href, locals);
          return visitInline(b.label, locals);
        case "callout":
          visitTpl(b.title, locals);
          return visit(b.children, locals);
        case "card":
          return visit(b.children, locals);
        case "rows":
          return b.rows.forEach((r) => {
            const l = r.each ? (visitExpr(r.each.list, locals), new Set([...locals, r.each.as, "loop"])) : locals;
            visitInline(r.label, l);
            visitInline(r.value, l);
          });
        case "table":
          b.head.forEach((x) => visitInline(x, locals));
          b.foot?.forEach((x) => visitInline(x, locals));
          return b.body.forEach((r) => {
            const l = r.each ? (visitExpr(r.each.list, locals), new Set([...locals, r.each.as, "loop"])) : locals;
            r.cells.forEach((x) => visitInline(x, l));
          });
        case "code":
          return b.lines.forEach((l) => visitTpl(l, locals));
        case "image":
          visitTpl(b.src, locals);
          return visitTpl(b.alt, locals);
        case "if":
          visitExpr(b.test, locals);
          visit(b.then, locals);
          return visit(b.else, locals);
        case "each":
          visitExpr(b.list, locals);
          return visit(b.children, new Set([...locals, b.as, "loop"]));
      }
    });
  visitTpl(doc.subject, new Set());
  visitTpl(doc.preheader, new Set());
  visitTpl(doc.footer, new Set());
  visit(doc.body, new Set());
  return [...found].sort();
}
