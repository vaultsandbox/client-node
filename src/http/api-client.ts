/**
 * HTTP API client for VaultSandbox Gateway
 */

import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import type { ClientConfig, InboxData, EmailData, ServerInfo, SyncStatus, RawEmailData } from '../types/index.js';
import { ApiError, NetworkError, InboxNotFoundError, EmailNotFoundError } from '../types/index.js';
import { sleep } from '../utils/sleep.js';

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
      timeout: 30000,
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
        const maxRetries = this.config.maxRetries ?? 3;
        const retryDelay = this.config.retryDelay ?? 1000;
        const retryOn = this.config.retryOn ?? [408, 429, 500, 502, 503, 504];

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
    const message = (error.response.data as { error?: string })?.error || error.message;

    if (status === 404) {
      if (message.toLowerCase().includes('inbox')) {
        return new InboxNotFoundError(message);
      }
      if (message.toLowerCase().includes('email')) {
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
   * @param publicKey - The client's KEM public key for encrypted communication
   * @param ttl - Optional time-to-live in seconds for the inbox
   * @param emailAddress - Optional desired email address or domain
   * @returns Promise resolving to the created inbox data including email address
   * @throws {NetworkError} If network communication fails
   * @throws {ApiError} If the server returns an error response
   */
  async createInbox(publicKey: string, ttl?: number, emailAddress?: string): Promise<InboxData> {
    const payload: { clientKemPk: string; ttl?: number; emailAddress?: string } = { clientKemPk: publicKey };
    if (ttl !== undefined && ttl !== null) {
      payload.ttl = ttl;
    }
    if (emailAddress !== undefined && emailAddress !== null) {
      payload.emailAddress = emailAddress;
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
   * @returns Promise resolving to an array of emails
   * @throws {NetworkError} If network communication fails
   * @throws {InboxNotFoundError} If the inbox does not exist
   * @throws {ApiError} If the server returns an error response
   */
  async listEmails(emailAddress: string): Promise<EmailData[]> {
    const response = await this.client.get<EmailData[]>(`/api/inboxes/${encodeURIComponent(emailAddress)}/emails`);
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
