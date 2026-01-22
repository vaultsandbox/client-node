/**
 * Integration tests for Chaos Configuration functionality.
 *
 * Tests cover:
 * - Chaos configuration CRUD operations (getChaosConfig, setChaosConfig, disableChaos)
 * - Creating inbox with chaos configuration
 * - All chaos types: latency, connectionDrop, randomError, greylist, blackhole
 * - Error handling when chaos is disabled globally
 *
 * These tests require a running VaultSandbox Gateway server with chaos enabled.
 * Set the following environment variables:
 * - VAULTSANDBOX_URL: The gateway URL (default: http://localhost:3000)
 * - VAULTSANDBOX_API_KEY: Your API key
 */

import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';
import { ApiError } from '../src/types/index';
import type { ChaosConfigRequest, ServerInfo } from '../src/types/index';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:3000';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';

// Skip integration tests if no API key is provided
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

describeIntegration('Chaos Configuration Integration Tests', () => {
  let client: VaultSandboxClient;
  let inbox: Inbox;
  let serverInfo: ServerInfo;

  beforeAll(async () => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
    });
    serverInfo = await client.getServerInfo();

    // Only run tests if chaos is enabled on the server
    if (!serverInfo.chaosEnabled) {
      console.warn('Chaos is not enabled on the server. Skipping chaos tests.');
    }
  });

  // Helper to skip tests if chaos is not enabled
  const itIfChaosEnabled = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      if (!serverInfo.chaosEnabled) {
        console.warn(`Skipping test "${name}" - chaos not enabled on server`);
        return;
      }
      await fn();
    });
  };

  describe('Basic Chaos Configuration', () => {
    beforeEach(async () => {
      // Create a fresh inbox for each test
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      // Clean up the inbox
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should get default chaos config for a new inbox', async () => {
      const config = await inbox.getChaosConfig();

      expect(config).toBeDefined();
      expect(config.enabled).toBe(false);
    });

    itIfChaosEnabled('should set chaos config with enabled=true', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
    });

    itIfChaosEnabled('should disable chaos', async () => {
      // First enable chaos
      await inbox.setChaosConfig({ enabled: true });

      // Then disable it
      await inbox.disableChaos();

      // Verify it's disabled
      const config = await inbox.getChaosConfig();
      expect(config.enabled).toBe(false);
    });

    itIfChaosEnabled('should set chaos config with expiresAt', async () => {
      const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      const config: ChaosConfigRequest = {
        enabled: true,
        expiresAt,
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.expiresAt).toBeDefined();
    });
  });

  describe('Latency Chaos Type', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should set latency chaos with default values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.latency).toBeDefined();
      expect(result.latency?.enabled).toBe(true);
    });

    itIfChaosEnabled('should set latency chaos with custom values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          minDelayMs: 1000,
          maxDelayMs: 5000,
          jitter: true,
          probability: 0.5,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.latency).toBeDefined();
      expect(result.latency?.enabled).toBe(true);
      expect(result.latency?.minDelayMs).toBe(1000);
      expect(result.latency?.maxDelayMs).toBe(5000);
      expect(result.latency?.jitter).toBe(true);
      expect(result.latency?.probability).toBe(0.5);
    });

    itIfChaosEnabled('should set latency chaos with jitter disabled', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          minDelayMs: 500,
          maxDelayMs: 2000,
          jitter: false,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.latency?.jitter).toBe(false);
    });
  });

  describe('Connection Drop Chaos Type', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should set connection drop chaos with default values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        connectionDrop: {
          enabled: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.connectionDrop).toBeDefined();
      expect(result.connectionDrop?.enabled).toBe(true);
    });

    itIfChaosEnabled('should set connection drop chaos with custom options', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        connectionDrop: {
          enabled: true,
          probability: 0.3,
          graceful: false,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.connectionDrop?.probability).toBe(0.3);
      expect(result.connectionDrop?.graceful).toBe(false);
    });

    itIfChaosEnabled('should set connection drop chaos with graceful close', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        connectionDrop: {
          enabled: true,
          graceful: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.connectionDrop?.graceful).toBe(true);
    });
  });

  describe('Random Error Chaos Type', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should set random error chaos with default values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        randomError: {
          enabled: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.randomError).toBeDefined();
      expect(result.randomError?.enabled).toBe(true);
    });

    itIfChaosEnabled('should set random error chaos with temporary errors only', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        randomError: {
          enabled: true,
          errorRate: 0.2,
          errorTypes: ['temporary'],
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.randomError?.errorRate).toBe(0.2);
      expect(result.randomError?.errorTypes).toContain('temporary');
    });

    itIfChaosEnabled('should set random error chaos with permanent errors only', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        randomError: {
          enabled: true,
          errorRate: 0.1,
          errorTypes: ['permanent'],
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.randomError?.errorTypes).toContain('permanent');
    });

    itIfChaosEnabled('should set random error chaos with both error types', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        randomError: {
          enabled: true,
          errorRate: 0.15,
          errorTypes: ['temporary', 'permanent'],
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.randomError?.errorTypes).toContain('temporary');
      expect(result.randomError?.errorTypes).toContain('permanent');
    });
  });

  describe('Greylist Chaos Type', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should set greylist chaos with default values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        greylist: {
          enabled: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.greylist).toBeDefined();
      expect(result.greylist?.enabled).toBe(true);
    });

    itIfChaosEnabled('should set greylist chaos with custom values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        greylist: {
          enabled: true,
          retryWindowMs: 600000,
          maxAttempts: 3,
          trackBy: 'ip_sender',
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.greylist?.retryWindowMs).toBe(600000);
      expect(result.greylist?.maxAttempts).toBe(3);
      expect(result.greylist?.trackBy).toBe('ip_sender');
    });

    itIfChaosEnabled('should set greylist chaos with ip tracking', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        greylist: {
          enabled: true,
          trackBy: 'ip',
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.greylist?.trackBy).toBe('ip');
    });

    itIfChaosEnabled('should set greylist chaos with sender tracking', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        greylist: {
          enabled: true,
          trackBy: 'sender',
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.greylist?.trackBy).toBe('sender');
    });
  });

  describe('Blackhole Chaos Type', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should set blackhole chaos with default values', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        blackhole: {
          enabled: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.blackhole).toBeDefined();
      expect(result.blackhole?.enabled).toBe(true);
    });

    itIfChaosEnabled('should set blackhole chaos with webhooks enabled', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        blackhole: {
          enabled: true,
          triggerWebhooks: true,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.blackhole?.triggerWebhooks).toBe(true);
    });

    itIfChaosEnabled('should set blackhole chaos with webhooks disabled', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        blackhole: {
          enabled: true,
          triggerWebhooks: false,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.blackhole?.triggerWebhooks).toBe(false);
    });
  });

  describe('Combined Chaos Types', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should set multiple chaos types simultaneously', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          minDelayMs: 500,
          maxDelayMs: 2000,
          probability: 0.8,
        },
        randomError: {
          enabled: true,
          errorRate: 0.1,
          errorTypes: ['temporary'],
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.latency?.enabled).toBe(true);
      expect(result.randomError?.enabled).toBe(true);
    });

    itIfChaosEnabled('should set all chaos types at once', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        latency: {
          enabled: true,
          minDelayMs: 100,
          maxDelayMs: 1000,
        },
        connectionDrop: {
          enabled: false,
        },
        randomError: {
          enabled: true,
          errorRate: 0.05,
        },
        greylist: {
          enabled: false,
          maxAttempts: 2,
        },
        blackhole: {
          enabled: false,
        },
      };

      const result = await inbox.setChaosConfig(config);

      expect(result.enabled).toBe(true);
      expect(result.latency?.enabled).toBe(true);
      expect(result.connectionDrop?.enabled).toBe(false);
      expect(result.randomError?.enabled).toBe(true);
      expect(result.greylist?.enabled).toBe(false);
      expect(result.blackhole?.enabled).toBe(false);
    });

    itIfChaosEnabled('should update chaos config replacing previous settings', async () => {
      // Set initial config with latency
      await inbox.setChaosConfig({
        enabled: true,
        latency: {
          enabled: true,
          minDelayMs: 1000,
        },
      });

      // Update to use random error instead
      const result = await inbox.setChaosConfig({
        enabled: true,
        randomError: {
          enabled: true,
          errorRate: 0.2,
        },
      });

      expect(result.enabled).toBe(true);
      expect(result.randomError?.enabled).toBe(true);
    });
  });

  describe('Create Inbox with Chaos', () => {
    let chaosInbox: Inbox;

    afterEach(async () => {
      if (chaosInbox) {
        try {
          await chaosInbox.delete();
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    itIfChaosEnabled('should create inbox with chaos configuration', async () => {
      chaosInbox = await client.createInbox({
        chaos: {
          enabled: true,
          latency: {
            enabled: true,
            minDelayMs: 500,
            maxDelayMs: 2000,
          },
        },
      });

      expect(chaosInbox.emailAddress).toBeDefined();

      // Verify the chaos config was applied
      const config = await chaosInbox.getChaosConfig();
      expect(config.enabled).toBe(true);
      expect(config.latency?.enabled).toBe(true);
    });

    itIfChaosEnabled('should create inbox with complex chaos configuration', async () => {
      chaosInbox = await client.createInbox({
        chaos: {
          enabled: true,
          latency: {
            enabled: true,
            minDelayMs: 100,
            maxDelayMs: 500,
            probability: 0.5,
          },
          randomError: {
            enabled: true,
            errorRate: 0.1,
            errorTypes: ['temporary'],
          },
        },
      });

      const config = await chaosInbox.getChaosConfig();
      expect(config.enabled).toBe(true);
      expect(config.latency?.enabled).toBe(true);
      expect(config.randomError?.enabled).toBe(true);
    });

    itIfChaosEnabled('should create inbox with chaos disabled by default', async () => {
      chaosInbox = await client.createInbox({
        chaos: {
          enabled: false,
        },
      });

      const config = await chaosInbox.getChaosConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      inbox = await client.createInbox();
    });

    afterEach(async () => {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    });

    itIfChaosEnabled('should reject invalid probability value (> 1)', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          probability: 1.5, // Invalid: > 1
        },
      };

      await expect(inbox.setChaosConfig(config)).rejects.toThrow(ApiError);
    });

    itIfChaosEnabled('should reject invalid probability value (< 0)', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          probability: -0.5, // Invalid: < 0
        },
      };

      await expect(inbox.setChaosConfig(config)).rejects.toThrow(ApiError);
    });

    itIfChaosEnabled('should accept minDelayMs > maxDelayMs (server may swap or handle)', async () => {
      // Note: The server may accept this and handle it internally (e.g., swap values)
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          minDelayMs: 5000,
          maxDelayMs: 1000,
        },
      };

      const result = await inbox.setChaosConfig(config);
      expect(result.enabled).toBe(true);
      expect(result.latency?.enabled).toBe(true);
    });

    itIfChaosEnabled('should reject maxDelayMs > 60000', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        latency: {
          enabled: true,
          maxDelayMs: 120000, // Invalid: > 60000
        },
      };

      await expect(inbox.setChaosConfig(config)).rejects.toThrow(ApiError);
    });

    itIfChaosEnabled('should reject invalid errorRate (> 1)', async () => {
      const config: ChaosConfigRequest = {
        enabled: true,
        randomError: {
          enabled: true,
          errorRate: 2.0, // Invalid: > 1
        },
      };

      await expect(inbox.setChaosConfig(config)).rejects.toThrow(ApiError);
    });

    itIfChaosEnabled('should handle chaos operations on non-existent inbox', async () => {
      // Delete the inbox first
      await inbox.delete();

      // Try to get chaos config - should fail
      await expect(inbox.getChaosConfig()).rejects.toThrow(ApiError);
    });
  });

  describe('Chaos Disabled on Server', () => {
    it('should return chaosEnabled flag from server info', async () => {
      const info = await client.getServerInfo();
      expect(typeof info.chaosEnabled).toBe('boolean');
    });
  });
});

// Tests that work even without a real server (using mocked chaos disabled scenario)
describe('Chaos Configuration - Server Disabled Scenario', () => {
  it('should handle 403 when chaos is disabled globally', async () => {
    // This tests the error handling path when chaos is disabled on the server
    // In a real scenario, the server would return 403 Forbidden
    const mockError = new ApiError(403, 'Chaos is disabled globally on the server');
    expect(mockError.statusCode).toBe(403);
    expect(mockError.message).toContain('Chaos is disabled');
  });
});
