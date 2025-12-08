/**
 * Crypto utilities for base64url encoding/decoding and buffer operations
 */

/**
 * Converts a Uint8Array to a base64url-encoded string (no padding)
 */
export function toBase64Url(buffer: Uint8Array): string {
  const base64 = Buffer.from(buffer).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Converts a base64url-encoded string to a Uint8Array
 */
export function fromBase64Url(base64url: string): Uint8Array {
  // Add padding if needed
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Ensures a buffer is owned (not a view) for WebCrypto compatibility.
 * WebCrypto operations require buffers to be properly aligned and owned.
 */
export function ensureOwnBuffer(buffer: Uint8Array): Uint8Array {
  // Check if buffer is a view of another buffer
  if (buffer.byteOffset !== 0 || buffer.byteLength !== buffer.buffer.byteLength) {
    // Create a new buffer with copied data
    return new Uint8Array(buffer);
  }
  return buffer;
}

/**
 * Concatenates multiple Uint8Arrays into a single Uint8Array
 */
export function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

/**
 * Converts a Uint8Array to a standard base64-encoded string
 */
export function toBase64(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString('base64');
}

/**
 * Converts a standard base64-encoded string to a Uint8Array
 */
export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
