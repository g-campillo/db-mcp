/**
 * Coerces driver values into something JSON-friendly, capping oversized cells
 * so one CLOB cannot blow up a whole response.
 */

/**
 * `maxCell` caps string/Buffer cell size in **bytes** (-1 or 0 disables).
 * Oversized cells are cut at a UTF-8 boundary and marked, matching the Go
 * build's byte-accurate truncation.
 */
export function normalize(v: unknown, maxCell: number): unknown {
  let s: string;
  if (Buffer.isBuffer(v)) {
    s = v.toString("utf8");
  } else if (typeof v === "string") {
    s = v;
  } else if (v instanceof Date) {
    return v.toISOString();
  } else {
    return v;
  }

  const byteLen = Buffer.byteLength(s, "utf8");
  if (maxCell > 0 && byteLen > maxCell) {
    return `${truncateUtf8(s, maxCell)}... [truncated, ${byteLen} bytes total]`;
  }
  return s;
}

/**
 * Cuts a string to at most `maxBytes` UTF-8 bytes without emitting a broken
 * character. Go slices raw bytes and then drops the invalid tail via
 * strings.ToValidUTF8(_, ""); backing off to the last complete sequence is the
 * same result reached directly.
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;

  let end = maxBytes;
  // Walk back over continuation bytes (10xxxxxx) to the sequence's lead byte.
  let i = end - 1;
  let back = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80 && back < 3) {
    i--;
    back++;
  }
  if (i >= 0) {
    const lead = buf[i]!;
    let seqLen = 1;
    if ((lead & 0xf8) === 0xf0) seqLen = 4;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xe0) === 0xc0) seqLen = 2;
    // An incomplete trailing sequence is dropped whole.
    if (i + seqLen > end) end = i;
  }
  return buf.subarray(0, end).toString("utf8");
}
