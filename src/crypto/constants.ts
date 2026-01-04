/**
 * Centralized cryptographic constants for the VaultSandbox client
 * See vaultsandbox-spec.md Appendix B: Size Constants
 */

/**
 * HKDF context string used for key derivation
 * This context ensures that derived keys are bound to this specific application and version
 */
export const HKDF_CONTEXT = 'vaultsandbox:email:v1';

/**
 * Algorithm suite identifier string
 */
export const ALGORITHM_SUITE = 'ML-KEM-768:ML-DSA-65:AES-256-GCM:HKDF-SHA-512';

// ===== ML-KEM-768 Constants =====

/**
 * ML-KEM-768 public key size in bytes
 */
export const MLKEM_PUBLIC_KEY_SIZE = 1184;

/**
 * ML-KEM-768 secret key size in bytes
 */
export const MLKEM_SECRET_KEY_SIZE = 2400;

/**
 * ML-KEM-768 ciphertext size in bytes
 */
export const MLKEM_CIPHERTEXT_SIZE = 1088;

/**
 * ML-KEM-768 shared secret size in bytes
 */
export const MLKEM_SHARED_SECRET_SIZE = 32;

/**
 * Offset of public key within secret key in bytes
 * The public key is embedded in the secret key at this offset
 */
export const MLKEM_PUBLIC_KEY_OFFSET = 1152;

// ===== ML-DSA-65 Constants =====

/**
 * ML-DSA-65 public key size in bytes
 */
export const MLDSA_PUBLIC_KEY_SIZE = 1952;

/**
 * ML-DSA-65 signature size in bytes
 */
export const MLDSA_SIGNATURE_SIZE = 3309;

// ===== AES-256-GCM Constants =====

/**
 * AES-256 key size in bytes
 */
export const AES_KEY_SIZE = 32;

/**
 * AES-GCM nonce size in bytes
 */
export const AES_NONCE_SIZE = 12;

/**
 * AES-GCM authentication tag size in bytes
 */
export const AES_TAG_SIZE = 16;

// ===== Export Format Constants =====

/**
 * Current export format version
 */
export const EXPORT_VERSION = 1;

/**
 * Current protocol version
 */
export const PROTOCOL_VERSION = 1;
