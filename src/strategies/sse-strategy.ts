import createDebug from 'debug';
import { EventSource } from 'eventsource';
import type { ApiClient } from '../http/api-client.js';
import type { Keypair, IEmail, WaitOptions, Subscription, SSEConfig, SSEMessageData } from '../types/index.js';
import { TimeoutError, SSEError } from '../types/index.js';
import { decryptEmailData, matchesFilters } from '../utils/email-utils.js';
import type { DeliveryStrategy } from './delivery-strategy.js';

const debug = createDebug('vaultsandbox:sse-strategy');

/**
 * Extended EventSource options to include the custom fetch function
 * supported by the eventsource polyfill
 */
interface EventSourceInitWithFetch {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
}

interface InboxSubscription {
  emailAddress: string;
  inboxHash: string;
  keypair: Keypair;
  callbacks: Set<(email: IEmail) => void | Promise<void>>;
}

interface SseMessageEvent {
  data: string;
}

export class SSEStrategy implements DeliveryStrategy {
  private apiClient: ApiClient;
  private url: string;
  private apiKey: string;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private backoffMultiplier: number;

  private eventSource: EventSource | null = null;
  private subscriptions = new Map<string, InboxSubscription>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isClosing = false;

  constructor(apiClient: ApiClient, config: SSEConfig) {
    this.apiClient = apiClient;
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.reconnectInterval = config.reconnectInterval ?? 5000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
  }

  /**
   * Wait for an email matching the specified criteria using SSE
   */
  async waitForEmail(
    emailAddress: string,
    inboxHash: string,
    keypair: Keypair,
    options: WaitOptions = {},
  ): Promise<IEmail> {
    const timeout = options.timeout ?? 30000;
    const startTime = Date.now();

    return new Promise<IEmail>((resolve, reject) => {
      let resolved = false;
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          subscription.unsubscribe();
          reject(new TimeoutError('No matching email received within timeout'));
        }
      }, timeout);

      const subscription = this.subscribe(emailAddress, inboxHash, keypair, async (email) => {
        if (resolved) return;

        // Check if email matches filters
        if (matchesFilters(email, options)) {
          resolved = true;
          clearTimeout(timeoutTimer);
          subscription.unsubscribe();
          resolve(email);
        }
      });

      // If we're past the timeout already, reject immediately
      if (Date.now() - startTime >= timeout) {
        resolved = true;
        clearTimeout(timeoutTimer);
        subscription.unsubscribe();
        reject(new TimeoutError('No matching email received within timeout'));
      }
    });
  }

  /**
   * Subscribe to new email notifications for a specific inbox
   */
  subscribe(
    emailAddress: string,
    inboxHash: string,
    keypair: Keypair,
    callback: (email: IEmail) => void | Promise<void>,
  ): Subscription {
    // Get or create subscription entry
    let subscription = this.subscriptions.get(emailAddress);
    if (!subscription) {
      subscription = {
        emailAddress,
        inboxHash,
        keypair,
        callbacks: new Set(),
      };
      this.subscriptions.set(emailAddress, subscription);
    }

    // Add callback
    subscription.callbacks.add(callback);

    // Connect or reconnect with updated inbox list
    if (!this.eventSource || this.eventSource.readyState === 2) {
      // 2 = CLOSED
      this.connect();
    } else {
      // Reconnect to include the new inbox
      this.reconnect();
    }

    // Return unsubscribe function
    return {
      unsubscribe: () => {
        const sub = this.subscriptions.get(emailAddress);
        if (sub) {
          sub.callbacks.delete(callback);
          if (sub.callbacks.size === 0) {
            this.subscriptions.delete(emailAddress);
            if (this.subscriptions.size === 0) {
              this.disconnect();
            } else {
              // Reconnect with updated inbox list
              this.reconnect();
            }
          }
        }
      },
    };
  }

  /**
   * Connect to SSE endpoint
   */
  private connect(): void {
    if (this.isClosing) return;
    if (this.subscriptions.size === 0) return;

    // Build inbox hashes list
    const inboxHashes = Array.from(this.subscriptions.values())
      .map((sub) => sub.inboxHash)
      .filter((hash) => hash) // Filter out empty hashes
      .join(',');

    if (!inboxHashes) {
      debug('No inbox hashes available, skipping connect');
      return;
    }

    const sseUrl = `${this.url}/api/events?inboxes=${inboxHashes}`;

    debug('Connecting to SSE endpoint: %s', sseUrl);
    debug('Using API key: %s', this.apiKey ? `${this.apiKey.substring(0, 10)}...` : 'MISSING');

    try {
      // Use custom fetch to add authentication headers
      const eventSourceOptions: EventSourceInitWithFetch = {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          debug('Custom fetch called with headers');
          return fetch(input, {
            ...init,
            headers: {
              ...(init?.headers || {}),
              'X-API-Key': this.apiKey,
            },
          });
        },
      };
      // The EventSource polyfill for Node supports a custom fetch option, but the
      // DOM EventSource typings don't include it; cast through unknown for Node-only usage.
      this.eventSource = new EventSource(sseUrl, eventSourceOptions as unknown as EventSourceInit);

      debug('EventSource created successfully with custom fetch');

      if (this.eventSource) {
        this.eventSource.onopen = () => {
          debug('SSE connection established');
          this.reconnectAttempts = 0; // Reset reconnect counter
        };

        this.eventSource.onmessage = async (event: SseMessageEvent) => {
          try {
            await this.handleMessage(event.data);
          } catch (error) {
            debug('Error handling SSE message: %O', error);
          }
        };

        this.eventSource.onerror = (error: unknown) => {
          debug('SSE connection error: %O', error);
          this.handleConnectionError();
        };
      }
    } catch (error) {
      debug('Failed to create EventSource: %O', error);
      this.handleConnectionError();
    }
  }

  /**
   * Handle incoming SSE message
   */
  private async handleMessage(data: string): Promise<void> {
    try {
      debug('Received message: %s', data.substring(0, 200));
      const messageData: SSEMessageData = JSON.parse(data);
      debug('Parsed message data: %s', JSON.stringify(messageData, null, 2).substring(0, 500));
      const { inboxId, emailId, encryptedMetadata } = messageData;

      debug('Looking for subscription with inboxId: %s', inboxId);
      debug('Available subscriptions: %O', Array.from(this.subscriptions.keys()));

      // Find matching subscription by inboxHash (which matches inboxId from server)
      const subscription = Array.from(this.subscriptions.values()).find((sub) => sub.inboxHash === inboxId);

      if (!subscription) {
        debug('No subscription found for inbox ID: %s', inboxId);
        debug(
          'Available inbox hashes: %O',
          Array.from(this.subscriptions.values()).map((s) => s.inboxHash),
        );
        return;
      }

      // Construct EmailData object from SSE message
      const emailData = {
        id: emailId,
        inboxId: inboxId,
        receivedAt: new Date().toISOString(), // SSE doesn't provide this, use current time
        isRead: false,
        encryptedMetadata: encryptedMetadata,
      };

      // Decrypt email
      const email = await decryptEmailData(emailData, subscription.keypair, subscription.emailAddress, this.apiClient);

      // Notify all callbacks for this inbox
      subscription.callbacks.forEach((callback) => {
        try {
          const result = callback(email);
          // Handle case where callback returns a promise
          if (result instanceof Promise) {
            result.catch((error: Error) => {
              debug('Error in async subscription callback: %O', error);
            });
          }
        } catch (error) {
          debug('Error in subscription callback: %O', error);
        }
      });
    } catch (error) {
      debug('Error processing SSE message: %O', error);
      throw new SSEError(`Failed to process SSE message: ${error}`);
    }
  }

  /**
   * Handle connection error and attempt reconnection
   */
  private handleConnectionError(): void {
    if (this.isClosing) return;

    this.disconnect();

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const backoffDelay = this.reconnectInterval * Math.pow(this.backoffMultiplier, this.reconnectAttempts);

      debug(
        'Reconnecting in %dms (attempt %d/%d)',
        backoffDelay,
        this.reconnectAttempts + 1,
        this.maxReconnectAttempts,
      );

      this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
      }, backoffDelay);
    } else {
      debug('Max reconnection attempts reached');
      throw new SSEError('Failed to establish SSE connection after maximum retry attempts');
    }
  }

  /**
   * Reconnect with updated inbox list
   */
  private reconnect(): void {
    this.disconnect();
    this.connect();
  }

  /**
   * Disconnect from SSE endpoint
   */
  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Close strategy and cleanup resources
   */
  close(): void {
    this.isClosing = true;
    this.disconnect();
    this.subscriptions.clear();
  }
}
