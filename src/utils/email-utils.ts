/**
 * Shared email utilities for decryption and filtering
 */

import { Email } from '../email.js';
import { decryptMetadata, decryptParsed } from '../crypto/decrypt.js';
import { verifySignature } from '../crypto/signature.js';
import { fromBase64 } from '../crypto/utils.js';
import type {
  Keypair,
  EmailData,
  EncryptedEmailData,
  PlainEmailData,
  IEmail,
  WaitOptions,
  DecryptedMetadata,
  DecryptedParsed,
  AttachmentData,
} from '../types/index.js';
import type { ApiClient } from '../http/api-client.js';

/**
 * Type guard to determine if email data is encrypted.
 * @param email - The email data to check
 * @returns true if the email has encryptedMetadata (encrypted format)
 */
export function isEncryptedEmailData(email: EmailData): email is EncryptedEmailData {
  return 'encryptedMetadata' in email;
}

/**
 * Decrypts an EncryptedEmailData object into an Email instance.
 * Expects full email data with encryptedParsed content.
 * IMPORTANT: Signature verification happens BEFORE decryption for security
 */
export async function decryptEmailData(
  emailData: EncryptedEmailData,
  keypair: Keypair,
  emailAddress: string,
  apiClient: ApiClient,
): Promise<IEmail> {
  // Verify signature FIRST (before decryption) - signature includes server public key
  verifySignature(emailData.encryptedMetadata);

  // Decrypt metadata
  const metadata = await decryptMetadata<DecryptedMetadata>(emailData.encryptedMetadata, keypair);

  // Decrypt parsed content if available
  let parsed: DecryptedParsed | null = null;
  if (emailData.encryptedParsed) {
    // Verify signature for parsed content too
    verifySignature(emailData.encryptedParsed);
    parsed = await decryptParsed<DecryptedParsed>(emailData.encryptedParsed, keypair);

    // Transform attachment content from base64 strings to Uint8Array
    // The server returns attachment content as base64-encoded strings, but our type expects Uint8Array
    if (parsed?.attachments) {
      parsed.attachments = parsed.attachments.map((att) => {
        // Check if content exists and is a string (base64 encoded)
        if (att.content && typeof att.content === 'string') {
          return {
            ...att,
            content: fromBase64(att.content),
          };
        }
        // Content is already Uint8Array or undefined
        return att;
      });
    }
  }

  return new Email(emailData, metadata, parsed, emailAddress, apiClient, keypair);
}

/**
 * Decodes a PlainEmailData object into an Email instance.
 * Plain emails have base64-encoded metadata and parsed content.
 */
export function decodeBase64EmailData(emailData: PlainEmailData, emailAddress: string, apiClient: ApiClient): IEmail {
  // Decode base64 metadata
  const metadataJson = Buffer.from(emailData.metadata, 'base64').toString('utf-8');
  const metadata: DecryptedMetadata = JSON.parse(metadataJson);

  // Decode parsed content if available
  let parsed: DecryptedParsed | null = null;
  if (emailData.parsed) {
    const parsedJson = Buffer.from(emailData.parsed, 'base64').toString('utf-8');
    parsed = JSON.parse(parsedJson);

    // Transform attachment content from base64 strings to Uint8Array
    // Same as encrypted path - server sends attachment content as base64
    if (parsed?.attachments) {
      parsed.attachments = parsed.attachments.map((att: AttachmentData & { content?: string | Uint8Array }) => {
        if (att.content && typeof att.content === 'string') {
          return {
            ...att,
            content: fromBase64(att.content),
          };
        }
        return att;
      });
    }
  }

  // Pass null for keypair since plain emails don't need decryption
  return new Email(emailData, metadata, parsed, emailAddress, apiClient, null);
}

/**
 * Finds the first email matching the specified criteria
 */
export function findMatchingEmail(emails: IEmail[], options: WaitOptions): IEmail | null {
  for (const email of emails) {
    if (matchesFilters(email, options)) {
      return email;
    }
  }
  return null;
}

/**
 * Check if email matches the specified filters
 */
export function matchesFilters(email: IEmail, options: WaitOptions): boolean {
  // Check subject filter
  if (options.subject) {
    /* istanbul ignore else - defensive check for non-TypeScript callers */
    if (typeof options.subject === 'string') {
      if (!email.subject.includes(options.subject)) {
        return false;
      }
    } else if (options.subject instanceof RegExp) {
      if (!options.subject.test(email.subject)) {
        return false;
      }
    }
  }

  // Check from filter
  if (options.from) {
    /* istanbul ignore else - defensive check for non-TypeScript callers */
    if (typeof options.from === 'string') {
      if (!email.from.includes(options.from)) {
        return false;
      }
    } else if (options.from instanceof RegExp) {
      if (!options.from.test(email.from)) {
        return false;
      }
    }
  }

  // Check custom predicate
  if (options.predicate) {
    if (!options.predicate(email)) {
      return false;
    }
  }

  return true;
}
