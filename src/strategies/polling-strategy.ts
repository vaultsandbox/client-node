/**
 * PollingStrategy - Smart polling implementation with exponential backoff
 */

import createDebug from 'debug';
import type { ApiClient } from '../http/api-client.js';
import type { Keypair, EmailData, IEmail, WaitOptions, Subscription } from '../types/index.js';
import { TimeoutError, InboxNotFoundError } from '../types/index.js';
import { decryptEmailData, findMatchingEmail } from '../utils/email-utils.js';
import { sleep } from '../utils/sleep.js';
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
   * Waits for an email matching the specified criteria using smart polling
   */
  async waitForEmail(
    emailAddress: string,
    _inboxHash: string,
    keypair: Keypair,
    options: WaitOptions = {},
  ): Promise<IEmail> {
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
            // Hash changed - fetch full email list
            const emailsData = await this.apiClient.listEmails(emailAddress);
            const emails = await this.decryptEmails(emailsData, keypair, emailAddress);
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
        if (remainingTime <= 0) {
          break;
        }

        // Calculate wait time with exponential backoff and jitter
        const jitter = Math.random() * this.jitterFactor * currentBackoff;
        const desiredWaitTime = Math.min(currentBackoff + jitter, this.maxBackoff);

        // Limit sleep to remaining time to avoid overshooting timeout
        const waitTime = Math.min(desiredWaitTime, remainingTime);

        // Wait before next poll
        await sleep(waitTime);

        // Increase backoff for next iteration (if no changes detected)
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
   * Decrypts a list of email data objects
   */
  private async decryptEmails(emailsData: EmailData[], keypair: Keypair, emailAddress: string): Promise<IEmail[]> {
    const emails: IEmail[] = [];

    for (const emailData of emailsData) {
      const email = await decryptEmailData(emailData, keypair, emailAddress, this.apiClient);
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
    keypair: Keypair,
    callback: (email: IEmail) => void | Promise<void>,
  ): Subscription {
    let isActive = true;
    const seenEmails = new Set<string>();

    // Start polling loop
    const poll = async () => {
      while (isActive) {
        try {
          const emailsData = await this.apiClient.listEmails(emailAddress);
          const emails = await this.decryptEmails(emailsData, keypair, emailAddress);

          // Notify about new emails we haven't seen
          for (const email of emails) {
            if (!seenEmails.has(email.id)) {
              seenEmails.add(email.id);
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
            }
          }
        } catch (error) {
          debug('Error polling for emails: %O', error);
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
