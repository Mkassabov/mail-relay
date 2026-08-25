import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeWords,
  parseAddress,
  parseMessage,
  sanitizeHeaderText,
  toForwardPayload,
} from "./mime.ts";

/** Build a raw message with CRLF line endings, the way SMTP delivers it. */
const crlf = (...lines: string[]) => new TextEncoder().encode(lines.join("\r\n"));

const bytes = (...values: number[]) => Uint8Array.from(values);

function rawFrom(parts: Array<string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

test("decodes quoted-printable text with soft line breaks", () => {
  const raw = crlf(
    "From: a@example.com",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 na=C3=AFve r=C3=A9sum=C3=A9 with a very long line that the sen=",
    "der wrapped, plus a trailing space=20",
    "",
  );
  const { text } = parseMessage(raw);
  assert.equal(
    text,
    "Café naïve résumé with a very long line that the sender wrapped, plus a trailing space \r\n",
  );
});

test("keeps a folded Content-Type header's boundary", () => {
  const raw = crlf(
    "Content-Type: multipart/alternative;",
    '\tboundary="=_NextPart_001"',
    "",
    "--=_NextPart_001",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain body",
    "--=_NextPart_001",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html body</p>",
    "--=_NextPart_001--",
    "",
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "plain body");
  assert.equal(parsed.html, "<p>html body</p>");
});

test("decodes base64 parts and prefers the richest alternative", () => {
  const raw = crlf(
    "Content-Type: multipart/alternative; boundary=abc",
    "",
    "--abc",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("hej hej ☕").toString("base64"),
    "--abc",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("<b>hej hej ☕</b>").toString("base64"),
    "--abc--",
    "",
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "hej hej ☕");
  assert.equal(parsed.html, "<b>hej hej ☕</b>");
});

test("handles nested multipart/mixed around multipart/alternative", () => {
  const raw = crlf(
    "Content-Type: multipart/mixed; boundary=outer",
    "",
    "--outer",
    "Content-Type: multipart/alternative; boundary=inner",
    "",
    "--inner",
    "Content-Type: text/plain",
    "",
    "the text",
    "--inner",
    "Content-Type: text/html",
    "",
    "<p>the html</p>",
    "--inner--",
    "",
    "--outer",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 fake").toString("base64"),
    "--outer--",
    "",
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "the text");
  assert.equal(parsed.html, "<p>the html</p>");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.filename, "report.pdf");
  assert.equal(parsed.attachments[0]?.type, "application/pdf");
  assert.equal(parsed.attachments[0]?.disposition, "attachment");
  assert.equal(Buffer.from(parsed.attachments[0]!.content).toString(), "%PDF-1.4 fake");
});

test("decodes a non-UTF-8 charset", () => {
  const raw = rawFrom([
    "Content-Type: text/plain; charset=iso-8859-1\r\n\r\n",
    bytes(0x43, 0x61, 0x66, 0xe9), // "Café" in latin1
  ]);
  assert.equal(parseMessage(raw).text, "Café");
});

test("does not mangle 8-bit UTF-8 bodies sent without an encoding", () => {
  const raw = rawFrom(["Content-Type: text/plain\r\n\r\n", new TextEncoder().encode("naïve ☕")]);
  assert.equal(parseMessage(raw).text, "naïve ☕");
});

test("keeps inline images as inline attachments so cid: references resolve", () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const raw = crlf(
    "Content-Type: multipart/related; boundary=rel",
    "",
    "--rel",
    "Content-Type: text/html",
    "",
    '<img src="cid:logo@example">',
    "--rel",
    "Content-Type: image/png",
    "Content-ID: <logo@example>",
    "Content-Disposition: inline; filename=logo.png",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(png).toString("base64"),
    "--rel--",
    "",
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.html, '<img src="cid:logo@example">');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.disposition, "inline");
  assert.equal(parsed.attachments[0]?.contentId, "logo@example");
  assert.deepEqual(parsed.attachments[0]?.content, png);
});

test("reads RFC 2231 split and charset-tagged filenames", () => {
  const raw = crlf(
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "see attached",
    "--b",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment;",
    "\tfilename*0*=utf-8''%C3%A5rsrapport%20;",
    "\tfilename*1*=2024.txt",
    "",
    "data",
    "--b--",
    "",
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.attachments[0]?.filename, "årsrapport 2024.txt");
});

test("unwraps format=flowed plain text", () => {
  const raw = crlf(
    "Content-Type: text/plain; charset=utf-8; format=flowed",
    "",
    "This paragraph was soft ",
    "wrapped by the sender.",
    "",
    "> quoted line one ",
    "> quoted line two",
    "",
  );
  assert.equal(
    parseMessage(raw).text,
    "This paragraph was soft wrapped by the sender.\n\n> quoted line one quoted line two\n",
  );
});

test("parses messages stored with bare LF line endings", () => {
  const raw = new TextEncoder().encode(
    [
      "Content-Type: multipart/alternative; boundary=lf",
      "",
      "--lf",
      "Content-Type: text/plain",
      "",
      "plain",
      "--lf",
      "Content-Type: text/html",
      "",
      "<p>rich</p>",
      "--lf--",
      "",
    ].join("\n"),
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "plain");
  assert.equal(parsed.html, "<p>rich</p>");
});

test("treats a bare body without headers as text", () => {
  assert.equal(parseMessage(new TextEncoder().encode("just a body")).text, "just a body");
});

test("decodes RFC 2047 encoded words in headers", () => {
  assert.equal(decodeWords("=?UTF-8?B?w6VyaHVz?= office"), "århus office");
  assert.equal(decodeWords("=?utf-8?Q?Caf=C3=A9_r=C3=A9sum=C3=A9?="), "Café résumé");
  // Adjacent encoded words: the whitespace between them is separator, not text.
  assert.equal(decodeWords("=?utf-8?B?4pyT?= =?utf-8?B?4pyT?="), "✓✓");
  assert.equal(decodeWords("plain subject"), "plain subject");
});

test("splits display names from addresses", () => {
  assert.deepEqual(parseAddress("=?utf-8?Q?Ren=C3=A9?= <rene@example.com>"), {
    name: "René",
    email: "rene@example.com",
  });
  assert.deepEqual(parseAddress('"Doe, Jane" <jane@example.com>'), {
    name: "Doe, Jane",
    email: "jane@example.com",
  });
  assert.deepEqual(parseAddress("bare@example.com"), { email: "bare@example.com" });
});

test("strips characters that would break a header line", () => {
  assert.equal(sanitizeHeaderText("Jane\r\nBcc: evil@example.com"), "Jane Bcc: evil@example.com");
});

test("always produces a sendable body", () => {
  const payload = toForwardPayload({ headers: new Map(), attachments: [] });
  assert.equal(payload.text, "(no message body)");
  assert.equal(payload.attachments, undefined);
});

test("drops oversized attachments and says so in the body", () => {
  const payload = toForwardPayload({
    headers: new Map(),
    text: "body",
    html: "<html><body>body</body></html>",
    attachments: [
      {
        disposition: "attachment",
        filename: "huge.bin",
        type: "application/octet-stream",
        content: new Uint8Array(13 * 1024 * 1024),
      },
      {
        disposition: "attachment",
        filename: "small.txt",
        type: "text/plain",
        content: new TextEncoder().encode("ok"),
      },
    ],
  });
  assert.equal(payload.attachments?.length, 1);
  assert.match(payload.text!, /huge\.bin/);
  assert.match(payload.html!, /<p>\[1 attachment\(s\) omitted[^<]*huge\.bin\]<\/p><\/body>/);
});
