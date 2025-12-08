/**
 * Unit tests for crypto primitives and utility functions.
 *
 * These tests cover the actual implementation of cryptographic primitives
 * and utility functions, ensuring they work correctly without mocks.
 */

import { generateKeypair, validateKeypair } from '../src/crypto/keypair';
import { toBase64Url, fromBase64Url, ensureOwnBuffer, concatBuffers } from '../src/crypto/utils';

describe('Crypto Utils', () => {
  describe('base64url encoding/decoding', () => {
    it('should encode and decode correctly', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);
      const encoded = toBase64Url(original);
      const decoded = fromBase64Url(encoded);

      expect(decoded).toEqual(original);
    });

    it('should not include padding', () => {
      const data = new Uint8Array([1, 2, 3]);
      const encoded = toBase64Url(data);

      expect(encoded).not.toContain('=');
    });

    it('should use URL-safe characters', () => {
      const data = new Uint8Array(Array(32).fill(255));
      const encoded = toBase64Url(data);

      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
    });
  });

  describe('ensureOwnBuffer', () => {
    it('should return same buffer if already owned', () => {
      const buffer = new Uint8Array([1, 2, 3]);
      const result = ensureOwnBuffer(buffer);

      expect(result).toBe(buffer);
    });

    it('should create new buffer for views', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5]);
      const view = original.subarray(1, 4);
      const result = ensureOwnBuffer(view);

      expect(result).not.toBe(view);
      expect(result).toEqual(new Uint8Array([2, 3, 4]));
    });
  });

  describe('concatBuffers', () => {
    it('should concatenate multiple buffers', () => {
      const buf1 = new Uint8Array([1, 2]);
      const buf2 = new Uint8Array([3, 4]);
      const buf3 = new Uint8Array([5, 6]);

      const result = concatBuffers(buf1, buf2, buf3);

      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('should handle empty buffers', () => {
      const buf1 = new Uint8Array([]);
      const buf2 = new Uint8Array([1, 2]);

      const result = concatBuffers(buf1, buf2);

      expect(result).toEqual(new Uint8Array([1, 2]));
    });
  });
});

describe('Keypair Generation', () => {
  it('should generate a valid ML-KEM-768 keypair', () => {
    const keypair = generateKeypair();

    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKeyB64).toBeTruthy();
    expect(typeof keypair.publicKeyB64).toBe('string');
  });

  it('should generate different keypairs each time', () => {
    const keypair1 = generateKeypair();
    const keypair2 = generateKeypair();

    expect(keypair1.publicKeyB64).not.toBe(keypair2.publicKeyB64);
  });

  it('should have correct key sizes', () => {
    const keypair = generateKeypair();

    // ML-KEM-768 key sizes
    expect(keypair.publicKey.length).toBe(1184);
    expect(keypair.secretKey.length).toBe(2400);
  });

  it('should validate a correct keypair', () => {
    const keypair = generateKeypair();

    expect(validateKeypair(keypair)).toBe(true);
  });

  it('should reject invalid keypairs', () => {
    const invalidKeypair = {
      publicKey: new Uint8Array(10),
      secretKey: new Uint8Array(10),
      publicKeyB64: 'invalid',
    };

    expect(validateKeypair(invalidKeypair)).toBe(false);
  });
});
