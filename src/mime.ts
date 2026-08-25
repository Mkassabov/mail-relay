/// <reference types="@cloudflare/workers-types" />

/**
 * A small MIME reader: enough of RFC 2045/2046/2047/2183/2231/3676 to relay a
 * message without mangling how it reads in the recipient's client.
 *
 * Parsing runs over a "binary string" (one code unit per byte) rather than a
 * UTF-8 decoded string, because transfer-encoding and charset decoding have to
 * happen per part — decoding the whole message as UTF-8 up front destroys
 * base64 attachments and any part that isn't UTF-8 to begin with.
 */

export interface Attachment {
  disposition: "inline" | "attachment";
  contentId?: string;
  filename: string;
  type: string;
  content: Uint8Array;
}

export interface ParsedMessage {
  headers: MimeHeaders;
  text?: string;
  html?: string;
  attachments: Attachment[];
}

export interface ForwardPayload {
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export type MimeHeaders = Map<string, string[]>;

interface ContentField {
  value: string;
  params: Record<string, string>;
}

interface MimeNode {
  headers: MimeHeaders;
  type: string;
  params: Record<string, string>;
  body: string;
  children?: MimeNode[];
}

/** Total attachment bytes we are willing to put back on the wire. */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

// --- bytes ---------------------------------------------------------------

function toBinaryString(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const chunk = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function toBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

function latin1(bytes: Uint8Array): string {
  return toBinaryString(bytes);
}

/**
 * Decode bytes with the declared charset, falling back to UTF-8 and then to
 * latin1. The strict UTF-8 attempt in the middle is deliberate: a mislabelled
 * or unsupported charset is better served by latin1 than by a body full of
 * replacement characters.
 */
function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? "")
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "");
  if (label && label !== "utf-8" && label !== "utf8") {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // unsupported label — fall through
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  const usable = clean.length % 4 === 1 ? clean.slice(0, -1) : clean;
  const pad = usable.length % 4;
  const padded = pad === 0 ? usable : usable + "=".repeat(4 - pad);
  try {
    return toBytes(atob(padded));
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * @param word - encoded-word mode (RFC 2047): no soft line breaks, and the
 * caller has already turned `_` into spaces.
 */
function quotedPrintableToBytes(input: string, word = false): Uint8Array {
  // Trailing whitespace before a hard break is not part of the content.
  const source = word ? input : input.replace(/[ \t]+(\r?\n)/g, "$1");
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "=") {
      out.push(source.charCodeAt(i) & 0xff);
      continue;
    }
    const next = source[i + 1];
    if (!word && (next === "\n" || (next === "\r" && source[i + 2] === "\n"))) {
      i += next === "\r" ? 2 : 1; // soft line break: drop it
      continue;
    }
    const hex = source.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(0x3d); // stray '=' — keep it
  }
  return new Uint8Array(out);
}

// --- headers -------------------------------------------------------------

/** Decode RFC 2047 encoded words (`=?utf-8?q?...?=`) in a header value. */
export function decodeWords(input: string): string {
  if (!input.includes("=?")) return input;
  return (
    input
      // Whitespace between two adjacent encoded words is separator, not content.
      .replace(/(\?=)\s+(?==\?)/g, "$1")
      .replace(
        /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
        (match, charset: string, encoding: string, body: string) => {
          const bytes =
            encoding.toLowerCase() === "b"
              ? base64ToBytes(body)
              : quotedPrintableToBytes(body.replace(/_/g, " "), true);
          if (bytes.length === 0 && body.length > 0) return match;
          return decodeBytes(bytes, charset.split("*")[0]);
        },
      )
  );
}

/** Strip anything that would let a header value break out of its own line. */
export function sanitizeHeaderText(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function splitUnquoted(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted && ch === "\\" && i + 1 < input.length) {
      current += ch + input[i + 1];
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function unquote(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
}

function percentDecode(input: string, charset?: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const hex = input.slice(i + 1, i + 3);
    if (input[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(input.charCodeAt(i) & 0xff);
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

/**
 * Parse a structured header (`Content-Type`, `Content-Disposition`) into its
 * value plus parameters, including RFC 2231 continuations and charset-tagged
 * values (`filename*0*=utf-8''...`).
 */
function parseContentField(raw: string | undefined): ContentField {
  if (!raw) return { value: "", params: {} };
  const segments = splitUnquoted(raw, ";");
  const value = (segments[0] ?? "").trim().toLowerCase();
  const collected = new Map<
    string,
    { charset?: string; encoded: boolean; parts: Map<number, string> }
  >();

  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const rawKey = segment.slice(0, eq).trim().toLowerCase();
    const keyMatch = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawKey);
    if (!keyMatch) continue;
    const name = keyMatch[1]!;
    const index = keyMatch[2] ? Number(keyMatch[2]) : 0;
    const extended = keyMatch[3] === "*";
    let text = unquote(segment.slice(eq + 1));

    let entry = collected.get(name);
    if (!entry) {
      entry = { encoded: false, parts: new Map() };
      collected.set(name, entry);
    }
    if (extended) {
      entry.encoded = true;
      if (index === 0) {
        const tagged = /^([^']*)'([^']*)'([\s\S]*)$/.exec(text);
        if (tagged) {
          entry.charset = tagged[1];
          text = tagged[3]!;
        }
      }
    }
    entry.parts.set(index, text);
  }

  const params: Record<string, string> = {};
  for (const [name, entry] of collected) {
    const joined = [...entry.parts.keys()]
      .toSorted((a, b) => a - b)
      .map((i) => entry.parts.get(i)!)
      .join("");
    params[name] = entry.encoded ? percentDecode(joined, entry.charset) : joined;
  }
  return { value, params };
}

function parseHeaderBlock(block: string): MimeHeaders {
  const headers: MimeHeaders = new Map();
  // Unfold continuation lines before splitting.
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!name) continue;
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
}

export function headerValue(headers: MimeHeaders, name: string): string | undefined {
  return headers.get(name.toLowerCase())?.[0];
}

// --- structure -----------------------------------------------------------

function splitParts(body: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiter = new RegExp(`(?:^|\\r\\n|\\n)--${escaped}(--)?[ \\t]*(?=\\r\\n|\\n|$)`, "g");
  const parts: string[] = [];
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(body)) !== null) {
    if (start >= 0) parts.push(body.slice(start, match.index));
    if (match[1] === "--") return parts; // closing delimiter; epilogue is not a part
    // Content starts after the delimiter line's own line break, but `lastIndex`
    // stays before it so that break can prefix an immediately following
    // delimiter (i.e. an empty part).
    const after = delimiter.lastIndex;
    start = body.startsWith("\r\n", after)
      ? after + 2
      : body.startsWith("\n", after)
        ? after + 1
        : after;
  }
  if (start >= 0) parts.push(body.slice(start));
  return parts;
}

function parseNode(raw: string): MimeNode {
  const separator = /\r?\n\r?\n/.exec(raw);
  const looksLikeHeaders = /^[\x21-\x39\x3b-\x7e]+:/.test(raw);
  const headerBlock = separator ? raw.slice(0, separator.index) : looksLikeHeaders ? raw : "";
  const body = separator
    ? raw.slice(separator.index + separator[0].length)
    : looksLikeHeaders
      ? ""
      : raw;

  const headers = parseHeaderBlock(headerBlock);
  const contentType = parseContentField(headerValue(headers, "content-type"));
  const type = contentType.value || "text/plain";
  const node: MimeNode = { headers, type, params: contentType.params, body };

  const boundary = contentType.params["boundary"];
  if (type.startsWith("multipart/") && boundary) {
    node.children = splitParts(body, boundary).map(parseNode);
  }
  return node;
}

function decodeContent(node: MimeNode): Uint8Array {
  const encoding = (headerValue(node.headers, "content-transfer-encoding") ?? "")
    .trim()
    .toLowerCase()
    .split(/[;\s]/)[0];
  if (encoding === "base64") return base64ToBytes(node.body);
  if (encoding === "quoted-printable") return quotedPrintableToBytes(node.body);
  return toBytes(node.body);
}

/**
 * Undo RFC 3676 `format=flowed` soft wrapping. Without this, a plain-text part
 * from Apple Mail or Thunderbird arrives re-wrapped at the sender's window
 * width once we re-send it as an ordinary text/plain part.
 */
function unflow(text: string, delsp: boolean): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let buffer: string | null = null;
  let depth = 0;

  const flush = () => {
    // Re-emit quoting the conventional way (`> `); the space that followed the
    // quote markers on the wire was RFC 3676 space-stuffing, not content.
    if (buffer !== null) out.push(depth > 0 ? `${">".repeat(depth)} ${buffer}` : buffer);
    buffer = null;
  };

  for (const line of lines) {
    const quote = /^(>*)([\s\S]*)$/.exec(line)!;
    const lineDepth = quote[1]!.length;
    let content = quote[2]!;
    if (content.startsWith(" ")) content = content.slice(1); // space-stuffing
    const flowed = content.endsWith(" ") && content !== "-- ";

    if (buffer !== null && lineDepth === depth) {
      buffer += content;
    } else {
      flush();
      depth = lineDepth;
      buffer = content;
    }
    if (flowed) {
      if (delsp) buffer = buffer.slice(0, -1);
    } else {
      flush();
    }
  }
  flush();
  return out.join("\n");
}

function attachmentFrom(
  node: MimeNode,
  disposition: ContentField,
  index: number,
): Attachment | undefined {
  const content = decodeContent(node);
  if (content.length === 0) return undefined;

  const contentId = (headerValue(node.headers, "content-id") ?? "").trim().replace(/^<|>$/g, "");
  const named = decodeWords(disposition.params["filename"] ?? node.params["name"] ?? "").trim();
  const subtype = node.type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
  const filename =
    sanitizeHeaderText(named).replace(/[\\/]/g, "_") ||
    (node.type === "message/rfc822"
      ? `forwarded-message-${index}.eml`
      : `attachment-${index}.${subtype}`);

  return contentId
    ? { disposition: "inline", contentId, filename, type: node.type, content }
    : { disposition: "attachment", filename, type: node.type, content };
}

/**
 * @param preferLast - inside `multipart/alternative` the richest representation
 * comes last, so later siblings replace earlier ones.
 */
function collect(node: MimeNode, out: ParsedMessage, preferLast: boolean): void {
  if (node.children) {
    // The signature half of a signed message is meaningless once we re-send.
    const children = node.type === "multipart/signed" ? node.children.slice(0, 1) : node.children;
    const alternative = node.type === "multipart/alternative";
    for (const child of children) collect(child, out, alternative);
    return;
  }

  const disposition = parseContentField(headerValue(node.headers, "content-disposition"));
  const named = disposition.params["filename"] ?? node.params["name"];
  const isBody =
    (node.type === "text/plain" || node.type === "text/html") &&
    disposition.value !== "attachment" &&
    !named;

  if (isBody) {
    let decoded = decodeBytes(decodeContent(node), node.params["charset"]);
    if (node.type === "text/plain") {
      if (node.params["format"]?.toLowerCase() === "flowed") {
        decoded = unflow(decoded, node.params["delsp"]?.toLowerCase() === "yes");
      }
      if (preferLast || out.text === undefined) out.text = decoded;
    } else if (preferLast || out.html === undefined) {
      out.html = decoded;
    }
    return;
  }

  const attachment = attachmentFrom(node, disposition, out.attachments.length + 1);
  if (attachment) out.attachments.push(attachment);
}

/** Parse a raw RFC 5322 message into its renderable parts. */
export function parseMessage(raw: ArrayBuffer | Uint8Array): ParsedMessage {
  const root = parseNode(toBinaryString(raw));
  const parsed: ParsedMessage = { headers: root.headers, attachments: [] };
  collect(root, parsed, false);
  return parsed;
}

/** Split an address header into its display name and address. */
export function parseAddress(raw: string): { name?: string; email?: string } {
  const first = (splitUnquoted(raw, ",")[0] ?? "").trim();
  const angle = /<([^>]*)>[^>]*$/.exec(first);
  if (angle) {
    const name = sanitizeHeaderText(decodeWords(unquote(first.slice(0, angle.index))));
    return { name: name || undefined, email: angle[1]!.trim() || undefined };
  }
  return { email: first || undefined };
}

/**
 * How many message-ids to carry in `References` before trimming. RFC 5322
 * lets a chain grow without bound; MUAs keep the oldest (the thread root) and
 * the most recent ones, which is what threading actually keys off.
 */
const MAX_REFERENCES = 20;

/**
 * Pull message-ids out of a header value. The pattern doubles as the
 * sanitizer: an id cannot contain whitespace or angle brackets, so anything a
 * sender tries to smuggle in — a folded line, an injected header — is simply
 * not matched.
 */
function messageIds(raw: string | undefined): string[] {
  return raw?.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * Build the threading headers for the relayed copy of a message.
 *
 * The relay re-sends rather than bounces, so the recipient's mailbox only ever
 * holds our copies and has never seen the sender's Message-IDs. Copying
 * `References` verbatim is therefore not enough on its own — we also append
 * the original's own Message-ID. That id is what ties the chain together:
 * when the recipient replies, their client carries it forward, so the sender's
 * client threads the reply against the message it actually sent, and our next
 * relayed copy shares a reference with the one before it.
 */
export function threadingHeaders(headers: MimeHeaders): Record<string, string> | undefined {
  const parent = messageIds(headerValue(headers, "in-reply-to"))[0];
  const references = messageIds(headerValue(headers, "references"));
  const chain = references.length > 0 ? references : parent ? [parent] : [];
  const self = messageIds(headerValue(headers, "message-id"))[0];
  const unique = [...new Set(self ? [...chain, self] : chain)];
  const trimmed =
    unique.length > MAX_REFERENCES ? [unique[0]!, ...unique.slice(1 - MAX_REFERENCES)] : unique;

  const out: Record<string, string> = {};
  if (parent) out["In-Reply-To"] = parent;
  if (trimmed.length > 0) out["References"] = trimmed.join(" ");
  return Object.keys(out).length > 0 ? out : undefined;
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appendToHtml(html: string, note: string): string {
  const paragraph = `<p>${escapeHtml(note)}</p>`;
  const close = html.search(/<\/body\s*>/i);
  return close === -1
    ? `${html}\n${paragraph}`
    : html.slice(0, close) + paragraph + html.slice(close);
}

/**
 * Turn a parsed message into the body of a `send()` call, keeping attachments
 * under the size a relayed message can carry and never returning an empty body
 * (the send builder requires at least one of `text`/`html`).
 */
export function toForwardPayload(message: ParsedMessage): ForwardPayload {
  let { text, html } = message;
  const attachments: EmailAttachment[] = [];
  const dropped: string[] = [];
  let budget = MAX_ATTACHMENT_BYTES;

  for (const attachment of message.attachments) {
    if (attachment.content.byteLength > budget) {
      dropped.push(attachment.filename);
      continue;
    }
    budget -= attachment.content.byteLength;
    const { disposition, contentId, filename, type, content } = attachment;
    attachments.push(
      disposition === "inline" && contentId
        ? { disposition, contentId, filename, type, content }
        : { disposition: "attachment", filename, type, content },
    );
  }

  if (dropped.length > 0) {
    const note = `[${dropped.length} attachment(s) omitted, over the relay size limit: ${dropped.join(", ")}]`;
    if (text !== undefined) text = `${text}\n\n${note}`;
    if (html !== undefined) html = appendToHtml(html, note);
    if (text === undefined && html === undefined) text = note;
  }

  if (text === undefined && html === undefined) text = "(no message body)";

  return {
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
