/**
 * Inbox class - manages email retrieval and decryption for a single inbox
 */

import createDebug from 'debug';
import { decryptMetadata, decryptRaw } from './crypto/decrypt.js';
import { decryptEmailData, decodeBase64EmailData, isEncryptedEmailData } from './utils/email-utils.js';
import { toBase64Url } from './crypto/utils.js';
import { EXPORT_VERSION } from './crypto/constants.js';
import { computeEmailsHash } from './utils/hash.js';
import type {
  InboxData,
  Keypair,
  WaitOptions,
  WaitForCountOptions,
  SyncStatus,
  RawEmail,
  Subscription,
  IEmail,
  IEmailMetadata,
  ExportedInboxData,
  DecryptedMetadata,
  EmailData,
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
  /** Whether this inbox uses encryption. */
  readonly encrypted: boolean;
  /** Whether email authentication checks (SPF, DKIM, DMARC, PTR) are enabled for this inbox. */
  readonly emailAuth: boolean;

  private keypair: Keypair | null;
  private apiClient: ApiClient;
  private serverPublicKey: string | null;
  private strategy: DeliveryStrategy | null = null;
  private emailCache: Map<string, EmailData> = new Map();

  /**
   * @internal
   * Do not construct this class directly. Use `VaultSandboxClient.createInbox()` instead.
   */
  constructor(inboxData: InboxData, keypair: Keypair | null, apiClient: ApiClient, serverPublicKey: string | null) {
    this.emailAddress = inboxData.emailAddress;
    this.inboxHash = inboxData.inboxHash;
    this.expiresAt = new Date(inboxData.expiresAt);
    this.encrypted = inboxData.encrypted;
    this.emailAuth = inboxData.emailAuth ?? false;
    this.keypair = keypair;
    this.apiClient = apiClient;
    this.serverPublicKey = serverPublicKey;

    debug(
      'Created inbox for %s (expires: %s, encrypted: %s)',
      this.emailAddress,
      this.expiresAt.toISOString(),
      this.encrypted,
    );
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
   * Retrieves all emails from the inbox with full content.
   *
   * @returns A promise that resolves to an array of `Email` instances.
   */
  async listEmails(): Promise<IEmail[]> {
    debug('Listing emails for inbox %s', this.emailAddress);
    const emailsData = await this.apiClient.listEmails(this.emailAddress, true);
    debug('Retrieved %d raw email data entries', emailsData.length);
    const emails: IEmail[] = [];

    for (const emailData of emailsData) {
      const email = isEncryptedEmailData(emailData)
        ? await decryptEmailData(emailData, this.keypair!, this.emailAddress, this.apiClient)
        : decodeBase64EmailData(emailData, this.emailAddress, this.apiClient);
      emails.push(email);
    }

    debug('Successfully processed %d emails for inbox %s', emails.length, this.emailAddress);
    return emails;
  }

  /**
   * Retrieves all emails from the inbox with metadata only (no content).
   *
   * @returns A promise that resolves to an array of email metadata.
   */
  async listEmailsMetadataOnly(): Promise<IEmailMetadata[]> {
    debug('Listing email metadata for inbox %s', this.emailAddress);
    const emailsData = await this.apiClient.listEmails(this.emailAddress, false);
    debug('Retrieved %d raw email data entries', emailsData.length);
    const emails: IEmailMetadata[] = [];

    for (const emailData of emailsData) {
      let metadata: DecryptedMetadata;
      if (isEncryptedEmailData(emailData)) {
        metadata = await decryptMetadata<DecryptedMetadata>(emailData.encryptedMetadata, this.keypair!);
      } else {
        // Plain email - decode base64 metadata
        const metadataJson = Buffer.from(emailData.metadata, 'base64').toString('utf-8');
        metadata = JSON.parse(metadataJson);
      }
      emails.push({
        id: emailData.id,
        from: metadata.from,
        subject: metadata.subject,
        receivedAt: new Date(metadata.receivedAt ?? emailData.receivedAt),
        isRead: emailData.isRead,
      });
    }

    debug('Successfully processed %d email metadata for inbox %s', emails.length, this.emailAddress);
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
    const email = isEncryptedEmailData(emailData)
      ? await decryptEmailData(emailData, this.keypair!, this.emailAddress, this.apiClient)
      : decodeBase64EmailData(emailData, this.emailAddress, this.apiClient);
    debug('Successfully retrieved and processed email %s', emailId);
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
    let raw: string;
    if (rawEmailData.encryptedRaw) {
      raw = await decryptRaw(rawEmailData.encryptedRaw, this.keypair!);
    } else if (rawEmailData.raw) {
      // Plain email - decode base64
      raw = Buffer.from(rawEmailData.raw, 'base64').toString('utf-8');
    } else {
      throw new Error('Invalid raw email data: neither encryptedRaw nor raw field present');
    }
    debug('Successfully retrieved and processed raw email %s (%d characters)', emailId, raw.length);
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
      /* istanbul ignore next 4 - defensive checks for race conditions */
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
   * Exports this inbox, including its key material (for encrypted inboxes), for backup/sharing.
   * See vaultsandbox-spec.md Section 9: Inbox Export Format
   */
  export(): ExportedInboxData {
    debug('Exporting inbox %s (encrypted: %s)', this.emailAddress, this.encrypted);
    const exportedData: ExportedInboxData = {
      version: EXPORT_VERSION,
      emailAddress: this.emailAddress,
      expiresAt: this.expiresAt.toISOString(),
      inboxHash: this.inboxHash,
      encrypted: this.encrypted,
      exportedAt: new Date().toISOString(),
    };

    // Only include keys for encrypted inboxes
    if (this.encrypted && this.serverPublicKey && this.keypair) {
      exportedData.serverSigPk = this.serverPublicKey;
      exportedData.secretKey = toBase64Url(this.keypair.secretKey);
    }

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

  // ===== Email Cache Management =====

  /**
   * Gets all email IDs currently in the local cache.
   *
   * @returns An array of email IDs.
   */
  getEmailIds(): string[] {
    return Array.from(this.emailCache.keys());
  }

  /**
   * Gets the local email cache.
   *
   * @returns The email cache map.
   * @internal
   */
  getEmailCache(): Map<string, EmailData> {
    return this.emailCache;
  }

  /**
   * Adds an email to the local cache.
   *
   * @param email - The email data to add.
   * @returns `true` if the email was added, `false` if it already existed.
   */
  addEmail(email: EmailData): boolean {
    if (this.emailCache.has(email.id)) {
      debug('Email %s already exists in cache for inbox %s', email.id, this.emailAddress);
      return false;
    }
    this.emailCache.set(email.id, email);
    debug('Added email %s to cache for inbox %s', email.id, this.emailAddress);
    return true;
  }

  /**
   * Removes an email from the local cache.
   *
   * @param emailId - The ID of the email to remove.
   * @returns `true` if the email was removed, `false` if it didn't exist.
   */
  removeEmail(emailId: string): boolean {
    const removed = this.emailCache.delete(emailId);
    if (removed) {
      debug('Removed email %s from cache for inbox %s', emailId, this.emailAddress);
    }
    return removed;
  }

  /**
   * Checks if an email exists in the local cache.
   *
   * @param emailId - The ID of the email to check.
   * @returns `true` if the email exists, `false` otherwise.
   */
  hasEmail(emailId: string): boolean {
    return this.emailCache.has(emailId);
  }

  /**
   * Computes the hash of the local email cache.
   *
   * This hash can be compared with the server's hash to detect changes.
   * Uses the algorithm: BASE64URL(SHA256(SORT(emailIds).join(",")))
   *
   * @returns The computed hash of local email IDs.
   */
  computeLocalHash(): string {
    const hash = computeEmailsHash(this.getEmailIds());
    debug('Computed local hash for inbox %s: %s', this.emailAddress, hash);
    return hash;
  }

  /**
   * Clears all emails from the local cache.
   */
  clearEmailCache(): void {
    this.emailCache.clear();
    debug('Cleared email cache for inbox %s', this.emailAddress);
  }

  /**
   * Gets the keypair for this inbox.
   *
   * @returns The keypair, or null for plain inboxes.
   * @internal
   */
  getKeypair(): Keypair | null {
    return this.keypair;
  }

  /**
   * Gets the API client for this inbox.
   *
   * @returns The API client.
   * @internal
   */
  getApiClient(): ApiClient {
    return this.apiClient;
  }
}
