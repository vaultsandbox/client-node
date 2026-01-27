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
import {
  HKDF_CONTEXT,
  PROTOCOL_VERSION,
  MLKEM_CIPHERTEXT_SIZE,
  AES_NONCE_SIZE,
  MLDSA_SIGNATURE_SIZE,
  MLDSA_PUBLIC_KEY_SIZE,
} from './constants.js';

/**
 * Pre-decoded payload fields to avoid redundant base64 decoding.
 * Used to pass decoded values between validation, signature verification, and decryption.
 */
export interface DecodedPayload {
  ctKem: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
  sig: Uint8Array;
  serverSigPk: Uint8Array;
}

/**
 * Decodes all base64url-encoded fields from the encrypted payload.
 * Call once and pass the result to validatePayload, verifySignature, and decrypt operations.
 *
 * @param encryptedData - The encrypted data from the server
 * @returns Pre-decoded payload fields
 * @throws DecryptionError if decoding fails
 */
export function decodePayload(encryptedData: EncryptedData): DecodedPayload {
  try {
    return {
      ctKem: fromBase64Url(encryptedData.ct_kem),
      nonce: fromBase64Url(encryptedData.nonce),
      aad: fromBase64Url(encryptedData.aad),
      ciphertext: fromBase64Url(encryptedData.ciphertext),
      sig: fromBase64Url(encryptedData.sig),
      serverSigPk: fromBase64Url(encryptedData.server_sig_pk),
    };
  } catch (error) {
    /* istanbul ignore next - defensive for non-Error exceptions */
    const message = error instanceof Error ? error.message : String(error);
    throw new DecryptionError(`Failed to decode payload: ${message}`);
  }
}

/**
 * Validates the encrypted payload structure and sizes per spec Section 8.1
 * @param encryptedData - The encrypted payload metadata
 * @param decoded - Optional pre-decoded payload fields to avoid redundant decoding
 * @throws DecryptionError if validation fails
 */
function validatePayload(encryptedData: EncryptedData, decoded?: DecodedPayload): void {
  // Step 2: Validate version
  if (encryptedData.v !== PROTOCOL_VERSION) {
    throw new DecryptionError(`Unsupported protocol version: ${encryptedData.v}, expected ${PROTOCOL_VERSION}`);
  }

  // Step 3: Validate algorithms
  const { algs } = encryptedData;
  if (algs.kem !== 'ML-KEM-768') {
    throw new DecryptionError(`Unsupported KEM algorithm: ${algs.kem}`);
  }
  if (algs.sig !== 'ML-DSA-65') {
    throw new DecryptionError(`Unsupported signature algorithm: ${algs.sig}`);
  }
  if (algs.aead !== 'AES-256-GCM') {
    throw new DecryptionError(`Unsupported AEAD algorithm: ${algs.aead}`);
  }
  if (algs.kdf !== 'HKDF-SHA-512') {
    throw new DecryptionError(`Unsupported KDF algorithm: ${algs.kdf}`);
  }

  // Step 4: Validate decoded sizes (use pre-decoded values if available)
  /* istanbul ignore next - decoded is always passed from decrypt(), fallback is defensive */
  const { ctKem, nonce, sig, serverSigPk } = decoded ?? decodePayload(encryptedData);

  if (ctKem.length !== MLKEM_CIPHERTEXT_SIZE) {
    throw new DecryptionError(`Invalid ct_kem size: expected ${MLKEM_CIPHERTEXT_SIZE}, got ${ctKem.length}`);
  }

  if (nonce.length !== AES_NONCE_SIZE) {
    throw new DecryptionError(`Invalid nonce size: expected ${AES_NONCE_SIZE}, got ${nonce.length}`);
  }

  if (sig.length !== MLDSA_SIGNATURE_SIZE) {
    throw new DecryptionError(`Invalid signature size: expected ${MLDSA_SIGNATURE_SIZE}, got ${sig.length}`);
  }

  if (serverSigPk.length !== MLDSA_PUBLIC_KEY_SIZE) {
    throw new DecryptionError(
      `Invalid server public key size: expected ${MLDSA_PUBLIC_KEY_SIZE}, got ${serverSigPk.length}`,
    );
  }
}

/**
 * Decrypts an encrypted payload using the complete reference implementation flow
 * See vaultsandbox-spec.md Section 8: Decryption Process
 *
 * @param encryptedData - The encrypted data from the server
 * @param keypair - The recipient's keypair
 * @returns The decrypted plaintext as a Uint8Array
 * @throws DecryptionError if decryption fails
 */
export async function decrypt(encryptedData: EncryptedData, keypair: Keypair): Promise<Uint8Array> {
  try {
    // Step 1: Decode all base64url fields once
    const decoded = decodePayload(encryptedData);

    // Steps 2-4: Parse and validate payload (version, algorithms, sizes)
    validatePayload(encryptedData, decoded);

    // Step 6: SECURITY: Verify signature BEFORE decryption (prevent tampering)
    verifySignature(encryptedData, decoded);

    // Step 7-9: Use pre-decoded values for decapsulation, key derivation, and decryption
    const { ctKem, nonce: nonceBytes, aad: aadBytes, ciphertext: ciphertextBytes } = decoded;

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
    /* istanbul ignore next - defensive for non-Error exceptions */
    const message = error instanceof Error ? error.message : String(error);
    throw new DecryptionError(`Decryption failed: ${message}`);
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
    /* istanbul ignore next - defensive for non-Error exceptions */
    const message = error instanceof Error ? error.message : String(error);
    throw new DecryptionError(`Failed to parse decrypted metadata: ${message}`);
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
    /* istanbul ignore next - defensive for non-Error exceptions */
    const message = error instanceof Error ? error.message : String(error);
    throw new DecryptionError(`Failed to decode decrypted raw email: ${message}`);
  }
}
