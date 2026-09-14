import { createHash } from "node:crypto";

export const MAIL_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, depth: 8, parts: 40, attachments: 10, headerBytes: 32768, headers: 100, textBytes: 256 * 1024, parseMs: 150 });
export class MailParseError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MailParseError"; }
}
export interface ParsedMail {
  subject: string;
  from: string;
  text: string;
  htmlText: string;
  attachments: number;
  rawSha256: string;
  // Metadata is descriptive only: it does not authenticate the marketplace.
  authenticationResults: string | null;
}
function fail(code: string): never { throw new MailParseError(code); }
function decodeBody(body: string, encoding: string): string {
  if (encoding === "base64") {
    const compact = body.replace(/[\r\n\t ]/g, "");
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) fail("MALFORMED_ENCODING");
    return Buffer.from(compact, "base64").toString("utf8");
  }
  if (encoding === "quoted-printable") {
    const value = body.replace(/=\r?\n/g, "");
    if (/=(?![0-9a-fA-F]{2})/.test(value)) fail("MALFORMED_ENCODING");
    return Buffer.from(value.replace(/=([a-fA-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8");
  }
  if (encoding && !["7bit", "8bit", "binary"].includes(encoding)) fail("UNSUPPORTED_ENCODING");
  return Buffer.from(body, "latin1").toString("utf8");
}
/** Produces inert text only. No HTML is returned, no remote URLs are requested. */
export function inertHtmlText(html: string): string {
  return html.replace(/<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/td)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, entity => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity.toLowerCase()]!)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
/** Intentionally bounded MIME subset; unsupported structure is quarantined. */
export function parseMail(raw: Buffer, now = () => performance.now()): ParsedMail {
  if (raw.length > MAIL_LIMITS.bytes) fail("MESSAGE_TOO_LARGE");
  const started = now();
  let parts = 0, attachments = 0, totalText = 0;
  const texts: string[] = [], htmlTexts: string[] = [];
  let rootHeaders = new Map<string, string>();
  const checkTime = () => { if (now() - started > MAIL_LIMITS.parseMs) fail("PARSER_TIME_LIMIT"); };
  const visit = (source: string, depth: number) => {
    checkTime();
    if (depth > MAIL_LIMITS.depth || ++parts > MAIL_LIMITS.parts) fail("MIME_COMPLEXITY_LIMIT");
    const split = /\r?\n\r?\n/.exec(source);
    if (!split || split.index > MAIL_LIMITS.headerBytes) fail("MALFORMED_HEADERS");
    const headerLines = source.slice(0, split.index).replace(/\r?\n[\t ]+/g, " ").split(/\r?\n/);
    if (headerLines.length > MAIL_LIMITS.headers) fail("HEADER_LIMIT");
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon < 1) fail("MALFORMED_HEADERS");
      const key = line.slice(0, colon).toLowerCase();
      if (!/^[a-z0-9-]+$/.test(key)) fail("MALFORMED_HEADERS");
      if (headers.has(key) && ["content-type", "content-transfer-encoding", "from", "subject"].includes(key)) fail("AMBIGUOUS_HEADERS");
      headers.set(key, line.slice(colon + 1).trim());
    }
    if (depth === 0) rootHeaders = headers;
    const body = source.slice(split.index + split[0].length);
    const contentType = headers.get("content-type") ?? "text/plain";
    const mediaType = contentType.split(";")[0].trim().toLowerCase();
    const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
    if (charset && !["utf-8", "utf8", "us-ascii", "ascii"].includes(charset)) fail("UNSUPPORTED_CHARSET");
    if (/^attachment\b/i.test(headers.get("content-disposition") ?? "") || /(?:filename|name)\s*=/i.test(`${contentType};${headers.get("content-disposition") ?? ""}`)) {
      if (++attachments > MAIL_LIMITS.attachments) fail("ATTACHMENT_LIMIT");
      return;
    }
    if (mediaType.startsWith("multipart/")) {
      if (!["multipart/alternative", "multipart/mixed", "multipart/related"].includes(mediaType)) fail("UNSUPPORTED_MULTIPART");
      const boundary = /boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
      const token = boundary?.[1] ?? boundary?.[2];
      if (!token || token.length > 200) fail("MALFORMED_BOUNDARY");
      const lines = body.split(/\r?\n/);
      let section: string[] | null = null, closed = false;
      for (const line of lines) {
        if (line === `--${token}` || line === `--${token}--`) {
          if (section !== null) visit(section.join("\r\n"), depth + 1);
          if (line.endsWith("--")) { closed = true; break; }
          section = [];
        } else if (section !== null) section.push(line);
      }
      if (!closed) fail("MALFORMED_BOUNDARY");
    } else if (mediaType === "text/plain" || mediaType === "text/html") {
      const decoded = decodeBody(body, (headers.get("content-transfer-encoding") ?? "").toLowerCase());
      totalText += Buffer.byteLength(decoded);
      if (totalText > MAIL_LIMITS.textBytes) fail("TEXT_LIMIT");
      (mediaType === "text/plain" ? texts : htmlTexts).push(mediaType === "text/plain" ? decoded : inertHtmlText(decoded));
    } else {
      // Attached .eml/archives/images are retained but never recursively opened.
      if (++attachments > MAIL_LIMITS.attachments) fail("ATTACHMENT_LIMIT");
    }
    checkTime();
  };
  visit(raw.toString("latin1"), 0);
  return { subject: rootHeaders.get("subject") ?? "", from: rootHeaders.get("from") ?? "", text: texts.join("\n"), htmlText: htmlTexts.join("\n"), attachments, rawSha256: createHash("sha256").update(raw).digest("hex"), authenticationResults: rootHeaders.get("authentication-results") ?? null };
}
export function forwardingChallenge(mail: ParsedMail): { code: string | null; url: string | null } | null {
  // This is a candidate for the owner to verify at Gmail, never provider authentication.
  if (!/gmail forwarding confirmation/i.test(mail.subject) || !/^(?:[^<>]*<)?forwarding-noreply@google\.com>?$/i.test(mail.from)) return null;
  const text = `${mail.text}\n${mail.htmlText}`;
  const code = /confirmation code\s*:\s*([0-9]{6,12})\b/i.exec(text)?.[1] ?? null;
  const candidate = /https:\/\/mail\.google\.com\/mail\/vf-[^\s<>"']{1,1024}/i.exec(text)?.[0] ?? null;
  return code || candidate ? { code, url: candidate } : null;
}
