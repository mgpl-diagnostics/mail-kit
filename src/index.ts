// @mgpl-diagnostics/mail-kit — mails written in the MGPL mail design language, rendered to
// email-safe HTML + plain text, sent through the worker's queue when there is one, or directly.
export * from "./types";
export * from "./errors";
export { parseMail, checkMail, FILTERS, type FilterName } from "./parse";
export { renderMail, mailVariables, escapeHtml, safeUrl, type RenderOptions } from "./render";
export { DEFAULT_THEME, DEFAULT_BRAND, createTheme } from "./theme";
export { defineMail, type MailTemplate, type AnyMailTemplate } from "./define";
export { MAIL_TEMPLATES, passwordReset, passwordChanged, staffInvite, reportReady, paymentReceipt, type BuiltinMailId } from "./templates";
export { buildMessage, parseAddress, quotedPrintable, encodeWord, type BuiltMessage, type ParsedAddress } from "./mime";
export { smtpTransport, parseSmtpUrl, type SmtpOptions } from "./smtp";
export { memoryTransport, fileTransport, type MemoryTransport } from "./transports";
export { createMailer, type Mailer, type MailerOptions, type MailJob, type MailQueue, type SendOutcome } from "./mailer";
export { queueAdapter, mailProcessor, type QueueLike, type QueueAdapterOptions } from "./queue";
