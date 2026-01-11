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
   * @param keypair - Keypair for decryption
   * @param options - Wait options including timeout and filters
   * @returns Promise resolving to the matched email
   */
  waitForEmail(emailAddress: string, inboxHash: string, keypair: Keypair, options: WaitOptions): Promise<IEmail>;

  /**
   * Subscribe to new email notifications
   * @param emailAddress - The inbox email address
   * @param inboxHash - The inbox hash for SSE subscription
   * @param keypair - Keypair for decryption
   * @param callback - Function to call when new email arrives
   * @param emailCache - Optional local email cache for sync operations
   * @param onEmailDeleted - Optional callback when email is deleted from server
   * @returns Subscription object with unsubscribe method
   */
  subscribe(
    emailAddress: string,
    inboxHash: string,
    keypair: Keypair,
    callback: (email: IEmail) => void | Promise<void>,
    emailCache?: Map<string, EmailData>,
    onEmailDeleted?: (emailId: string) => void,
  ): Subscription;

  /**
   * Close and cleanup resources
   */
  close(): void;
}
