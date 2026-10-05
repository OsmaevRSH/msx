/** FNV-1a 32 бита по байтам UTF-8, 8 hex-символов. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    h = Math.imul(h ^ byte, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
