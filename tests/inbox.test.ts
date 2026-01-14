/**
 * Unit tests for Inbox class
 *
 * Tests cover:
 * - Email cache management (getEmailIds, addEmail, removeEmail, hasEmail, etc.)
 * - Metadata-only listing (listEmailsMetadataOnly)
 * - Strategy error handling (waitForEmail, onNewEmail without strategy)
 * - waitForEmailCount error handling
 * - Export functionality
 * - Internal accessors (getKeypair, getApiClient)
 */

import { Inbox } from '../src/inbox';
import { StrategyError, TimeoutError } from '../src/types/index';
import type {
  InboxData,
  Keypair,
  EmailData,
  SyncStatus,
  IEmail,
  EncryptedData,
  DecryptedMetadata,
  Subscription,
} from '../src/types/index';
import type { ApiClient } from '../src/http/api-client';
import type { DeliveryStrategy } from '../src/strategies/delivery-strategy';
import * as decryptModule from '../src/crypto/decrypt';
import * as emailUtils from '../src/utils/email-utils';

// Mock the crypto decrypt module
jest.mock('../src/crypto/decrypt');
jest.mock('../src/utils/email-utils');

// Create mock encrypted data
const createMockEncryptedData = (): EncryptedData => ({
  v: 1,
  ct_kem: 'mock_ct_kem',
  nonce: 'mock_nonce',
  aad: 'mock_aad',
  ciphertext: 'mock_ciphertext',
  sig: 'mock_sig',
  server_sig_pk: 'mock_server_sig_pk',
  algs: {
    kem: 'ML-KEM-768',
    sig: 'ML-DSA-65',
    aead: 'AES-256-GCM',
    kdf: 'HKDF-SHA-512',
  },
});

// Create mock email data
const createMockEmailData = (id: string, receivedAt?: string): EmailData => ({
  id,
  inboxId: 'test-inbox',
  receivedAt: receivedAt ?? new Date().toISOString(),
  isRead: false,
  encryptedMetadata: createMockEncryptedData(),
});

// Create mock inbox data
const createMockInboxData = (): InboxData => ({
  emailAddress: 'test@example.vaultsandbox.io',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  inboxHash: 'mock-inbox-hash',
  encrypted: true,
  serverSigPk: 'mock-server-sig-pk',
});

// Create mock keypair
const createMockKeypair = (): Keypair => ({
  publicKey: new Uint8Array(1184),
  secretKey: new Uint8Array(2400),
  publicKeyB64: 'mock-public-key-b64',
});

// Create mock API client
const createMockApiClient = (overrides: Partial<ApiClient> = {}): ApiClient =>
  ({
    getSyncStatus: jest.fn(),
    listEmails: jest.fn(),
    getEmail: jest.fn(),
    getRawEmail: jest.fn(),
    markEmailAsRead: jest.fn(),
    deleteEmail: jest.fn(),
    deleteInbox: jest.fn(),
    ...overrides,
  }) as unknown as ApiClient;

// Create mock delivery strategy
const createMockStrategy = (overrides: Partial<DeliveryStrategy> = {}): DeliveryStrategy => ({
  waitForEmail: jest.fn(),
  subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  close: jest.fn(),
  ...overrides,
});

describe('Inbox', () => {
  let inbox: Inbox;
  let mockApiClient: ApiClient;
  let mockKeypair: Keypair;

  beforeEach(() => {
    jest.clearAllMocks();
    mockKeypair = createMockKeypair();
    mockApiClient = createMockApiClient();
    inbox = new Inbox(createMockInboxData(), mockKeypair, mockApiClient, 'mock-server-pk');

    // Mock isEncryptedEmailData to return true for mock encrypted email data
    (emailUtils.isEncryptedEmailData as unknown as jest.Mock).mockReturnValue(true);
  });

  describe('constructor', () => {
    it('should create an inbox with correct properties', () => {
      const inboxData = createMockInboxData();
      const newInbox = new Inbox(inboxData, mockKeypair, mockApiClient, 'server-pk');

      expect(newInbox.emailAddress).toBe(inboxData.emailAddress);
      expect(newInbox.inboxHash).toBe(inboxData.inboxHash);
      expect(newInbox.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('setStrategy', () => {
    it('should set the delivery strategy', () => {
      const mockStrategy = createMockStrategy();
      inbox.setStrategy(mockStrategy);

      // Verify strategy was set by calling a method that requires it
      inbox.onNewEmail(jest.fn());
      expect(mockStrategy.subscribe).toHaveBeenCalled();
    });
  });

  describe('listEmails', () => {
    it('should return decrypted emails', async () => {
      const mockEmailsData = [createMockEmailData('email-1'), createMockEmailData('email-2')];

      const mockEmail1 = { id: 'email-1', subject: 'Test 1' } as IEmail;
      const mockEmail2 = { id: 'email-2', subject: 'Test 2' } as IEmail;

      (mockApiClient.listEmails as jest.Mock).mockResolvedValue(mockEmailsData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValueOnce(mockEmail1).mockResolvedValueOnce(mockEmail2);

      const result = await inbox.listEmails();

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(mockEmail1);
      expect(result[1]).toBe(mockEmail2);
      expect(mockApiClient.listEmails).toHaveBeenCalledWith(inbox.emailAddress, true);
      expect(emailUtils.decryptEmailData).toHaveBeenCalledTimes(2);
    });

    it('should handle empty email list', async () => {
      (mockApiClient.listEmails as jest.Mock).mockResolvedValue([]);

      const result = await inbox.listEmails();

      expect(result).toHaveLength(0);
    });
  });

  describe('listEmailsMetadataOnly', () => {
    it('should return decrypted email metadata', async () => {
      const mockEmailsData = [
        createMockEmailData('email-1', '2024-01-01T10:00:00Z'),
        createMockEmailData('email-2', '2024-01-02T10:00:00Z'),
      ];

      (mockApiClient.listEmails as jest.Mock).mockResolvedValue(mockEmailsData);

      (decryptModule.decryptMetadata as jest.Mock)
        .mockResolvedValueOnce({
          from: 'sender1@example.com',
          subject: 'Subject 1',
          receivedAt: '2024-01-01T10:00:00Z',
        } as DecryptedMetadata)
        .mockResolvedValueOnce({
          from: 'sender2@example.com',
          subject: 'Subject 2',
          receivedAt: undefined, // Test fallback to emailData.receivedAt
        } as DecryptedMetadata);

      const result = await inbox.listEmailsMetadataOnly();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'email-1',
        from: 'sender1@example.com',
        subject: 'Subject 1',
        receivedAt: new Date('2024-01-01T10:00:00Z'),
        isRead: false,
      });
      expect(result[1]).toEqual({
        id: 'email-2',
        from: 'sender2@example.com',
        subject: 'Subject 2',
        receivedAt: new Date('2024-01-02T10:00:00Z'),
        isRead: false,
      });

      expect(mockApiClient.listEmails).toHaveBeenCalledWith(inbox.emailAddress, false);
      expect(decryptModule.decryptMetadata).toHaveBeenCalledTimes(2);
    });

    it('should handle empty email list', async () => {
      (mockApiClient.listEmails as jest.Mock).mockResolvedValue([]);

      const result = await inbox.listEmailsMetadataOnly();

      expect(result).toHaveLength(0);
    });
  });

  describe('waitForEmail', () => {
    it('should throw StrategyError when no strategy is set', async () => {
      await expect(inbox.waitForEmail()).rejects.toThrow(StrategyError);
      await expect(inbox.waitForEmail()).rejects.toThrow('No delivery strategy set');
    });

    it('should call strategy.waitForEmail when strategy is set', async () => {
      const mockEmail = { id: 'email-1' } as IEmail;
      const mockStrategy = createMockStrategy({
        waitForEmail: jest.fn().mockResolvedValue(mockEmail),
      });
      inbox.setStrategy(mockStrategy);

      const result = await inbox.waitForEmail({ timeout: 5000 });

      expect(result).toBe(mockEmail);
      expect(mockStrategy.waitForEmail).toHaveBeenCalledWith(inbox.emailAddress, inbox.inboxHash, mockKeypair, {
        timeout: 5000,
      });
    });
  });

  describe('waitForEmailCount', () => {
    it('should return immediately if count is already reached', async () => {
      const mockStrategy = createMockStrategy();
      inbox.setStrategy(mockStrategy);

      (mockApiClient.getSyncStatus as jest.Mock).mockResolvedValue({
        emailCount: 5,
        emailsHash: 'hash',
      } as SyncStatus);

      await inbox.waitForEmailCount(3);

      expect(mockApiClient.getSyncStatus).toHaveBeenCalledTimes(1);
      expect(mockStrategy.subscribe).not.toHaveBeenCalled();
    });

    it('should wait for emails and resolve when count is reached', async () => {
      const mockStrategy = createMockStrategy();
      let subscribeCallback: ((email: IEmail) => void | Promise<void>) | undefined;

      (mockStrategy.subscribe as jest.Mock).mockImplementation((_emailAddress, _inboxHash, _keypair, callback) => {
        subscribeCallback = callback;
        return { unsubscribe: jest.fn() };
      });

      inbox.setStrategy(mockStrategy);

      // First call returns count of 1, second call returns count of 3
      (mockApiClient.getSyncStatus as jest.Mock)
        .mockResolvedValueOnce({ emailCount: 1, emailsHash: 'hash1' })
        .mockResolvedValueOnce({ emailCount: 2, emailsHash: 'hash2' })
        .mockResolvedValueOnce({ emailCount: 3, emailsHash: 'hash3' });

      const waitPromise = inbox.waitForEmailCount(3, { timeout: 10000 });

      // Simulate email arrival
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (subscribeCallback) {
        await subscribeCallback({ id: 'email-1' } as IEmail);
        await subscribeCallback({ id: 'email-2' } as IEmail);
      }

      await waitPromise;
      expect(mockApiClient.getSyncStatus).toHaveBeenCalled();
    });

    it('should reject with TimeoutError when timeout is reached', async () => {
      const mockStrategy = createMockStrategy();
      inbox.setStrategy(mockStrategy);

      (mockApiClient.getSyncStatus as jest.Mock).mockResolvedValue({
        emailCount: 0,
        emailsHash: 'hash',
      });

      await expect(inbox.waitForEmailCount(5, { timeout: 50 })).rejects.toThrow(TimeoutError);
      await expect(inbox.waitForEmailCount(5, { timeout: 50 })).rejects.toThrow(
        'Inbox did not receive 5 emails within timeout',
      );
    });

    it('should reject when getSyncStatus throws an error', async () => {
      const mockStrategy = createMockStrategy();
      let subscribeCallback: ((email: IEmail) => void | Promise<void>) | undefined;

      (mockStrategy.subscribe as jest.Mock).mockImplementation((_emailAddress, _inboxHash, _keypair, callback) => {
        subscribeCallback = callback;
        return { unsubscribe: jest.fn() };
      });

      inbox.setStrategy(mockStrategy);

      const apiError = new Error('API Error');

      // First call to initial check returns low count, subsequent call throws
      (mockApiClient.getSyncStatus as jest.Mock)
        .mockResolvedValueOnce({ emailCount: 0, emailsHash: 'hash' })
        .mockRejectedValueOnce(apiError);

      const waitPromise = inbox.waitForEmailCount(3, { timeout: 10000 });

      // Simulate email arrival that triggers the error
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (subscribeCallback) {
        await subscribeCallback({ id: 'email-1' } as IEmail);
      }

      await expect(waitPromise).rejects.toThrow('API Error');
    });
  });

  describe('onNewEmail', () => {
    it('should throw StrategyError when no strategy is set', () => {
      expect(() => inbox.onNewEmail(jest.fn())).toThrow(StrategyError);
      expect(() => inbox.onNewEmail(jest.fn())).toThrow('No delivery strategy set');
    });

    it('should call strategy.subscribe when strategy is set', () => {
      const mockStrategy = createMockStrategy();
      const mockSubscription: Subscription = { unsubscribe: jest.fn() };
      (mockStrategy.subscribe as jest.Mock).mockReturnValue(mockSubscription);

      inbox.setStrategy(mockStrategy);
      const callback = jest.fn();

      const result = inbox.onNewEmail(callback);

      expect(result).toBe(mockSubscription);
      expect(mockStrategy.subscribe).toHaveBeenCalledWith(inbox.emailAddress, inbox.inboxHash, mockKeypair, callback);
    });
  });

  describe('getEmail', () => {
    it('should retrieve and decrypt a specific email', async () => {
      const mockEmailData = createMockEmailData('email-123');
      const mockEmail = { id: 'email-123', subject: 'Test' } as IEmail;

      (mockApiClient.getEmail as jest.Mock).mockResolvedValue(mockEmailData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);

      const result = await inbox.getEmail('email-123');

      expect(result).toBe(mockEmail);
      expect(mockApiClient.getEmail).toHaveBeenCalledWith(inbox.emailAddress, 'email-123');
      expect(emailUtils.decryptEmailData).toHaveBeenCalledWith(
        mockEmailData,
        mockKeypair,
        inbox.emailAddress,
        mockApiClient,
      );
    });
  });

  describe('getRawEmail', () => {
    it('should retrieve and decrypt raw email', async () => {
      const mockRawEmailData = {
        id: 'email-123',
        encryptedRaw: createMockEncryptedData(),
      };

      (mockApiClient.getRawEmail as jest.Mock).mockResolvedValue(mockRawEmailData);
      (decryptModule.decryptRaw as jest.Mock).mockResolvedValue('raw email content');

      const result = await inbox.getRawEmail('email-123');

      expect(result).toEqual({
        id: 'email-123',
        raw: 'raw email content',
      });
      expect(mockApiClient.getRawEmail).toHaveBeenCalledWith(inbox.emailAddress, 'email-123');
      expect(decryptModule.decryptRaw).toHaveBeenCalledWith(mockRawEmailData.encryptedRaw, mockKeypair);
    });
  });

  describe('markEmailAsRead', () => {
    it('should mark email as read via API', async () => {
      (mockApiClient.markEmailAsRead as jest.Mock).mockResolvedValue(undefined);

      await inbox.markEmailAsRead('email-123');

      expect(mockApiClient.markEmailAsRead).toHaveBeenCalledWith(inbox.emailAddress, 'email-123');
    });
  });

  describe('deleteEmail', () => {
    it('should delete email via API', async () => {
      (mockApiClient.deleteEmail as jest.Mock).mockResolvedValue(undefined);

      await inbox.deleteEmail('email-123');

      expect(mockApiClient.deleteEmail).toHaveBeenCalledWith(inbox.emailAddress, 'email-123');
    });
  });

  describe('delete', () => {
    it('should delete the inbox via API', async () => {
      (mockApiClient.deleteInbox as jest.Mock).mockResolvedValue(undefined);

      await inbox.delete();

      expect(mockApiClient.deleteInbox).toHaveBeenCalledWith(inbox.emailAddress);
    });
  });

  describe('getSyncStatus', () => {
    it('should retrieve sync status from API', async () => {
      const mockSyncStatus: SyncStatus = {
        emailCount: 5,
        emailsHash: 'test-hash',
      };

      (mockApiClient.getSyncStatus as jest.Mock).mockResolvedValue(mockSyncStatus);

      const result = await inbox.getSyncStatus();

      expect(result).toEqual(mockSyncStatus);
      expect(mockApiClient.getSyncStatus).toHaveBeenCalledWith(inbox.emailAddress);
    });
  });

  describe('export', () => {
    it('should export inbox data with key material', () => {
      const exportedData = inbox.export();

      expect(exportedData.version).toBe(1);
      expect(exportedData.emailAddress).toBe(inbox.emailAddress);
      expect(exportedData.inboxHash).toBe(inbox.inboxHash);
      expect(exportedData.expiresAt).toBe(inbox.expiresAt.toISOString());
      expect(exportedData.serverSigPk).toBe('mock-server-pk');
      expect(exportedData.secretKey).toBeTruthy();
      expect(exportedData.exportedAt).toBeTruthy();
    });
  });

  describe('Email Cache Management', () => {
    describe('getEmailIds', () => {
      it('should return empty array when cache is empty', () => {
        expect(inbox.getEmailIds()).toEqual([]);
      });

      it('should return all email IDs from cache', () => {
        inbox.addEmail(createMockEmailData('email-1'));
        inbox.addEmail(createMockEmailData('email-2'));

        const ids = inbox.getEmailIds();
        expect(ids).toContain('email-1');
        expect(ids).toContain('email-2');
        expect(ids).toHaveLength(2);
      });
    });

    describe('getEmailCache', () => {
      it('should return the internal email cache Map', () => {
        const cache = inbox.getEmailCache();
        expect(cache).toBeInstanceOf(Map);
        expect(cache.size).toBe(0);

        inbox.addEmail(createMockEmailData('email-1'));
        expect(cache.size).toBe(1);
      });
    });

    describe('addEmail', () => {
      it('should add email to cache and return true', () => {
        const emailData = createMockEmailData('email-1');
        const result = inbox.addEmail(emailData);

        expect(result).toBe(true);
        expect(inbox.hasEmail('email-1')).toBe(true);
      });

      it('should return false when email already exists', () => {
        const emailData = createMockEmailData('email-1');
        inbox.addEmail(emailData);

        const result = inbox.addEmail(emailData);
        expect(result).toBe(false);
      });
    });

    describe('removeEmail', () => {
      it('should remove email from cache and return true', () => {
        inbox.addEmail(createMockEmailData('email-1'));

        const result = inbox.removeEmail('email-1');
        expect(result).toBe(true);
        expect(inbox.hasEmail('email-1')).toBe(false);
      });

      it('should return false when email does not exist', () => {
        const result = inbox.removeEmail('nonexistent');
        expect(result).toBe(false);
      });
    });

    describe('hasEmail', () => {
      it('should return true when email exists', () => {
        inbox.addEmail(createMockEmailData('email-1'));
        expect(inbox.hasEmail('email-1')).toBe(true);
      });

      it('should return false when email does not exist', () => {
        expect(inbox.hasEmail('nonexistent')).toBe(false);
      });
    });

    describe('computeLocalHash', () => {
      it('should compute hash for empty cache', () => {
        const hash = inbox.computeLocalHash();
        // SHA256 of empty string, base64url encoded
        expect(hash).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
      });

      it('should compute consistent hash for same emails', () => {
        inbox.addEmail(createMockEmailData('a'));
        inbox.addEmail(createMockEmailData('b'));
        inbox.addEmail(createMockEmailData('c'));

        const hash1 = inbox.computeLocalHash();
        const hash2 = inbox.computeLocalHash();

        expect(hash1).toBe(hash2);
      });
    });

    describe('clearEmailCache', () => {
      it('should clear all emails from cache', () => {
        inbox.addEmail(createMockEmailData('email-1'));
        inbox.addEmail(createMockEmailData('email-2'));

        inbox.clearEmailCache();

        expect(inbox.getEmailIds()).toHaveLength(0);
        expect(inbox.hasEmail('email-1')).toBe(false);
        expect(inbox.hasEmail('email-2')).toBe(false);
      });
    });
  });

  describe('Internal Accessors', () => {
    describe('getKeypair', () => {
      it('should return the keypair', () => {
        const keypair = inbox.getKeypair();
        expect(keypair).toBe(mockKeypair);
      });
    });

    describe('getApiClient', () => {
      it('should return the API client', () => {
        const apiClient = inbox.getApiClient();
        expect(apiClient).toBe(mockApiClient);
      });
    });
  });

  describe('Plain Inbox Operations', () => {
    let plainInbox: Inbox;
    let plainMockApiClient: ApiClient;

    // Create mock plain email data
    const createMockPlainEmailData = (id: string, receivedAt?: string) => ({
      id,
      inboxId: 'test-inbox',
      receivedAt: receivedAt ?? new Date().toISOString(),
      isRead: false,
      metadata: Buffer.from(
        JSON.stringify({
          from: `sender${id}@example.com`,
          to: ['recipient@example.com'],
          subject: `Subject ${id}`,
          receivedAt: receivedAt ?? new Date().toISOString(),
        }),
      ).toString('base64'),
      parsed: Buffer.from(
        JSON.stringify({
          text: 'Plain text body',
          html: '<p>HTML body</p>',
          headers: {},
          attachments: [],
        }),
      ).toString('base64'),
    });

    // Create mock plain inbox data
    const createMockPlainInboxData = (): InboxData => ({
      emailAddress: 'plain@example.vaultsandbox.io',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      inboxHash: 'mock-plain-inbox-hash',
      encrypted: false, // Plain inbox
    });

    beforeEach(() => {
      jest.clearAllMocks();
      plainMockApiClient = createMockApiClient();
      // Create plain inbox with null keypair and null serverPublicKey
      plainInbox = new Inbox(createMockPlainInboxData(), null, plainMockApiClient, null);
    });

    describe('listEmails with plain emails', () => {
      it('should return decoded plain emails', async () => {
        const mockPlainEmailsData = [createMockPlainEmailData('email-1'), createMockPlainEmailData('email-2')];

        const mockEmail1 = { id: 'email-1', subject: 'Test 1' } as IEmail;
        const mockEmail2 = { id: 'email-2', subject: 'Test 2' } as IEmail;

        (plainMockApiClient.listEmails as jest.Mock).mockResolvedValue(mockPlainEmailsData);
        // Mock isEncryptedEmailData to return false for plain emails
        (emailUtils.isEncryptedEmailData as unknown as jest.Mock).mockReturnValue(false);
        (emailUtils.decodeBase64EmailData as unknown as jest.Mock)
          .mockReturnValueOnce(mockEmail1)
          .mockReturnValueOnce(mockEmail2);

        const result = await plainInbox.listEmails();

        expect(result).toHaveLength(2);
        expect(result[0]).toBe(mockEmail1);
        expect(result[1]).toBe(mockEmail2);
        expect(plainMockApiClient.listEmails).toHaveBeenCalledWith(plainInbox.emailAddress, true);
        expect(emailUtils.decodeBase64EmailData).toHaveBeenCalledTimes(2);
        expect(emailUtils.decryptEmailData).not.toHaveBeenCalled();
      });
    });

    describe('listEmailsMetadataOnly with plain emails', () => {
      it('should return decoded plain email metadata', async () => {
        const mockPlainEmailsData = [
          createMockPlainEmailData('email-1', '2024-01-01T10:00:00Z'),
          createMockPlainEmailData('email-2', '2024-01-02T10:00:00Z'),
        ];

        (plainMockApiClient.listEmails as jest.Mock).mockResolvedValue(mockPlainEmailsData);
        // Mock isEncryptedEmailData to return false for plain emails
        (emailUtils.isEncryptedEmailData as unknown as jest.Mock).mockReturnValue(false);

        const result = await plainInbox.listEmailsMetadataOnly();

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          id: 'email-1',
          from: 'senderemail-1@example.com',
          subject: 'Subject email-1',
          receivedAt: new Date('2024-01-01T10:00:00Z'),
          isRead: false,
        });
        expect(result[1]).toEqual({
          id: 'email-2',
          from: 'senderemail-2@example.com',
          subject: 'Subject email-2',
          receivedAt: new Date('2024-01-02T10:00:00Z'),
          isRead: false,
        });

        expect(plainMockApiClient.listEmails).toHaveBeenCalledWith(plainInbox.emailAddress, false);
        // Should NOT use decryptMetadata for plain emails
        expect(decryptModule.decryptMetadata).not.toHaveBeenCalled();
      });

      it('should fallback to emailData.receivedAt when metadata.receivedAt is missing', async () => {
        const plainEmailWithoutMetadataReceivedAt = {
          id: 'email-1',
          inboxId: 'test-inbox',
          receivedAt: '2024-01-01T10:00:00Z',
          isRead: false,
          metadata: Buffer.from(
            JSON.stringify({
              from: 'sender@example.com',
              to: ['recipient@example.com'],
              subject: 'Test Subject',
              // No receivedAt in metadata
            }),
          ).toString('base64'),
        };

        (plainMockApiClient.listEmails as jest.Mock).mockResolvedValue([plainEmailWithoutMetadataReceivedAt]);
        (emailUtils.isEncryptedEmailData as unknown as jest.Mock).mockReturnValue(false);

        const result = await plainInbox.listEmailsMetadataOnly();

        expect(result[0].receivedAt).toEqual(new Date('2024-01-01T10:00:00Z'));
      });
    });

    describe('getEmail with plain emails', () => {
      it('should retrieve and decode a specific plain email', async () => {
        const mockPlainEmailData = createMockPlainEmailData('email-123');
        const mockEmail = { id: 'email-123', subject: 'Test' } as IEmail;

        (plainMockApiClient.getEmail as jest.Mock).mockResolvedValue(mockPlainEmailData);
        (emailUtils.isEncryptedEmailData as unknown as jest.Mock).mockReturnValue(false);
        (emailUtils.decodeBase64EmailData as unknown as jest.Mock).mockReturnValue(mockEmail);

        const result = await plainInbox.getEmail('email-123');

        expect(result).toBe(mockEmail);
        expect(plainMockApiClient.getEmail).toHaveBeenCalledWith(plainInbox.emailAddress, 'email-123');
        expect(emailUtils.decodeBase64EmailData).toHaveBeenCalledWith(
          mockPlainEmailData,
          plainInbox.emailAddress,
          plainMockApiClient,
        );
        expect(emailUtils.decryptEmailData).not.toHaveBeenCalled();
      });
    });

    describe('getRawEmail with plain emails', () => {
      it('should retrieve and decode raw plain email', async () => {
        const rawContent = 'From: sender@example.com\r\nSubject: Test\r\n\r\nBody';
        const mockRawEmailData = {
          id: 'email-123',
          raw: Buffer.from(rawContent).toString('base64'),
        };

        (plainMockApiClient.getRawEmail as jest.Mock).mockResolvedValue(mockRawEmailData);

        const result = await plainInbox.getRawEmail('email-123');

        expect(result).toEqual({
          id: 'email-123',
          raw: rawContent,
        });
        expect(plainMockApiClient.getRawEmail).toHaveBeenCalledWith(plainInbox.emailAddress, 'email-123');
        // Should NOT use decryptRaw for plain emails
        expect(decryptModule.decryptRaw).not.toHaveBeenCalled();
      });

      it('should throw error when neither encryptedRaw nor raw field is present', async () => {
        const mockRawEmailData = {
          id: 'email-123',
          // Neither encryptedRaw nor raw
        };

        (plainMockApiClient.getRawEmail as jest.Mock).mockResolvedValue(mockRawEmailData);

        await expect(plainInbox.getRawEmail('email-123')).rejects.toThrow(
          'Invalid raw email data: neither encryptedRaw nor raw field present',
        );
      });
    });

    describe('export for plain inboxes', () => {
      it('should export plain inbox data without key material', () => {
        const exportedData = plainInbox.export();

        expect(exportedData.version).toBe(1);
        expect(exportedData.emailAddress).toBe(plainInbox.emailAddress);
        expect(exportedData.inboxHash).toBe(plainInbox.inboxHash);
        expect(exportedData.expiresAt).toBe(plainInbox.expiresAt.toISOString());
        expect(exportedData.encrypted).toBe(false);
        // Plain inbox should NOT have key material
        expect(exportedData.serverSigPk).toBeUndefined();
        expect(exportedData.secretKey).toBeUndefined();
        expect(exportedData.exportedAt).toBeTruthy();
      });
    });

    describe('constructor for plain inbox', () => {
      it('should create a plain inbox with encrypted=false', () => {
        const plainInboxData = createMockPlainInboxData();
        const newPlainInbox = new Inbox(plainInboxData, null, plainMockApiClient, null);

        expect(newPlainInbox.emailAddress).toBe(plainInboxData.emailAddress);
        expect(newPlainInbox.inboxHash).toBe(plainInboxData.inboxHash);
        expect(newPlainInbox.encrypted).toBe(false);
        expect(newPlainInbox.getKeypair()).toBeNull();
      });
    });
  });
});
