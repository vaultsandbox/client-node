/**
 * VaultSandboxClient - Main entry point for the SDK
 */

import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import createDebug from 'debug';
import { ApiClient } from './http/api-client.js';
import { Inbox } from './inbox.js';
import { generateKeypair, PUBLIC_KEY_SIZE, SECRET_KEY_SIZE, derivePublicKeyFromSecret } from './crypto/keypair.js';
import { toBase64Url, toBase64, fromBase64 } from './crypto/utils.js';
import { SSEStrategy } from './strategies/sse-strategy.js';
import { PollingStrategy } from './strategies/polling-strategy.js';
import type { DeliveryStrategy } from './strategies/delivery-strategy.js';
import type {
  ClientConfig,
  CreateInboxOptions,
  ServerInfo,
  Subscription,
  IEmail,
  ExportedInboxData,
  InboxData,
  Keypair,
} from './types/index.js';
import { InboxNotFoundError, InboxAlreadyExistsError, InvalidImportDataError, StrategyError } from './types/index.js';

const debug = createDebug('vaultsandbox:client');

/**
 * An event emitter for monitoring multiple inboxes simultaneously.
 * @emits email - When a new email arrives in any of the monitored inboxes.
 *
 * @example
 * const monitor = client.monitorInboxes([inbox1, inbox2]);
 * monitor.on('email', (inbox, email) => {
 *  console.log(`New email in ${inbox.emailAddress}: ${email.subject}`);
 * });
 * // To stop monitoring:
 * monitor.unsubscribe();
 */
export class InboxMonitor extends EventEmitter {
  private subscriptions: Subscription[] = [];

  /**
   * @internal
   * Adds a subscription to the monitor.
   * @param subscription - The subscription to add.
   */
  addSubscription(subscription: Subscription): void {
    this.subscriptions.push(subscription);
  }

  /**
   * Unsubscribes from all monitored inboxes and cleans up resources.
   */
  unsubscribe(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
    this.removeAllListeners();
  }

  /**
   * @internal
   * Emits an 'email' event for a specific inbox.
   * @param inbox - The inbox that received the email.
   * @param email - The email that was received.
   */
  emitEmail(inbox: Inbox, email: IEmail): void {
    this.emit('email', inbox, email);
  }
}

/**
 * The main client for interacting with the VaultSandbox API.
 *
 * This class provides methods for creating and managing inboxes,
 * as well as for monitoring them for new emails.
 */
export class VaultSandboxClient {
  private apiClient: ApiClient;
  private config: ClientConfig;
  private serverPublicKey: string | null = null;
  private inboxes: Map<string, Inbox> = new Map();
  private strategy: DeliveryStrategy | null = null;

  /**
   * Creates a new VaultSandboxClient instance.
   * @param config - The client configuration.
   */
  constructor(config: ClientConfig) {
    this.config = config;
    this.apiClient = new ApiClient(config);
  }

  /**
   * Initializes the client by fetching server info and creating a delivery strategy.
   * This method is called automatically when needed and should not be called directly.
   * @private
   */
  private async ensureInitialized(): Promise<void> {
    if (this.serverPublicKey) {
      return;
    }

    const serverInfo = await this.apiClient.getServerInfo();
    this.serverPublicKey = serverInfo.serverSigPk;

    // Create delivery strategy based on config
    // Note: SSE for email events (/api/events) is always available
    this.strategy = this.createStrategy();
  }

  /**
   * Creates the appropriate delivery strategy based on configuration.
   * SSE for email events (/api/events) is always available on the server.
   * @private
   */
  private createStrategy(): DeliveryStrategy {
    const strategyType = this.config.strategy ?? 'auto';

    // SSE strategy (default for 'auto' and 'sse')
    if (strategyType === 'sse' || strategyType === 'auto') {
      debug('Using SSE strategy for real-time delivery');
      return new SSEStrategy(this.apiClient, {
        url: this.config.url,
        apiKey: this.config.apiKey,
        reconnectInterval: this.config.sseReconnectInterval ?? 5000,
        maxReconnectAttempts: this.config.sseMaxReconnectAttempts ?? 10,
        backoffMultiplier: 2,
      });
    }

    // Polling strategy (explicit only)
    debug('Using polling strategy');
    return new PollingStrategy(this.apiClient, {
      initialInterval: this.config.pollingInterval ?? 2000,
      maxBackoff: 30000,
      backoffMultiplier: 1.5,
      jitterFactor: 0.3,
    });
  }

  /**
   * Creates a new, temporary email inbox.
   *
   * This method generates a new quantum-safe keypair, registers the inbox
   * with the VaultSandbox server, and returns an `Inbox` instance.
   *
   * @param options - Optional parameters for inbox creation.
   * @returns A promise that resolves to a new `Inbox` instance.
   * @example
   * const inbox = await client.createInbox({ ttl: 3600 }); // Inbox expires in 1 hour
   */
  async createInbox(options: CreateInboxOptions = {}): Promise<Inbox> {
    await this.ensureInitialized();

    // Generate keypair
    const keypair = generateKeypair();

    // Create inbox on server
    const inboxData = await this.apiClient.createInbox(keypair.publicKeyB64, options.ttl, options.emailAddress);

    // Create Inbox instance (use serverSigPk from response)
    const inbox = new Inbox(inboxData, keypair, this.apiClient, inboxData.serverSigPk);

    // Set delivery strategy
    if (this.strategy) {
      inbox.setStrategy(this.strategy);
    }

    // Track inbox
    this.inboxes.set(inbox.emailAddress, inbox);

    return inbox;
  }

  /**
   * Deletes all inboxes associated with the current API key.
   *
   * @returns A promise that resolves to the number of inboxes deleted.
   */
  async deleteAllInboxes(): Promise<number> {
    const result = await this.apiClient.deleteAllInboxes();
    this.inboxes.clear();
    return result.deleted;
  }

  /**
   * Retrieves information about the VaultSandbox server.
   *
   * @returns A promise that resolves to the server information.
   */
  async getServerInfo(): Promise<ServerInfo> {
    return this.apiClient.getServerInfo();
  }

  /**
   * Checks if the configured API key is valid.
   *
   * @returns A promise that resolves to `true` if the API key is valid, `false` otherwise.
   */
  async checkKey(): Promise<boolean> {
    return this.apiClient.checkKey();
  }

  /**
   * Monitors multiple inboxes simultaneously for new emails.
   *
   * @param inboxes - An array of `Inbox` instances to monitor.
   * @returns An `InboxMonitor` instance that emits 'email' events.
   */
  monitorInboxes(inboxes: Inbox[]): InboxMonitor {
    if (!this.strategy) {
      throw new StrategyError('No delivery strategy available. Client not initialized.');
    }

    const monitor = new InboxMonitor();

    // Subscribe to each inbox
    for (const inbox of inboxes) {
      const subscription = inbox.onNewEmail((email) => {
        monitor.emitEmail(inbox, email);
      });
      monitor.addSubscription(subscription);
    }

    return monitor;
  }

  /**
   * Exports an inbox's data for backup or sharing purposes.
   *
   * @param inboxOrEmail - Either an Inbox instance or an email address string
   * @returns The exported inbox data containing all necessary information to import the inbox
   * @throws {InboxNotFoundError} If the inbox is not found in the client
   * @example
   * const exportedData = client.exportInbox(inbox);
   * // or
   * const exportedData = client.exportInbox('test@example.com');
   */
  exportInbox(inboxOrEmail: Inbox | string): ExportedInboxData {
    // Get the inbox instance
    const emailAddress = typeof inboxOrEmail === 'string' ? inboxOrEmail : inboxOrEmail.emailAddress;
    const inbox = this.inboxes.get(emailAddress);

    if (!inbox) {
      throw new InboxNotFoundError(`Inbox not found: ${emailAddress}`);
    }

    return inbox.export();
  }

  /**
   * Imports an inbox from exported data.
   *
   * @param data - The exported inbox data
   * @returns A promise that resolves to the imported Inbox instance
   * @throws {InvalidImportDataError} If the data is invalid or malformed
   * @throws {InboxAlreadyExistsError} If an inbox with this email already exists
   * @example
   * const importedInbox = await client.importInbox(exportedData);
   */
  async importInbox(data: ExportedInboxData): Promise<Inbox> {
    this.validateRequiredFields(data);
    this.ensurePublicKeyPresent(data);
    this.validateTimestamps(data);
    this.checkInboxDoesNotExist(data.emailAddress);

    await this.ensureInitialized();
    this.validateServerPublicKey(data.serverSigPk);

    const keypair = this.decodeAndValidateKeys(data);
    const inboxData = this.buildInboxData(data);

    return this.createAndTrackInbox(inboxData, keypair);
  }

  /**
   * Validates that all required fields are present and non-empty in the exported inbox data.
   * @private
   * @param data - The exported inbox data to validate
   * @throws {InvalidImportDataError} If any required field is missing, not a string, or empty
   */
  private validateRequiredFields(data: ExportedInboxData): void {
    const requiredFields: (keyof ExportedInboxData)[] = [
      'emailAddress',
      'expiresAt',
      'inboxHash',
      'serverSigPk',
      'secretKeyB64',
      'exportedAt',
    ];

    for (const field of requiredFields) {
      if (!data[field] || typeof data[field] !== 'string' || data[field].trim() === '') {
        throw new InvalidImportDataError(`Missing or invalid field: ${field}`);
      }
    }
  }

  /**
   * Ensures the public key is present in the exported data, deriving it from the secret key if necessary.
   * In ML-KEM (Kyber), the public key is embedded in the secret key, so we can extract it if missing.
   * @private
   * @param data - The exported inbox data (will be mutated to add publicKeyB64 if missing)
   * @throws {InvalidImportDataError} If the secret key is invalid or derivation fails
   */
  private ensurePublicKeyPresent(data: ExportedInboxData): void {
    if (data.publicKeyB64) {
      return;
    }

    try {
      const secretKeyBytes = fromBase64(data.secretKeyB64);
      const publicKeyBytes = derivePublicKeyFromSecret(secretKeyBytes);
      data.publicKeyB64 = toBase64(publicKeyBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidImportDataError(`Failed to derive public key from secret key: ${message}`);
    }
  }

  /**
   * Validates that the timestamp fields contain valid ISO 8601 date strings.
   * @private
   * @param data - The exported inbox data containing timestamps to validate
   * @throws {InvalidImportDataError} If either timestamp is not a valid date format
   */
  private validateTimestamps(data: ExportedInboxData): void {
    try {
      new Date(data.expiresAt).toISOString();
      new Date(data.exportedAt).toISOString();
    } catch {
      throw new InvalidImportDataError('Invalid timestamp format');
    }
  }

  /**
   * Checks that an inbox with the given email address is not already tracked by this client.
   * @private
   * @param emailAddress - The email address to check
   * @throws {InboxAlreadyExistsError} If an inbox with this email address already exists
   */
  private checkInboxDoesNotExist(emailAddress: string): void {
    if (this.inboxes.has(emailAddress)) {
      throw new InboxAlreadyExistsError(`Inbox already exists: ${emailAddress}`);
    }
  }

  /**
   * Validates that the server public key in the exported data matches the current server's key.
   * This prevents importing inboxes that were created for a different VaultSandbox server.
   * @private
   * @param serverSigPk - The server public key from the exported data
   * @throws {InvalidImportDataError} If the server public keys don't match
   */
  private validateServerPublicKey(serverSigPk: string): void {
    if (serverSigPk !== this.serverPublicKey) {
      throw new InvalidImportDataError('Server public key mismatch. This inbox was created for a different server.');
    }
  }

  /**
   * Decodes the cryptographic keys from base64 and validates their lengths.
   * @private
   * @param data - The exported inbox data containing base64-encoded keys
   * @returns A keypair object with decoded keys and base64url-encoded public key
   * @throws {InvalidImportDataError} If keys cannot be decoded or have invalid lengths
   */
  private decodeAndValidateKeys(data: ExportedInboxData): Keypair {
    const publicKey = this.decodeBase64Key(data.publicKeyB64, 'public');
    const secretKey = this.decodeBase64Key(data.secretKeyB64, 'secret');

    this.validateKeyLength(publicKey, PUBLIC_KEY_SIZE, 'public');
    this.validateKeyLength(secretKey, SECRET_KEY_SIZE, 'secret');

    return {
      publicKey,
      secretKey,
      publicKeyB64: toBase64Url(publicKey),
    };
  }

  /**
   * Decodes a base64-encoded cryptographic key to a byte array.
   * @private
   * @param keyB64 - The base64-encoded key string
   * @param keyType - The type of key (e.g., 'public', 'secret') for error messages
   * @returns The decoded key as a Uint8Array
   * @throws {InvalidImportDataError} If the base64 string is malformed
   */
  private decodeBase64Key(keyB64: string, keyType: string): Uint8Array {
    try {
      return fromBase64(keyB64);
    } catch {
      throw new InvalidImportDataError(`Invalid base64 encoding in ${keyType} key`);
    }
  }

  /**
   * Validates that a cryptographic key has the expected byte length.
   * @private
   * @param key - The decoded key to validate
   * @param expectedLength - The expected length in bytes
   * @param keyType - The type of key (e.g., 'public', 'secret') for error messages
   * @throws {InvalidImportDataError} If the key length doesn't match the expected length
   */
  private validateKeyLength(key: Uint8Array, expectedLength: number, keyType: string): void {
    if (key.length !== expectedLength) {
      throw new InvalidImportDataError(`Invalid ${keyType} key length: expected ${expectedLength}, got ${key.length}`);
    }
  }

  /**
   * Constructs an InboxData object from exported data.
   * @private
   * @param data - The exported inbox data
   * @returns An InboxData object ready for creating an Inbox instance
   */
  private buildInboxData(data: ExportedInboxData): InboxData {
    return {
      emailAddress: data.emailAddress,
      expiresAt: data.expiresAt,
      inboxHash: data.inboxHash,
      serverSigPk: data.serverSigPk,
    };
  }

  /**
   * Creates a new Inbox instance, configures it with the delivery strategy, and adds it to tracking.
   * @private
   * @param inboxData - The inbox metadata
   * @param keypair - The cryptographic keypair for the inbox
   * @returns The newly created and tracked Inbox instance
   */
  private createAndTrackInbox(inboxData: InboxData, keypair: Keypair): Inbox {
    const inbox = new Inbox(inboxData, keypair, this.apiClient, inboxData.serverSigPk);

    if (this.strategy) {
      inbox.setStrategy(this.strategy);
    }

    this.inboxes.set(inbox.emailAddress, inbox);
    return inbox;
  }

  /**
   * Exports an inbox to a JSON file.
   *
   * @param inboxOrEmail - Either an Inbox instance or an email address string
   * @param filePath - The path where the file should be written
   * @throws {InboxNotFoundError} If the inbox is not found in the client
   * @example
   * await client.exportInboxToFile(inbox, './inbox-backup.json');
   */
  async exportInboxToFile(inboxOrEmail: Inbox | string, filePath: string): Promise<void> {
    const data = this.exportInbox(inboxOrEmail);
    const json = JSON.stringify(data, null, 2);
    await writeFile(filePath, json, 'utf-8');
  }

  /**
   * Imports an inbox from a JSON file.
   *
   * @param filePath - The path to the exported inbox JSON file
   * @returns A promise that resolves to the imported Inbox instance
   * @throws {InvalidImportDataError} If the file cannot be read or parsed
   * @throws {InboxAlreadyExistsError} If an inbox with this email already exists
   * @example
   * const importedInbox = await client.importInboxFromFile('./inbox-backup.json');
   */
  async importInboxFromFile(filePath: string): Promise<Inbox> {
    let data: ExportedInboxData;

    try {
      const fileContents = await readFile(filePath, 'utf-8');
      data = JSON.parse(fileContents);
    } catch (error) {
      throw new InvalidImportDataError(
        `Failed to read or parse file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    return await this.importInbox(data);
  }

  /**
   * Closes the client, terminates any active connections, and cleans up resources.
   */
  async close(): Promise<void> {
    if (this.strategy) {
      this.strategy.close();
    }
    this.inboxes.clear();
  }
}
