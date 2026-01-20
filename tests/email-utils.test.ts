/**
 * Tests for email-utils.ts
 * Covers all branches for findMatchingEmail and matchesFilters functions.
 */

import {
  findMatchingEmail,
  matchesFilters,
  decryptEmailData,
  isEncryptedEmailData,
  decodeBase64EmailData,
} from '../src/utils/email-utils';
import type {
  IEmail,
  EmailData,
  Keypair,
  AttachmentData,
  PlainEmailData,
  EncryptedEmailData,
} from '../src/types/index';
import * as decryptModule from '../src/crypto/decrypt';
import * as signatureModule from '../src/crypto/signature';
import * as utilsModule from '../src/crypto/utils';
import { Email } from '../src/email';

// Mock dependencies
jest.mock('../src/crypto/decrypt');
jest.mock('../src/crypto/signature');
jest.mock('../src/email');

// Create a mock email factory for testing
function createMockEmail(overrides: Partial<IEmail> = {}): IEmail {
  return {
    id: 'test-id',
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    subject: 'Test Subject',
    receivedAt: new Date(),
    isRead: false,
    text: 'Test body',
    html: '<p>Test body</p>',
    attachments: [],
    links: [],
    headers: {},
    authResults: {
      validate: () => ({
        passed: true,
        spfPassed: true,
        dkimPassed: true,
        dmarcPassed: true,
        reverseDnsPassed: true,
        failures: [],
      }),
    },
    metadata: {},
    markAsRead: jest.fn(),
    delete: jest.fn(),
    getRaw: jest.fn(),
    isSpam: () => null,
    getSpamScore: () => null,
    ...overrides,
  };
}

describe('email-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('matchesFilters', () => {
    describe('subject filter', () => {
      it('should return true when no filters are specified', () => {
        const email = createMockEmail();
        expect(matchesFilters(email, {})).toBe(true);
      });

      it('should return true when subject string matches', () => {
        const email = createMockEmail({ subject: 'Welcome to our service' });
        expect(matchesFilters(email, { subject: 'Welcome' })).toBe(true);
      });

      it('should return false when subject string does not match', () => {
        const email = createMockEmail({ subject: 'Welcome to our service' });
        expect(matchesFilters(email, { subject: 'Goodbye' })).toBe(false);
      });

      it('should return true when subject RegExp matches', () => {
        const email = createMockEmail({ subject: 'Order #12345 confirmed' });
        expect(matchesFilters(email, { subject: /Order #\d+/ })).toBe(true);
      });

      it('should return false when subject RegExp does not match', () => {
        const email = createMockEmail({ subject: 'Welcome message' });
        expect(matchesFilters(email, { subject: /Order #\d+/ })).toBe(false);
      });
    });

    describe('from filter', () => {
      it('should return true when from string matches', () => {
        const email = createMockEmail({ from: 'noreply@company.com' });
        expect(matchesFilters(email, { from: 'company.com' })).toBe(true);
      });

      it('should return false when from string does not match', () => {
        const email = createMockEmail({ from: 'noreply@company.com' });
        expect(matchesFilters(email, { from: 'other.com' })).toBe(false);
      });

      it('should return true when from RegExp matches', () => {
        const email = createMockEmail({ from: 'support@company.com' });
        expect(matchesFilters(email, { from: /support@.*\.com/ })).toBe(true);
      });

      it('should return false when from RegExp does not match', () => {
        const email = createMockEmail({ from: 'sales@company.com' });
        expect(matchesFilters(email, { from: /support@.*\.com/ })).toBe(false);
      });
    });

    describe('predicate filter', () => {
      it('should return true when predicate returns true', () => {
        const email = createMockEmail({ attachments: [{ filename: 'doc.pdf' } as AttachmentData] });
        expect(matchesFilters(email, { predicate: (e) => e.attachments.length > 0 })).toBe(true);
      });

      it('should return false when predicate returns false', () => {
        const email = createMockEmail({ attachments: [] });
        expect(matchesFilters(email, { predicate: (e) => e.attachments.length > 0 })).toBe(false);
      });
    });

    describe('combined filters', () => {
      it('should return true when all filters match', () => {
        const email = createMockEmail({
          subject: 'Invoice #123',
          from: 'billing@company.com',
          attachments: [{ filename: 'invoice.pdf' } as AttachmentData],
        });
        expect(
          matchesFilters(email, {
            subject: 'Invoice',
            from: /billing@/,
            predicate: (e) => e.attachments.length > 0,
          }),
        ).toBe(true);
      });

      it('should return false when subject filter fails', () => {
        const email = createMockEmail({
          subject: 'Receipt #123',
          from: 'billing@company.com',
        });
        expect(matchesFilters(email, { subject: 'Invoice', from: 'billing' })).toBe(false);
      });

      it('should return false when from filter fails', () => {
        const email = createMockEmail({
          subject: 'Invoice #123',
          from: 'sales@company.com',
        });
        expect(matchesFilters(email, { subject: 'Invoice', from: 'billing' })).toBe(false);
      });

      it('should return false when predicate fails despite other filters passing', () => {
        const email = createMockEmail({
          subject: 'Invoice #123',
          from: 'billing@company.com',
          attachments: [],
        });
        expect(
          matchesFilters(email, {
            subject: 'Invoice',
            from: 'billing',
            predicate: (e) => e.attachments.length > 0,
          }),
        ).toBe(false);
      });
    });
  });

  describe('findMatchingEmail', () => {
    it('should return null for empty array', () => {
      expect(findMatchingEmail([], {})).toBeNull();
    });

    it('should return first matching email', () => {
      const email1 = createMockEmail({ id: '1', subject: 'First' });
      const email2 = createMockEmail({ id: '2', subject: 'Second' });
      const result = findMatchingEmail([email1, email2], { subject: 'First' });
      expect(result).toBe(email1);
    });

    it('should return null when no emails match', () => {
      const email1 = createMockEmail({ id: '1', subject: 'First' });
      const email2 = createMockEmail({ id: '2', subject: 'Second' });
      const result = findMatchingEmail([email1, email2], { subject: 'Third' });
      expect(result).toBeNull();
    });

    it('should return first match when multiple emails match', () => {
      const email1 = createMockEmail({ id: '1', subject: 'Welcome message' });
      const email2 = createMockEmail({ id: '2', subject: 'Welcome back' });
      const result = findMatchingEmail([email1, email2], { subject: 'Welcome' });
      expect(result).toBe(email1);
    });

    it('should skip non-matching emails and return later match', () => {
      const email1 = createMockEmail({ id: '1', subject: 'First' });
      const email2 = createMockEmail({ id: '2', subject: 'Target' });
      const email3 = createMockEmail({ id: '3', subject: 'Third' });
      const result = findMatchingEmail([email1, email2, email3], { subject: 'Target' });
      expect(result).toBe(email2);
    });
  });

  describe('decryptEmailData', () => {
    const mockKeypair: Keypair = {
      publicKey: new Uint8Array(1184),
      secretKey: new Uint8Array(2400),
      publicKeyB64: 'test-pk',
    };

    const mockEmailData: EmailData = {
      id: 'email-123',
      inboxId: 'inbox-456',
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: false,
      encryptedMetadata: {
        v: 1,
        ct_kem: 'ct',
        nonce: 'nonce',
        aad: 'aad',
        ciphertext: 'cipher',
        sig: 'sig',
        server_sig_pk: 'pk',
        algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
      },
    };

    const mockApiClient = {} as import('../src/http/api-client').ApiClient;

    beforeEach(() => {
      (signatureModule.verifySignature as jest.Mock).mockReturnValue(true);
      (decryptModule.decryptMetadata as jest.Mock).mockResolvedValue({
        from: 'test@example.com',
        to: ['recipient@example.com'],
        subject: 'Test',
      });
      (decryptModule.decryptParsed as jest.Mock).mockResolvedValue({
        text: 'body',
        html: '<p>body</p>',
        headers: {},
        attachments: [],
      });
      (Email as jest.Mock).mockImplementation(() => createMockEmail());
    });

    it('should decrypt email without encryptedParsed', async () => {
      await decryptEmailData(mockEmailData, mockKeypair, 'test@example.com', mockApiClient);

      expect(signatureModule.verifySignature).toHaveBeenCalledWith(mockEmailData.encryptedMetadata);
      expect(decryptModule.decryptMetadata).toHaveBeenCalledWith(mockEmailData.encryptedMetadata, mockKeypair);
      expect(decryptModule.decryptParsed).not.toHaveBeenCalled();
    });

    it('should decrypt email with encryptedParsed', async () => {
      const emailDataWithParsed: EmailData = {
        ...mockEmailData,
        encryptedParsed: {
          v: 1,
          ct_kem: 'ct2',
          nonce: 'nonce2',
          aad: 'aad2',
          ciphertext: 'cipher2',
          sig: 'sig2',
          server_sig_pk: 'pk2',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      await decryptEmailData(emailDataWithParsed, mockKeypair, 'test@example.com', mockApiClient);

      expect(signatureModule.verifySignature).toHaveBeenCalledTimes(2);
      expect(decryptModule.decryptParsed).toHaveBeenCalledWith(emailDataWithParsed.encryptedParsed, mockKeypair);
    });

    it('should convert base64 string attachment content to Uint8Array', async () => {
      const base64Content = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
      const expectedUint8Array = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);

      (decryptModule.decryptParsed as jest.Mock).mockResolvedValue({
        text: 'body',
        html: '<p>body</p>',
        headers: {},
        attachments: [
          {
            filename: 'test.txt',
            contentType: 'text/plain',
            size: 11,
            content: base64Content,
          },
        ],
      });

      // Mock fromBase64 to return expected Uint8Array
      jest.spyOn(utilsModule, 'fromBase64').mockReturnValue(expectedUint8Array);

      const emailDataWithParsed: EmailData = {
        ...mockEmailData,
        encryptedParsed: {
          v: 1,
          ct_kem: 'ct2',
          nonce: 'nonce2',
          aad: 'aad2',
          ciphertext: 'cipher2',
          sig: 'sig2',
          server_sig_pk: 'pk2',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      await decryptEmailData(emailDataWithParsed, mockKeypair, 'test@example.com', mockApiClient);

      expect(utilsModule.fromBase64).toHaveBeenCalledWith(base64Content);
    });

    it('should preserve attachment content that is already Uint8Array', async () => {
      const existingUint8Array = new Uint8Array([1, 2, 3, 4, 5]);

      (decryptModule.decryptParsed as jest.Mock).mockResolvedValue({
        text: 'body',
        html: '<p>body</p>',
        headers: {},
        attachments: [
          {
            filename: 'test.bin',
            contentType: 'application/octet-stream',
            size: 5,
            content: existingUint8Array,
          },
        ],
      });

      const emailDataWithParsed: EmailData = {
        ...mockEmailData,
        encryptedParsed: {
          v: 1,
          ct_kem: 'ct2',
          nonce: 'nonce2',
          aad: 'aad2',
          ciphertext: 'cipher2',
          sig: 'sig2',
          server_sig_pk: 'pk2',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      const fromBase64Spy = jest.spyOn(utilsModule, 'fromBase64');

      await decryptEmailData(emailDataWithParsed, mockKeypair, 'test@example.com', mockApiClient);

      // fromBase64 should not be called for Uint8Array content
      expect(fromBase64Spy).not.toHaveBeenCalled();
    });

    it('should handle attachment with undefined content', async () => {
      (decryptModule.decryptParsed as jest.Mock).mockResolvedValue({
        text: 'body',
        html: '<p>body</p>',
        headers: {},
        attachments: [
          {
            filename: 'test.txt',
            contentType: 'text/plain',
            size: 0,
            content: undefined,
          },
        ],
      });

      const emailDataWithParsed: EmailData = {
        ...mockEmailData,
        encryptedParsed: {
          v: 1,
          ct_kem: 'ct2',
          nonce: 'nonce2',
          aad: 'aad2',
          ciphertext: 'cipher2',
          sig: 'sig2',
          server_sig_pk: 'pk2',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      const fromBase64Spy = jest.spyOn(utilsModule, 'fromBase64');

      await decryptEmailData(emailDataWithParsed, mockKeypair, 'test@example.com', mockApiClient);

      // fromBase64 should not be called for undefined content
      expect(fromBase64Spy).not.toHaveBeenCalled();
    });

    it('should handle null attachments array', async () => {
      (decryptModule.decryptParsed as jest.Mock).mockResolvedValue({
        text: 'body',
        html: '<p>body</p>',
        headers: {},
        attachments: null,
      });

      const emailDataWithParsed: EmailData = {
        ...mockEmailData,
        encryptedParsed: {
          v: 1,
          ct_kem: 'ct2',
          nonce: 'nonce2',
          aad: 'aad2',
          ciphertext: 'cipher2',
          sig: 'sig2',
          server_sig_pk: 'pk2',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      // Should not throw
      await expect(
        decryptEmailData(emailDataWithParsed, mockKeypair, 'test@example.com', mockApiClient),
      ).resolves.toBeDefined();
    });
  });

  describe('isEncryptedEmailData', () => {
    it('should return true for encrypted email data', () => {
      const encryptedEmail: EncryptedEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        encryptedMetadata: {
          v: 1,
          ct_kem: 'ct',
          nonce: 'nonce',
          aad: 'aad',
          ciphertext: 'cipher',
          sig: 'sig',
          server_sig_pk: 'pk',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      expect(isEncryptedEmailData(encryptedEmail)).toBe(true);
    });

    it('should return false for plain email data', () => {
      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(
          JSON.stringify({
            from: 'sender@example.com',
            to: ['recipient@example.com'],
            subject: 'Test Subject',
            receivedAt: '2024-01-01T00:00:00Z',
          }),
        ).toString('base64'),
      };

      expect(isEncryptedEmailData(plainEmail)).toBe(false);
    });
  });

  describe('decodeBase64EmailData', () => {
    const mockApiClient = {} as import('../src/http/api-client').ApiClient;

    beforeEach(() => {
      (Email as jest.Mock).mockImplementation(() => createMockEmail());
    });

    it('should decode plain email without parsed content', () => {
      const metadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        receivedAt: '2024-01-01T00:00:00Z',
      };

      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(JSON.stringify(metadata)).toString('base64'),
      };

      decodeBase64EmailData(plainEmail, 'test@example.com', mockApiClient);

      expect(Email).toHaveBeenCalledWith(
        plainEmail,
        metadata,
        null, // no parsed content
        'test@example.com',
        mockApiClient,
        null, // no keypair for plain emails
      );
    });

    it('should decode plain email with parsed content', () => {
      const metadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        receivedAt: '2024-01-01T00:00:00Z',
      };

      const parsed = {
        text: 'Plain text body',
        html: '<p>HTML body</p>',
        headers: { 'message-id': '<test@example.com>' },
        attachments: [],
      };

      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(JSON.stringify(metadata)).toString('base64'),
        parsed: Buffer.from(JSON.stringify(parsed)).toString('base64'),
      };

      decodeBase64EmailData(plainEmail, 'test@example.com', mockApiClient);

      expect(Email).toHaveBeenCalledWith(plainEmail, metadata, parsed, 'test@example.com', mockApiClient, null);
    });

    it('should convert base64 string attachment content to Uint8Array', () => {
      const base64Content = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
      const expectedUint8Array = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);

      const metadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test with Attachment',
        receivedAt: '2024-01-01T00:00:00Z',
      };

      const parsed = {
        text: 'Body with attachment',
        html: null,
        headers: {},
        attachments: [
          {
            filename: 'test.txt',
            contentType: 'text/plain',
            size: 11,
            content: base64Content,
          },
        ],
      };

      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(JSON.stringify(metadata)).toString('base64'),
        parsed: Buffer.from(JSON.stringify(parsed)).toString('base64'),
      };

      // Mock fromBase64 to return expected Uint8Array
      jest.spyOn(utilsModule, 'fromBase64').mockReturnValue(expectedUint8Array);

      decodeBase64EmailData(plainEmail, 'test@example.com', mockApiClient);

      expect(utilsModule.fromBase64).toHaveBeenCalledWith(base64Content);
    });

    it('should preserve attachment content that is already Uint8Array', () => {
      const existingUint8Array = new Uint8Array([1, 2, 3, 4, 5]);

      const metadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test with Binary Attachment',
        receivedAt: '2024-01-01T00:00:00Z',
      };

      const parsed = {
        text: 'Body',
        html: null,
        headers: {},
        attachments: [
          {
            filename: 'test.bin',
            contentType: 'application/octet-stream',
            size: 5,
            content: existingUint8Array,
          },
        ],
      };

      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(JSON.stringify(metadata)).toString('base64'),
        parsed: Buffer.from(JSON.stringify(parsed)).toString('base64'),
      };

      const fromBase64Spy = jest.spyOn(utilsModule, 'fromBase64');

      decodeBase64EmailData(plainEmail, 'test@example.com', mockApiClient);

      // fromBase64 should not be called for Uint8Array content
      expect(fromBase64Spy).not.toHaveBeenCalled();
    });

    it('should handle attachment with undefined content', () => {
      const metadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test with Empty Attachment',
        receivedAt: '2024-01-01T00:00:00Z',
      };

      const parsed = {
        text: 'Body',
        html: null,
        headers: {},
        attachments: [
          {
            filename: 'test.txt',
            contentType: 'text/plain',
            size: 0,
            content: undefined,
          },
        ],
      };

      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(JSON.stringify(metadata)).toString('base64'),
        parsed: Buffer.from(JSON.stringify(parsed)).toString('base64'),
      };

      const fromBase64Spy = jest.spyOn(utilsModule, 'fromBase64');

      decodeBase64EmailData(plainEmail, 'test@example.com', mockApiClient);

      // fromBase64 should not be called for undefined content
      expect(fromBase64Spy).not.toHaveBeenCalled();
    });

    it('should handle null attachments array', () => {
      const metadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test without Attachments',
        receivedAt: '2024-01-01T00:00:00Z',
      };

      const parsed = {
        text: 'Body',
        html: null,
        headers: {},
        attachments: null,
      };

      const plainEmail: PlainEmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T00:00:00Z',
        isRead: false,
        metadata: Buffer.from(JSON.stringify(metadata)).toString('base64'),
        parsed: Buffer.from(JSON.stringify(parsed)).toString('base64'),
      };

      // Should not throw
      expect(() => decodeBase64EmailData(plainEmail, 'test@example.com', mockApiClient)).not.toThrow();
    });
  });
});
