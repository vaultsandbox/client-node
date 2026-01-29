/**
 * ML-DSA-65 (Dilithium3) signature verification
 * Based on working reference implementation
 */

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { fromBase64Url, ensureOwnBuffer, concatBuffers } from './utils.js';
import { SignatureVerificationError } from '../types/index.js';
import type { EncryptedData } from '../types/index.js';
import { HKDF_CONTEXT, MLDSA_PUBLIC_KEY_SIZE } from './constants.js';
// Type-only import to avoid circular dependency at runtime
import type { DecodedPayload } from './decrypt.js';

/**
 * Builds the algorithm ciphersuite string from algs object
 */
function buildAlgsCiphersuite(algs: { kem: string; sig: string; aead: string; kdf: string }): string {
  return `${algs.kem}:${algs.sig}:${algs.aead}:${algs.kdf}`;
}

/**
 * Build transcript for signature verification
 * This matches the server-side transcript construction exactly
 */
function buildTranscript(
  version: number,
  algsCiphersuite: string,
  ctKem: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  serverSigPk: Uint8Array,
  context: string,
): Uint8Array {
  const versionBytes = new Uint8Array([version]);
  const algsBytes = new TextEncoder().encode(algsCiphersuite);
  const contextBytes = new TextEncoder().encode(context);
  return concatBuffers(versionBytes, algsBytes, contextBytes, ctKem, nonce, aad, ciphertext, serverSigPk);
}

/**
 * Verifies an ML-DSA-65 signature on encrypted data
 * IMPORTANT: Must be called BEFORE decryption for security
 *
 * @param encryptedData - The encrypted data with signature
 * @param decoded - Optional pre-decoded payload fields to avoid redundant decoding
 * @param expectedServerPublicKey - Optional expected server public key (base64url) to validate against
 * @returns True if signature is valid
 * @throws SignatureVerificationError if verification fails or server key doesn't match expected
 */
export function verifySignature(
  encryptedData: EncryptedData,
  decoded?: DecodedPayload,
  expectedServerPublicKey?: string,
): boolean {
  try {
    // 0. Validate server public key matches expected (MITM protection)
    if (expectedServerPublicKey && encryptedData.server_sig_pk !== expectedServerPublicKey) {
      throw new SignatureVerificationError(
        'Server public key mismatch - possible MITM attack. ' +
          'The encrypted data was signed by a different server than expected.',
      );
    }

    // 1. Use pre-decoded values or decode components
    const signature = decoded?.sig ?? fromBase64Url(encryptedData.sig);
    const ctKem = decoded?.ctKem ?? fromBase64Url(encryptedData.ct_kem);
    const nonceBytes = decoded?.nonce ?? fromBase64Url(encryptedData.nonce);
    const aadBytes = decoded?.aad ?? fromBase64Url(encryptedData.aad);
    const ciphertextBytes = decoded?.ciphertext ?? fromBase64Url(encryptedData.ciphertext);
    const serverSigPk = decoded?.serverSigPk ?? fromBase64Url(encryptedData.server_sig_pk);

    // 2. Build the transcript (exactly as the server did)
    const algsCiphersuite = buildAlgsCiphersuite(encryptedData.algs);
    const transcript = buildTranscript(
      encryptedData.v,
      algsCiphersuite,
      ctKem,
      nonceBytes,
      aadBytes,
      ciphertextBytes,
      serverSigPk,
      HKDF_CONTEXT,
    );

    // 3. Verify the signature
    // Noble's ML-DSA verify signature order: (signature, message, publicKey)
    const isValid = ml_dsa65.verify(
      ensureOwnBuffer(signature),
      ensureOwnBuffer(transcript),
      ensureOwnBuffer(serverSigPk),
    );

    if (!isValid) {
      throw new SignatureVerificationError('SIGNATURE VERIFICATION FAILED - Data may be tampered!');
    }

    return true;
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      throw error;
    }
    /* istanbul ignore next - defensive for non-Error exceptions */
    const message = error instanceof Error ? error.message : String(error);
    throw new SignatureVerificationError(`Signature verification error: ${message}`);
  }
}

/**
 * Verifies a signature without throwing an error
 *
 * @param encryptedData - The encrypted data with signature
 * @returns True if signature is valid, false otherwise
 */
export function verifySignatureSafe(encryptedData: EncryptedData): boolean {
  try {
    return verifySignature(encryptedData);
  } catch {
    return false;
  }
}

/**
 * Validates that a server public key has the correct format and size
 *
 * @param serverPublicKey - The server's public key (base64url)
 * @returns True if valid, false otherwise
 */
export function validateServerPublicKey(serverPublicKey: string): boolean {
  try {
    const publicKey = fromBase64Url(serverPublicKey);
    return publicKey.length === MLDSA_PUBLIC_KEY_SIZE;
  } catch {
    return false;
  }
}
