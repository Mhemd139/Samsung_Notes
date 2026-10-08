const MAX_NAME_BYTES = 200;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(\.|$)/i;
const encoder = new TextEncoder();

export function cleanName(name: string, maxBytes = MAX_NAME_BYTES): string {
  const clean = cutToBytes(
    name
      .replace(/[\t\n\r\v\f]/g, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/g, " ")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, ""),
    maxBytes,
  ).replace(/[. ]+$/, "");
  return RESERVED.test(clean) ? `_${clean}` : clean;
}

function cutToBytes(value: string, max: number): string {
  let bytes = 0;
  let out = "";
  for (const char of value) {
    bytes += encoder.encode(char).length;
    if (bytes > max) break;
    out += char;
  }
  return out;
}
