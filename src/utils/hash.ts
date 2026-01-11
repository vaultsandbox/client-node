/**
 * Hash utilities for email synchronization
 */

import { createHash } from 'crypto';

/**
 * Computes the emails hash using the spec algorithm:
 * BASE64URL(SHA256(SORT(emailIds).join(",")))
 *
 * This hash is used to efficiently detect changes between
 * the local and server email lists without transferring
 * the full list.
 *
 * @param emailIds - Array of email IDs to hash
 * @returns Base64URL encoded SHA-256 hash (no padding)
 */
export function computeEmailsHash(emailIds: string[]): string {
  const sorted = [...emailIds].sort();
  const joined = sorted.join(',');
  const hash = createHash('sha256').update(joined).digest();
  return base64UrlEncode(hash);
}

/**
 * Encodes a buffer as Base64URL (RFC 4648 §5) without padding.
 *
 * @param buffer - The buffer to encode
 * @returns Base64URL encoded string without padding
 */
function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
