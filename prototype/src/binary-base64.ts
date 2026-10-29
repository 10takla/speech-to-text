export function base64(bytes: Uint8Array): string {
  let value = '';
  for (let i = 0; i < bytes.length; i += 32_768) value += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  return btoa(value);
}
