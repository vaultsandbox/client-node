/**
 * Email decryption using ML-KEM-768 + AES-256-GCM with HKDF-SHA-512
 * Based on working reference implementation
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { fromBase64Url, ensureOwnBuffer, fromBase64 } from './utils.js';
import { DecryptionError, SignatureVerificationError } from '../types/index.js';
import type { Keypair, EncryptedData } from '../types/index.js';
import { verifySignature } from './signature.js';
import { deriveKey } from './keypair.js';
import { HKDF_CONTEXT } from './constants.js';

/**
 * Decrypts an encrypted payload using the complete reference implementation flow
 *
 * @param encryptedData - The encrypted data from the server
 * @param keypair - The recipient's keypair
 * @returns The decrypted plaintext as a Uint8Array
 * @throws DecryptionError if decryption fails
 */
export async function decrypt(encryptedData: EncryptedData, keypair: Keypair): Promise<Uint8Array> {
  try {
    // 0. SECURITY: Verify signature BEFORE decryption (prevent tampering)
    verifySignature(encryptedData);

    // 1. Decode all components
    const ctKem = fromBase64Url(encryptedData.ct_kem);
    const nonceBytes = fromBase64Url(encryptedData.nonce);
    const aadBytes = fromBase64Url(encryptedData.aad);
    const ciphertextBytes = fromBase64Url(encryptedData.ciphertext);

    // 2. KEM Decapsulation to get shared secret
    const sharedSecret = ml_kem768.decapsulate(ctKem, ensureOwnBuffer(keypair.secretKey));

    // 3. Derive AES-256 key using HKDF-SHA-512
    const aesKey = await deriveKey(sharedSecret, HKDF_CONTEXT, aadBytes, ctKem);

    // 4. Decrypt with AES-256-GCM
    // Ensure all buffers are properly aligned
    const aesKeyClean = ensureOwnBuffer(aesKey);
    const nonceClean = ensureOwnBuffer(nonceBytes);
    const aadClean = ensureOwnBuffer(aadBytes);
    const ciphertextClean = ensureOwnBuffer(ciphertextBytes);

    // TypeScript doesn't recognize Uint8Array as BufferSource, but WebCrypto API accepts it
    // The cast is safe because Uint8Array implements ArrayBufferView which extends BufferSource
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      aesKeyClean as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    // TypeScript doesn't recognize Uint8Array as BufferSource, but WebCrypto API accepts it
    // The cast is safe because Uint8Array implements ArrayBufferView which extends BufferSource
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonceClean as unknown as BufferSource,
        additionalData: aadClean as unknown as BufferSource,
        tagLength: 128, // 16 bytes
      },
      cryptoKey,
      ciphertextClean as unknown as BufferSource,
    );

    return new Uint8Array(plaintext);
  } catch (error) {
    // Re-throw signature verification errors as-is (critical security failures)
    if (error instanceof SignatureVerificationError) {
      throw error;
    }
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Decrypts and parses email metadata
 *
 * @param encryptedData - The encrypted metadata
 * @param keypair - The recipient's keypair
 * @returns The decrypted metadata as a parsed JSON object
 * @throws DecryptionError if decryption or parsing fails
 */
export async function decryptMetadata<T = unknown>(encryptedData: EncryptedData, keypair: Keypair): Promise<T> {
  const plaintext = await decrypt(encryptedData, keypair);
  try {
    const jsonString = new TextDecoder().decode(plaintext);
    return JSON.parse(jsonString) as T;
  } catch (error) {
    throw new DecryptionError(
      `Failed to parse decrypted metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Decrypts and parses email body (parsed content)
 *
 * @param encryptedData - The encrypted parsed content
 * @param keypair - The recipient's keypair
 * @returns The decrypted parsed content as a JSON object
 * @throws DecryptionError if decryption or parsing fails
 */
export async function decryptParsed<T = unknown>(encryptedData: EncryptedData, keypair: Keypair): Promise<T> {
  return decryptMetadata<T>(encryptedData, keypair);
}

/**
 * Decrypts raw email source
 *
 * @param encryptedData - The encrypted raw email
 * @param keypair - The recipient's keypair
 * @returns The decrypted raw email as a string
 * @throws DecryptionError if decryption fails
 */
export async function decryptRaw(encryptedData: EncryptedData, keypair: Keypair): Promise<string> {
  const plaintext = await decrypt(encryptedData, keypair);
  try {
    // Decrypted content is a base64-encoded string
    const base64String = new TextDecoder().decode(plaintext);
    // Decode the base64 to get the actual raw email content
    const rawEmailBytes = fromBase64(base64String);
    return new TextDecoder().decode(rawEmailBytes);
  } catch (error) {
    throw new DecryptionError(
      `Failed to decode decrypted raw email: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
