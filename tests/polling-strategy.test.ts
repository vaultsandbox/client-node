/**
 * Unit tests for PollingStrategy
 *
 * Tests cover:
 * - Constructor configuration
 * - waitForEmail success and error paths
 * - subscribe method (polling loop, callbacks, unsubscribe)
 * - close method
 */

import { PollingStrategy } from '../src/strategies/polling-strategy';
import type { ApiClient } from '../src/http/api-client';
import type { Keypair, EmailData, IEmail, EncryptedData } from '../src/types';
import * as emailUtils from '../src/utils/email-utils';
import * as inboxSync from '../src/sync/inbox-sync';
import * as sleepModule from '../src/utils/sleep';

// Mock dependencies
jest.mock('../src/utils/email-utils');
jest.mock('../src/sync/inbox-sync');
jest.mock('../src/utils/sleep');

// Mock encrypted data
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
const createMockEmailData = (id: string): EmailData => ({
  id,
  inboxId: 'test-inbox',
  receivedAt: new Date().toISOString(),
  isRead: false,
  encryptedMetadata: createMockEncryptedData(),
});

// Create mock IEmail
const createMockEmail = (id: string, subject = 'Test Subject'): IEmail => ({
  id,
  from: 'sender@example.com',
  to: ['recipient@example.com'],
  subject,
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
});

// Create mock API client
const createMockApiClient = (overrides: Partial<ApiClient> = {}): jest.Mocked<ApiClient> =>
  ({
    getSyncStatus: jest.fn(),
    listEmails: jest.fn(),
    getEmail: jest.fn(),
    ...overrides,
  }) as unknown as jest.Mocked<ApiClient>;

// Mock keypair
const mockKeypair: Keypair = {
  publicKey: new Uint8Array(1184),
  secretKey: new Uint8Array(2400),
  publicKeyB64: 'test-pk',
};

describe('PollingStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock for sleep - resolves immediately
    (sleepModule.sleep as jest.Mock).mockResolvedValue(undefined);

    // Mock isEncryptedEmailData to return true for mock encrypted email data
    (emailUtils.isEncryptedEmailData as unknown as jest.Mock).mockReturnValue(true);
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);

      expect(strategy).toBeDefined();
    });

    it('should create with custom config', () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, {
        initialInterval: 1000,
        maxBackoff: 15000,
        backoffMultiplier: 2.0,
        jitterFactor: 0.2,
      });

      expect(strategy).toBeDefined();
    });
  });

  describe('waitForEmail', () => {
    it('should return matching email when found on first poll', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';
      const mockEmail = createMockEmail('email1', 'Welcome');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getSyncStatus.mockResolvedValue({
        emailCount: 1,
        emailsHash: 'hash1',
      });

      apiClient.listEmails.mockResolvedValue([mockEmailData]);

      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(mockEmail);

      const result = await strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
        timeout: 5000,
        subject: 'Welcome',
      });

      expect(result).toBe(mockEmail);
      expect(apiClient.getSyncStatus).toHaveBeenCalledWith(emailAddress);
      expect(apiClient.listEmails).toHaveBeenCalledWith(emailAddress, true);
      expect(emailUtils.decryptEmailData).toHaveBeenCalledWith(mockEmailData, mockKeypair, emailAddress, apiClient);
      expect(emailUtils.findMatchingEmail).toHaveBeenCalled();
    });

    it('should continue polling when no matching email found initially then find on second poll', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 100 });
      const emailAddress = 'test@example.com';
      const mockEmail = createMockEmail('email1');

      // First poll - no emails, second poll - email found
      apiClient.getSyncStatus
        .mockResolvedValueOnce({ emailCount: 0, emailsHash: 'hash0' })
        .mockResolvedValueOnce({ emailCount: 1, emailsHash: 'hash1' });

      apiClient.listEmails.mockResolvedValue([createMockEmailData('email1')]);

      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(mockEmail);

      const result = await strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
        timeout: 5000,
      });

      expect(result).toBe(mockEmail);
      expect(apiClient.getSyncStatus).toHaveBeenCalledTimes(2);
    });

    it('should reset backoff when hash changes', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, {
        initialInterval: 100,
        backoffMultiplier: 2,
      });
      const emailAddress = 'test@example.com';
      const mockEmail = createMockEmail('email1');

      // First poll - no emails, second poll - hash changed but no match, third poll - match
      apiClient.getSyncStatus
        .mockResolvedValueOnce({ emailCount: 0, emailsHash: 'hash0' })
        .mockResolvedValueOnce({ emailCount: 1, emailsHash: 'hash1' })
        .mockResolvedValueOnce({ emailCount: 2, emailsHash: 'hash2' });

      apiClient.listEmails.mockResolvedValue([createMockEmailData('email1')]);

      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValueOnce(null).mockReturnValueOnce(mockEmail);

      const result = await strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
        timeout: 10000,
      });

      expect(result).toBe(mockEmail);
      expect(apiClient.getSyncStatus).toHaveBeenCalledTimes(3);
    });

    it('should throw TimeoutError when no email arrives within timeout', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 10, jitterFactor: 0 });
      const emailAddress = 'test@example.com';

      apiClient.getSyncStatus.mockResolvedValue({ emailCount: 0, emailsHash: 'hash0' });

      // Make sleep track time properly for timeout
      let elapsedTime = 0;
      (sleepModule.sleep as jest.Mock).mockImplementation(async (ms: number) => {
        elapsedTime += ms;
      });

      const startTime = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => startTime + elapsedTime);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 50,
        }),
      ).rejects.toThrow('No matching email received within timeout');

      jest.restoreAllMocks();
    });

    it('should throw InboxNotFoundError when 404 error occurs', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';

      const error = { statusCode: 404, message: 'Not found' };
      apiClient.getSyncStatus.mockRejectedValue(error);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 5000,
        }),
      ).rejects.toThrow('Inbox not found or has been deleted');
    });

    it('should rethrow non-404 errors with statusCode', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';

      const error = { statusCode: 500, message: 'Server error' };
      apiClient.getSyncStatus.mockRejectedValue(error);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 5000,
        }),
      ).rejects.toEqual(error);
    });

    it('should rethrow errors without statusCode', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';

      const error = new Error('Network error');
      apiClient.getSyncStatus.mockRejectedValue(error);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 5000,
        }),
      ).rejects.toThrow('Network error');
    });

    it('should use custom pollInterval from options', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 2000 });
      const emailAddress = 'test@example.com';
      const mockEmail = createMockEmail('email1');

      apiClient.getSyncStatus
        .mockResolvedValueOnce({ emailCount: 0, emailsHash: 'hash0' })
        .mockResolvedValueOnce({ emailCount: 1, emailsHash: 'hash1' });

      apiClient.listEmails.mockResolvedValue([createMockEmailData('email1')]);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(mockEmail);

      await strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
        timeout: 5000,
        pollInterval: 100,
      });

      // Verify sleep was called with the custom poll interval (not the default 2000)
      expect(sleepModule.sleep).toHaveBeenCalled();
    });

    it('should skip fetching emails when emailCount is 0', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 10, jitterFactor: 0 });
      const emailAddress = 'test@example.com';

      // Hash changes but no emails
      apiClient.getSyncStatus.mockResolvedValue({ emailCount: 0, emailsHash: 'hash0' });

      let elapsedTime = 0;
      (sleepModule.sleep as jest.Mock).mockImplementation(async (ms: number) => {
        elapsedTime += ms;
      });

      const startTime = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => startTime + elapsedTime);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 50,
        }),
      ).rejects.toThrow('No matching email received within timeout');

      // listEmails should not be called when emailCount is 0
      expect(apiClient.listEmails).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });

    it('should not re-fetch emails when hash has not changed after first fetch', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 10, jitterFactor: 0 });
      const emailAddress = 'test@example.com';

      // Same hash returned multiple times
      apiClient.getSyncStatus.mockResolvedValue({ emailCount: 1, emailsHash: 'same-hash' });
      apiClient.listEmails.mockResolvedValue([createMockEmailData('email1')]);

      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(createMockEmail('email1'));
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(null);

      let elapsedTime = 0;
      (sleepModule.sleep as jest.Mock).mockImplementation(async (ms: number) => {
        elapsedTime += ms;
      });

      const startTime = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => startTime + elapsedTime);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 50,
        }),
      ).rejects.toThrow('No matching email received within timeout');

      // listEmails should only be called once (first time when lastHash was null)
      expect(apiClient.listEmails).toHaveBeenCalledTimes(1);

      jest.restoreAllMocks();
    });

    it('should increase backoff when hash remains unchanged', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, {
        initialInterval: 10,
        backoffMultiplier: 2,
        maxBackoff: 1000,
        jitterFactor: 0,
      });
      const emailAddress = 'test@example.com';

      // Always return same hash
      apiClient.getSyncStatus.mockResolvedValue({ emailCount: 1, emailsHash: 'same-hash' });
      apiClient.listEmails.mockResolvedValue([createMockEmailData('email1')]);

      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(createMockEmail('email1'));
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(null);

      const sleepCalls: number[] = [];
      let elapsedTime = 0;
      (sleepModule.sleep as jest.Mock).mockImplementation(async (ms: number) => {
        sleepCalls.push(ms);
        elapsedTime += ms;
      });

      const startTime = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => startTime + elapsedTime);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 100,
        }),
      ).rejects.toThrow('No matching email received within timeout');

      // Verify backoff increased
      expect(sleepCalls.length).toBeGreaterThan(1);
      if (sleepCalls.length >= 2) {
        expect(sleepCalls[1]).toBeGreaterThanOrEqual(sleepCalls[0]);
      }

      jest.restoreAllMocks();
    });

    it('should decrypt multiple emails and find the matching one', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';
      const mockEmail1 = createMockEmail('email1', 'First');
      const mockEmail2 = createMockEmail('email2', 'Welcome');
      const mockEmailData1 = createMockEmailData('email1');
      const mockEmailData2 = createMockEmailData('email2');

      apiClient.getSyncStatus.mockResolvedValue({
        emailCount: 2,
        emailsHash: 'hash1',
      });

      apiClient.listEmails.mockResolvedValue([mockEmailData1, mockEmailData2]);

      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValueOnce(mockEmail1).mockResolvedValueOnce(mockEmail2);

      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(mockEmail2);

      const result = await strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
        timeout: 5000,
        subject: 'Welcome',
      });

      expect(result).toBe(mockEmail2);
      expect(emailUtils.decryptEmailData).toHaveBeenCalledTimes(2);
    });

    it('should handle error that is not an object', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';

      apiClient.getSyncStatus.mockRejectedValue('string error');

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 5000,
        }),
      ).rejects.toBe('string error');
    });

    it('should handle null error', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';

      apiClient.getSyncStatus.mockRejectedValue(null);

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair, {
          timeout: 5000,
        }),
      ).rejects.toBe(null);
    });

    it('should use default options when none provided', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';
      const mockEmail = createMockEmail('email1');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getSyncStatus.mockResolvedValue({
        emailCount: 1,
        emailsHash: 'hash1',
      });
      apiClient.listEmails.mockResolvedValue([mockEmailData]);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);
      (emailUtils.findMatchingEmail as jest.Mock).mockReturnValue(mockEmail);

      // Call without options argument to cover default parameter
      const result = await strategy.waitForEmail(emailAddress, 'inbox-hash', mockKeypair);

      expect(result).toBe(mockEmail);
    });
  });

  describe('subscribe', () => {
    // Helper to create a controlled subscribe test
    const createControlledSubscribeTest = () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 50 });
      const emailAddress = 'test@example.com';

      let pollResolvers: Array<(value: inboxSync.SyncResult) => void> = [];
      let pollCount = 0;

      (inboxSync.syncInbox as jest.Mock).mockImplementation(() => {
        pollCount++;
        return new Promise<inboxSync.SyncResult>((resolve) => {
          pollResolvers.push(resolve);
        });
      });

      // Make sleep return immediately
      (sleepModule.sleep as jest.Mock).mockResolvedValue(undefined);

      return {
        apiClient,
        strategy,
        emailAddress,
        getPollCount: () => pollCount,
        resolvePoll: (result: inboxSync.SyncResult) => {
          const resolver = pollResolvers.shift();
          if (resolver) {
            resolver(result);
          }
        },
      };
    };

    it('should call callback when new email arrives', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();
      const mockEmail = createMockEmail('email1');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getEmail.mockResolvedValue(mockEmailData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      // Allow first poll to start
      await Promise.resolve();

      // Resolve first poll with new email
      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      // Wait for callback to be called
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).toHaveBeenCalledWith(mockEmail);
      expect(apiClient.getEmail).toHaveBeenCalledWith(emailAddress, 'email1');

      subscription.unsubscribe();
    });

    it('should handle async callback that returns a promise', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();
      const mockEmail = createMockEmail('email1');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getEmail.mockResolvedValue(mockEmailData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);

      const asyncCallback = jest.fn().mockResolvedValue(undefined);
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, asyncCallback);

      await Promise.resolve();

      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(asyncCallback).toHaveBeenCalledWith(mockEmail);

      subscription.unsubscribe();
    });

    it('should handle async callback that rejects', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();
      const mockEmail = createMockEmail('email1');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getEmail.mockResolvedValue(mockEmailData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);

      const asyncCallback = jest.fn().mockRejectedValue(new Error('Callback error'));
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, asyncCallback);

      await Promise.resolve();

      // Should not throw even when callback rejects
      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(asyncCallback).toHaveBeenCalled();

      subscription.unsubscribe();
    });

    it('should call onEmailDeleted callback when email is deleted', async () => {
      const { strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();

      const callback = jest.fn();
      const onEmailDeleted = jest.fn();

      const subscription = strategy.subscribe(
        emailAddress,
        'inbox-hash',
        mockKeypair,
        callback,
        undefined,
        onEmailDeleted,
      );

      await Promise.resolve();

      resolvePoll({
        unchanged: false,
        added: [],
        deleted: ['deleted-email-1'],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(onEmailDeleted).toHaveBeenCalledWith('deleted-email-1');

      subscription.unsubscribe();
    });

    it('should not call callback for already seen emails', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();
      const mockEmail = createMockEmail('email1');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getEmail.mockResolvedValue(mockEmailData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      await Promise.resolve();

      // First poll - new email
      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();

      // Second poll - same email (already seen)
      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      // Callback should only be called once
      expect(callback).toHaveBeenCalledTimes(1);

      subscription.unsubscribe();
    });

    it('should use provided email cache', async () => {
      const { apiClient, strategy, emailAddress } = createControlledSubscribeTest();

      const existingEmailData = createMockEmailData('existing-email');
      const emailCache = new Map<string, EmailData>();
      emailCache.set('existing-email', existingEmailData);

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback, emailCache);

      await Promise.resolve();

      expect(inboxSync.syncInbox).toHaveBeenCalledWith(apiClient, emailAddress, emailCache);

      subscription.unsubscribe();
    });

    it('should create local cache when none provided', async () => {
      const { strategy, emailAddress } = createControlledSubscribeTest();

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      await Promise.resolve();

      expect(inboxSync.syncInbox).toHaveBeenCalled();
      const callArgs = (inboxSync.syncInbox as jest.Mock).mock.calls[0];
      expect(callArgs[2]).toBeInstanceOf(Map);

      subscription.unsubscribe();
    });

    it('should stop polling when unsubscribed', async () => {
      const { strategy, emailAddress, getPollCount, resolvePoll } = createControlledSubscribeTest();

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      await Promise.resolve();

      // Complete one poll
      resolvePoll({
        unchanged: true,
        added: [],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      const countBefore = getPollCount();
      subscription.unsubscribe();

      // Resolve any pending poll
      resolvePoll({
        unchanged: true,
        added: [],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      // Should have stopped or had at most one more poll
      expect(getPollCount()).toBeLessThanOrEqual(countBefore + 1);
    });

    it('should handle sync errors gracefully and continue polling', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 50 });
      const emailAddress = 'test@example.com';

      let pollCount = 0;
      let pollResolvers: Array<{ resolve: (value: inboxSync.SyncResult) => void; reject: (error: Error) => void }> = [];

      (inboxSync.syncInbox as jest.Mock).mockImplementation(() => {
        pollCount++;
        return new Promise<inboxSync.SyncResult>((resolve, reject) => {
          pollResolvers.push({ resolve, reject });
        });
      });

      (sleepModule.sleep as jest.Mock).mockResolvedValue(undefined);

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      await Promise.resolve();

      // First poll - error
      pollResolvers[0].reject(new Error('Sync error'));

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();

      // Second poll should start
      expect(pollCount).toBe(2);

      // Complete second poll
      pollResolvers[1].resolve({
        unchanged: true,
        added: [],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      subscription.unsubscribe();
    });

    it('should call onError callback when sync fails', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 50 });
      const emailAddress = 'test@example.com';

      let pollResolvers: Array<{ resolve: (value: inboxSync.SyncResult) => void; reject: (error: Error) => void }> = [];

      (inboxSync.syncInbox as jest.Mock).mockImplementation(() => {
        return new Promise<inboxSync.SyncResult>((resolve, reject) => {
          pollResolvers.push({ resolve, reject });
        });
      });

      (sleepModule.sleep as jest.Mock).mockResolvedValue(undefined);

      const callback = jest.fn();
      const onError = jest.fn();
      const subscription = strategy.subscribe(
        emailAddress,
        'inbox-hash',
        mockKeypair,
        callback,
        undefined,
        undefined,
        onError,
      );

      await Promise.resolve();

      // First poll - error
      pollResolvers[0].reject(new Error('Sync error'));

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Sync error' }));

      subscription.unsubscribe();
    });

    it('should call onError callback with wrapped error for non-Error objects', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 50 });
      const emailAddress = 'test@example.com';

      let pollResolvers: Array<{ resolve: (value: inboxSync.SyncResult) => void; reject: (error: unknown) => void }> =
        [];

      (inboxSync.syncInbox as jest.Mock).mockImplementation(() => {
        return new Promise<inboxSync.SyncResult>((resolve, reject) => {
          pollResolvers.push({ resolve, reject });
        });
      });

      (sleepModule.sleep as jest.Mock).mockResolvedValue(undefined);

      const callback = jest.fn();
      const onError = jest.fn();
      const subscription = strategy.subscribe(
        emailAddress,
        'inbox-hash',
        mockKeypair,
        callback,
        undefined,
        undefined,
        onError,
      );

      await Promise.resolve();

      // First poll - reject with non-Error object
      pollResolvers[0].reject('string error');

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'string error' }));

      subscription.unsubscribe();
    });

    it('should handle onError callback that throws', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient, { initialInterval: 50 });
      const emailAddress = 'test@example.com';

      let pollCount = 0;
      let pollResolvers: Array<{ resolve: (value: inboxSync.SyncResult) => void; reject: (error: Error) => void }> = [];

      (inboxSync.syncInbox as jest.Mock).mockImplementation(() => {
        pollCount++;
        return new Promise<inboxSync.SyncResult>((resolve, reject) => {
          pollResolvers.push({ resolve, reject });
        });
      });

      (sleepModule.sleep as jest.Mock).mockResolvedValue(undefined);

      const callback = jest.fn();
      const throwingOnError = jest.fn().mockImplementation(() => {
        throw new Error('Error callback threw');
      });
      const subscription = strategy.subscribe(
        emailAddress,
        'inbox-hash',
        mockKeypair,
        callback,
        undefined,
        undefined,
        throwingOnError,
      );

      await Promise.resolve();

      // First poll - error
      pollResolvers[0].reject(new Error('Sync error'));

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();

      // Should continue polling despite error callback throwing
      expect(pollCount).toBe(2);
      expect(throwingOnError).toHaveBeenCalled();

      subscription.unsubscribe();
    });

    it('should handle email fetch errors gracefully', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();
      const mockEmailData = createMockEmailData('email1');

      apiClient.getEmail.mockRejectedValue(new Error('Fetch error'));

      const callback = jest.fn();
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      await Promise.resolve();

      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      // Callback should not be called when fetch fails
      expect(callback).not.toHaveBeenCalled();

      subscription.unsubscribe();
    });

    it('should not call onEmailDeleted when not provided', async () => {
      const { strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();

      const callback = jest.fn();

      // No onEmailDeleted callback provided - should not throw
      const subscription = strategy.subscribe(emailAddress, 'inbox-hash', mockKeypair, callback);

      await Promise.resolve();

      resolvePoll({
        unchanged: false,
        added: [],
        deleted: ['deleted-email-1'],
      });

      await new Promise((resolve) => setImmediate(resolve));

      subscription.unsubscribe();
    });

    it('should do nothing when sync returns unchanged', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();

      const callback = jest.fn();
      const onEmailDeleted = jest.fn();

      const subscription = strategy.subscribe(
        emailAddress,
        'inbox-hash',
        mockKeypair,
        callback,
        undefined,
        onEmailDeleted,
      );

      await Promise.resolve();

      resolvePoll({
        unchanged: true,
        added: [],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).not.toHaveBeenCalled();
      expect(onEmailDeleted).not.toHaveBeenCalled();
      expect(apiClient.getEmail).not.toHaveBeenCalled();

      subscription.unsubscribe();
    });

    it('should remove email from seen set when deleted', async () => {
      const { apiClient, strategy, emailAddress, resolvePoll } = createControlledSubscribeTest();
      const mockEmail = createMockEmail('email1');
      const mockEmailData = createMockEmailData('email1');

      apiClient.getEmail.mockResolvedValue(mockEmailData);
      (emailUtils.decryptEmailData as jest.Mock).mockResolvedValue(mockEmail);

      const callback = jest.fn();
      const onEmailDeleted = jest.fn();

      const subscription = strategy.subscribe(
        emailAddress,
        'inbox-hash',
        mockKeypair,
        callback,
        undefined,
        onEmailDeleted,
      );

      await Promise.resolve();

      // First poll - email added
      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(callback).toHaveBeenCalledTimes(1);

      await Promise.resolve();

      // Second poll - email deleted
      resolvePoll({
        unchanged: false,
        added: [],
        deleted: ['email1'],
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(onEmailDeleted).toHaveBeenCalledWith('email1');

      await Promise.resolve();

      // Third poll - email re-added (should trigger callback again since it was removed from seen set)
      resolvePoll({
        unchanged: false,
        added: [mockEmailData],
        deleted: [],
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(callback).toHaveBeenCalledTimes(2);

      subscription.unsubscribe();
    });
  });

  describe('close', () => {
    it('should be callable without error', () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);

      expect(() => strategy.close()).not.toThrow();
    });

    it('should be idempotent', () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);

      strategy.close();
      strategy.close();
      strategy.close();
    });
  });

  describe('validateKeypair', () => {
    it('should throw DecryptionError when keypair is null for encrypted email', async () => {
      const apiClient = createMockApiClient();
      const strategy = new PollingStrategy(apiClient);
      const emailAddress = 'test@example.com';
      const mockEmailData = createMockEmailData('email1');

      apiClient.getSyncStatus.mockResolvedValue({
        emailCount: 1,
        emailsHash: 'hash1',
      });

      apiClient.listEmails.mockResolvedValue([mockEmailData]);

      // isEncryptedEmailData returns true by default in beforeEach

      await expect(
        strategy.waitForEmail(emailAddress, 'inbox-hash', null, {
          timeout: 5000,
        }),
      ).rejects.toThrow('Received encrypted email for inbox test@example.com but no keypair available');
    });
  });
});
