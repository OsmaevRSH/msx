export function b64urlEncode(s: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Бросает, если строка не base64url или внутри не UTF-8. */
export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
