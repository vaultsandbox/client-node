/**
 * ML-DSA-65 (Dilithium3) signature verification
 * Based on working reference implementation
 */

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { fromBase64Url, ensureOwnBuffer, concatBuffers } from './utils.js';
import { SignatureVerificationError } from '../types/index.js';
import type { EncryptedData } from '../types/index.js';
import { HKDF_CONTEXT, MLDSA65_PUBLIC_KEY_SIZE } from './constants.js';

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
 * @returns True if signature is valid
 * @throws SignatureVerificationError if verification fails
 */
export function verifySignature(encryptedData: EncryptedData): boolean {
  try {
    // 1. Decode all components
    const signature = fromBase64Url(encryptedData.sig);
    const ctKem = fromBase64Url(encryptedData.ct_kem);
    const nonceBytes = fromBase64Url(encryptedData.nonce);
    const aadBytes = fromBase64Url(encryptedData.aad);
    const ciphertextBytes = fromBase64Url(encryptedData.ciphertext);
    const serverSigPk = fromBase64Url(encryptedData.server_sig_pk);

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
    throw new SignatureVerificationError(
      `Signature verification error: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    return publicKey.length === MLDSA65_PUBLIC_KEY_SIZE;
  } catch {
    return false;
  }
}
