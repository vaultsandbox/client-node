/**
 * Mocks for crypto-related functions.
 *
 * This file tests the higher-level application logic for decryption and
 * signature verification. It uses mocks for the underlying cryptographic
 * primitives (`ml_dsa` and `ml_kem`) to isolate the control flow,
 * error handling, and data transformations.
 */
import * as utils from '../src/crypto/utils';
import { toBase64Url, toBase64 } from '../src/crypto/utils';
import { validateServerPublicKey, verifySignatureSafe, verifySignature } from '../src/crypto/signature';
import { validateKeypair, generateKeypair } from '../src/crypto/keypair';
import { decrypt, decryptMetadata, decryptParsed, decryptRaw } from '../src/crypto/decrypt';
import { DecryptionError, SignatureVerificationError } from '../src/types';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

// Mock dependencies
jest.mock('@noble/post-quantum/ml-dsa.js', () => ({
  ml_dsa65: {
    verify: jest.fn(),
  },
}));

jest.mock('@noble/post-quantum/ml-kem.js', () => ({
  ml_kem768: {
    keygen: jest.fn(),
    decapsulate: jest.fn(),
  },
}));

// Mock crypto.subtle
const mockImportKey = jest.fn();
const mockDeriveBits = jest.fn();
const mockDecrypt = jest.fn();
const mockDigest = jest.fn();

// Save original crypto to restore later if needed, though Jest environment usually isolates
// const originalCrypto = global.crypto;

Object.defineProperty(global, 'crypto', {
  value: {
    subtle: {
      importKey: mockImportKey,
      deriveBits: mockDeriveBits,
      decrypt: mockDecrypt,
      digest: mockDigest,
    },
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    },
  },
  writable: true,
});

describe('Crypto Mocked Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('keypair', () => {
    describe('validateKeypair', () => {
      it('should return false if properties are missing', () => {
        expect(validateKeypair({} as unknown as import('../src/types').Keypair)).toBe(false);
        expect(validateKeypair({ publicKey: new Uint8Array(1184) } as unknown as import('../src/types').Keypair)).toBe(
          false,
        );
      });

      it('should return false if key sizes are wrong', () => {
        const kp = {
          publicKey: new Uint8Array(10),
          secretKey: new Uint8Array(2400),
          publicKeyB64: 'valid',
        };
        expect(validateKeypair(kp)).toBe(false);

        const kp2 = {
          publicKey: new Uint8Array(1184),
          secretKey: new Uint8Array(10),
          publicKeyB64: 'valid',
        };
        expect(validateKeypair(kp2)).toBe(false);
      });

      it('should return false if publicKeyB64 does not match publicKey', () => {
        const pk = new Uint8Array(1184).fill(1);
        const sk = new Uint8Array(2400).fill(2);
        const kp = {
          publicKey: pk,
          secretKey: sk,
          publicKeyB64: 'mismatch',
        };
        expect(validateKeypair(kp)).toBe(false);
      });

      it('should return true for valid keypair', () => {
        const pk = new Uint8Array(1184).fill(1);
        const sk = new Uint8Array(2400).fill(2);
        const kp = {
          publicKey: pk,
          secretKey: sk,
          publicKeyB64: toBase64Url(pk),
        };
        expect(validateKeypair(kp)).toBe(true);
      });

      it('should handle exception in toBase64Url during validation', () => {
        const pk = new Uint8Array(1184).fill(1);
        const sk = new Uint8Array(2400).fill(2);
        const kp = {
          publicKey: pk,
          secretKey: sk,
          publicKeyB64: 'valid',
        };

        const spy = jest.spyOn(utils, 'fromBase64Url').mockImplementationOnce(() => {
          throw new Error('Mocked error');
        });

        expect(validateKeypair(kp)).toBe(false);
        spy.mockRestore();
      });
    });

    describe('generateKeypair', () => {
      it('should call ml_kem768.keygen', () => {
        (ml_kem768.keygen as jest.Mock).mockReturnValue({
          publicKey: new Uint8Array(1184),
          secretKey: new Uint8Array(2400),
        });
        const kp = generateKeypair();
        expect(ml_kem768.keygen).toHaveBeenCalled();
        expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      });
    });
  });

  describe('signature', () => {
    const validEncryptedData = {
      v: 1,
      ct_kem: toBase64Url(new Uint8Array(32)),
      nonce: toBase64Url(new Uint8Array(12)),
      aad: toBase64Url(new Uint8Array(10)),
      ciphertext: toBase64Url(new Uint8Array(100)),
      sig: toBase64Url(new Uint8Array(100)),
      server_sig_pk: toBase64Url(new Uint8Array(1952)),
      algs: {
        kem: 'ML-KEM-768',
        sig: 'ML-DSA-65',
        aead: 'AES-256-GCM',
        kdf: 'HKDF-SHA-512',
      },
    };

    describe('validateServerPublicKey', () => {
      it('should return true for valid size', () => {
        const pk = new Uint8Array(1952);
        expect(validateServerPublicKey(toBase64Url(pk))).toBe(true);
      });

      it('should return false for invalid size', () => {
        const pk = new Uint8Array(10);
        expect(validateServerPublicKey(toBase64Url(pk))).toBe(false);
      });

      it('should return false for invalid base64', () => {
        expect(validateServerPublicKey('invalid-base64!')).toBe(false); // '!' is not in base64url usually, but fromBase64Url might handle it or throw
        // fromBase64Url uses Buffer.from(base64, 'base64') which ignores invalid chars usually.
        // But if the length doesn't match 1952 after decoding, it returns false.
      });

      it('should return false if fromBase64Url throws', () => {
        const spy = jest.spyOn(utils, 'fromBase64Url').mockImplementationOnce(() => {
          throw new Error('Mocked error');
        });
        expect(validateServerPublicKey('some-key')).toBe(false);
        spy.mockRestore();
      });
    });

    describe('verifySignature', () => {
      it('should return true if ml_dsa65.verify returns true', () => {
        (ml_dsa65.verify as jest.Mock).mockReturnValue(true);
        expect(verifySignature(validEncryptedData)).toBe(true);
        expect(ml_dsa65.verify).toHaveBeenCalled();
      });

      it('should throw SignatureVerificationError if verify returns false', () => {
        (ml_dsa65.verify as jest.Mock).mockReturnValue(false);
        expect(() => verifySignature(validEncryptedData)).toThrow(SignatureVerificationError);
      });

      it('should throw SignatureVerificationError if decoding fails', () => {
        // Actually fromBase64Url might not throw, but let's assume it produces something.
        // If we pass something that causes error in buildTranscript or verify
        (ml_dsa65.verify as jest.Mock).mockImplementation(() => {
          throw new Error('Random error');
        });
        expect(() => verifySignature(validEncryptedData)).toThrow(SignatureVerificationError);
      });
    });

    describe('verifySignatureSafe', () => {
      it('should return true when verifySignature succeeds', () => {
        (ml_dsa65.verify as jest.Mock).mockReturnValue(true);
        expect(verifySignatureSafe(validEncryptedData)).toBe(true);
      });

      it('should return false when verifySignature throws', () => {
        (ml_dsa65.verify as jest.Mock).mockReturnValue(false);
        expect(verifySignatureSafe(validEncryptedData)).toBe(false);
      });
    });
  });

  describe('decrypt', () => {
    const mockKeypair = {
      publicKey: new Uint8Array(1184),
      secretKey: new Uint8Array(2400),
      publicKeyB64: 'pk',
    };

    const validEncryptedData = {
      v: 1,
      ct_kem: toBase64Url(new Uint8Array(32)),
      nonce: toBase64Url(new Uint8Array(12)),
      aad: toBase64Url(new Uint8Array(10)),
      ciphertext: toBase64Url(new Uint8Array(100)),
      sig: toBase64Url(new Uint8Array(100)),
      server_sig_pk: toBase64Url(new Uint8Array(1952)),
      algs: {
        kem: 'ML-KEM-768',
        sig: 'ML-DSA-65',
        aead: 'AES-256-GCM',
        kdf: 'HKDF-SHA-512',
      },
    };

    beforeEach(() => {
      (ml_dsa65.verify as jest.Mock).mockReturnValue(true);
      (ml_kem768.decapsulate as jest.Mock).mockReturnValue(new Uint8Array(32));
      mockImportKey.mockResolvedValue('mockKey');
      mockDeriveBits.mockResolvedValue(new ArrayBuffer(32));
      mockDecrypt.mockResolvedValue(new ArrayBuffer(10));
      mockDigest.mockResolvedValue(new ArrayBuffer(32)); // SHA-256 produces 32 bytes
    });

    it('should decrypt successfully', async () => {
      const result = await decrypt(validEncryptedData, mockKeypair);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(ml_dsa65.verify).toHaveBeenCalled();
      expect(ml_kem768.decapsulate).toHaveBeenCalled();
      expect(mockDigest).toHaveBeenCalled(); // SHA-256 for salt derivation
      expect(mockImportKey).toHaveBeenCalledTimes(2); // HKDF and AES
      expect(mockDecrypt).toHaveBeenCalled();
    });

    it('should throw SignatureVerificationError if signature invalid', async () => {
      (ml_dsa65.verify as jest.Mock).mockReturnValue(false);
      await expect(decrypt(validEncryptedData, mockKeypair)).rejects.toThrow(SignatureVerificationError);
    });

    it('should throw DecryptionError if crypto operation fails', async () => {
      mockDecrypt.mockRejectedValue(new Error('Decrypt failed'));
      await expect(decrypt(validEncryptedData, mockKeypair)).rejects.toThrow(DecryptionError);
    });

    it('should re-throw DecryptionError if it occurs', async () => {
      (ml_kem768.decapsulate as jest.Mock).mockImplementationOnce(() => {
        throw new DecryptionError('Inner decryption error');
      });
      await expect(decrypt(validEncryptedData, mockKeypair)).rejects.toThrow(DecryptionError);
    });

    describe('decryptMetadata', () => {
      it('should decrypt and parse JSON', async () => {
        const mockJson = JSON.stringify({ subject: 'Hello' });
        mockDecrypt.mockResolvedValue(new TextEncoder().encode(mockJson).buffer);

        const result = await decryptMetadata(validEncryptedData, mockKeypair);
        expect(result).toEqual({ subject: 'Hello' });
      });

      it('should throw DecryptionError if JSON parse fails', async () => {
        mockDecrypt.mockResolvedValue(new TextEncoder().encode('invalid json').buffer);

        await expect(decryptMetadata(validEncryptedData, mockKeypair)).rejects.toThrow(DecryptionError);
      });
    });

    describe('decryptParsed', () => {
      it('should alias decryptMetadata', async () => {
        const mockJson = JSON.stringify({ text: 'Body' });
        mockDecrypt.mockResolvedValue(new TextEncoder().encode(mockJson).buffer);

        const result = await decryptParsed(validEncryptedData, mockKeypair);
        expect(result).toEqual({ text: 'Body' });
      });
    });

    describe('decryptRaw', () => {
      it('should decode base64-encoded raw email', async () => {
        const rawContent = 'From: me@example.com';
        const base64Raw = toBase64(new TextEncoder().encode(rawContent));
        mockDecrypt.mockResolvedValue(new TextEncoder().encode(base64Raw).buffer);

        const result = await decryptRaw(validEncryptedData, mockKeypair);
        expect(result).toBe(rawContent);
      });
    });
  });
});
