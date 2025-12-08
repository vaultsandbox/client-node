/**
 * Integration tests for the core VaultSandboxClient API.
 *
 * These tests verify the fundamental client-side operations for managing the client
 * and inboxes, such as initialization, creating, and deleting inboxes.
 * They do not cover email sending/receiving flows.
 *
 * These tests require a running VaultSandbox Gateway server.
 * Set the following environment variables:
 * - VAULTSANDBOX_URL: The gateway URL (default: http://localhost:3000)
 * - VAULTSANDBOX_API_KEY: Your API key
 */

import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';
import type { ApiClient } from '../src/http/api-client';
import { sleep } from '../src/utils/sleep';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:3000';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';

// Type helper for accessing private properties in tests
interface VaultSandboxClientWithPrivates {
  apiClient: ApiClient;
}

// Skip integration tests if no API key is provided
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

describeIntegration('VaultSandbox Client Tests', () => {
  let client: VaultSandboxClient;
  let createdInboxes: Inbox[] = [];

  beforeAll(() => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
    });
  });

  afterEach(async () => {
    // Clean up created inboxes
    for (const inbox of createdInboxes) {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    }
    createdInboxes = [];
  });

  describe('Client Initialization', () => {
    it('should check API key validity', async () => {
      const isValid = await client.checkKey();
      expect(isValid).toBe(true);
    });

    it('should fetch server info', async () => {
      const serverInfo = await client.getServerInfo();

      expect(serverInfo).toBeDefined();
      expect(serverInfo.serverSigPk).toBeDefined();
      expect(serverInfo.algs).toBeDefined();
      expect(serverInfo.algs.kem).toBe('ML-KEM-768');
      expect(serverInfo.algs.sig).toBe('ML-DSA-65');
      expect(serverInfo.algs.aead).toBe('AES-256-GCM');
      expect(serverInfo.algs.kdf).toBe('HKDF-SHA-512');
      expect(serverInfo.context).toBe('vaultsandbox:email:v1');
    });
  });

  describe('Inbox Management', () => {
    it('should create a new inbox', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      expect(inbox.emailAddress).toBeDefined();
      expect(inbox.emailAddress).toMatch(/@/);
      expect(inbox.inboxHash).toBeDefined();
      expect(inbox.expiresAt).toBeInstanceOf(Date);
    });

    it('should create inbox with custom TTL', async () => {
      const inbox = await client.createInbox({ ttl: 3600 });
      createdInboxes.push(inbox);

      expect(inbox.emailAddress).toBeDefined();
      expect(inbox.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should get sync status', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const syncStatus = await inbox.getSyncStatus();

      expect(syncStatus).toBeDefined();
      expect(syncStatus.emailCount).toBe(0);
      expect(syncStatus.emailsHash).toBeDefined();
    });

    it('should delete an inbox', async () => {
      const inbox = await client.createInbox();

      await inbox.delete();

      // Attempting to get sync status should fail after deletion
      await expect(inbox.getSyncStatus()).rejects.toThrow();
    });

    it('should list emails (empty inbox)', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const emails = await inbox.listEmails();

      expect(emails).toEqual([]);
    });
  });

  describe('Bulk Operations', () => {
    it('should call deleteAllInboxes API endpoint', async () => {
      // This test is mocked because deleteAllInboxes is too destructive and would
      // interfere with parallel testing and manual usage on the same server.
      const mockDeletedCount = 5;

      // Mock the underlying HTTP client delete method to cover the ApiClient implementation
      const httpClientSpy = jest
        .spyOn((client as unknown as VaultSandboxClientWithPrivates).apiClient['client'], 'delete')
        .mockResolvedValue({ data: { deleted: mockDeletedCount } });

      // Call the method
      const deletedCount = await client.deleteAllInboxes();

      // Verify the HTTP delete method was called with the correct endpoint
      expect(httpClientSpy).toHaveBeenCalledWith('/api/inboxes');
      expect(httpClientSpy).toHaveBeenCalledTimes(1);

      // Verify the return value
      expect(deletedCount).toBe(mockDeletedCount);

      // Restore the original implementation
      httpClientSpy.mockRestore();
    });
  });

  describe('Client Configuration', () => {
    it('should expose base URL via apiClient', () => {
      const baseUrl = (client as unknown as VaultSandboxClientWithPrivates).apiClient.getBaseUrl();
      expect(baseUrl).toBe(GATEWAY_URL);
    });

    it('should expose API key via apiClient', () => {
      const apiKey = (client as unknown as VaultSandboxClientWithPrivates).apiClient.getApiKey();
      expect(apiKey).toBe(API_KEY);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid inbox address gracefully', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      await expect(inbox.getEmail('non-existent-email-id')).rejects.toThrow();
    }, 10000);

    it('should have working sleep utility for retry backoff', async () => {
      const startTime = Date.now();
      const sleepDuration = 100;

      // Test the centralized sleep utility
      await sleep(sleepDuration);

      const endTime = Date.now();
      const elapsed = endTime - startTime;

      // Verify sleep duration (allow some tolerance for timing)
      expect(elapsed).toBeGreaterThanOrEqual(sleepDuration - 5); // once I got a 99
      expect(elapsed).toBeLessThan(sleepDuration + 50); // Not too much longer
    });
  });
});

// Export test helpers for manual testing
export function createTestClient(url?: string, apiKey?: string): VaultSandboxClient {
  return new VaultSandboxClient({
    url: url || GATEWAY_URL,
    apiKey: apiKey || API_KEY,
  });
}
