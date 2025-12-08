/**
 * VaultSandbox Client SDK - Public API
 *
 * Email testing made effortless
 */

// Main classes
export { VaultSandboxClient, InboxMonitor } from './client.js';
export { Inbox } from './inbox.js';
export { Email } from './email.js';

// Types
export type {
  ClientConfig,
  CreateInboxOptions,
  InboxData,
  SyncStatus,
  WaitOptions,
  WaitForCountOptions,
  IEmail,
  AttachmentData,
  RawEmail,
  SPFResult,
  DKIMResult,
  DMARCResult,
  ReverseDNSResult,
  AuthResultsData,
  AuthResults,
  AuthValidation,
  ServerInfo,
  Subscription,
  ExportedInboxData,
} from './types/index.js';

// Errors - all custom errors should be exported for proper error handling
export {
  VaultSandboxError,
  ApiError,
  NetworkError,
  TimeoutError,
  DecryptionError,
  SignatureVerificationError,
  InboxNotFoundError,
  EmailNotFoundError,
  InboxAlreadyExistsError,
  InvalidImportDataError,
  StrategyError,
  SSEError,
} from './types/index.js';

// Crypto utilities (for advanced users)
export { generateKeypair } from './crypto/keypair.js';
export { decrypt, decryptMetadata, decryptParsed, decryptRaw } from './crypto/decrypt.js';
export { verifySignature, verifySignatureSafe } from './crypto/signature.js';
export { toBase64Url, fromBase64Url } from './crypto/utils.js';
