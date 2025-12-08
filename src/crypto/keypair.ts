/**
 * ML-KEM-768 (Kyber768) keypair generation
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { toBase64Url, fromBase64Url, ensureOwnBuffer, concatBuffers } from './utils.js';
import type { Keypair } from '../types/index.js';
import { DecryptionError } from '../types/index.js';

/**
 * ML-KEM-768 public key size in bytes
 */
export const PUBLIC_KEY_SIZE = 1184;

/**
 * ML-KEM-768 secret key size in bytes
 */
export const SECRET_KEY_SIZE = 2400;

/**
 * Generates a new ML-KEM-768 keypair for inbox encryption
 * Uses internal randomness - no seed required
 *
 * @returns A keypair containing public key, secret key, and base64url-encoded public key
 */
export function generateKeypair(): Keypair {
  const keypair = ml_kem768.keygen();

  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
    publicKeyB64: toBase64Url(keypair.publicKey),
  };
}

/**
 * Validates that a keypair has the correct structure and sizes
 *
 * @param keypair - The keypair to validate
 * @returns True if valid, false otherwise
 */
export function validateKeypair(keypair: Keypair): boolean {
  if (!keypair.publicKey || !keypair.secretKey || !keypair.publicKeyB64) {
    return false;
  }

  if (keypair.publicKey.length !== PUBLIC_KEY_SIZE) {
    return false;
  }

  if (keypair.secretKey.length !== SECRET_KEY_SIZE) {
    return false;
  }

  // Verify base64url encoding matches public key bytes
  try {
    const decodedPublicKey = fromBase64Url(keypair.publicKeyB64);
    if (decodedPublicKey.length !== keypair.publicKey.length) {
      return false;
    }

    for (let i = 0; i < decodedPublicKey.length; i++) {
      if (decodedPublicKey[i] !== keypair.publicKey[i]) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Derive AES-256 key using WebCrypto's native HKDF-SHA-512
 * Matches the reference implementation exactly
 */
export async function deriveKey(
  ikm: Uint8Array,
  context: string,
  aad: Uint8Array,
  ctKem: Uint8Array,
): Promise<Uint8Array> {
  const contextBytes = new TextEncoder().encode(context);

  // Hash KEM ciphertext for salt
  const saltBuffer = await crypto.subtle.digest('SHA-256', ctKem as unknown as BufferSource);
  const salt = new Uint8Array(saltBuffer);

  // Add aad_length prefix (4 bytes, big-endian)
  const aadLength = new Uint8Array(4);
  new DataView(aadLength.buffer).setUint32(0, aad.length, false);
  const info = concatBuffers(contextBytes, aadLength, aad);

  // Ensure buffers are owned (not views)
  const ikmClean = ensureOwnBuffer(ikm);
  const saltClean = ensureOwnBuffer(salt);
  const infoClean = ensureOwnBuffer(info);

  // Use WebCrypto's native HKDF with SHA-256(ctKem) salt
  // TypeScript doesn't recognize Uint8Array as BufferSource, but WebCrypto API accepts it
  // The cast is safe because Uint8Array implements ArrayBufferView which extends BufferSource
  const baseKey = await crypto.subtle.importKey('raw', ikmClean as unknown as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-512',
      salt: saltClean as unknown as BufferSource,
      // TypeScript doesn't recognize Uint8Array as BufferSource, but WebCrypto API accepts it
      // The cast is safe because Uint8Array implements ArrayBufferView which extends BufferSource
      info: infoClean as unknown as BufferSource,
    },
    baseKey,
    256, // 256 bits = 32 bytes for AES-256
  );

  return ensureOwnBuffer(new Uint8Array(derivedBits));
}

/**
 * Derives a public key from a secret key in ML-KEM (Kyber)
 * In ML-KEM, the public key is embedded in the secret key
 *
 * @param secretKey - The secret key bytes
 * @returns The derived public key bytes
 */
export function derivePublicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== SECRET_KEY_SIZE) {
    throw new DecryptionError(
      `Cannot derive public key: secret key has invalid length ${secretKey.length}, expected ${SECRET_KEY_SIZE}`,
    );
  }

  // In ML-KEM, the public key is appended to the secret key
  return secretKey.slice(secretKey.length - PUBLIC_KEY_SIZE);
}
