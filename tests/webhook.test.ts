/**
 * Integration tests for Webhook functionality.
 *
 * Tests cover:
 * - Inbox webhook CRUD operations (createWebhook, listWebhooks, getWebhook, updateWebhook, deleteWebhook)
 * - Webhook testing (testWebhook)
 * - Webhook secret rotation (rotateWebhookSecret)
 * - WebhookNotFoundError handling
 *
 * These tests require a running VaultSandbox Gateway server.
 * Set the following environment variables:
 * - VAULTSANDBOX_URL: The gateway URL (default: http://localhost:3000)
 * - VAULTSANDBOX_API_KEY: Your API key
 */

import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';
import { ApiClient } from '../src/http/api-client';
import { WebhookNotFoundError, ApiError } from '../src/types/index';
import type { WebhookData } from '../src/types/index';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:3000';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';

// Skip integration tests if no API key is provided
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

describeIntegration('Webhook Integration Tests', () => {
  let client: VaultSandboxClient;
  let inbox: Inbox;

  beforeAll(async () => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
    });
    // Create an inbox for webhook tests
    inbox = await client.createInbox();
  });

  afterAll(async () => {
    // Clean up the inbox
    try {
      await inbox.delete();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Webhook CRUD Operations', () => {
    let createdWebhook: WebhookData;

    it('should create a webhook for an inbox', async () => {
      createdWebhook = await inbox.createWebhook({
        url: 'https://example.com/webhook',
        events: ['email.received'],
        description: 'Test webhook',
      });

      expect(createdWebhook.id).toBeDefined();
      expect(createdWebhook.url).toBe('https://example.com/webhook');
      expect(createdWebhook.events).toContain('email.received');
      expect(createdWebhook.scope).toBe('inbox');
      expect(createdWebhook.enabled).toBe(true);
      expect(createdWebhook.secret).toBeDefined(); // Secret is only returned on creation
      expect(createdWebhook.description).toBe('Test webhook');
      expect(createdWebhook.createdAt).toBeDefined();
    });

    it('should list webhooks for an inbox', async () => {
      const response = await inbox.listWebhooks();

      expect(response.total).toBeGreaterThanOrEqual(1);
      expect(response.webhooks).toBeInstanceOf(Array);

      const found = response.webhooks.find((w) => w.id === createdWebhook.id);
      expect(found).toBeDefined();
      expect(found?.url).toBe('https://example.com/webhook');
    });

    it('should get a specific webhook by ID', async () => {
      const webhook = await inbox.getWebhook(createdWebhook.id);

      expect(webhook.id).toBe(createdWebhook.id);
      expect(webhook.url).toBe('https://example.com/webhook');
      expect(webhook.events).toContain('email.received');
      expect(webhook.description).toBe('Test webhook');
    });

    it('should update a webhook', async () => {
      const updatedWebhook = await inbox.updateWebhook(createdWebhook.id, {
        url: 'https://example.com/webhook-updated',
        description: 'Updated test webhook',
        enabled: false,
      });

      expect(updatedWebhook.id).toBe(createdWebhook.id);
      expect(updatedWebhook.url).toBe('https://example.com/webhook-updated');
      expect(updatedWebhook.description).toBe('Updated test webhook');
      expect(updatedWebhook.enabled).toBe(false);
    });

    it('should test a webhook', async () => {
      // Re-enable the webhook first
      await inbox.updateWebhook(createdWebhook.id, { enabled: true });

      const result = await inbox.testWebhook(createdWebhook.id);

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      // The test may fail since the URL doesn't exist, but the method should work
      expect(result.payloadSent).toBeDefined();
    });

    it('should rotate a webhook secret', async () => {
      const rotateResult = await inbox.rotateWebhookSecret(createdWebhook.id);

      expect(rotateResult.id).toBe(createdWebhook.id);
      expect(rotateResult.secret).toBeDefined();
      expect(rotateResult.secret).not.toBe(createdWebhook.secret);
      expect(rotateResult.previousSecretValidUntil).toBeDefined();
    });

    it('should delete a webhook', async () => {
      await inbox.deleteWebhook(createdWebhook.id);

      // Verify the webhook is deleted - server returns 404 ApiError
      await expect(inbox.getWebhook(createdWebhook.id)).rejects.toThrow(ApiError);
    });
  });

  describe('Webhook with Filter', () => {
    let filteredWebhook: WebhookData;

    afterEach(async () => {
      if (filteredWebhook) {
        try {
          await inbox.deleteWebhook(filteredWebhook.id);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should create a webhook with filter configuration', async () => {
      filteredWebhook = await inbox.createWebhook({
        url: 'https://example.com/filtered-webhook',
        events: ['email.received', 'email.stored'],
        filter: {
          rules: [{ field: 'subject', operator: 'equals', value: 'Test Subject' }],
          mode: 'all',
        },
        description: 'Filtered webhook',
      });

      expect(filteredWebhook.id).toBeDefined();
      expect(filteredWebhook.filter).toBeDefined();
      expect(filteredWebhook.filter?.rules).toHaveLength(1);
      expect(filteredWebhook.filter?.rules[0].field).toBe('subject');
      expect(filteredWebhook.filter?.rules[0].operator).toBe('equals');
      expect(filteredWebhook.filter?.rules[0].value).toBe('Test Subject');
      expect(filteredWebhook.filter?.mode).toBe('all');
    });
  });

  describe('Webhook with Template', () => {
    let templateWebhook: WebhookData;

    afterEach(async () => {
      if (templateWebhook) {
        try {
          await inbox.deleteWebhook(templateWebhook.id);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should create a webhook with a named template', async () => {
      templateWebhook = await inbox.createWebhook({
        url: 'https://hooks.slack.com/services/test',
        events: ['email.received'],
        template: 'slack',
      });

      expect(templateWebhook.id).toBeDefined();
      expect(templateWebhook.template).toBeDefined();
    });

    it('should create a webhook with a custom template', async () => {
      templateWebhook = await inbox.createWebhook({
        url: 'https://example.com/custom-webhook',
        events: ['email.received'],
        template: {
          type: 'custom',
          body: '{"email_from": "{{from}}", "email_subject": "{{subject}}"}',
          contentType: 'application/json',
        },
      });

      expect(templateWebhook.id).toBeDefined();
      expect(templateWebhook.template).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw ApiError for non-existent webhook', async () => {
      await expect(inbox.getWebhook('non-existent-webhook-id')).rejects.toThrow(ApiError);
    });

    it('should throw ApiError when updating non-existent webhook', async () => {
      await expect(inbox.updateWebhook('non-existent-webhook-id', { enabled: false })).rejects.toThrow(ApiError);
    });

    it('should throw ApiError when testing non-existent webhook', async () => {
      await expect(inbox.testWebhook('non-existent-webhook-id')).rejects.toThrow(ApiError);
    });

    it('should throw ApiError when rotating secret for non-existent webhook', async () => {
      await expect(inbox.rotateWebhookSecret('non-existent-webhook-id')).rejects.toThrow(ApiError);
    });
  });
});

// Unit tests for WebhookNotFoundError handling (covers api-client.ts line 115)
describe('WebhookNotFoundError Unit Tests', () => {
  it('should throw WebhookNotFoundError when server returns 404 with webhook message', async () => {
    const apiClient = new ApiClient({
      url: 'http://localhost:9999', // Non-existent server
      apiKey: 'test-key',
    });

    // Access the private handleError method via a type cast
    const handleError = (apiClient as unknown as { handleError: (error: unknown) => Error }).handleError.bind(
      apiClient,
    );

    // Create a mock Axios error with 404 status and "webhook" in the message
    const mockAxiosError = {
      response: {
        status: 404,
        data: { error: 'Webhook not found' },
      },
      message: 'Request failed with status code 404',
    };

    const error = handleError(mockAxiosError);

    expect(error).toBeInstanceOf(WebhookNotFoundError);
    expect(error.message).toBe('Webhook not found');
  });

  it('should throw ApiError when server returns 404 without webhook message', async () => {
    const apiClient = new ApiClient({
      url: 'http://localhost:9999',
      apiKey: 'test-key',
    });

    const handleError = (apiClient as unknown as { handleError: (error: unknown) => Error }).handleError.bind(
      apiClient,
    );

    // Create a mock Axios error with 404 status but without "webhook" in the message
    const mockAxiosError = {
      response: {
        status: 404,
        data: { error: 'Not Found' },
      },
      message: 'Request failed with status code 404',
    };

    const error = handleError(mockAxiosError);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Not Found');
  });
});
