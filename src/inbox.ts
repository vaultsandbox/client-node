/**
 * Inbox class - manages email retrieval and decryption for a single inbox
 */

import createDebug from 'debug';
import { decryptRaw } from './crypto/decrypt.js';
import { decryptEmailData } from './utils/email-utils.js';
import { toBase64 } from './crypto/utils.js';
import type {
  InboxData,
  Keypair,
  WaitOptions,
  WaitForCountOptions,
  SyncStatus,
  RawEmail,
  Subscription,
  IEmail,
  ExportedInboxData,
} from './types/index.js';
import { TimeoutError, StrategyError } from './types/index.js';
import type { ApiClient } from './http/api-client.js';
import type { DeliveryStrategy } from './strategies/delivery-strategy.js';

const debug = createDebug('vaultsandbox:inbox');

/**
 * Represents a single email inbox.
 *
 * This class provides methods for retrieving, decrypting, and managing emails
 * within a specific inbox.
 */
export class Inbox {
  /** The email address of the inbox. */
  readonly emailAddress: string;
  /** The date and time when the inbox will expire. */
  expiresAt: Date;
  /** A unique identifier for the inbox. */
  readonly inboxHash: string;

  private keypair: Keypair;
  private apiClient: ApiClient;
  private serverPublicKey: string;
  private strategy: DeliveryStrategy | null = null;

  /**
   * @internal
   * Do not construct this class directly. Use `VaultSandboxClient.createInbox()` instead.
   */
  constructor(inboxData: InboxData, keypair: Keypair, apiClient: ApiClient, serverPublicKey: string) {
    this.emailAddress = inboxData.emailAddress;
    this.inboxHash = inboxData.inboxHash;
    this.expiresAt = new Date(inboxData.expiresAt);
    this.keypair = keypair;
    this.apiClient = apiClient;
    this.serverPublicKey = serverPublicKey;

    debug('Created inbox for %s (expires: %s)', this.emailAddress, this.expiresAt.toISOString());
  }

  /**
   * @internal
   * Sets the delivery strategy for this inbox.
   * @param strategy - The delivery strategy to use.
   */
  setStrategy(strategy: DeliveryStrategy): void {
    this.strategy = strategy;
    debug('Set delivery strategy for inbox %s', this.emailAddress);
  }

  /**
   * Retrieves all emails from the inbox.
   *
   * @returns A promise that resolves to an array of `Email` instances.
   */
  async listEmails(): Promise<IEmail[]> {
    debug('Listing emails for inbox %s', this.emailAddress);
    const emailsData = await this.apiClient.listEmails(this.emailAddress);
    debug('Retrieved %d raw email data entries', emailsData.length);
    const emails: IEmail[] = [];

    for (const emailData of emailsData) {
      const email = await decryptEmailData(emailData, this.keypair, this.emailAddress, this.apiClient);
      emails.push(email);
    }

    debug('Successfully decrypted %d emails for inbox %s', emails.length, this.emailAddress);
    return emails;
  }

  /**
   * Retrieves a specific email by its ID.
   *
   * @param emailId - The ID of the email to retrieve.
   * @returns A promise that resolves to an `Email` instance.
   */
  async getEmail(emailId: string): Promise<IEmail> {
    debug('Retrieving email %s from inbox %s', emailId, this.emailAddress);
    const emailData = await this.apiClient.getEmail(this.emailAddress, emailId);
    const email = await decryptEmailData(emailData, this.keypair, this.emailAddress, this.apiClient);
    debug('Successfully retrieved and decrypted email %s', emailId);
    return email;
  }

  /**
   * Retrieves the raw, decrypted source of a specific email.
   *
   * @param emailId - The ID of the email to retrieve.
   * @returns A promise that resolves to the raw email data.
   */
  async getRawEmail(emailId: string): Promise<RawEmail> {
    debug('Retrieving raw email %s from inbox %s', emailId, this.emailAddress);
    const rawEmailData = await this.apiClient.getRawEmail(this.emailAddress, emailId);
    const raw = await decryptRaw(rawEmailData.encryptedRaw, this.keypair);
    debug('Successfully retrieved and decrypted raw email %s (%d characters)', emailId, raw.length);
    return { id: rawEmailData.id, raw };
  }

  /**
   * Waits for an email that matches the specified criteria.
   *
   * This method uses the configured delivery strategy (SSE or polling) to wait
   * for an email to arrive.
   *
   * @param options - Options for waiting for the email.
   * @returns A promise that resolves to the matched `Email` instance.
   */
  async waitForEmail(options: WaitOptions = {}): Promise<IEmail> {
    if (!this.strategy) {
      throw new StrategyError('No delivery strategy set. Call setStrategy() first.');
    }
    debug('Waiting for email in inbox %s with options: %O', this.emailAddress, options);
    const email = await this.strategy.waitForEmail(this.emailAddress, this.inboxHash, this.keypair, options);
    debug('Successfully received email %s in inbox %s', email.id, this.emailAddress);
    return email;
  }

  /**
   * Waits until the inbox contains at least a specified number of emails.
   *
   * This method uses the configured delivery strategy (SSE or polling) to
   * efficiently wait for emails to arrive instead of constantly polling the API.
   *
   * @param count - The number of emails to wait for.
   * @param options - Options for waiting.
   * @returns A promise that resolves when the email count is reached.
   */
  async waitForEmailCount(count: number, options: WaitForCountOptions = {}): Promise<void> {
    const timeout = options.timeout ?? 30000;

    debug('Waiting for %d emails in inbox %s (timeout: %dms)', count, this.emailAddress, timeout);

    // Check if we already have enough emails
    const syncStatus = await this.getSyncStatus();
    if (syncStatus.emailCount >= count) {
      debug('Target email count %d already reached in inbox %s', count, this.emailAddress);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let subscription: Subscription | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      // Centralized cleanup to prevent memory leaks
      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (subscription) subscription.unsubscribe();
      };

      timeoutTimer = setTimeout(() => {
        cleanup();
        debug('Timeout reached while waiting for %d emails in inbox %s', count, this.emailAddress);
        reject(new TimeoutError(`Inbox did not receive ${count} emails within timeout`));
      }, timeout);

      subscription = this.onNewEmail(async () => {
        try {
          const syncStatus = await this.getSyncStatus();
          debug('Current email count in inbox %s: %d', this.emailAddress, syncStatus.emailCount);

          if (syncStatus.emailCount >= count) {
            cleanup();
            debug('Target email count %d reached in inbox %s', count, this.emailAddress);
            resolve();
          }
        } catch (error) {
          cleanup();
          debug('Error checking sync status: %O', error);
          reject(error);
        }
      });
    });
  }

  /**
   * Subscribes to new emails as they arrive in the inbox.
   *
   * This method uses the configured delivery strategy (SSE or polling) to
   * provide real-time email notifications.
   *
   * @param callback - A function to call with the new `Email` instance.
   * @returns A `Subscription` object with an `unsubscribe` method.
   */
  onNewEmail(callback: (email: IEmail) => void | Promise<void>): Subscription {
    if (!this.strategy) {
      throw new StrategyError('No delivery strategy set. Call setStrategy() first.');
    }

    debug('Subscribing to new emails for inbox %s', this.emailAddress);
    return this.strategy.subscribe(this.emailAddress, this.inboxHash, this.keypair, callback);
  }

  /**
   * Marks a specific email as read.
   *
   * @param emailId - The ID of the email to mark as read.
   * @returns A promise that resolves when the email is marked as read.
   */
  async markEmailAsRead(emailId: string): Promise<void> {
    debug('Marking email %s as read in inbox %s', emailId, this.emailAddress);
    await this.apiClient.markEmailAsRead(this.emailAddress, emailId);
    debug('Successfully marked email %s as read', emailId);
  }

  /**
   * Deletes a specific email from the inbox.
   *
   * @param emailId - The ID of the email to delete.
   * @returns A promise that resolves when the email is deleted.
   */
  async deleteEmail(emailId: string): Promise<void> {
    debug('Deleting email %s from inbox %s', emailId, this.emailAddress);
    await this.apiClient.deleteEmail(this.emailAddress, emailId);
    debug('Successfully deleted email %s', emailId);
  }

  /**
   * Deletes the entire inbox and all its emails.
   *
   * @returns A promise that resolves when the inbox is deleted.
   */
  async delete(): Promise<void> {
    debug('Deleting inbox %s', this.emailAddress);
    await this.apiClient.deleteInbox(this.emailAddress);
    debug('Successfully deleted inbox %s', this.emailAddress);
  }

  /**
   * Exports this inbox, including its key material, for backup/sharing.
   * Keys are returned in plain base64 to keep import/export symmetric.
   */
  export(): ExportedInboxData {
    debug('Exporting inbox %s with key material', this.emailAddress);
    const exportedData = {
      emailAddress: this.emailAddress,
      expiresAt: this.expiresAt.toISOString(),
      inboxHash: this.inboxHash,
      serverSigPk: this.serverPublicKey,
      publicKeyB64: toBase64(this.keypair.publicKey),
      secretKeyB64: toBase64(this.keypair.secretKey),
      exportedAt: new Date().toISOString(),
    };
    debug('Successfully exported inbox %s', this.emailAddress);
    return exportedData;
  }

  /**
   * Retrieves the synchronization status of the inbox.
   *
   * This includes the number of emails and a hash of the email list, which
   * can be used to efficiently check for changes.
   *
   * @returns A promise that resolves to the sync status.
   */
  async getSyncStatus(): Promise<SyncStatus> {
    debug('Retrieving sync status for inbox %s', this.emailAddress);
    const syncStatus = await this.apiClient.getSyncStatus(this.emailAddress);
    debug(
      'Sync status for inbox %s: %d emails, hash: %s',
      this.emailAddress,
      syncStatus.emailCount,
      syncStatus.emailsHash,
    );
    return syncStatus;
  }
}
