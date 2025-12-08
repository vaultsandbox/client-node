/**
 * Shared email utilities for decryption and filtering
 */

import { Email } from '../email.js';
import { decryptMetadata, decryptParsed } from '../crypto/decrypt.js';
import { verifySignature } from '../crypto/signature.js';
import { fromBase64 } from '../crypto/utils.js';
import type { Keypair, EmailData, IEmail, WaitOptions, DecryptedMetadata, DecryptedParsed } from '../types/index.js';
import type { ApiClient } from '../http/api-client.js';

/**
 * Decrypts an EmailData object into an Email instance.
 * If only metadata is present, fetch the full email (including parsed content) first.
 * IMPORTANT: Signature verification happens BEFORE decryption for security
 */
export async function decryptEmailData(
  emailData: EmailData,
  keypair: Keypair,
  emailAddress: string,
  apiClient: ApiClient,
): Promise<IEmail> {
  const fullEmailData = emailData.encryptedParsed ? emailData : await apiClient.getEmail(emailAddress, emailData.id);

  // Verify signature FIRST (before decryption) - signature includes server public key
  verifySignature(fullEmailData.encryptedMetadata);

  // Decrypt metadata
  const metadata = await decryptMetadata<DecryptedMetadata>(fullEmailData.encryptedMetadata, keypair);

  // Decrypt parsed content if available
  let parsed: DecryptedParsed | null = null;
  if (fullEmailData.encryptedParsed) {
    // Verify signature for parsed content too
    verifySignature(fullEmailData.encryptedParsed);
    parsed = await decryptParsed<DecryptedParsed>(fullEmailData.encryptedParsed, keypair);

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

  return new Email(fullEmailData, metadata, parsed, emailAddress, apiClient, keypair);
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
