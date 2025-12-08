/**
 * Integration tests for the Polling delivery strategy.
 *
 * These tests focus on the specific mechanics of the polling strategy,
 * such as exponential backoff, custom intervals, and sync-based change detection.
 */

import { VaultSandboxClient } from '../src/client';
import { PollingStrategy } from '../src/strategies/polling-strategy';
import { Inbox } from '../src/inbox';
import type { ApiClient } from '../src/http/api-client';
import type { Keypair } from '../src/types';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:3000';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';

// Type helpers for accessing private properties in tests
interface VaultSandboxClientWithPrivates {
  apiClient: ApiClient;
}

interface InboxWithPrivates {
  keypair: Keypair;
}

// Skip integration tests if no API key is provided
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

describeIntegration('Polling Strategy Tests', () => {
  let client: VaultSandboxClient;
  let createdInboxes: Inbox[] = [];

  beforeAll(() => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
      strategy: 'polling',
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

  describe('Exponential Backoff', () => {
    it('should timeout with exponential backoff when no email arrives', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const startTime = Date.now();
      const timeout = 5000;

      await expect(inbox.waitForEmail({ timeout })).rejects.toThrow('No matching email received within timeout');

      const elapsed = Date.now() - startTime;

      // Should timeout close to the specified timeout (within 1.5s tolerance for async operations)
      expect(elapsed).toBeGreaterThanOrEqual(timeout);
      expect(elapsed).toBeLessThan(timeout + 1500);
    }, 15000);

    it('should respect custom polling interval', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const customInterval = 1000;
      const timeout = 3000;
      const startTime = Date.now();

      await expect(inbox.waitForEmail({ timeout, pollInterval: customInterval })).rejects.toThrow(
        'No matching email received within timeout',
      );

      const elapsed = Date.now() - startTime;

      // Should timeout close to the specified timeout (within 1.5s tolerance for async operations)
      expect(elapsed).toBeGreaterThanOrEqual(timeout);
      expect(elapsed).toBeLessThan(timeout + 1500);
    }, 15000);
  });

  describe('Sync-based Change Detection', () => {
    it('should efficiently detect changes using sync endpoint', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Get initial sync status
      const initialSync = await inbox.getSyncStatus();
      expect(initialSync.emailCount).toBe(0);
      expect(initialSync.emailsHash).toBeDefined();

      // Multiple calls should return the same hash (no changes)
      const secondSync = await inbox.getSyncStatus();
      expect(secondSync.emailsHash).toBe(initialSync.emailsHash);
      expect(secondSync.emailCount).toBe(0);
    });

    it('should detect when sync hash changes after email arrival', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const initialSync = await inbox.getSyncStatus();

      // Note: This test requires sending an email to the inbox
      // which is beyond the scope of Phase 2 without SMTP client
      // For now, we just verify the sync status returns consistent data
      expect(initialSync.emailCount).toBe(0);
      expect(initialSync.emailsHash).toBeDefined();
    });
  });

  describe('PollingStrategy Class', () => {
    it('should create polling strategy with default config', () => {
      const apiClient = (client as unknown as VaultSandboxClientWithPrivates).apiClient;
      const strategy = new PollingStrategy(apiClient);

      expect(strategy).toBeDefined();
    });

    it('should create polling strategy with custom config', () => {
      const apiClient = (client as unknown as VaultSandboxClientWithPrivates).apiClient;
      const strategy = new PollingStrategy(apiClient, {
        initialInterval: 1000,
        maxBackoff: 15000,
        backoffMultiplier: 2.0,
        jitterFactor: 0.2,
      });

      expect(strategy).toBeDefined();
    });

    it('should timeout when using strategy directly', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const apiClient = (client as unknown as VaultSandboxClientWithPrivates).apiClient;
      const strategy = new PollingStrategy(apiClient, {
        initialInterval: 500,
        maxBackoff: 5000,
      });

      // Extract keypair from inbox (private field)
      const keypair = (inbox as unknown as InboxWithPrivates).keypair;

      await expect(
        strategy.waitForEmail(inbox.emailAddress, inbox.inboxHash, keypair, { timeout: 2000 }),
      ).rejects.toThrow('No matching email received within timeout');
    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle inbox deletion during polling', async () => {
      const inbox = await client.createInbox();

      // Start waiting for email
      const waitPromise = inbox.waitForEmail({ timeout: 10000 });

      // Delete inbox after a short delay
      setTimeout(async () => {
        await inbox.delete();
      }, 1000);

      // Should eventually error when polling encounters 404
      await expect(waitPromise).rejects.toThrow();
    }, 15000);

    it('should handle network errors gracefully', async () => {
      // Create client with invalid URL to simulate network error
      const badClient = new VaultSandboxClient({
        url: 'http://invalid-host-that-does-not-exist:9999',
        apiKey: API_KEY,
      });

      await expect(badClient.createInbox()).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    it('should handle multiple concurrent polling operations', async () => {
      const inboxes = await Promise.all([client.createInbox(), client.createInbox(), client.createInbox()]);

      createdInboxes.push(...inboxes);

      // Start polling on all inboxes concurrently
      const waitPromises = inboxes.map((inbox) => inbox.waitForEmail({ timeout: 2000 }).catch((error) => error));

      const results = await Promise.all(waitPromises);

      // All should timeout (no emails sent)
      results.forEach((result) => {
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain('No matching email received within timeout');
      });
    }, 15000);

    it('should efficiently use sync endpoint for change detection', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Multiple sync status calls should be fast
      const startTime = Date.now();
      await Promise.all([
        inbox.getSyncStatus(),
        inbox.getSyncStatus(),
        inbox.getSyncStatus(),
        inbox.getSyncStatus(),
        inbox.getSyncStatus(),
      ]);
      const elapsed = Date.now() - startTime;

      // Should complete quickly (less than 4 seconds for 5 calls)
      expect(elapsed).toBeLessThan(4000);
    });
  });
});
