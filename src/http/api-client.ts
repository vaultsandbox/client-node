/**
 * HTTP API client for VaultSandbox Gateway
 */

import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import type {
  ClientConfig,
  InboxData,
  EmailData,
  ServerInfo,
  SyncStatus,
  RawEmailData,
  CreateWebhookOptions,
  UpdateWebhookOptions,
  WebhookData,
  WebhookListResponse,
  TestWebhookResponse,
  RotateSecretResponse,
  ChaosConfigRequest,
  ChaosConfigResponse,
} from '../types/index.js';
import {
  ApiError,
  NetworkError,
  InboxNotFoundError,
  EmailNotFoundError,
  WebhookNotFoundError,
} from '../types/index.js';
import { sleep } from '../utils/sleep.js';

/** Default HTTP request timeout in milliseconds */
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

/** Default maximum number of retry attempts for failed requests */
const DEFAULT_MAX_RETRIES = 3;

/** Default delay between retries in milliseconds (used as base for exponential backoff) */
const DEFAULT_RETRY_DELAY_MS = 1000;

/** Default HTTP status codes that trigger automatic retry */
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Extended AxiosRequestConfig with retry tracking
 */
interface RetryableAxiosRequestConfig extends AxiosRequestConfig {
  __retryCount?: number;
}

/**
 * HTTP API client for interacting with the VaultSandbox Gateway server.
 * Handles all API communication including inbox management, email operations,
 * and server information retrieval with built-in retry logic.
 */
export class ApiClient {
  private client: AxiosInstance;
  private config: ClientConfig;

  /**
   * Creates a new API client instance.
   * @param config - Configuration object containing URL, API key, and retry settings
   */
  constructor(config: ClientConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.url,
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: DEFAULT_HTTP_TIMEOUT_MS,
    });

    // Setup retry logic
    this.setupRetry();
  }

  /**
   * Configures automatic retry logic for failed HTTP requests.
   * Retries are performed with exponential backoff for specific HTTP status codes.
   * @private
   */
  private setupRetry(): void {
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config;
        const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
        const retryDelay = this.config.retryDelay ?? DEFAULT_RETRY_DELAY_MS;
        const retryOn = this.config.retryOn ?? DEFAULT_RETRY_STATUS_CODES;

        // Early return if no config
        if (!config) {
          throw error;
        }

        // Use a custom property on the config object to track retries
        const requestConfig: RetryableAxiosRequestConfig = config;

        if (!requestConfig.__retryCount) {
          requestConfig.__retryCount = 0;
        }

        const retryCount = requestConfig.__retryCount;
        const shouldRetry = retryCount < maxRetries && error.response && retryOn.includes(error.response.status);

        if (shouldRetry) {
          requestConfig.__retryCount = retryCount + 1;
          await sleep(retryDelay * Math.pow(2, retryCount));
          return this.client.request(config);
        }

        throw this.handleError(error);
      },
    );
  }

  /**
   * Converts Axios errors into domain-specific error types.
   * @param error - The Axios error to handle
   * @returns A domain-specific error (NetworkError, InboxNotFoundError, EmailNotFoundError, or ApiError)
   * @private
   */
  private handleError(error: AxiosError): Error {
    if (!error.response) {
      return new NetworkError(error.message || 'Network error occurred');
    }

    const status = error.response.status;
    const data = error.response.data as { error?: string; errorType?: string } | undefined;
    /* istanbul ignore next - defensive fallback when server doesn't return error message */
    const message = data?.error || error.message;

    // Prefer structured error type if available
    if (data?.errorType) {
      switch (data.errorType) {
        case 'inbox_not_found':
          return new InboxNotFoundError(message);
        case 'email_not_found':
          return new EmailNotFoundError(message);
        case 'webhook_not_found':
          return new WebhookNotFoundError(message);
      }
    }

    // Fallback to message-based detection for backwards compatibility
    if (status === 404) {
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes('webhook')) {
        return new WebhookNotFoundError(message);
      }
      if (lowerMessage.includes('inbox')) {
        return new InboxNotFoundError(message);
      }
      if (lowerMessage.includes('email')) {
        return new EmailNotFoundError(message);
      }
    }

    return new ApiError(status, message);
  }

  // ===== Server Info =====

  /**
   * Retrieves information about the VaultSandbox Gateway server.
   * @returns Promise resolving to server information including version and capabilities
   * @throws {NetworkError} If network communication fails
   * @throws {ApiError} If the server returns an error response
   */
  async getServerInfo(): Promise<ServerInfo> {
    const response = await this.client.get<ServerInfo>('/api/server-info');
    return response.data;
  }

  /**
   * Validates that the configured API key is valid.
   * @returns Promise resolving to an object indicating if the key is valid
   * @throws {NetworkError} If network communication fails
   * @throws {ApiError} If the server returns an error response
   */
  async checkKey(): Promise<boolean> {
    const response = await this.client.get<{ ok: boolean }>('/api/check-key');
    return response.data.ok;
  }

  // ===== Inbox Management =====

  /**
   * Creates a new temporary inbox on the server.
   * @param publicKey - The client's KEM public key for encrypted communication (required for encrypted inboxes)
   * @param ttl - Optional time-to-live in seconds for the inbox
   * @param emailAddress - Optional desired email address or domain
   * @param emailAuth - Optional flag to enable email authentication checks
   * @param encryption - Optional encryption preference ('encrypted' or 'plain')
   * @param spamAnalysis - Optional flag to enable spam analysis for the inbox
   * @param chaos - Optional chaos engineering configuration for the inbox
   * @returns Promise resolving to the created inbox data including email address
   * @throws {NetworkError} If network communication fails
   * @throws {ApiError} If the server returns an error response
   */
  async createInbox(
    publicKey?: string,
    ttl?: number,
    emailAddress?: string,
    emailAuth?: boolean,
    encryption?: 'encrypted' | 'plain',
    spamAnalysis?: boolean,
    chaos?: ChaosConfigRequest,
  ): Promise<InboxData> {
    const payload: {
      clientKemPk?: string;
      ttl?: number;
      emailAddress?: string;
      emailAuth?: boolean;
      encryption?: 'encrypted' | 'plain';
      spamAnalysis?: boolean;
      chaos?: ChaosConfigRequest;
    } = {};
    if (publicKey !== undefined && publicKey !== null) {
      payload.clientKemPk = publicKey;
    }
    if (ttl !== undefined && ttl !== null) {
      payload.ttl = ttl;
    }
    if (emailAddress !== undefined && emailAddress !== null) {
      payload.emailAddress = emailAddress;
    }
    if (emailAuth !== undefined) {
      payload.emailAuth = emailAuth;
    }
    if (encryption !== undefined) {
      payload.encryption = encryption;
    }
    if (spamAnalysis !== undefined) {
      payload.spamAnalysis = spamAnalysis;
    }
    if (chaos !== undefined) {
      payload.chaos = chaos;
    }
    const response = await this.client.post<InboxData>('/api/inboxes', payload);
    return response.data;
  }

  /**
   * Deletes a specific inbox and all its emails.
   * @param emailAddress - The email address of the inbox to delete
   * @returns Promise that resolves when the inbox is deleted
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async deleteInbox(emailAddress: string): Promise<void> {
    await this.client.delete(`/api/inboxes/${encodeURIComponent(emailAddress)}`);
  }

  /**
   * Deletes all inboxes associated with the API key.
   * @returns Promise resolving to the number of inboxes deleted
   * @throws {NetworkError} If network communication fails
   * @throws {ApiError} If the server returns an error response
   */
  /* istanbul ignore next 4 - destructive operation, not safe to test against real server */
  async deleteAllInboxes(): Promise<{ deleted: number }> {
    const response = await this.client.delete<{ deleted: number }>('/api/inboxes');
    return response.data;
  }

  /**
   * Gets the email synchronization status for an inbox.
   * @param emailAddress - The email address of the inbox
   * @returns Promise resolving to the sync status including last sync time and email count
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async getSyncStatus(emailAddress: string): Promise<SyncStatus> {
    const response = await this.client.get<SyncStatus>(`/api/inboxes/${encodeURIComponent(emailAddress)}/sync`);
    return response.data;
  }

  // ===== Email Management =====

  /**
   * Lists all emails in an inbox.
   * @param emailAddress - The email address of the inbox
   * @param includeContent - Whether to include full email content (default: false)
   * @returns Promise resolving to an array of emails
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If the server returns an error response
   */
  /* istanbul ignore next - false positive on default parameter value */
  async listEmails(emailAddress: string, includeContent = false): Promise<EmailData[]> {
    const query = includeContent ? '?includeContent=true' : '';
    const response = await this.client.get<EmailData[]>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/emails${query}`,
    );
    return response.data;
  }

  /**
   * Retrieves a specific email by ID.
   * @param emailAddress - The email address of the inbox
   * @param emailId - The unique identifier of the email
   * @returns Promise resolving to the email data
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {EmailNotFoundError} If the email does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async getEmail(emailAddress: string, emailId: string): Promise<EmailData> {
    const response = await this.client.get<EmailData>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/emails/${emailId}`,
    );
    return response.data;
  }

  /**
   * Retrieves the raw email data including full headers and body.
   * @param emailAddress - The email address of the inbox
   * @param emailId - The unique identifier of the email
   * @returns Promise resolving to the raw email data
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {EmailNotFoundError} If the email does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async getRawEmail(emailAddress: string, emailId: string): Promise<RawEmailData> {
    const response = await this.client.get<RawEmailData>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/emails/${emailId}/raw`,
    );
    return response.data;
  }

  /**
   * Marks an email as read.
   * @param emailAddress - The email address of the inbox
   * @param emailId - The unique identifier of the email
   * @returns Promise that resolves when the email is marked as read
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {EmailNotFoundError} If the email does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async markEmailAsRead(emailAddress: string, emailId: string): Promise<void> {
    await this.client.patch(`/api/inboxes/${encodeURIComponent(emailAddress)}/emails/${emailId}/read`);
  }

  /**
   * Deletes a specific email from an inbox.
   * @param emailAddress - The email address of the inbox
   * @param emailId - The unique identifier of the email
   * @returns Promise that resolves when the email is deleted
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {EmailNotFoundError} If the email does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async deleteEmail(emailAddress: string, emailId: string): Promise<void> {
    await this.client.delete(`/api/inboxes/${encodeURIComponent(emailAddress)}/emails/${emailId}`);
  }

  // ===== Inbox Webhooks =====

  /**
   * Creates a new webhook for an inbox.
   * @param emailAddress - The email address of the inbox
   * @param options - Options for creating the webhook
   * @returns Promise resolving to the created webhook data including the secret
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async createInboxWebhook(emailAddress: string, options: CreateWebhookOptions): Promise<WebhookData> {
    const response = await this.client.post<WebhookData>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks`,
      options,
    );
    return response.data;
  }

  /**
   * Lists all webhooks for an inbox.
   * @param emailAddress - The email address of the inbox
   * @returns Promise resolving to the list of webhooks
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async listInboxWebhooks(emailAddress: string): Promise<WebhookListResponse> {
    const response = await this.client.get<WebhookListResponse>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks`,
    );
    return response.data;
  }

  /**
   * Retrieves a specific webhook by ID.
   * @param emailAddress - The email address of the inbox
   * @param webhookId - The unique identifier of the webhook
   * @returns Promise resolving to the webhook data
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {WebhookNotFoundError} If the webhook does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async getInboxWebhook(emailAddress: string, webhookId: string): Promise<WebhookData> {
    const response = await this.client.get<WebhookData>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks/${webhookId}`,
    );
    return response.data;
  }

  /**
   * Updates a specific webhook.
   * @param emailAddress - The email address of the inbox
   * @param webhookId - The unique identifier of the webhook
   * @param options - Options for updating the webhook
   * @returns Promise resolving to the updated webhook data
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {WebhookNotFoundError} If the webhook does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async updateInboxWebhook(
    emailAddress: string,
    webhookId: string,
    options: UpdateWebhookOptions,
  ): Promise<WebhookData> {
    const response = await this.client.patch<WebhookData>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks/${webhookId}`,
      options,
    );
    return response.data;
  }

  /**
   * Deletes a specific webhook.
   * @param emailAddress - The email address of the inbox
   * @param webhookId - The unique identifier of the webhook
   * @returns Promise that resolves when the webhook is deleted
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {WebhookNotFoundError} If the webhook does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async deleteInboxWebhook(emailAddress: string, webhookId: string): Promise<void> {
    await this.client.delete(`/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks/${webhookId}`);
  }

  /**
   * Tests a webhook by sending a test payload.
   * @param emailAddress - The email address of the inbox
   * @param webhookId - The unique identifier of the webhook
   * @returns Promise resolving to the test result
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {WebhookNotFoundError} If the webhook does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async testInboxWebhook(emailAddress: string, webhookId: string): Promise<TestWebhookResponse> {
    const response = await this.client.post<TestWebhookResponse>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks/${webhookId}/test`,
    );
    return response.data;
  }

  /**
   * Rotates the secret for a specific webhook.
   * @param emailAddress - The email address of the inbox
   * @param webhookId - The unique identifier of the webhook
   * @returns Promise resolving to the new secret and validity period of the old secret
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {WebhookNotFoundError} If the webhook does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async rotateInboxWebhookSecret(emailAddress: string, webhookId: string): Promise<RotateSecretResponse> {
    const response = await this.client.post<RotateSecretResponse>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/webhooks/${webhookId}/rotate-secret`,
    );
    return response.data;
  }

  // ===== Chaos Configuration =====

  /**
   * Gets the chaos configuration for an inbox.
   * @param emailAddress - The email address of the inbox
   * @returns Promise resolving to the chaos configuration
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If chaos is disabled globally (403) or other error
   */
  async getChaosConfig(emailAddress: string): Promise<ChaosConfigResponse> {
    const response = await this.client.get<ChaosConfigResponse>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/chaos`,
    );
    return response.data;
  }

  /**
   * Sets or updates the chaos configuration for an inbox.
   * @param emailAddress - The email address of the inbox
   * @param config - The chaos configuration to apply
   * @returns Promise resolving to the updated chaos configuration
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If chaos is disabled globally (403), validation fails (400), or other error
   */
  async setChaosConfig(emailAddress: string, config: ChaosConfigRequest): Promise<ChaosConfigResponse> {
    const response = await this.client.post<ChaosConfigResponse>(
      `/api/inboxes/${encodeURIComponent(emailAddress)}/chaos`,
      config,
    );
    return response.data;
  }

  /**
   * Disables all chaos for an inbox.
   * @param emailAddress - The email address of the inbox
   * @returns Promise that resolves when chaos is disabled
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If chaos is disabled globally (403) or other error
   */
  async disableChaos(emailAddress: string): Promise<void> {
    await this.client.delete(`/api/inboxes/${encodeURIComponent(emailAddress)}/chaos`);
  }

  // ===== Utility =====

  /**
   * Gets the base URL of the VaultSandbox Gateway server.
   * @returns The configured base URL
   */
  getBaseUrl(): string {
    return this.config.url;
  }

  /**
   * Gets the configured API key.
   * @returns The API key being used for authentication
   */
  getApiKey(): string {
    return this.config.apiKey;
  }
}
