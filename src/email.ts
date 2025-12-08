/**
 * Email model - represents a decrypted email with convenient accessors
 */

/**
 * Represents a decrypted email with convenient accessors for its content and metadata.
 */

import createDebug from 'debug';
import type {
  IEmail,
  EmailData,
  DecryptedMetadata,
  DecryptedParsed,
  AttachmentData,
  AuthResults as IAuthResults,
  AuthValidation,
  RawEmail,
  SPFResult,
  DKIMResult,
  DMARCResult,
  ReverseDNSResult,
  AuthResultsData,
  Keypair,
} from './types/index.js';
import type { ApiClient } from './http/api-client.js';
import { decryptRaw } from './crypto/decrypt.js';

const debug = createDebug('vaultsandbox:email');

/**
 * Provides a summary of email authentication results (SPF, DKIM, DMARC).
 */
class AuthResults implements IAuthResults {
  /** The SPF (Sender Policy Framework) validation result. */
  spf?: SPFResult;
  /** An array of DKIM (DomainKeys Identified Mail) validation results. */
  dkim?: DKIMResult[];
  /** The DMARC (Domain-based Message Authentication, Reporting, and Conformance) validation result. */
  dmarc?: DMARCResult;
  /** The reverse DNS validation result. */
  reverseDns?: ReverseDNSResult;

  /**
   * @internal
   */
  constructor(data: AuthResultsData) {
    this.spf = data.spf;
    this.dkim = data.dkim;
    this.dmarc = data.dmarc;
    this.reverseDns = data.reverseDns;

    debug(
      'Created AuthResults with SPF: %O, DKIM: %O, DMARC: %O, ReverseDNS: %O',
      this.spf,
      this.dkim,
      this.dmarc,
      this.reverseDns,
    );
  }

  /**
   * Validates the authentication results and provides a summary.
   *
   * @returns An `AuthValidation` object with the overall status and a list of failures.
   */
  validate(): AuthValidation {
    debug('Validating email authentication results');
    const failures: string[] = [];

    // Check SPF
    const spfPassed = this.spf?.status === 'pass';
    if (this.spf && !spfPassed) {
      failures.push(`SPF check failed: ${this.spf.status}${this.spf.domain ? ` (domain: ${this.spf.domain})` : ''}`);
    }

    // Check DKIM (at least one signature must pass)
    const dkimPassed = this.dkim?.some((d) => d.status === 'pass') ?? false;
    if (this.dkim && this.dkim.length > 0 && !dkimPassed) {
      const failedDomains = this.dkim
        .filter((d) => d.status !== 'pass')
        .map((d) => d.domain)
        .filter(Boolean)
        .join(', ');
      failures.push(`DKIM signature failed${failedDomains ? `: ${failedDomains}` : ''}`);
    }

    // Check DMARC
    const dmarcPassed = this.dmarc?.status === 'pass';
    if (this.dmarc && !dmarcPassed) {
      failures.push(`DMARC policy: ${this.dmarc.status}${this.dmarc.policy ? ` (policy: ${this.dmarc.policy})` : ''}`);
    }

    // Check Reverse DNS
    const reverseDnsPassed = this.reverseDns?.status === 'pass';
    if (this.reverseDns && !reverseDnsPassed) {
      failures.push(
        `Reverse DNS check failed: ${this.reverseDns.status}${this.reverseDns.hostname ? ` (hostname: ${this.reverseDns.hostname})` : ''}`,
      );
    }

    const validation = {
      passed: spfPassed && dkimPassed && dmarcPassed,
      spfPassed,
      dkimPassed,
      dmarcPassed,
      reverseDnsPassed,
      failures,
    };

    debug('Authentication validation result: %O', validation);
    return validation;
  }
}

/**
 * Represents a fully decrypted email, providing access to its content,
 * attachments, and metadata.
 */
export class Email implements IEmail {
  /** The unique identifier for the email. */
  readonly id: string;
  /** The sender's email address. */
  readonly from: string;
  /** An array of recipient email addresses. */
  readonly to: string[];
  /** The subject of the email. */
  readonly subject: string;
  /** The date and time the email was received. */
  readonly receivedAt: Date;
  /** A boolean indicating whether the email has been read. */
  readonly isRead: boolean;
  /** The plain text content of the email, or `null` if not available. */
  readonly text: string | null;
  /** The HTML content of the email, or `null` if not available. */
  readonly html: string | null;
  /** An array of attachments found in the email. */
  readonly attachments: AttachmentData[];
  /** An array of URLs extracted from the email's content. */
  readonly links: string[];
  /** An object containing the email's headers. */
  readonly headers: Record<string, unknown>;
  /** The email's authentication results (SPF, DKIM, DMARC). */
  readonly authResults: IAuthResults;
  /** Any other metadata associated with the email. */
  readonly metadata: Record<string, unknown>;

  private emailAddress: string;
  private apiClient: ApiClient;
  private keypair: Keypair;

  /**
   * @internal
   * Do not construct this class directly.
   */
  constructor(
    emailData: EmailData,
    metadata: DecryptedMetadata,
    parsed: DecryptedParsed | null,
    emailAddress: string,
    apiClient: ApiClient,
    keypair: Keypair,
  ) {
    this.id = emailData.id;
    this.from = metadata.from;
    this.to = Array.isArray(metadata.to) ? metadata.to : [metadata.to].filter(Boolean);
    this.subject = metadata.subject;
    const receivedAtValue =
      metadata.receivedAt ?? (emailData as { receivedAt?: string | number }).receivedAt ?? Date.now();
    this.receivedAt = new Date(receivedAtValue);
    this.isRead = emailData.isRead;
    this.emailAddress = emailAddress;
    this.apiClient = apiClient;
    this.keypair = keypair;

    debug('Creating email %s from %s to %s', this.id, this.from, Array.isArray(this.to) ? this.to.join(', ') : this.to);

    // If parsed content is available, use it
    if (parsed) {
      this.text = parsed.text;
      this.html = parsed.html;
      this.headers = parsed.headers;
      this.attachments = parsed.attachments || [];
      this.links = parsed.links || [];
      this.authResults = new AuthResults(parsed.authResults || {});
      debug(
        'Email %s created with full parsed content (%d attachments, %d links)',
        this.id,
        this.attachments.length,
        this.links.length,
      );
    } else {
      // Metadata only (SSE notification without full fetch)
      this.text = null;
      this.html = null;
      this.headers = {};
      this.attachments = [];
      this.links = [];
      this.authResults = new AuthResults({});
      debug('Email %s created with metadata only', this.id);
    }

    this.metadata = {};
  }

  /**
   * Marks this email as read.
   *
   * @returns A promise that resolves when the email is marked as read.
   */
  async markAsRead(): Promise<void> {
    debug('Marking email %s as read', this.id);
    await this.apiClient.markEmailAsRead(this.emailAddress, this.id);
    // The isRead property is readonly for external consumers to prevent accidental modification,
    // but we need to update it after the API call succeeds. This mapped type temporarily removes
    // the readonly modifier to allow the internal update while maintaining the public API contract.
    (this as { -readonly [P in keyof Email]: Email[P] }).isRead = true;
    debug('Successfully marked email %s as read', this.id);
  }

  /**
   * Deletes this email from the inbox.
   *
   * @returns A promise that resolves when the email is deleted.
   */
  async delete(): Promise<void> {
    debug('Deleting email %s', this.id);
    await this.apiClient.deleteEmail(this.emailAddress, this.id);
    debug('Successfully deleted email %s', this.id);
  }

  /**
   * Fetches the raw, decrypted source of the email.
   *
   * @returns A promise that resolves to the raw email data.
   */
  async getRaw(): Promise<RawEmail> {
    debug('Fetching raw content for email %s', this.id);
    const rawEmailData = await this.apiClient.getRawEmail(this.emailAddress, this.id);
    const raw = await decryptRaw(rawEmailData.encryptedRaw, this.keypair);
    debug('Successfully fetched and decrypted raw content for email %s (%d characters)', this.id, raw.length);
    return { id: rawEmailData.id, raw };
  }
}
