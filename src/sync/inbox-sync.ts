/**
 * Inbox synchronization utilities for hash-based sync with deletion handling
 */

import createDebug from 'debug';
import { computeEmailsHash } from '../utils/hash.js';
import type { ApiClient } from '../http/api-client.js';
import type { EmailData } from '../types/index.js';

const debug = createDebug('vaultsandbox:sync');

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** Emails that exist on the server but not locally */
  added: EmailData[];
  /** Email IDs that exist locally but not on the server */
  deleted: string[];
  /** Whether the inbox was already in sync (no changes) */
  unchanged: boolean;
}

/**
 * Synchronizes the local email cache with the server using hash comparison.
 *
 * This implements the spec's hash-based sync algorithm:
 * 1. Compute local hash from current email IDs
 * 2. Get server hash via /sync endpoint
 * 3. If hashes match, no sync needed
 * 4. If hashes differ, fetch full email list and reconcile
 *
 * @param apiClient - The API client for server communication
 * @param emailAddress - The inbox email address
 * @param localEmails - Map of local email IDs to EmailData
 * @returns Promise resolving to sync result with added/deleted emails
 */
export async function syncInbox(
  apiClient: ApiClient,
  emailAddress: string,
  localEmails: Map<string, EmailData>,
): Promise<SyncResult> {
  debug('Starting sync for inbox %s', emailAddress);

  // Step 1: Compute local hash from current email IDs
  const localIds = Array.from(localEmails.keys());
  const localHash = computeEmailsHash(localIds);
  debug('Computed local hash: %s (from %d emails)', localHash, localIds.length);

  // Step 2: Get server hash
  const syncStatus = await apiClient.getSyncStatus(emailAddress);
  debug('Server hash: %s (with %d emails)', syncStatus.emailsHash, syncStatus.emailCount);

  // Step 3: Compare hashes
  if (localHash === syncStatus.emailsHash) {
    debug('Hashes match - inbox %s is in sync', emailAddress);
    return { added: [], deleted: [], unchanged: true };
  }

  debug('Hash mismatch detected for inbox %s - fetching full email list', emailAddress);

  // Step 4: Fetch full email list from server
  const serverEmails = await apiClient.listEmails(emailAddress, false);
  const serverIds = new Set(serverEmails.map((e) => e.id));
  const localIdSet = new Set(localIds);

  // Step 5: Find new emails (on server but not local)
  const newEmails = serverEmails.filter((e) => !localIdSet.has(e.id));
  debug('Found %d new emails on server', newEmails.length);

  // Step 6: Find deleted emails (local but not on server)
  const deletedIds = localIds.filter((id) => !serverIds.has(id));
  debug('Found %d emails deleted from server', deletedIds.length);

  return {
    added: newEmails,
    deleted: deletedIds,
    unchanged: false,
  };
}
