/**
 * VaultSandbox Client SDK - Type Definitions
 */

// ===== Client Configuration =====

/**
 * Configuration for the VaultSandboxClient.
 */
export interface ClientConfig {
  /** The URL of the VaultSandbox Gateway server. */
  url: string;
  /** Your API key for authentication. */
  apiKey: string;
  /**
   * The email delivery strategy to use.
   * - `sse`: Use Server-Sent Events for real-time updates.
   * - `polling`: Use traditional polling.
   * - `auto`: Use SSE if available, otherwise fall back to polling (default).
   */
  strategy?: 'sse' | 'polling' | 'auto';
  /** The base interval for polling in milliseconds (default: 2000). */
  pollingInterval?: number;
  /** The maximum number of retries for failed HTTP requests (default: 3). */
  maxRetries?: number;
  /** The initial delay in milliseconds between retries (default: 1000). */
  retryDelay?: number;
  /** An array of HTTP status codes that should trigger a retry. */
  retryOn?: number[];
  /** The initial interval in milliseconds for SSE reconnection attempts (default: 5000). */
  sseReconnectInterval?: number;
  /** The maximum number of SSE reconnection attempts (default: 10). */
  sseMaxReconnectAttempts?: number;
}

// ===== Inbox =====

/**
 * Options for creating a new inbox.
 */
export interface CreateInboxOptions {
  /** The time-to-live for the inbox in seconds. */
  ttl?: number;
  /** A specific email address to request for the inbox. */
  emailAddress?: string;
}

/**
 * Exported inbox data structure for sharing or backup purposes.
 * Contains all necessary information to import and access an inbox.
 */
export interface ExportedInboxData {
  /** The email address for this inbox */
  emailAddress: string;

  /** ISO timestamp when the inbox expires */
  expiresAt: string;

  /** Unique hash identifier for the inbox */
  inboxHash: string;

  /** Server's public signing key */
  serverSigPk: string;

  /** Base64-encoded public key */
  publicKeyB64: string;

  /** Base64-encoded secret key for decryption */
  secretKeyB64: string;

  /** ISO timestamp when the inbox was exported */
  exportedAt: string;
}

/**
 * Data returned by the server when an inbox is created.
 * Matches the CreateInboxResponseDto from the API.
 * @internal
 */
export interface InboxData {
  /** The email address assigned to the inbox. */
  emailAddress: string;
  /** ISO 8601 timestamp when the inbox will expire. */
  expiresAt: string;
  /** Base64URL-encoded SHA-256 hash of the client KEM public key, used for SSE subscriptions and API references. */
  inboxHash: string;
  /** Base64URL-encoded server signing public key for verifying server signatures. */
  serverSigPk: string;
}

/**
 * The synchronization status of an inbox.
 */
export interface SyncStatus {
  /** The number of emails in the inbox. */
  emailCount: number;
  /** A hash of the email list, used for efficient change detection. */
  emailsHash: string;
}

// ===== Email =====

/**
 * Options for waiting for an email.
 */
export interface WaitOptions {
  /** The maximum time to wait in milliseconds (default: 30000). */
  timeout?: number;
  /** The interval for polling in milliseconds (default: 2000). */
  pollInterval?: number;
  /** A string or regular expression to match against the email subject. */
  subject?: string | RegExp;
  /** A string or regular expression to match against the sender's email address. */
  from?: string | RegExp;
  /** A custom predicate function to filter emails. */
  predicate?: (email: IEmail) => boolean;
}

/**
 * Options for waiting for a specific number of emails.
 */
export interface WaitForCountOptions {
  /** The maximum time to wait in milliseconds (default: 30000). */
  timeout?: number;
}

/**
 * Raw email data returned from the API.
 * @internal
 */
export interface EmailData {
  id: string;
  inboxId: string;
  receivedAt: string;
  isRead: boolean;
  encryptedMetadata: EncryptedData;
  encryptedParsed?: EncryptedData;
}

/**
 * The structure of encrypted data returned from the server.
 * @internal
 */
export interface EncryptedData {
  v: number;
  ct_kem: string;
  nonce: string;
  aad: string;
  ciphertext: string;
  sig: string;
  server_sig_pk: string;
  algs: {
    kem: string;
    sig: string;
    aead: string;
    kdf: string;
  };
}

/**
 * Decrypted email metadata.
 * @internal
 */
export interface DecryptedMetadata {
  from: string;
  to: string[];
  subject: string;
  receivedAt?: string;
}

/**
 * Decrypted and parsed email content.
 * @internal
 */
export interface DecryptedParsed {
  text: string | null;
  html: string | null;
  headers: Record<string, unknown>;
  attachments: AttachmentData[];
  links?: string[];
  authResults?: AuthResultsData;
}

/**
 * Represents an email attachment.
 */
export interface AttachmentData {
  /** The filename of the attachment. */
  filename: string;
  /** The content type of the attachment. */
  contentType: string;
  /** The size of the attachment in bytes. */
  size: number;
  /** Optional content ID for inline attachments referenced in HTML. */
  contentId?: string;
  /** Content disposition header value (e.g., 'attachment', 'inline'). */
  contentDisposition?: string;
  /** Optional checksum for verifying attachment integrity. */
  checksum?: string;
  /** The content of the attachment as a byte array. */
  content?: Uint8Array;
}

/**
 * Represents the raw, decrypted source of an email.
 */
export interface RawEmail {
  /** The ID of the email. */
  id: string;
  /** The raw email content. */
  raw: string;
}

/**
 * @internal
 */
export interface RawEmailData {
  id: string;
  encryptedRaw: EncryptedData;
}

// ===== Authentication Results =====

/**
 * The result of an SPF (Sender Policy Framework) validation check.
 */
export interface SPFResult {
  result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
  domain?: string;
  ip?: string;
  details?: string;
}

/**
 * The result of a DKIM (DomainKeys Identified Mail) validation check.
 */
export interface DKIMResult {
  result: 'pass' | 'fail' | 'none';
  domain?: string;
  selector?: string;
  signature?: string;
}

/**
 * The result of a DMARC (Domain-based Message Authentication, Reporting, and Conformance) validation check.
 */
export interface DMARCResult {
  result: 'pass' | 'fail' | 'none';
  policy?: 'none' | 'quarantine' | 'reject';
  aligned?: boolean;
  domain?: string;
}

/**
 * The result of a reverse DNS validation check.
 */
export interface ReverseDNSResult {
  verified: boolean;
  ip?: string;
  hostname?: string;
}

/**
 * The raw data for email authentication results.
 */
export interface AuthResultsData {
  spf?: SPFResult;
  dkim?: DKIMResult[];
  dmarc?: DMARCResult;
  reverseDns?: ReverseDNSResult;
}

/**
 * A summary of email authentication validation.
 */
export interface AuthValidation {
  /** A boolean indicating whether all checks passed. */
  passed: boolean;
  /** A boolean indicating whether the SPF check passed. */
  spfPassed: boolean;
  /** A boolean indicating whether the DKIM check passed. */
  dkimPassed: boolean;
  /** A boolean indicating whether the DMARC check passed. */
  dmarcPassed: boolean;
  /** A boolean indicating whether the reverse DNS check passed. */
  reverseDnsPassed: boolean;
  /** An array of strings describing any failures. */
  failures: string[];
}

// ===== Email Class Interface =====

/**
 * Interface for the Email class.
 */
export interface IEmail {
  readonly id: string;
  readonly from: string;
  readonly to: string[];
  readonly subject: string;
  readonly receivedAt: Date;
  readonly isRead: boolean;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: AttachmentData[];
  readonly links: string[];
  readonly headers: Record<string, unknown>;
  readonly authResults: AuthResults;
  readonly metadata: Record<string, unknown>;

  markAsRead(): Promise<void>;
  delete(): Promise<void>;
  getRaw(): Promise<RawEmail>;
}

/**
 * Interface for the AuthResults class.
 */
export interface AuthResults extends AuthResultsData {
  validate(): AuthValidation;
}

// ===== Server Info =====

/**
 * Information about the VaultSandbox server.
 */
export interface ServerInfo {
  /** Base64URL-encoded server signing public key for ML-DSA-65. */
  serverSigPk: string;
  /** Cryptographic algorithms supported by the server. */
  algs: {
    /** Key encapsulation mechanism algorithm (e.g., 'ML-KEM-768'). */
    kem: string;
    /** Digital signature algorithm (e.g., 'ML-DSA-65'). */
    sig: string;
    /** Authenticated encryption algorithm (e.g., 'AES-256-GCM'). */
    aead: string;
    /** Key derivation function (e.g., 'HKDF-SHA-512'). */
    kdf: string;
  };
  /** Context string for the encryption scheme. */
  context: string;
  /** Maximum time-to-live for inboxes in seconds. */
  maxTtl: number;
  /** Default time-to-live for inboxes in seconds. */
  defaultTtl: number;
  /** Whether the server SSE console is enabled. */
  sseConsole: boolean;
  /** List of domains allowed for inbox creation. */
  allowedDomains: string[];
}

// ===== Subscriptions =====

/**
 * Represents a subscription to an event source, such as new emails.
 */
export interface Subscription {
  /** Unsubscribes from the event source and cleans up resources. */
  unsubscribe(): void;
}

// ===== SSE Types =====

/**
 * @internal
 */
export interface SSEConfig {
  url: string;
  apiKey: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  backoffMultiplier?: number;
}

/**
 * @internal
 */
export interface SSEMessageData {
  inboxId: string;
  emailId: string;
  encryptedMetadata: EncryptedData;
}

// ===== Crypto Types =====

/**
 * A quantum-safe keypair used for encryption and decryption.
 * @internal
 */
export interface Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
}

/**
 * @internal
 */
export interface DecryptionResult {
  plaintext: Uint8Array;
  verified: boolean;
}

// ===== Errors =====

/**
 * Base class for all errors thrown by the VaultSandbox client.
 */
export class VaultSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultSandboxError';
    Object.setPrototypeOf(this, VaultSandboxError.prototype);
  }
}

/**
 * An error thrown when the API returns a non-successful status code.
 */
export class ApiError extends VaultSandboxError {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * An error thrown when a network error occurs.
 */
export class NetworkError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * An error thrown when an operation times out.
 */
export class TimeoutError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * An error thrown when decryption fails.
 */
export class DecryptionError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
    Object.setPrototypeOf(this, DecryptionError.prototype);
  }
}

/**
 * An error thrown when signature verification fails.
 */
export class SignatureVerificationError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureVerificationError';
    Object.setPrototypeOf(this, SignatureVerificationError.prototype);
  }
}

/**
 * An error thrown when an inbox is not found.
 */
export class InboxNotFoundError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'InboxNotFoundError';
    Object.setPrototypeOf(this, InboxNotFoundError.prototype);
  }
}

/**
 * An error thrown when an email is not found.
 */
export class EmailNotFoundError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'EmailNotFoundError';
    Object.setPrototypeOf(this, EmailNotFoundError.prototype);
  }
}

/**
 * An error thrown when an SSE (Server-Sent Events) error occurs.
 */
export class SSEError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'SSEError';
    Object.setPrototypeOf(this, SSEError.prototype);
  }
}

/**
 * An error thrown when trying to import an inbox that already exists.
 */
export class InboxAlreadyExistsError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'InboxAlreadyExistsError';
    Object.setPrototypeOf(this, InboxAlreadyExistsError.prototype);
  }
}

/**
 * An error thrown when imported inbox data fails validation.
 */
export class InvalidImportDataError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImportDataError';
    Object.setPrototypeOf(this, InvalidImportDataError.prototype);
  }
}

/**
 * An error thrown when a delivery strategy is not set or is invalid.
 */
export class StrategyError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'StrategyError';
    Object.setPrototypeOf(this, StrategyError.prototype);
  }
}
