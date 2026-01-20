/**
 * VaultSandboxClient - Main entry point for the SDK
 */

import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import createDebug from 'debug';
import { ApiClient } from './http/api-client.js';
import { Inbox } from './inbox.js';
import { generateKeypair, SECRET_KEY_SIZE, derivePublicKeyFromSecret } from './crypto/keypair.js';
import { toBase64Url, fromBase64Url } from './crypto/utils.js';
import { EXPORT_VERSION, MLDSA_PUBLIC_KEY_SIZE } from './crypto/constants.js';
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
  EncryptionPolicy,
} from './types/index.js';
import {
  InboxNotFoundError,
  InboxAlreadyExistsError,
  InvalidImportDataError,
  StrategyError,
  ApiError,
} from './types/index.js';

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
  private encryptionPolicy: EncryptionPolicy | null = null;
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
    this.encryptionPolicy = serverInfo.encryptionPolicy;

    // Create delivery strategy based on config
    // Note: SSE for email events (/api/events) is always available
    this.strategy = this.createStrategy();
  }

  /**
   * Determines whether to create an encrypted inbox based on options and server policy.
   * @private
   */
  private shouldEncrypt(options: CreateInboxOptions): boolean {
    // If explicit encryption preference is set, use it
    if (options.encryption) {
      return options.encryption === 'encrypted';
    }
    // Use server default based on policy
    return this.encryptionPolicy === 'always' || this.encryptionPolicy === 'enabled';
  }

  /**
   * Creates the appropriate delivery strategy based on configuration.
   * SSE for email events (/api/events) is always available on the server.
   * @private
   */
  private createStrategy(): DeliveryStrategy {
    const strategyType = this.config.strategy ?? 'sse';

    // SSE strategy (default)
    if (strategyType === 'sse') {
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
   * This method optionally generates a new quantum-safe keypair (for encrypted inboxes),
   * registers the inbox with the VaultSandbox server, and returns an `Inbox` instance.
   *
   * @param options - Optional parameters for inbox creation.
   * @returns A promise that resolves to a new `Inbox` instance.
   * @example
   * const inbox = await client.createInbox({ ttl: 3600 }); // Inbox expires in 1 hour
   * const plainInbox = await client.createInbox({ encryption: 'plain' }); // Plain inbox (no encryption)
   */
  async createInbox(options: CreateInboxOptions = {}): Promise<Inbox> {
    await this.ensureInitialized();

    const useEncryption = this.shouldEncrypt(options);

    // Generate keypair only for encrypted inboxes
    const keypair = useEncryption ? generateKeypair() : null;

    // Create inbox on server
    let inboxData: InboxData;
    try {
      inboxData = await this.apiClient.createInbox(
        keypair?.publicKeyB64,
        options.ttl,
        options.emailAddress,
        options.emailAuth,
        options.encryption,
        options.spamAnalysis,
      );
    } catch (error) {
      // Convert 409 Conflict to InboxAlreadyExistsError
      if (error instanceof ApiError && error.statusCode === 409) {
        /* istanbul ignore next - defensive fallback for error message */
        const address = options.emailAddress ?? 'requested address';
        throw new InboxAlreadyExistsError(`Inbox already exists: ${address}`);
      }
      throw error;
    }

    // Create Inbox instance
    const inbox = new Inbox(inboxData, keypair, this.apiClient, inboxData.serverSigPk ?? null);

    // Set delivery strategy
    /* istanbul ignore else - strategy always exists after ensureInitialized */
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
  /* istanbul ignore next 5 - destructive operation, not safe to test against real server */
  async deleteAllInboxes(): Promise<number> {
    const result = await this.apiClient.deleteAllInboxes();
    this.inboxes.clear();
    return result.deleted;
  }

  /**
   * Deletes a specific inbox by its email address.
   *
   * @param emailAddress - The email address of the inbox to delete.
   * @returns A promise that resolves when the inbox is deleted.
   */
  async deleteInbox(emailAddress: string): Promise<void> {
    await this.apiClient.deleteInbox(emailAddress);
    this.inboxes.delete(emailAddress);
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
   * See vaultsandbox-spec.md Section 10: Inbox Import Process
   *
   * @param data - The exported inbox data
   * @returns A promise that resolves to the imported Inbox instance
   * @throws {InvalidImportDataError} If the data is invalid or malformed
   * @throws {InboxAlreadyExistsError} If an inbox with this email already exists
   * @example
   * const importedInbox = await client.importInbox(exportedData);
   */
  async importInbox(data: ExportedInboxData): Promise<Inbox> {
    // Step 2: Validate version
    this.validateVersion(data);

    // Step 3: Validate required fields (depends on encryption status)
    this.validateRequiredFields(data);

    // Step 4: Validate emailAddress
    this.validateEmailAddress(data.emailAddress);

    // Step 5: Validate inboxHash
    this.validateInboxHash(data.inboxHash);

    // Step 8: Validate timestamps
    this.validateTimestamps(data);

    // Check for duplicates
    this.checkInboxDoesNotExist(data.emailAddress);

    await this.ensureInitialized();

    // For encrypted inboxes, validate server public key and decode keys
    let keypair: Keypair | null = null;
    /* istanbul ignore else - plain inbox import doesn't enter this block */
    if (data.encrypted) {
      // Step 7: Validate and decode serverSigPk
      /* istanbul ignore else - defensive, already validated by validateRequiredFields */
      if (data.serverSigPk) {
        this.validateServerSigPkSize(data.serverSigPk);
        this.validateServerPublicKey(data.serverSigPk);
      } else {
        throw new InvalidImportDataError('serverSigPk is required for encrypted inboxes');
      }

      // Step 6: Validate and decode secretKey
      /* istanbul ignore else - defensive, already validated by validateRequiredFields */
      if (data.secretKey) {
        keypair = this.decodeAndValidateKeys(data);
      } else {
        throw new InvalidImportDataError('secretKey is required for encrypted inboxes');
      }
    }

    const inboxData = this.buildInboxData(data);

    return this.createAndTrackInbox(inboxData, keypair);
  }

  /**
   * Validates the export format version.
   * @private
   * @param data - The exported inbox data to validate
   * @throws {InvalidImportDataError} If version is not supported
   */
  private validateVersion(data: ExportedInboxData): void {
    if (data.version !== EXPORT_VERSION) {
      throw new InvalidImportDataError(`Unsupported version: ${data.version}, expected ${EXPORT_VERSION}`);
    }
  }

  /**
   * Validates that all required fields are present and non-empty in the exported inbox data.
   * Note: serverSigPk and secretKey are only required for encrypted inboxes.
   * @private
   * @param data - The exported inbox data to validate
   * @throws {InvalidImportDataError} If any required field is missing or empty
   */
  private validateRequiredFields(data: ExportedInboxData): void {
    // These fields are always required
    const alwaysRequiredFields: (keyof ExportedInboxData)[] = ['emailAddress', 'expiresAt', 'inboxHash', 'exportedAt'];

    for (const field of alwaysRequiredFields) {
      const value = data[field];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        throw new InvalidImportDataError(`Missing or invalid field: ${field}`);
      }
    }

    // encrypted field must be a boolean
    if (typeof data.encrypted !== 'boolean') {
      /* istanbul ignore next - defensive for non-TypeScript callers */
      throw new InvalidImportDataError('Missing or invalid field: encrypted');
    }

    // serverSigPk and secretKey are only required for encrypted inboxes
    // Their validation is handled in importInbox when encrypted is true
  }

  /**
   * Validates that the email address contains exactly one @ character.
   * @private
   * @param emailAddress - The email address to validate
   * @throws {InvalidImportDataError} If email format is invalid
   */
  private validateEmailAddress(emailAddress: string): void {
    const atCount = (emailAddress.match(/@/g) || []).length;
    if (atCount !== 1) {
      throw new InvalidImportDataError('Invalid email address: must contain exactly one @ character');
    }
  }

  /**
   * Validates that the inbox hash is non-empty.
   * @private
   * @param inboxHash - The inbox hash to validate
   * @throws {InvalidImportDataError} If inbox hash is empty
   */
  private validateInboxHash(inboxHash: string): void {
    /* istanbul ignore next 3 - defensive check, already validated by validateRequiredFields */
    if (!inboxHash || inboxHash.trim() === '') {
      throw new InvalidImportDataError('Invalid inbox hash: must be non-empty');
    }
  }

  /**
   * Validates that the server signature public key has the correct size.
   * @private
   * @param serverSigPk - The server public key (base64url encoded)
   * @throws {InvalidImportDataError} If server public key has invalid size
   */
  private validateServerSigPkSize(serverSigPk: string): void {
    try {
      const decoded = fromBase64Url(serverSigPk);
      if (decoded.length !== MLDSA_PUBLIC_KEY_SIZE) {
        throw new InvalidImportDataError(
          `Invalid server public key size: expected ${MLDSA_PUBLIC_KEY_SIZE}, got ${decoded.length}`,
        );
      }
    } catch (error) {
      if (error instanceof InvalidImportDataError) throw error;
      const errorMsg = error instanceof Error ? error.message : /* istanbul ignore next */ String(error);
      throw new InvalidImportDataError(`Invalid server public key encoding: ${errorMsg}`);
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
   * Decodes the cryptographic keys from base64url and validates their lengths.
   * Public key is derived from secret key per spec Section 10.2.
   * @private
   * @param data - The exported inbox data containing base64url-encoded keys
   * @returns A keypair object with decoded keys and base64url-encoded public key
   * @throws {InvalidImportDataError} If keys cannot be decoded or have invalid lengths
   */
  private decodeAndValidateKeys(data: ExportedInboxData): Keypair {
    // Decode and validate secret key (caller ensures secretKey is defined for encrypted inboxes)
    const secretKey = this.decodeBase64UrlKey(data.secretKey!, 'secret');
    this.validateKeyLength(secretKey, SECRET_KEY_SIZE, 'secret');

    // Derive public key from secret key per spec Section 10.2
    const publicKey = derivePublicKeyFromSecret(secretKey);

    return {
      publicKey,
      secretKey,
      publicKeyB64: toBase64Url(publicKey),
    };
  }

  /**
   * Decodes a base64url-encoded cryptographic key to a byte array.
   * @private
   * @param keyB64Url - The base64url-encoded key string
   * @param keyType - The type of key (e.g., 'public', 'secret') for error messages
   * @returns The decoded key as a Uint8Array
   * @throws {InvalidImportDataError} If the base64url string is malformed
   */
  private decodeBase64UrlKey(keyB64Url: string, keyType: string): Uint8Array {
    try {
      return fromBase64Url(keyB64Url);
    } catch {
      throw new InvalidImportDataError(`Invalid base64url encoding in ${keyType} key`);
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
      encrypted: data.encrypted,
      serverSigPk: data.serverSigPk,
    };
  }

  /**
   * Creates a new Inbox instance, configures it with the delivery strategy, and adds it to tracking.
   * @private
   * @param inboxData - The inbox metadata
   * @param keypair - The cryptographic keypair for the inbox (null for plain inboxes)
   * @returns The newly created and tracked Inbox instance
   */
  private createAndTrackInbox(inboxData: InboxData, keypair: Keypair | null): Inbox {
    const inbox = new Inbox(
      inboxData,
      keypair,
      this.apiClient,
      inboxData.serverSigPk ?? /* istanbul ignore next */ null,
    );

    /* istanbul ignore else - strategy always exists after ensureInitialized */
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
