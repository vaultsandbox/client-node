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
import { StrategyError, ApiError, InboxAlreadyExistsError } from '../src/types/index';

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

    it('should delete an inbox by email address via client', async () => {
      const inbox = await client.createInbox();
      const emailAddress = inbox.emailAddress;

      await client.deleteInbox(emailAddress);

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

// Unit tests that don't require a server
describe('VaultSandbox Client Unit Tests', () => {
  describe('TTL Validation', () => {
    it('should throw error when TTL is not an integer', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: unknown;
      };

      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: jest.fn() };

      await expect(client.createInbox({ ttl: 3.5 })).rejects.toThrow('TTL must be an integer');
    });

    it('should throw error when TTL is not positive', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: unknown;
      };

      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: jest.fn() };

      await expect(client.createInbox({ ttl: 0 })).rejects.toThrow('TTL must be positive');
      await expect(client.createInbox({ ttl: -1 })).rejects.toThrow('TTL must be positive');
    });

    it('should throw error when TTL exceeds server maximum', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: unknown;
        maxTtl: number;
      };

      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: jest.fn() };
      clientWithPrivates.maxTtl = 3600;

      await expect(client.createInbox({ ttl: 7200 })).rejects.toThrow('TTL exceeds server maximum of 3600 seconds');
    });
  });

  it('should default persistencePolicy to null when server info omits it', async () => {
    const client = new VaultSandboxClient({
      url: 'http://localhost:3000',
      apiKey: 'test-api-key',
    });

    const clientWithPrivates = client as unknown as {
      apiClient: ApiClient;
      persistencePolicy: string | null;
    };

    // Mock getServerInfo to return response without persistencePolicy
    clientWithPrivates.apiClient.getServerInfo = jest.fn().mockResolvedValue({
      serverSigPk: 'mock-key',
      encryptionPolicy: 'enabled',
      maxTtl: 86400,
      defaultTtl: 3600,
      sseConsole: false,
      allowedDomains: [],
      algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
      context: 'vaultsandbox:email:v1',
      // persistencePolicy intentionally omitted
    });

    // Trigger ensureInitialized via getServerInfo -> createInbox would also work
    // but we need to access privates, so call createInbox with a TTL error to short-circuit
    await expect(client.createInbox({ ttl: 0 })).rejects.toThrow('TTL must be positive');

    expect(clientWithPrivates.persistencePolicy).toBeNull();
  });

  it('should throw StrategyError when calling monitorInboxes before initialization', () => {
    const uninitializedClient = new VaultSandboxClient({
      url: 'http://localhost:3000',
      apiKey: 'test-api-key',
    });

    // monitorInboxes requires strategy to be set, which only happens after ensureInitialized()
    expect(() => uninitializedClient.monitorInboxes([])).toThrow(StrategyError);
    expect(() => uninitializedClient.monitorInboxes([])).toThrow('No delivery strategy available');
  });

  it('should throw InboxAlreadyExistsError when createInbox receives 409 conflict', async () => {
    const client = new VaultSandboxClient({
      url: 'http://localhost:3000',
      apiKey: 'test-api-key',
    });

    // Mock ensureInitialized by setting private properties
    const clientWithPrivates = client as unknown as {
      serverPublicKey: string;
      encryptionPolicy: string;
      strategy: unknown;
      apiClient: ApiClient;
    };

    clientWithPrivates.serverPublicKey = 'mock-server-public-key';
    clientWithPrivates.encryptionPolicy = 'enabled';
    clientWithPrivates.strategy = { close: jest.fn() };

    // Mock apiClient.createInbox to throw ApiError with 409
    clientWithPrivates.apiClient.createInbox = jest.fn().mockRejectedValue(new ApiError(409, 'Inbox already exists'));

    await expect(client.createInbox({ emailAddress: 'test@example.com' })).rejects.toThrow(InboxAlreadyExistsError);
    await expect(client.createInbox({ emailAddress: 'test@example.com' })).rejects.toThrow(
      'Inbox already exists: test@example.com',
    );
  });

  it('should re-throw non-409 ApiErrors from createInbox', async () => {
    const client = new VaultSandboxClient({
      url: 'http://localhost:3000',
      apiKey: 'test-api-key',
    });

    // Mock ensureInitialized by setting private properties
    const clientWithPrivates = client as unknown as {
      serverPublicKey: string;
      encryptionPolicy: string;
      strategy: unknown;
      apiClient: ApiClient;
    };

    clientWithPrivates.serverPublicKey = 'mock-server-public-key';
    clientWithPrivates.encryptionPolicy = 'enabled';
    clientWithPrivates.strategy = { close: jest.fn() };

    // Mock apiClient.createInbox to throw ApiError with 500
    clientWithPrivates.apiClient.createInbox = jest.fn().mockRejectedValue(new ApiError(500, 'Internal server error'));

    await expect(client.createInbox()).rejects.toThrow(ApiError);
    await expect(client.createInbox()).rejects.toThrow('Internal server error');
  });

  describe('graceful shutdown', () => {
    it('should close with default timeout', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      // Mock ensureInitialized by setting private properties
      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: { close: () => void };
        inboxes: Map<string, unknown>;
      };

      const mockClose = jest.fn();
      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: mockClose };

      await client.close();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should close strategy when closing client', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      // Mock ensureInitialized by setting private properties
      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: { close: () => void };
        inboxes: Map<string, unknown>;
      };

      const mockClose = jest.fn();
      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: mockClose };

      await client.close();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should unsubscribe all inboxes during close', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      const mockUnsubscribeAll = jest.fn();
      const mockInbox = { unsubscribeAll: mockUnsubscribeAll };

      // Mock ensureInitialized by setting private properties
      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: { close: () => void };
        inboxes: Map<string, unknown>;
      };

      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: jest.fn() };
      clientWithPrivates.inboxes = new Map([['test@example.com', mockInbox]]);

      await client.close();

      expect(mockUnsubscribeAll).toHaveBeenCalled();
    });

    it('should not wait forever if unsubscribe hangs', async () => {
      const client = new VaultSandboxClient({
        url: 'http://localhost:3000',
        apiKey: 'test-api-key',
      });

      // Create an inbox that hangs on unsubscribeAll
      const mockUnsubscribeAll = jest.fn().mockImplementation(() => {
        return new Promise(() => {
          // Never resolves
        });
      });
      const mockInbox = { unsubscribeAll: mockUnsubscribeAll };

      // Mock ensureInitialized by setting private properties
      const clientWithPrivates = client as unknown as {
        serverPublicKey: string;
        encryptionPolicy: string;
        strategy: { close: () => void };
        inboxes: Map<string, unknown>;
      };

      clientWithPrivates.serverPublicKey = 'mock-server-public-key';
      clientWithPrivates.encryptionPolicy = 'enabled';
      clientWithPrivates.strategy = { close: jest.fn() };
      clientWithPrivates.inboxes = new Map([['test@example.com', mockInbox]]);

      const startTime = Date.now();
      await client.close();
      const elapsed = Date.now() - startTime;

      // Should complete quickly since unsubscribeAll is synchronous
      expect(elapsed).toBeLessThan(100);
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
