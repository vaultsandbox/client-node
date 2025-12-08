/**
 * Centralized cryptographic constants for the VaultSandbox client
 */

/**
 * HKDF context string used for key derivation
 * This context ensures that derived keys are bound to this specific application and version
 */
export const HKDF_CONTEXT = 'vaultsandbox:email:v1';

/**
 * ML-DSA-65 (Dilithium3) public key size in bytes
 * This is the standard size for ML-DSA-65 public keys
 */
export const MLDSA65_PUBLIC_KEY_SIZE = 1952;
