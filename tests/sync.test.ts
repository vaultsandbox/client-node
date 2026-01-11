/**
 * Unit tests for email synchronization utilities.
 *
 * Tests cover:
 * - Hash computation algorithm (computeEmailsHash)
 * - Sync logic with hash comparison
 * - Deletion handling
 */

import { computeEmailsHash } from '../src/utils/hash';
import { syncInbox } from '../src/sync/inbox-sync';
import type { EmailData, SyncStatus, EncryptedData } from '../src/types';
import type { ApiClient } from '../src/http/api-client';

// Mock the ApiClient
const createMockApiClient = (syncStatus: SyncStatus, emails: EmailData[]) => ({
  getSyncStatus: jest.fn().mockResolvedValue(syncStatus),
  listEmails: jest.fn().mockResolvedValue(emails),
});

// Create mock encrypted data
const createMockEncryptedData = (): EncryptedData => ({
  v: 1,
  ct_kem: 'mock_ct_kem',
  nonce: 'mock_nonce',
  aad: 'mock_aad',
  ciphertext: 'mock_ciphertext',
  sig: 'mock_sig',
  server_sig_pk: 'mock_server_sig_pk',
  algs: {
    kem: 'ML-KEM-768',
    sig: 'ML-DSA-65',
    aead: 'AES-256-GCM',
    kdf: 'HKDF-SHA-512',
  },
});

// Create mock email data
const createMockEmailData = (id: string): EmailData => ({
  id,
  inboxId: 'test-inbox',
  receivedAt: new Date().toISOString(),
  isRead: false,
  encryptedMetadata: createMockEncryptedData(),
});

describe('computeEmailsHash', () => {
  it('should return correct hash for empty array', () => {
    // SHA256 of empty string, base64url encoded without padding
    const hash = computeEmailsHash([]);
    expect(hash).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  it('should sort email IDs alphabetically before hashing', () => {
    const hash1 = computeEmailsHash(['c', 'a', 'b']);
    const hash2 = computeEmailsHash(['a', 'b', 'c']);
    const hash3 = computeEmailsHash(['b', 'c', 'a']);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('should join IDs with commas', () => {
    // The hash of "a,b,c" (sorted and joined)
    const hash = computeEmailsHash(['a', 'b', 'c']);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
    // Verify it's a valid base64url string (no padding, no + or /)
    expect(hash).not.toContain('=');
    expect(hash).not.toContain('+');
    expect(hash).not.toContain('/');
  });

  it('should produce different hashes for different email sets', () => {
    const hash1 = computeEmailsHash(['email1', 'email2']);
    const hash2 = computeEmailsHash(['email1', 'email3']);
    const hash3 = computeEmailsHash(['email1']);

    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });

  it('should produce consistent hashes for same input', () => {
    const ids = ['id1', 'id2', 'id3', 'id4', 'id5'];

    const hash1 = computeEmailsHash(ids);
    const hash2 = computeEmailsHash(ids);
    const hash3 = computeEmailsHash([...ids]);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('should handle special characters in email IDs', () => {
    const ids = ['email@test.com', 'email+tag@test.com', 'email/path'];
    const hash = computeEmailsHash(ids);

    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
  });

  it('should not modify the original array', () => {
    const original = ['c', 'a', 'b'];
    const copy = [...original];

    computeEmailsHash(original);

    expect(original).toEqual(copy);
  });
});

describe('syncInbox', () => {
  const emailAddress = 'test@example.com';

  it('should return unchanged when hashes match', async () => {
    const localEmails = new Map<string, EmailData>();
    localEmails.set('email1', createMockEmailData('email1'));
    localEmails.set('email2', createMockEmailData('email2'));

    const localHash = computeEmailsHash(['email1', 'email2']);

    const mockApiClient = createMockApiClient({ emailCount: 2, emailsHash: localHash }, []);

    const result = await syncInbox(mockApiClient as unknown as ApiClient, emailAddress, localEmails);

    expect(result.unchanged).toBe(true);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(mockApiClient.listEmails).not.toHaveBeenCalled();
  });

  it('should detect new emails when hash differs', async () => {
    const localEmails = new Map<string, EmailData>();
    localEmails.set('email1', createMockEmailData('email1'));

    const serverEmails = [createMockEmailData('email1'), createMockEmailData('email2')];
    const serverHash = computeEmailsHash(['email1', 'email2']);

    const mockApiClient = createMockApiClient({ emailCount: 2, emailsHash: serverHash }, serverEmails);

    const result = await syncInbox(mockApiClient as unknown as ApiClient, emailAddress, localEmails);

    expect(result.unchanged).toBe(false);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].id).toBe('email2');
    expect(result.deleted).toHaveLength(0);
  });

  it('should detect deleted emails when hash differs', async () => {
    const localEmails = new Map<string, EmailData>();
    localEmails.set('email1', createMockEmailData('email1'));
    localEmails.set('email2', createMockEmailData('email2'));

    const serverEmails = [createMockEmailData('email1')];
    const serverHash = computeEmailsHash(['email1']);

    const mockApiClient = createMockApiClient({ emailCount: 1, emailsHash: serverHash }, serverEmails);

    const result = await syncInbox(mockApiClient as unknown as ApiClient, emailAddress, localEmails);

    expect(result.unchanged).toBe(false);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe('email2');
  });

  it('should handle both additions and deletions', async () => {
    const localEmails = new Map<string, EmailData>();
    localEmails.set('email1', createMockEmailData('email1'));
    localEmails.set('email2', createMockEmailData('email2'));

    const serverEmails = [createMockEmailData('email1'), createMockEmailData('email3')];
    const serverHash = computeEmailsHash(['email1', 'email3']);

    const mockApiClient = createMockApiClient({ emailCount: 2, emailsHash: serverHash }, serverEmails);

    const result = await syncInbox(mockApiClient as unknown as ApiClient, emailAddress, localEmails);

    expect(result.unchanged).toBe(false);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].id).toBe('email3');
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe('email2');
  });

  it('should handle empty local cache', async () => {
    const localEmails = new Map<string, EmailData>();

    const serverEmails = [createMockEmailData('email1'), createMockEmailData('email2')];
    const serverHash = computeEmailsHash(['email1', 'email2']);

    const mockApiClient = createMockApiClient({ emailCount: 2, emailsHash: serverHash }, serverEmails);

    const result = await syncInbox(mockApiClient as unknown as ApiClient, emailAddress, localEmails);

    expect(result.unchanged).toBe(false);
    expect(result.added).toHaveLength(2);
    expect(result.deleted).toHaveLength(0);
  });

  it('should handle empty server', async () => {
    const localEmails = new Map<string, EmailData>();
    localEmails.set('email1', createMockEmailData('email1'));

    const emptyHash = computeEmailsHash([]);

    const mockApiClient = createMockApiClient({ emailCount: 0, emailsHash: emptyHash }, []);

    const result = await syncInbox(mockApiClient as unknown as ApiClient, emailAddress, localEmails);

    expect(result.unchanged).toBe(false);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe('email1');
  });
});
