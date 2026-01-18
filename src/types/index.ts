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
   * - `sse`: Use Server-Sent Events for real-time updates (default).
   * - `polling`: Use traditional polling.
   */
  strategy?: 'sse' | 'polling';
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
  /** Enable or disable email authentication checks (SPF, DKIM, DMARC, PTR). Omit to use server default. */
  emailAuth?: boolean;
  /** Request encrypted or plain inbox. Omit to use server default based on encryptionPolicy. */
  encryption?: 'encrypted' | 'plain';
}

/**
 * Exported inbox data structure for sharing or backup purposes.
 * Contains all necessary information to import and access an inbox.
 * See vaultsandbox-spec.md Section 9: Inbox Export Format
 */
export interface ExportedInboxData {
  /** Export format version. MUST be 1. */
  version: number;

  /** The email address for this inbox. MUST contain @. */
  emailAddress: string;

  /** ISO 8601 timestamp when the inbox expires */
  expiresAt: string;

  /** Unique hash identifier for the inbox */
  inboxHash: string;

  /** Whether this inbox uses encryption. */
  encrypted: boolean;

  /** Server's ML-DSA-65 public key (base64url encoded, 1952 bytes decoded). Only present for encrypted inboxes. */
  serverSigPk?: string;

  /** ML-KEM-768 secret key (base64url encoded, 2400 bytes decoded). Only present for encrypted inboxes. */
  secretKey?: string;

  /** ISO 8601 timestamp when the export was created */
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
  /** Whether this inbox uses encryption. */
  encrypted: boolean;
  /** Base64URL-encoded server signing public key for verifying server signatures. Only present for encrypted inboxes. */
  serverSigPk?: string;
  /** Whether email authentication checks (SPF, DKIM, DMARC, PTR) are enabled for this inbox. */
  emailAuth?: boolean;
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
 * Encrypted email data returned from the API.
 * @internal
 */
export interface EncryptedEmailData {
  id: string;
  inboxId: string;
  receivedAt: string;
  isRead: boolean;
  encryptedMetadata: EncryptedData;
  encryptedParsed?: EncryptedData;
}

/**
 * Plain (unencrypted) email data returned from the API.
 * @internal
 */
export interface PlainEmailData {
  id: string;
  inboxId: string;
  receivedAt: string;
  isRead: boolean;
  /** Base64-encoded JSON metadata */
  metadata: string;
  /** Base64-encoded JSON parsed content */
  parsed?: string;
}

/**
 * Raw email data returned from the API (encrypted or plain).
 * Use `isEncryptedEmailData()` type guard to discriminate.
 * @internal
 */
export type EmailData = EncryptedEmailData | PlainEmailData;

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
 * Raw email data from the API (encrypted or plain).
 * @internal
 */
export interface RawEmailData {
  id: string;
  /** Encrypted raw email content. Present for encrypted inboxes. */
  encryptedRaw?: EncryptedData;
  /** Base64-encoded raw email content. Present for plain inboxes. */
  raw?: string;
}

// ===== Authentication Results =====

/**
 * The result of an SPF (Sender Policy Framework) validation check.
 */
export interface SPFResult {
  result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'skipped';
  domain?: string;
  ip?: string;
  details?: string;
}

/**
 * The result of a DKIM (DomainKeys Identified Mail) validation check.
 */
export interface DKIMResult {
  result: 'pass' | 'fail' | 'none' | 'skipped';
  domain?: string;
  selector?: string;
  signature?: string;
}

/**
 * The result of a DMARC (Domain-based Message Authentication, Reporting, and Conformance) validation check.
 */
export interface DMARCResult {
  result: 'pass' | 'fail' | 'none' | 'skipped';
  policy?: 'none' | 'quarantine' | 'reject';
  aligned?: boolean;
  domain?: string;
}

/**
 * The result of a reverse DNS validation check.
 */
export interface ReverseDNSResult {
  result: 'pass' | 'fail' | 'none' | 'skipped';
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
 * Interface for email metadata (without content).
 */
export interface IEmailMetadata {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  isRead: boolean;
}

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
 * The server's encryption policy for inboxes.
 * - `always`: All inboxes are encrypted, no override allowed
 * - `enabled`: Inboxes are encrypted by default, can request plain
 * - `disabled`: Inboxes are plain by default, can request encrypted
 * - `never`: All inboxes are plain, no override allowed
 */
export type EncryptionPolicy = 'always' | 'enabled' | 'disabled' | 'never';

/**
 * Information about the VaultSandbox server.
 */
export interface ServerInfo {
  /** Base64URL-encoded server signing public key for ML-DSA-65. */
  serverSigPk: string;
  /** The server's encryption policy for inboxes. */
  encryptionPolicy: EncryptionPolicy;
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
 * SSE message data for new email notifications.
 * @internal
 */
export interface SSEMessageData {
  inboxId: string;
  emailId: string;
  /** Encrypted metadata. Present for encrypted inboxes. */
  encryptedMetadata?: EncryptedData;
  /** Base64-encoded JSON metadata. Present for plain inboxes. */
  metadata?: string;
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

/**
 * An error thrown when a webhook is not found.
 */
export class WebhookNotFoundError extends VaultSandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookNotFoundError';
    Object.setPrototypeOf(this, WebhookNotFoundError.prototype);
  }
}

// ===== Webhooks =====

/**
 * Webhook event types.
 */
export type WebhookEventType = 'email.received' | 'email.stored' | 'email.deleted';

/**
 * A single filter rule for webhook filtering.
 */
export interface FilterRule {
  /** The field to filter on. */
  field: string;
  /** The operator to use for matching. */
  operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'domain' | 'regex' | 'exists';
  /** The value to match against. */
  value: string;
  /** Whether the match should be case sensitive. */
  caseSensitive?: boolean;
}

/**
 * Filter configuration for webhooks.
 */
export interface FilterConfig {
  /** The filter rules to apply. */
  rules: FilterRule[];
  /** How to combine the rules: 'all' (AND) or 'any' (OR). */
  mode: 'all' | 'any';
  /** Whether to require email authentication to pass. */
  requireAuth?: boolean;
}

/**
 * A custom webhook template.
 */
export interface CustomTemplate {
  /** Template type, must be 'custom'. */
  type: 'custom';
  /** The template body. */
  body: string;
  /** The content type for the webhook payload. */
  contentType?: string;
}

/**
 * Options for creating a webhook.
 */
export interface CreateWebhookOptions {
  /** The URL to send webhook requests to. */
  url: string;
  /** The events that trigger the webhook. */
  events: WebhookEventType[];
  /** The template to use for formatting the webhook payload. */
  template?: 'slack' | 'discord' | 'teams' | 'simple' | 'notification' | 'zapier' | 'default' | CustomTemplate;
  /** Filter configuration to control which emails trigger the webhook. */
  filter?: FilterConfig;
  /** A description of the webhook. */
  description?: string;
}

/**
 * Options for updating a webhook.
 */
export interface UpdateWebhookOptions {
  /** The URL to send webhook requests to. */
  url?: string;
  /** The events that trigger the webhook. */
  events?: WebhookEventType[];
  /** The template to use for formatting the webhook payload. Set to null to remove. */
  template?: string | CustomTemplate | null;
  /** Filter configuration to control which emails trigger the webhook. Set to null to remove. */
  filter?: FilterConfig | null;
  /** A description of the webhook. */
  description?: string;
  /** Whether the webhook is enabled. */
  enabled?: boolean;
}

/**
 * Webhook delivery statistics.
 */
export interface WebhookStats {
  /** Total number of delivery attempts. */
  totalDeliveries: number;
  /** Number of successful deliveries. */
  successfulDeliveries: number;
  /** Number of failed deliveries. */
  failedDeliveries: number;
}

/**
 * Webhook data returned from the API.
 */
export interface WebhookData {
  /** Unique identifier for the webhook. */
  id: string;
  /** The URL to send webhook requests to. */
  url: string;
  /** The events that trigger the webhook. */
  events: WebhookEventType[];
  /** The scope of the webhook. */
  scope: 'global' | 'inbox';
  /** The email address of the inbox (for inbox-scoped webhooks). */
  inboxEmail?: string;
  /** The hash of the inbox (for inbox-scoped webhooks). */
  inboxHash?: string;
  /** Whether the webhook is enabled. */
  enabled: boolean;
  /** The webhook secret for signature verification. Only included on creation. */
  secret?: string;
  /** The template configuration. */
  template?: unknown;
  /** The filter configuration. */
  filter?: FilterConfig;
  /** A description of the webhook. */
  description?: string;
  /** ISO 8601 timestamp when the webhook was created. */
  createdAt: string;
  /** ISO 8601 timestamp when the webhook was last updated. */
  updatedAt?: string;
  /** ISO 8601 timestamp of the last delivery attempt. */
  lastDeliveryAt?: string;
  /** The status of the last delivery attempt. */
  lastDeliveryStatus?: 'success' | 'failed';
  /** Delivery statistics. */
  stats?: WebhookStats;
}

/**
 * Response from listing webhooks.
 */
export interface WebhookListResponse {
  /** The list of webhooks. */
  webhooks: WebhookData[];
  /** Total number of webhooks. */
  total: number;
}

/**
 * Response from testing a webhook.
 */
export interface TestWebhookResponse {
  /** Whether the test was successful. */
  success: boolean;
  /** The HTTP status code returned by the webhook endpoint. */
  statusCode?: number;
  /** The response time in milliseconds. */
  responseTime?: number;
  /** The response body from the webhook endpoint. */
  responseBody?: string;
  /** Error message if the test failed. */
  error?: string;
  /** The payload that was sent to the webhook endpoint. */
  payloadSent?: unknown;
}

/**
 * Response from rotating a webhook secret.
 */
export interface RotateSecretResponse {
  /** The webhook ID. */
  id: string;
  /** The new webhook secret. */
  secret: string;
  /** ISO 8601 timestamp until which the previous secret remains valid. */
  previousSecretValidUntil: string;
}
