// Parser for the MGPL mail design language (`.mail` files). See docs/language.md for the syntax.
// It collects every problem with its line and column and throws one MailSyntaxError at the end.
import { at, MailSyntaxError, type Diagnostic } from "./errors";
import type { Align, Block, Expr, Inline, MailDocument, Pos, Repeat, Template, Tone } from "./types";

export const FILTERS = ["money", "number", "date", "time", "datetime", "upper", "lower", "default"] as const;
export type FilterName = (typeof FILTERS)[number];

const TONES: Tone[] = ["info", "success", "warning", "danger"];
const FRONT_KEYS = ["subject", "preheader", "footer"] as const;

/** Directives and the attributes each one accepts (`*` = required). */
const DIRECTIVES: Record<string, { attrs: string[]; body: "none" | "blocks" | "lines" }> = {
  button: { attrs: ["href*", "tone"], body: "lines" },
  callout: { attrs: ["tone", "title"], body: "blocks" },
  card: { attrs: [], body: "blocks" },
  rows: { attrs: [], body: "lines" },
  table: { attrs: ["align", "footer"], body: "lines" },
  code: { attrs: [], body: "lines" },
  divider: { attrs: [], body: "none" },
  spacer: { attrs: ["size"], body: "none" },
  image: { attrs: ["src*", "alt*", "width"], body: "none" },
  if: { attrs: [], body: "blocks" },
  each: { attrs: [], body: "blocks" },
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Parser {
  readonly diags: Diagnostic[] = [];
  private i = 0;
  constructor(private readonly lines: string[], private readonly firstLine: number) {}

  error(pos: Pos, message: string): void {
    this.diags.push(at(pos, message));
  }

  private pos(i: number, col = 1): Pos {
    return { line: this.firstLine + i, col };
  }

  // ---- expressions and templates -------------------------------------------------------------

  /** Parses the inside of `{{ … }}`. */
  expr(src: string, pos: Pos): Expr {
    const parts = splitPipes(src);
    const head = (parts.shift() ?? "").trim();
    const path = head.split(".");
    const out: Expr = { path, filters: [], pos };
    if (!head || !path.every((p) => IDENT.test(p) || /^\d+$/.test(p))) {
      this.error(pos, `Bad variable "${head}": use names like name or patient.name`);
    }
    for (const raw of parts) {
      const m = /^\s*([a-z]+)\s*(?::\s*(.*?))?\s*$/.exec(raw);
      if (!m || !(FILTERS as readonly string[]).includes(m[1]!)) {
        this.error(pos, `Unknown filter "${raw.trim()}" (filters: ${FILTERS.join(", ")})`);
        continue;
      }
      let arg = m[2];
      if (arg !== undefined) {
        const q = /^"(.*)"$|^'(.*)'$/.exec(arg);
        if (q) arg = q[1] ?? q[2];
      }
      if (m[1] === "default" && arg === undefined) this.error(pos, `"default" needs a value: {{ x | default: "…" }}`);
      out.filters.push(arg === undefined ? { name: m[1]! } : { name: m[1]!, arg });
    }
    return out;
  }

  /** Text with `{{ }}` holes (attribute values, front matter, code lines). */
  template(src: string, pos: Pos): Template {
    const out: Template = [];
    let rest = src;
    let col = pos.col;
    for (;;) {
      const open = rest.indexOf("{{");
      if (open < 0) break;
      const close = rest.indexOf("}}", open + 2);
      if (close < 0) {
        this.error({ line: pos.line, col: col + open }, `"{{" is not closed`);
        break;
      }
      if (open > 0) out.push(rest.slice(0, open));
      out.push(this.expr(rest.slice(open + 2, close), { line: pos.line, col: col + open }));
      col += close + 2;
      rest = rest.slice(close + 2);
    }
    if (rest) out.push(rest);
    return out;
  }

  /** Inline markup: **strong**, *em* / _em_, `code`, [label](url), {{ var }}, \ escapes. */
  inline(src: string, pos: Pos): Inline[] {
    const out: Inline[] = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ kind: "text", value: buf });
      buf = "";
    };
    let k = 0;
    const p = (off: number): Pos => ({ line: pos.line, col: pos.col + off });
    while (k < src.length) {
      const c = src[k]!;
      const rest = src.slice(k);
      if (c === "\\" && k + 1 < src.length) {
        buf += src[k + 1];
        k += 2;
        continue;
      }
      if (rest.startsWith("{{")) {
        const close = src.indexOf("}}", k + 2);
        if (close < 0) {
          this.error(p(k), `"{{" is not closed`);
          buf += rest;
          break;
        }
        flush();
        out.push({ kind: "var", expr: this.expr(src.slice(k + 2, close), p(k)) });
        k = close + 2;
        continue;
      }
      if (rest.startsWith("**")) {
        const close = src.indexOf("**", k + 2);
        if (close > k + 2) {
          flush();
          out.push({ kind: "strong", children: this.inline(src.slice(k + 2, close), p(k + 2)) });
          k = close + 2;
          continue;
        }
      }
      if ((c === "*" || c === "_") && /\S/.test(src[k + 1] ?? "") && !/[A-Za-z0-9]/.test(src[k - 1] ?? "")) {
        let close = src.indexOf(c, k + 1);
        while (close > 0 && c === "_" && /[A-Za-z0-9]/.test(src[close + 1] ?? "")) close = src.indexOf(c, close + 1);
        if (close > k + 1) {
          flush();
          out.push({ kind: "em", children: this.inline(src.slice(k + 1, close), p(k + 1)) });
          k = close + 1;
          continue;
        }
      }
      if (c === "`") {
        const close = src.indexOf("`", k + 1);
        if (close > k) {
          flush();
          out.push({ kind: "code", value: src.slice(k + 1, close) });
          k = close + 1;
          continue;
        }
      }
      if (c === "[") {
        const mid = findLinkMid(src, k);
        if (mid > 0) {
          const end = src.indexOf(")", mid + 2);
          if (end > 0) {
            flush();
            out.push({
              kind: "link",
              children: this.inline(src.slice(k + 1, mid), p(k + 1)),
              href: this.template(src.slice(mid + 2, end).trim(), p(mid + 2)),
              pos: p(k),
            });
            k = end + 1;
            continue;
          }
        }
      }
      buf += c;
      k++;
    }
    flush();
    return out;
  }

  // ---- blocks ---------------------------------------------------------------------------------

  /** Parses blocks until a closing `::` (when `closable`), `::else` (when `elseable`) or the end. */
  blocks(opener?: { name: string; pos: Pos; elseable?: boolean }): { blocks: Block[]; end: "close" | "else" | "eof" } {
    const out: Block[] = [];
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]!;
      const line = raw.trim();
      const indent = raw.length - raw.trimStart().length;
      const pos = this.pos(this.i, indent + 1);
      if (!line || line.startsWith("//")) {
        this.i++;
        continue;
      }
      if (line === "::") {
        this.i++;
        if (opener) return { blocks: out, end: "close" };
        this.error(pos, `"::" closes nothing`);
        continue;
      }
      if (line === "::else") {
        this.i++;
        if (opener?.elseable) return { blocks: out, end: "else" };
        this.error(pos, `"::else" is only allowed inside "::if"`);
        continue;
      }
      if (line.startsWith("::")) {
        const b = this.directive(line, pos);
        if (b) out.push(b);
        continue;
      }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        this.i++;
        out.push({ kind: "heading", level: h[1]!.length as 1 | 2 | 3, content: this.inline(h[2]!, { line: pos.line, col: pos.col + h[1]!.length + 1 }), pos });
        continue;
      }
      if (LIST.test(line)) {
        out.push(this.list(pos));
        continue;
      }
      out.push({ kind: "paragraph", content: this.paragraph(), pos });
    }
    if (opener) this.error(opener.pos, `"::${opener.name}" is not closed (add a line with "::")`);
    return { blocks: out, end: "eof" };
  }

  private paragraph(): Inline[] {
    const out: Inline[] = [];
    let first = true;
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]!;
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("::") || /^#{1,3}\s/.test(line) || LIST.test(line)) break;
      const indent = raw.length - raw.trimStart().length;
      const hard = /(^|[^\\])\\$/.test(line);
      const text = hard ? line.slice(0, -1).trimEnd() : line;
      if (!first) out.push({ kind: "text", value: " " });
      out.push(...this.inline(text, this.pos(this.i, indent + 1)));
      if (hard) out.push({ kind: "br" });
      first = false;
      this.i++;
    }
    while (out.length && out[out.length - 1]!.kind === "br") out.pop();
    return out;
  }

  private list(pos: Pos): Block {
    const ordered = /^\d+\.\s/.test(this.lines[this.i]!.trim());
    const items: Inline[][] = [];
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]!;
      const line = raw.trim();
      const m = LIST.exec(line);
      const indent = raw.length - raw.trimStart().length;
      if (m) {
        if (/^\d/.test(m[1]!) !== ordered) break;
        items.push(this.inline(m[2]!, this.pos(this.i, indent + m[1]!.length + 2)));
      } else if (line && items.length && !line.startsWith("::") && !line.startsWith("//") && !/^#{1,3}\s/.test(line) && indent > 0) {
        // indented continuation of the previous item
        items[items.length - 1]!.push({ kind: "text", value: " " }, ...this.inline(line, this.pos(this.i, indent + 1)));
      } else break;
      this.i++;
    }
    return { kind: "list", ordered, items, pos };
  }

  /** Raw lines up to the closing `::` (for button, rows, table, code). */
  private rawLines(name: string, pos: Pos): { text: string; pos: Pos }[] {
    const out: { text: string; pos: Pos }[] = [];
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i]!;
      if (raw.trim() === "::") {
        this.i++;
        return out;
      }
      if (raw.trim().startsWith("::")) {
        this.error(this.pos(this.i), `"::${name}" holds plain lines only; close it with "::" first`);
      }
      const indent = raw.length - raw.trimStart().length;
      out.push({ text: raw.trimEnd().slice(indent), pos: this.pos(this.i, indent + 1) });
      this.i++;
    }
    this.error(pos, `"::${name}" is not closed (add a line with "::")`);
    return out;
  }

  private directive(line: string, pos: Pos): Block | null {
    this.i++;
    const m = /^::([a-z]+)\s*(.*)$/.exec(line);
    const name = m?.[1] ?? "";
    const spec = DIRECTIVES[name];
    if (!m || !spec) {
      this.error(pos, `Unknown block "${line.split(/\s/)[0]}" (blocks: ${Object.keys(DIRECTIVES).map((d) => "::" + d).join(", ")})`);
      // skip its body when a closing "::" comes before the next block, so one typo is one error
      let k = this.i;
      while (k < this.lines.length && !this.lines[k]!.trim().startsWith("::")) k++;
      if (this.lines[k]?.trim() === "::") this.i = k + 1;
      return null;
    }
    const restCol = pos.col + line.length - m[2]!.length;
    if (name === "if" || name === "each") return this.control(name, m[2]!, { line: pos.line, col: restCol }, pos);

    const attrs = this.attrs(m[2]!, { line: pos.line, col: restCol });
    const allowed = spec.attrs.map((a) => a.replace("*", ""));
    for (const key of Object.keys(attrs)) {
      if (!allowed.includes(key)) this.error(pos, `"::${name}" has no attribute "${key}"${allowed.length ? ` (allowed: ${allowed.join(", ")})` : ""}`);
    }
    for (const a of spec.attrs) {
      if (a.endsWith("*") && attrs[a.slice(0, -1)] === undefined) this.error(pos, `"::${name}" needs ${a.slice(0, -1)}="…"`);
    }
    const tpl = (key: string): Template => (attrs[key] ? this.template(attrs[key]!.value, attrs[key]!.pos) : []);
    const plain = (key: string): string | undefined => attrs[key]?.value;
    const num = (key: string, def: number, min: number, max: number): number => {
      const v = plain(key);
      if (v === undefined) return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        this.error(attrs[key]!.pos, `${key} must be a whole number from ${min} to ${max}`);
        return def;
      }
      return n;
    };

    switch (name) {
      case "divider":
        return { kind: "divider", pos };
      case "spacer":
        return { kind: "spacer", size: num("size", 24, 4, 96), pos };
      case "image":
        return { kind: "image", src: tpl("src"), alt: tpl("alt"), width: num("width", 536, 16, 600), pos };
      case "callout": {
        const tone = (plain("tone") ?? "info") as Tone;
        if (!TONES.includes(tone)) this.error(pos, `tone must be one of ${TONES.join(", ")}`);
        const { blocks } = this.blocks({ name, pos });
        return attrs.title ? { kind: "callout", tone, title: tpl("title"), children: blocks, pos } : { kind: "callout", tone, children: blocks, pos };
      }
      case "card":
        return { kind: "card", children: this.blocks({ name, pos }).blocks, pos };
      case "button": {
        const tone = plain("tone") ?? "primary";
        if (tone !== "primary" && tone !== "secondary") this.error(pos, `button tone must be primary or secondary`);
        const lines = this.rawLines(name, pos).filter((l) => l.text.trim());
        if (lines.length !== 1) this.error(pos, `"::button" holds exactly one line: its label`);
        const l = lines[0];
        return { kind: "button", href: tpl("href"), tone: tone as "primary" | "secondary", label: l ? this.inline(l.text.trim(), l.pos) : [], pos };
      }
      case "code":
        return { kind: "code", lines: trimBlank(this.rawLines(name, pos)).map((l) => this.template(l.text, l.pos)), pos };
      case "rows": {
        const rows = this.rawLines(name, pos)
          .filter((l) => l.text.trim() && !l.text.trim().startsWith("//"))
          .map((raw) => {
            const { each, line: l } = this.repeat(raw);
            const cells = splitCells(l.text);
            if (cells.length !== 2) this.error(l.pos, `a row is "Label | value"`);
            const row = { label: this.inline(cells[0]?.text ?? "", { line: l.pos.line, col: l.pos.col + (cells[0]?.off ?? 0) }), value: this.inline(cells[1]?.text ?? "", { line: l.pos.line, col: l.pos.col + (cells[1]?.off ?? 0) }) };
            return each ? { ...row, each } : row;
          });
        if (!rows.length) this.error(pos, `"::rows" is empty`);
        return { kind: "rows", rows, pos };
      }
      case "table": {
        const parsed = this.rawLines(name, pos)
          .filter((l) => l.text.trim() && !l.text.trim().startsWith("//"))
          .map((raw) => this.repeat(raw));
        const lines = parsed.map((x) => x.line);
        const rows = lines.map((l) => splitCells(l.text).map((c) => this.inline(c.text, { line: l.pos.line, col: l.pos.col + c.off })));
        const hasFoot0 = attrs.footer !== undefined;
        parsed.forEach((x, k) => {
          if (x.each && (k === 0 || (hasFoot0 && k === parsed.length - 1))) this.error(x.line.pos, "@each is for body rows, not the header or footer");
        });
        const cols = rows[0]?.length ?? 0;
        rows.forEach((r, k) => {
          if (r.length !== cols) this.error(lines[k]!.pos, `this row has ${r.length} cells; the header has ${cols}`);
        });
        let align: Align[] = Array.from({ length: cols }, () => "left");
        const a = plain("align");
        if (a !== undefined) {
          const parts = a.trim().split(/\s+/);
          const map: Record<string, Align> = { l: "left", left: "left", r: "right", right: "right", c: "center", center: "center" };
          if (parts.length !== cols || parts.some((x) => !map[x])) this.error(attrs.align!.pos, `align needs one of l, r, c per column (${cols} columns)`);
          else align = parts.map((x) => map[x]!);
        }
        const hasFoot = attrs.footer !== undefined;
        if (rows.length < (hasFoot ? 3 : 2)) this.error(pos, `"::table" needs a header row and at least one row${hasFoot ? " plus the footer row" : ""}`);
        const head = rows[0] ?? [];
        const body = rows.slice(1, hasFoot ? -1 : undefined).map((cells, k) => {
          const each = parsed[k + 1]!.each;
          return each ? { cells, each } : { cells };
        });
        const foot = hasFoot && rows.length > 1 ? rows[rows.length - 1]! : null;
        return { kind: "table", align, head, body, foot, pos };
      }
    }
    return null;
  }

  /** Splits an "@each items as item: …" prefix off a table / rows line. */
  private repeat(l: { text: string; pos: Pos }): { each?: Repeat; line: { text: string; pos: Pos } } {
    const m = /^(\s*@each\s+(\S+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)/.exec(l.text);
    if (!m) {
      if (/^\s*@each\b/.test(l.text)) this.error(l.pos, `write "@each items as item: cell | cell"`);
      return { line: l };
    }
    const each: Repeat = { list: this.expr(m[2]!, { line: l.pos.line, col: l.pos.col + m[1]!.indexOf(m[2]!) }), as: m[3]! };
    return { each, line: { text: l.text.slice(m[1]!.length), pos: { line: l.pos.line, col: l.pos.col + m[1]!.length } } };
  }

  private control(name: "if" | "each", rest: string, restPos: Pos, pos: Pos): Block {
    if (name === "if") {
      const m = /^(!?)\s*(.+)$/.exec(rest.trim());
      if (!m) this.error(pos, `"::if" needs a variable: ::if name or ::if !name`);
      const test = this.expr(m?.[2] ?? "", restPos);
      if (test.filters.length) this.error(restPos, `"::if" takes a variable without filters`);
      const first = this.blocks({ name, pos, elseable: true });
      const second = first.end === "else" ? this.blocks({ name, pos }).blocks : [];
      return { kind: "if", negate: m?.[1] === "!", test, then: first.blocks, else: second, pos };
    }
    const m = /^(\S+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(rest.trim());
    if (!m) this.error(pos, `"::each" is written ::each items as item`);
    const list = this.expr(m?.[1] ?? "", restPos);
    if (m && m[2] === "loop") this.error(pos, `"loop" is reserved inside ::each`);
    return { kind: "each", list, as: m?.[2] ?? "item", children: this.blocks({ name, pos }).blocks, pos };
  }

  private attrs(src: string, pos: Pos): Record<string, { value: string; pos: Pos }> {
    const out: Record<string, { value: string; pos: Pos }> = {};
    const re = /\s*([a-z]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/y;
    let k = 0;
    while (k < src.length) {
      if (!src.slice(k).trim()) break;
      re.lastIndex = k;
      const m = re.exec(src);
      if (!m) {
        this.error({ line: pos.line, col: pos.col + k }, `Cannot read attributes here: ${src.slice(k).trim()}`);
        break;
      }
      const key = m[1]!;
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      const valueCol = pos.col + m.index + m[0].indexOf("=") + (m[4] !== undefined ? 1 : 2);
      if (out[key]) this.error(pos, `attribute "${key}" is given twice`);
      out[key] = { value, pos: { line: pos.line, col: valueCol } };
      k = re.lastIndex;
    }
    return out;
  }
}

const LIST = /^([-*]|\d+\.)\s+(.*)$/;

function findLinkMid(src: string, open: number): number {
  let depth = 0;
  for (let k = open + 1; k < src.length; k++) {
    if (src[k] === "\\") k++;
    else if (src[k] === "[") depth++;
    else if (src[k] === "]") {
      if (depth === 0) return src[k + 1] === "(" ? k : -1;
      depth--;
    }
  }
  return -1;
}

/** Splits on `|` outside `{{ }}` (filters use `|` too) and outside `\|`. */
function splitPipes(src: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const c of src) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function splitCells(line: string): { text: string; off: number }[] {
  const out: { text: string; off: number }[] = [];
  let cur = "";
  let start = 0;
  let depth = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line[k]!;
    if (c === "\\" && line[k + 1] === "|") {
      cur += "\\|";
      k++;
      continue;
    }
    if (line.startsWith("{{", k)) depth++;
    if (line.startsWith("}}", k)) depth = Math.max(0, depth - 1);
    if (c === "|" && depth === 0) {
      out.push(cell(cur, start));
      cur = "";
      start = k + 1;
      continue;
    }
    cur += c;
  }
  out.push(cell(cur, start));
  return out;
}

function cell(text: string, start: number): { text: string; off: number } {
  const lead = text.length - text.trimStart().length;
  return { text: text.trim(), off: start + lead };
}

function trimBlank<T extends { text: string }>(lines: T[]): T[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.text.trim()) a++;
  while (b > a && !lines[b - 1]!.text.trim()) b--;
  return lines.slice(a, b);
}

/**
 * Parses a `.mail` source. Throws a MailSyntaxError listing every problem (line:col message).
 * `file` only labels the messages.
 */
export function parseMail(source: string, file?: string): MailDocument {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const diags: Diagnostic[] = [];
  const front: Partial<Record<(typeof FRONT_KEYS)[number], { value: string; pos: Pos }>> = {};
  let start = 0;
  if (lines[0]?.trim() === "---") {
    let k = 1;
    for (; k < lines.length && lines[k]!.trim() !== "---"; k++) {
      const raw = lines[k]!;
      if (!raw.trim() || raw.trim().startsWith("//")) continue;
      const m = /^\s*([a-z]+)\s*:\s?(.*)$/.exec(raw);
      if (!m || !(FRONT_KEYS as readonly string[]).includes(m[1]!)) {
        diags.push({ line: k + 1, col: 1, message: `Front matter takes ${FRONT_KEYS.join(", ")} ("key: value")` });
        continue;
      }
      front[m[1] as (typeof FRONT_KEYS)[number]] = { value: m[2]!.trim(), pos: { line: k + 1, col: raw.indexOf(":") + 2 } };
    }
    if (k >= lines.length) diags.push({ line: 1, col: 1, message: `Front matter is not closed (add a line with "---")` });
    start = k + 1;
  }
  if (!front.subject?.value) diags.push({ line: 1, col: 1, message: `Every mail needs a subject: start the file with ---, subject: …, ---` });

  const p = new Parser(lines.slice(start), start + 1);
  const tpl = (f?: { value: string; pos: Pos }) => (f && f.value ? p.template(f.value, f.pos) : null);
  const subject = tpl(front.subject) ?? [];
  const preheader = tpl(front.preheader);
  const footer = tpl(front.footer);
  const { blocks } = p.blocks();
  if (!blocks.length && !diags.length && !p.diags.length) diags.push({ line: start + 1, col: 1, message: "The mail has no content" });
  const all = [...diags, ...p.diags].sort((a, b) => a.line - b.line || a.col - b.col);
  if (all.length) throw new MailSyntaxError(all, file);
  return { subject, preheader, footer, body: blocks };
}

/** Problems in a `.mail` source, without throwing (empty when it parses). For editors and CI. */
export function checkMail(source: string): Diagnostic[] {
  try {
    parseMail(source);
    return [];
  } catch (e) {
    if (e instanceof MailSyntaxError) return e.diagnostics;
    throw e;
  }
}
