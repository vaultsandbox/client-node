import type { IEmail, WaitOptions, Subscription, Keypair, EmailData } from '../types/index.js';

/**
 * DeliveryStrategy defines the interface for email delivery mechanisms.
 * Implementations include SSE (real-time) and Polling (fallback).
 */
export interface DeliveryStrategy {
  /**
   * Wait for an email matching the given options
   * @param emailAddress - The inbox email address
   * @param inboxHash - The inbox hash for SSE subscription
   * @param keypair - Keypair for decryption (null for plain inboxes)
   * @param options - Wait options including timeout and filters
   * @param serverPublicKey - Optional server public key for MITM protection
   * @returns Promise resolving to the matched email
   */
  waitForEmail(
    emailAddress: string,
    inboxHash: string,
    keypair: Keypair | null,
    options: WaitOptions,
    serverPublicKey?: string | null,
  ): Promise<IEmail>;

  /**
   * Subscribe to new email notifications
   * @param emailAddress - The inbox email address
   * @param inboxHash - The inbox hash for SSE subscription
   * @param keypair - Keypair for decryption (null for plain inboxes)
   * @param callback - Function to call when new email arrives
   * @param emailCache - Optional local email cache for sync operations
   * @param onEmailDeleted - Optional callback when email is deleted from server
   * @param onError - Optional callback when an error occurs during processing
   * @param serverPublicKey - Optional server public key for MITM protection
   * @returns Subscription object with unsubscribe method
   */
  subscribe(
    emailAddress: string,
    inboxHash: string,
    keypair: Keypair | null,
    callback: (email: IEmail) => void | Promise<void>,
    emailCache?: Map<string, EmailData>,
    onEmailDeleted?: (emailId: string) => void,
    onError?: (error: Error) => void,
    serverPublicKey?: string | null,
  ): Subscription;

  /**
   * Close and cleanup resources
   */
  close(): void;
}
