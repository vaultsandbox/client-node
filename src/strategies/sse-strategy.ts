import createDebug from 'debug';
import { EventSource } from 'eventsource';
import type { ApiClient } from '../http/api-client.js';
import type {
  Keypair,
  IEmail,
  WaitOptions,
  Subscription,
  SSEConfig,
  SSEMessageData,
  EmailData,
} from '../types/index.js';
import { TimeoutError, SSEError } from '../types/index.js';
import { decryptEmailData, decodeBase64EmailData, isEncryptedEmailData, matchesFilters } from '../utils/email-utils.js';
import { syncInbox } from '../sync/inbox-sync.js';
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
  keypair: Keypair | null;
  callbacks: Set<(email: IEmail) => void | Promise<void>>;
  seenEmailIds: Set<string>;
  emailCache: Map<string, EmailData>;
  onEmailDeleted?: (emailId: string) => void;
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
    this.reconnectInterval = config.reconnectInterval ?? 2000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
  }

  /**
   * Wait for an email matching the specified criteria using SSE
   */
  async waitForEmail(
    emailAddress: string,
    inboxHash: string,
    keypair: Keypair | null,
    /* istanbul ignore next - default parameter */ options: WaitOptions = {},
  ): Promise<IEmail> {
    const timeout = options.timeout ?? /* istanbul ignore next - default timeout */ 30000;
    const startTime = Date.now();

    return new Promise<IEmail>((resolve, reject) => {
      let resolved = false;
      const timeoutTimer = setTimeout(() => {
        /* istanbul ignore else - resolved is false unless race condition */
        if (!resolved) {
          subscription.unsubscribe();
          reject(new TimeoutError('No matching email received within timeout'));
        }
      }, timeout);

      const subscription = this.subscribe(emailAddress, inboxHash, keypair, async (email) => {
        /* istanbul ignore if - race condition guard */ if (resolved) return;

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
    keypair: Keypair | null,
    callback: (email: IEmail) => void | Promise<void>,
    emailCache?: Map<string, EmailData>,
    onEmailDeleted?: (emailId: string) => void,
  ): Subscription {
    // Get or create subscription entry
    let subscription = this.subscriptions.get(emailAddress);
    if (!subscription) {
      subscription = {
        emailAddress,
        inboxHash,
        keypair,
        callbacks: new Set(),
        seenEmailIds: new Set(),
        emailCache: emailCache ?? new Map(),
        onEmailDeleted,
      };
      this.subscriptions.set(emailAddress, subscription);
    } else if (emailCache) {
      // Update email cache if provided
      subscription.emailCache = emailCache;
      subscription.onEmailDeleted = onEmailDeleted;
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
    debug(
      'Using API key: %s',
      this.apiKey
        ? `${this.apiKey.substring(0, 10)}...`
        : /* istanbul ignore next - API key always provided */ 'MISSING',
    );

    try {
      // Use custom fetch to add authentication headers
      const eventSourceOptions: EventSourceInitWithFetch = {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          debug('Custom fetch called with headers');
          return fetch(input, {
            ...init,
            headers: {
              ...(init?.headers || /* istanbul ignore next - init.headers always provided by EventSource */ {}),
              'X-API-Key': this.apiKey,
            },
          });
        },
      };
      // The EventSource polyfill for Node supports a custom fetch option, but the
      // DOM EventSource typings don't include it; cast through unknown for Node-only usage.
      this.eventSource = new EventSource(sseUrl, eventSourceOptions as unknown as EventSourceInit);

      debug('EventSource created successfully with custom fetch');

      /* istanbul ignore else - eventSource always set after new EventSource */
      if (this.eventSource) {
        this.eventSource.onopen = () => {
          debug('SSE connection established');
          this.reconnectAttempts = 0; // Reset reconnect counter
        };

        this.eventSource.onmessage = async (event: SseMessageEvent) => {
          try {
            await this.handleMessage(event.data);
          } catch (error) /* istanbul ignore next - defensive catch for unexpected SSE message errors */ {
            debug('Error handling SSE message: %O', error);
          }
        };

        this.eventSource.onerror = (error: unknown) => {
          debug('SSE connection error: %O', error);
          this.handleConnectionError();
        };
      }
    } catch (error) /* istanbul ignore next - defensive catch for EventSource creation failures */ {
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
      const { inboxId, emailId } = messageData;

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

      // Duplicate check - skip if we've already seen this email
      if (subscription.seenEmailIds.has(emailId)) {
        debug('Skipping duplicate email %s for inbox %s', emailId, subscription.emailAddress);
        return;
      }

      // Mark as seen before processing to prevent race conditions
      subscription.seenEmailIds.add(emailId);

      // SSE notification only contains metadata, fetch full email from API
      const emailData = await this.apiClient.getEmail(subscription.emailAddress, emailId);

      // Add to email cache
      subscription.emailCache.set(emailId, emailData);

      // Decrypt or decode email based on format
      const email = isEncryptedEmailData(emailData)
        ? await decryptEmailData(emailData, subscription.keypair!, subscription.emailAddress, this.apiClient)
        : decodeBase64EmailData(emailData, subscription.emailAddress, this.apiClient);

      // Notify all callbacks for this inbox
      subscription.callbacks.forEach((callback) => {
        try {
          const result = callback(email);
          // Handle case where callback returns a promise
          /* istanbul ignore else - else branch is sync callback that returns void */
          if (result instanceof Promise) {
            result.catch(
              /* istanbul ignore next - defensive for async callback errors */ (error: Error) => {
                debug('Error in async subscription callback: %O', error);
              },
            );
          }
        } catch (error) /* istanbul ignore next - defensive for sync callback errors */ {
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

      this.reconnectTimer = setTimeout(
        /* istanbul ignore next - async reconnection timer tested via integration */ async () => {
          this.reconnectAttempts++;
          this.connect();

          // Sync all inboxes after reconnection to catch missed emails
          await this.syncAllInboxes();
        },
        backoffDelay,
      );
    } else {
      debug('Max reconnection attempts reached');
      throw new SSEError('Failed to establish SSE connection after maximum retry attempts');
    }
  }

  /**
   * Sync all subscribed inboxes after reconnection.
   * This catches any emails that arrived during the disconnect window.
   */
  private async syncAllInboxes(): Promise<void> {
    debug('Syncing all inboxes after reconnection');

    const syncPromises = Array.from(this.subscriptions.values()).map(async (subscription) => {
      try {
        const result = await syncInbox(this.apiClient, subscription.emailAddress, subscription.emailCache);

        if (!result.unchanged) {
          // Process new emails
          for (const metadataOnly of result.added) {
            // Skip if already seen
            if (subscription.seenEmailIds.has(metadataOnly.id)) {
              continue;
            }

            subscription.seenEmailIds.add(metadataOnly.id);

            // Fetch full email content (sync only returned metadata for speed)
            try {
              const fullEmailData = await this.apiClient.getEmail(subscription.emailAddress, metadataOnly.id);
              subscription.emailCache.set(metadataOnly.id, fullEmailData);

              // Decrypt or decode and notify
              const email = isEncryptedEmailData(fullEmailData)
                ? await decryptEmailData(
                    fullEmailData,
                    subscription.keypair!,
                    subscription.emailAddress,
                    this.apiClient,
                  )
                : /* istanbul ignore next */ decodeBase64EmailData(
                    fullEmailData,
                    subscription.emailAddress,
                    this.apiClient,
                  );

              /* istanbul ignore next - callback execution after successful decryption */
              subscription.callbacks.forEach((callback) => {
                try {
                  const callbackResult = callback(email);
                  if (callbackResult instanceof Promise) {
                    callbackResult.catch(
                      /* istanbul ignore next - defensive for async callback errors */ (error: Error) => {
                        debug('Error in async subscription callback during sync: %O', error);
                      },
                    );
                  }
                } catch (error) /* istanbul ignore next - defensive for sync callback errors */ {
                  debug('Error in subscription callback during sync: %O', error);
                }
              });
            } catch (error) {
              debug('Error fetching/decrypting email %s during sync: %O', metadataOnly.id, error);
            }
          }

          // Process deleted emails
          for (const emailId of result.deleted) {
            subscription.emailCache.delete(emailId);
            subscription.seenEmailIds.delete(emailId);

            if (subscription.onEmailDeleted) {
              subscription.onEmailDeleted(emailId);
            }
          }
        }

        debug(
          'Sync complete for inbox %s: %d added, %d deleted',
          subscription.emailAddress,
          result.added.length,
          result.deleted.length,
        );
      } catch (error) {
        debug('Error syncing inbox %s: %O', subscription.emailAddress, error);
      }
    });

    await Promise.all(syncPromises);
    debug('All inbox syncs complete');
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

    // Clear seen email IDs on disconnect - sync will repopulate on reconnect
    for (const subscription of this.subscriptions.values()) {
      subscription.seenEmailIds.clear();
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
