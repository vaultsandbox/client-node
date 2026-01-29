/**
 * PollingStrategy - Smart polling implementation with exponential backoff
 */

import createDebug from 'debug';
import type { ApiClient } from '../http/api-client.js';
import type { Keypair, EmailData, IEmail, WaitOptions, Subscription } from '../types/index.js';
import { TimeoutError, InboxNotFoundError, DecryptionError } from '../types/index.js';
import {
  decryptEmailData,
  decodeBase64EmailData,
  isEncryptedEmailData,
  findMatchingEmail,
} from '../utils/email-utils.js';
import { sleep } from '../utils/sleep.js';
import { syncInbox } from '../sync/inbox-sync.js';
import type { DeliveryStrategy } from './delivery-strategy.js';

const debug = createDebug('vaultsandbox:polling-strategy');

export interface PollingConfig {
  initialInterval?: number;
  maxBackoff?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
}

export class PollingStrategy implements DeliveryStrategy {
  private apiClient: ApiClient;
  private initialInterval: number;
  private maxBackoff: number;
  private backoffMultiplier: number;
  private jitterFactor: number;

  constructor(apiClient: ApiClient, config: PollingConfig = {}) {
    this.apiClient = apiClient;
    this.initialInterval = config.initialInterval ?? 2000;
    this.maxBackoff = config.maxBackoff ?? 30000;
    this.backoffMultiplier = config.backoffMultiplier ?? 1.5;
    this.jitterFactor = config.jitterFactor ?? 0.3;
  }

  /**
   * Validates that a keypair exists for encrypted email operations.
   * @param keypair - The keypair to validate
   * @param emailAddress - The email address for error context
   * @returns The validated keypair
   * @throws DecryptionError if keypair is null
   */
  private validateKeypair(keypair: Keypair | null, emailAddress: string): Keypair {
    if (!keypair) {
      throw new DecryptionError(`Received encrypted email for inbox ${emailAddress} but no keypair available`);
    }
    return keypair;
  }

  /**
   * Waits for an email matching the specified criteria using smart polling
   */
  async waitForEmail(
    emailAddress: string,
    _inboxHash: string,
    keypair: Keypair | null,
    options: WaitOptions = {},
    serverPublicKey?: string | null,
  ): Promise<IEmail> {
    /* istanbul ignore next 2 - compile-time defaults, only one branch taken per execution */
    const timeout = options.timeout ?? 30000;
    const pollInterval = options.pollInterval ?? this.initialInterval;
    const startTime = Date.now();

    let lastHash: string | null = null;
    let currentBackoff = pollInterval;

    while (Date.now() - startTime < timeout) {
      try {
        // Check sync status to see if there are new emails (lightweight check)
        const syncStatus = await this.apiClient.getSyncStatus(emailAddress);

        // If hash changed or first check, fetch and check emails
        if (lastHash === null || syncStatus.emailsHash !== lastHash) {
          lastHash = syncStatus.emailsHash;

          if (syncStatus.emailCount > 0) {
            // Hash changed - fetch full email list with content
            const emailsData = await this.apiClient.listEmails(emailAddress, true);
            const emails = await this.processEmails(emailsData, keypair, emailAddress, serverPublicKey);
            const matchingEmail = findMatchingEmail(emails, options);

            if (matchingEmail) {
              return matchingEmail;
            }
          }

          // Reset backoff when we detect changes
          currentBackoff = pollInterval;
        }

        // Calculate remaining time before timeout
        const remainingTime = timeout - (Date.now() - startTime);

        // If we've already exceeded timeout, exit immediately
        /* istanbul ignore next - race condition guard between loop condition and remaining time calculation */
        if (remainingTime <= 0) {
          break;
        }

        // Calculate wait time with exponential backoff and bidirectional jitter
        // Apply jitter as +/- percentage of current backoff, with floor at pollInterval
        const jitter = this.jitterFactor * currentBackoff * (Math.random() - 0.5) * 2;
        const desiredWaitTime = Math.max(pollInterval, Math.min(currentBackoff + jitter, this.maxBackoff));

        // Limit sleep to remaining time to avoid overshooting timeout
        const waitTime = Math.min(desiredWaitTime, remainingTime);

        // Wait before next poll
        await sleep(waitTime);

        // Increase backoff for next iteration (if no changes detected)
        // Note: This condition is always true when reached because lastHash is set to
        // syncStatus.emailsHash above, or the if-block was skipped because they were equal
        /* istanbul ignore else - false branch unreachable with current logic */
        if (syncStatus.emailsHash === lastHash) {
          currentBackoff = Math.min(currentBackoff * this.backoffMultiplier, this.maxBackoff);
        }
      } catch (error) {
        // Handle 404 (inbox deleted) or other errors
        if (error && typeof error === 'object' && 'statusCode' in error) {
          const apiError = error as { statusCode: number };
          if (apiError.statusCode === 404) {
            throw new InboxNotFoundError('Inbox not found or has been deleted');
          }
        }
        throw error;
      }
    }

    throw new TimeoutError('No matching email received within timeout');
  }

  /**
   * Processes a list of email data objects (decrypts or decodes based on format)
   */
  private async processEmails(
    emailsData: EmailData[],
    keypair: Keypair | null,
    emailAddress: string,
    serverPublicKey?: string | null,
  ): Promise<IEmail[]> {
    const emails: IEmail[] = [];

    for (const emailData of emailsData) {
      const email = isEncryptedEmailData(emailData)
        ? await decryptEmailData(
            emailData,
            this.validateKeypair(keypair, emailAddress),
            emailAddress,
            this.apiClient,
            serverPublicKey ?? undefined,
          )
        : decodeBase64EmailData(emailData, emailAddress, this.apiClient);
      emails.push(email);
    }

    return emails;
  }

  /**
   * Subscribe to new email notifications (polling-based)
   */
  subscribe(
    emailAddress: string,
    _inboxHash: string,
    keypair: Keypair | null,
    callback: (email: IEmail) => void | Promise<void>,
    emailCache?: Map<string, EmailData>,
    onEmailDeleted?: (emailId: string) => void,
    onError?: (error: Error) => void,
    serverPublicKey?: string | null,
  ): Subscription {
    let isActive = true;
    const localCache = emailCache ?? new Map<string, EmailData>();
    const seenEmails = new Set<string>();

    // Start polling loop
    const poll = async () => {
      while (isActive) {
        try {
          // Use hash-based sync to detect changes efficiently
          const result = await syncInbox(this.apiClient, emailAddress, localCache);

          if (!result.unchanged) {
            // Process new emails
            for (const emailData of result.added) {
              if (!seenEmails.has(emailData.id)) {
                seenEmails.add(emailData.id);
                localCache.set(emailData.id, emailData);

                try {
                  // Fetch full email content for new emails
                  const fullEmailData = await this.apiClient.getEmail(emailAddress, emailData.id);
                  const email = isEncryptedEmailData(fullEmailData)
                    ? await decryptEmailData(
                        fullEmailData,
                        this.validateKeypair(keypair, emailAddress),
                        emailAddress,
                        this.apiClient,
                        serverPublicKey ?? undefined,
                      )
                    : decodeBase64EmailData(fullEmailData, emailAddress, this.apiClient);

                  const callbackResult = callback(email);
                  // Handle case where callback returns a promise
                  if (callbackResult instanceof Promise) {
                    callbackResult.catch((error: Error) => {
                      debug('Error in async subscription callback: %O', error);
                    });
                  }
                } catch (error) {
                  debug('Error processing new email %s: %O', emailData.id, error);
                }
              }
            }

            // Process deleted emails
            for (const emailId of result.deleted) {
              localCache.delete(emailId);
              seenEmails.delete(emailId);

              if (onEmailDeleted) {
                onEmailDeleted(emailId);
              }
            }
          }
        } catch (error) {
          debug('Error polling for emails: %O', error);
          if (onError) {
            try {
              onError(error instanceof Error ? error : new Error(String(error)));
            } catch (e) {
              debug('Error in error callback: %O', e);
            }
          }
        }

        if (isActive) {
          await sleep(this.initialInterval);
        }
      }
    };

    // Start polling
    poll();

    return {
      unsubscribe: () => {
        isActive = false;
      },
    };
  }

  /**
   * Close and cleanup resources
   */
  close(): void {
    // Polling strategy has no persistent connections to close
  }
}
