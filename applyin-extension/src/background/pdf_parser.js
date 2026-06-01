// Applyin — PDF Parser v3
// Properly handles binary PDFs by working with byte offsets, not string positions.
// Uses DecompressionStream for zlib/deflate streams.

export async function parsePDF(uint8Array) {
  try {
    const text = await extract(uint8Array);
    const words = text.trim().split(/\s+/).filter(w => w.length > 1).length;
    console.log(`[Applyin] Parsed: ${words} words, ${text.length} chars`);
    console.log(`[Applyin] Preview: ${text.slice(0, 300)}`);
    return { text: text.slice(0, 8000), words };
  } catch (e) {
    console.error("[Applyin] parsePDF error:", e);
    return { text: "", words: 0 };
  }
}

async function extract(bytes) {
  // Find all stream...endstream byte ranges using proper binary search
  const streamRanges = findStreams(bytes);
  console.log(`[Applyin] Found ${streamRanges.length} streams`);

  const textChunks = [];

  for (const { headerBytes, dataBytes } of streamRanges) {
    const header = bytesToAscii(headerBytes);
    const isFlate = header.includes("FlateDecode");
    const isFont = header.includes("/Font") || header.includes("/CIDFont");

    // Skip pure font program streams (they contain glyph outlines, not text)
    if (isFont && !header.includes("ToUnicode")) continue;

    let content;
    if (isFlate) {
      try {
        const decompressed = await inflate(dataBytes);
        content = bytesToAscii(decompressed);
        // console.log(`[Applyin] Decompressed stream: ${content.length} chars`);
      } catch (e) {
        content = bytesToAscii(dataBytes);
      }
    } else {
      content = bytesToAscii(dataBytes);
    }

    const text = extractTextOperators(content);
    if (text.trim().length > 5) textChunks.push(text);
  }

  // Deduplicate and join
  const seen = new Set();
  const lines = textChunks
    .join("\n")
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => {
      if (l.length < 2 || !/[a-zA-Z]/.test(l)) return false;
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });

  return lines.join("\n").trim();
}

// ── Find all stream/endstream pairs using byte-level search ─────────────────
function findStreams(bytes) {
  const STREAM    = strToBytes("stream");
  const ENDSTREAM = strToBytes("endstream");
  const OBJ       = strToBytes("obj");

  const results = [];
  let i = 0;

  while (i < bytes.length - 10) {
    // Find "stream" keyword
    const sPos = indexOf(bytes, STREAM, i);
    if (sPos === -1) break;

    // The byte immediately after "stream" must be \r\n or \n
    let dataStart = sPos + STREAM.length;
    if (bytes[dataStart] === 0x0D && bytes[dataStart + 1] === 0x0A) dataStart += 2;
    else if (bytes[dataStart] === 0x0A) dataStart += 1;
    else { i = sPos + 1; continue; }

    // Find "endstream" after data start
    const ePos = indexOf(bytes, ENDSTREAM, dataStart);
    if (ePos === -1) break;

    // Find the obj header before this stream (look back up to 2KB)
    const lookbackStart = Math.max(0, sPos - 2048);
    const lookbackBytes = bytes.slice(lookbackStart, sPos);
    const headerText = bytesToAscii(lookbackBytes);

    // Trim trailing whitespace before stream keyword for data end
    let dataEnd = ePos;
    if (bytes[dataEnd - 1] === 0x0A) dataEnd--;
    if (bytes[dataEnd - 1] === 0x0D) dataEnd--;

    results.push({
      headerBytes: lookbackBytes,
      dataBytes: bytes.slice(dataStart, dataEnd),
    });

    i = ePos + ENDSTREAM.length;
  }

  return results;
}

// ── Extract text from decompressed PDF content stream ──────────────────────
function extractTextOperators(content) {
  const lines = [];
  let currentLine = [];

  // Tokenize: find all string literals and operators
  let i = 0;
  while (i < content.length) {
    // Skip whitespace
    while (i < content.length && " \t\r\n".includes(content[i])) i++;
    if (i >= content.length) break;

    if (content[i] === "(") {
      // Literal string
      const { str, end } = parseLiteralString(content, i);
      if (str.trim()) currentLine.push(str);
      i = end;
    } else if (content[i] === "<" && content[i+1] === "<") {
      // Dictionary — skip
      let depth = 0;
      while (i < content.length) {
        if (content[i] === "<" && content[i+1] === "<") { depth++; i += 2; }
        else if (content[i] === ">" && content[i+1] === ">") { depth--; i += 2; if (!depth) break; }
        else i++;
      }
    } else if (content[i] === "<") {
      // Hex string <4865...>
      const end = content.indexOf(">", i + 1);
      if (end !== -1) {
        const hex = content.slice(i + 1, end).replace(/\s/g, "");
        const str = hexToString(hex);
        if (str.trim()) currentLine.push(str);
        i = end + 1;
      } else i++;
    } else if (content[i] === "[") {
      // Array — collect strings inside
      i++;
      while (i < content.length && content[i] !== "]") {
        while (i < content.length && " \t\r\n".includes(content[i])) i++;
        if (content[i] === "(") {
          const { str, end } = parseLiteralString(content, i);
          if (str.trim()) currentLine.push(str);
          i = end;
        } else if (content[i] === "<" && content[i+1] !== "<") {
          const end = content.indexOf(">", i + 1);
          if (end !== -1) {
            const str = hexToString(content.slice(i + 1, end).replace(/\s/g, ""));
            if (str.trim()) currentLine.push(str);
            i = end + 1;
          } else i++;
        } else {
          // Skip number or other token
          while (i < content.length && !" \t\r\n[]".includes(content[i])) i++;
        }
      }
      if (content[i] === "]") i++;
    } else {
      // Read operator/token
      let tok = "";
      while (i < content.length && !" \t\r\n()<>[]{}/%".includes(content[i])) {
        tok += content[i++];
      }
      if (!tok) { i++; continue; }

      // Text-ending operators
      if (tok === "Tj" || tok === "'" || tok === '"') {
        if (currentLine.length) {
          lines.push(currentLine.join(""));
          currentLine = [];
        }
      } else if (tok === "TJ") {
        if (currentLine.length) {
          lines.push(currentLine.join(""));
          currentLine = [];
        }
      } else if (tok === "Td" || tok === "TD" || tok === "T*" || tok === "Tm") {
        // Line position change — add newline
        if (currentLine.length) {
          lines.push(currentLine.join(""));
          currentLine = [];
        }
      } else if (tok === "ET") {
        if (currentLine.length) {
          lines.push(currentLine.join(""));
          currentLine = [];
        }
      }
      // All other operators (Tf, Tc, Tw, etc.) — ignore, keep reading
    }
  }

  if (currentLine.length) lines.push(currentLine.join(""));
  return lines.filter(l => l.trim().length > 0).join("\n");
}

function parseLiteralString(content, start) {
  let i = start + 1; // skip opening (
  let str = "";
  let depth = 1;

  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === "\\") {
      const next = content[i + 1];
      if (next === "n") { str += "\n"; i += 2; }
      else if (next === "r") { str += "\r"; i += 2; }
      else if (next === "t") { str += "\t"; i += 2; }
      else if (next === "(" || next === ")" || next === "\\") { str += next; i += 2; }
      else if (next >= "0" && next <= "7") {
        // Octal
        let oct = "";
        let j = i + 1;
        while (j < i + 4 && content[j] >= "0" && content[j] <= "7") oct += content[j++];
        str += String.fromCharCode(parseInt(oct, 8));
        i = j;
      } else { str += next || ""; i += 2; }
    } else if (ch === "(") { depth++; str += ch; i++; }
    else if (ch === ")") {
      depth--;
      if (depth > 0) str += ch;
      i++;
    } else { str += ch; i++; }
  }

  return { str, end: i };
}

function hexToString(hex) {
  if (hex.length % 2 !== 0) hex += "0";
  let str = "";
  // Try UTF-16 BE first (common for CID fonts)
  if (hex.length >= 4) {
    const firstCode = parseInt(hex.slice(0, 4), 16);
    if (firstCode > 0x00FF && firstCode < 0xFFFD) {
      // Likely UTF-16 BE
      for (let i = 0; i < hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        if (code && code < 0xFFFD) str += String.fromCodePoint(code);
      }
      return str;
    }
  }
  // Fallback: single-byte encoding
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code > 31 && code !== 127) str += String.fromCharCode(code);
  }
  return str;
}

// ── Inflate (zlib/deflate) ────────────────────────────────────────────────────
async function inflate(bytes) {
  for (const format of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      // Write in chunks to avoid backpressure issues
      const CHUNK = 65536;
      const writePromise = (async () => {
        for (let i = 0; i < bytes.length; i += CHUNK) {
          await writer.write(bytes.slice(i, i + CHUNK));
        }
        await writer.close();
      })();

      const chunks = [];
      const readPromise = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      })();

      await Promise.all([writePromise, readPromise]);

      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch { /* try next format */ }
  }
  return bytes;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function strToBytes(str) {
  return new Uint8Array(str.split("").map(c => c.charCodeAt(0)));
}

function indexOf(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function bytesToAscii(bytes) {
  // Replace non-printable non-whitespace with space, keep all printable ASCII + newlines
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0A || b === 0x0D || b === 0x09) s += String.fromCharCode(b);
    else if (b >= 0x20 && b <= 0x7E) s += String.fromCharCode(b);
    else s += " "; // non-ASCII byte → space (won't corrupt string positions)
  }
  return s;
}

function strToBytes2(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}
