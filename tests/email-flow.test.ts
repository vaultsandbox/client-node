/**
 * End-to-end tests for the complete email receiving workflow.
 *
 * These tests simulate a real-world scenario by:
 * 1. Creating an inbox.
 * 2. Sending an email to that inbox via an SMTP client.
 * 3. Using the VaultSandboxClient to wait for, receive, and decrypt the email.
 * 4. Verifying the email's content, headers, and attachments.
 *
 * This is the primary integration test for the user-facing email functionality.
 *
 * Environment variables:
 * - VAULTSANDBOX_URL: Gateway URL (default: http://localhost:9999)
 * - VAULTSANDBOX_API_KEY: API key (default: dev_api_key_12345_change_in_production)
 * - SMTP_HOST: SMTP server host (default: localhost)
 * - SMTP_PORT: SMTP server port (default: 25)
 */

import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';
import { SimpleSmtpClient } from './helpers/smtp-helper';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:9999';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'dev_api_key_12345_change_in_production';
const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25');

// Skip if no real gateway is available
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

describeIntegration('Email Flow Integration Tests', () => {
  let client: VaultSandboxClient;
  let smtp: SimpleSmtpClient;
  let createdInboxes: Inbox[] = [];

  beforeAll(() => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
      strategy: 'polling', // Use polling for predictable tests
      pollingInterval: 1000, // Poll every second
    });
    smtp = new SimpleSmtpClient(SMTP_HOST, SMTP_PORT);
  });

  afterEach(async () => {
    // Clean up created inboxes
    for (const inbox of createdInboxes) {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    }
    createdInboxes = [];
  });

  describe('Basic Email Flow', () => {
    it('should send email and receive it via waitForEmail', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const testSubject = `Test Email ${Date.now()}`;
      const testBody = 'This is a quantum-safe encrypted test email!';

      // Send email via SMTP
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, testSubject, testBody);

      // Wait for email (with timeout)
      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Verify email content
      expect(email).toBeDefined();
      expect(email.id).toBeDefined();
      expect(email.from).toBe('sender@example.com');
      expect(email.to).toContain(inbox.emailAddress);
      expect(email.subject).toBe(testSubject);
      expect(email.text).toContain(testBody);
      expect(email.receivedAt).toBeInstanceOf(Date);
    }, 40000);

    it('should handle HTML emails correctly', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const testSubject = `HTML Test ${Date.now()}`;
      const textBody = 'Plain text version';
      const htmlBody = '<html><body><h1>HTML Version</h1><p>Test content</p></body></html>';

      // Send HTML email via SMTP
      await smtp.sendHtmlEmail('sender@example.com', inbox.emailAddress, testSubject, textBody, htmlBody);

      // Wait for email
      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Verify both text and HTML content
      expect(email.subject).toBe(testSubject);
      expect(email.text).toContain(textBody);
      expect(email.html).toContain('HTML Version');
      expect(email.html).toContain('Test content');
    }, 40000);

    it('should extract links from email content', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const testLink = 'https://example.com/verify?token=abc123';
      const htmlBody = `
        <html>
          <body>
            <p>Click here to verify: <a href="${testLink}">Verify Email</a></p>
            <p>Or visit: https://example.com/help</p>
          </body>
        </html>
      `;

      await smtp.sendHtmlEmail(
        'sender@example.com',
        inbox.emailAddress,
        'Verification Email',
        'Verify: ' + testLink,
        htmlBody,
      );

      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Check extracted links
      expect(email.links).toBeDefined();
      expect(email.links.length).toBeGreaterThan(0);
      expect(email.links).toContain(testLink);
    }, 40000);
  });

  describe('Email Filtering', () => {
    it('should filter emails by subject', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Send two emails with different subjects
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Welcome Email', 'Welcome to our service!');

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Verification Email', 'Please verify your email');

      // Wait for specific email by subject
      const email = await inbox.waitForEmail({
        timeout: 30000,
        subject: /Verification/,
      });

      expect(email.subject).toBe('Verification Email');
      expect(email.text).toContain('verify');
    }, 40000);

    it('should filter emails by sender', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Send emails from different senders
      await smtp.sendEmail('alice@example.com', inbox.emailAddress, 'From Alice', 'Hello from Alice');

      await smtp.sendEmail('bob@example.com', inbox.emailAddress, 'From Bob', 'Hello from Bob');

      // Wait for email from specific sender
      const email = await inbox.waitForEmail({
        timeout: 30000,
        from: /bob@/,
      });

      expect(email.from).toBe('bob@example.com');
      expect(email.subject).toBe('From Bob');
    }, 40000);

    it('should use custom predicate for filtering', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Send emails
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Normal Email', 'Regular content');

      await smtp.sendEmail('urgent@example.com', inbox.emailAddress, '[URGENT] Important Message', 'This is urgent!');

      // Wait for urgent email using custom predicate
      const email = await inbox.waitForEmail({
        timeout: 30000,
        predicate: (e) => e.subject.includes('[URGENT]'),
      });

      expect(email.subject).toContain('[URGENT]');
      expect(email.from).toBe('urgent@example.com');
    }, 40000);
  });

  describe('Multiple Emails', () => {
    it('should list all received emails', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const emailCount = 3;

      const waitPromise = inbox.waitForEmailCount(emailCount, { timeout: 30000 });

      // Send multiple emails
      for (let i = 0; i < emailCount; i++) {
        await smtp.sendEmail('sender@example.com', inbox.emailAddress, `Email ${i + 1}`, `Content of email ${i + 1}`);
        if (i < emailCount - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // Wait for all emails to arrive
      await waitPromise;

      // List all emails
      const emails = await inbox.listEmails();
      expect(emails.length).toBe(emailCount);

      // Verify all emails are decrypted
      for (let i = 0; i < emailCount; i++) {
        expect(emails[i].subject).toBeDefined();
        expect(emails[i].from).toBe('sender@example.com');
        expect(emails[i].text).toContain('Content of email');
      }
    }, 50000);

    it('should get specific email by ID', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const testSubject = `Specific Email ${Date.now()}`;

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, testSubject, 'Test content');

      // Wait for email
      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Get same email by ID
      const retrievedEmail = await inbox.getEmail(email.id);

      expect(retrievedEmail.id).toBe(email.id);
      expect(retrievedEmail.subject).toBe(testSubject);
      expect(retrievedEmail.from).toBe(email.from);
    }, 40000);

    it('should delete specific email', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const waitPromise = inbox.waitForEmailCount(2, { timeout: 30000 });

      // Send two emails
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 1', 'First email');

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 2', 'Second email');

      // Wait for both emails to arrive
      await waitPromise;

      // Get all emails
      const emails = await inbox.listEmails();
      expect(emails.length).toBe(2);

      // Delete first email
      await inbox.deleteEmail(emails[0].id);

      // Verify deletion
      const remainingEmails = await inbox.listEmails();
      expect(remainingEmails.length).toBe(1);
      expect(remainingEmails[0].id).toBe(emails[1].id);
    }, 50000);
  });

  describe('Email Management Operations', () => {
    it('should mark email as read via Inbox.markEmailAsRead', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Send email
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Test Read Status', 'Testing mark as read');

      // Wait for email
      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Verify initial read status (should be false)
      expect(email.isRead).toBe(false);

      // Mark email as read via inbox
      await inbox.markEmailAsRead(email.id);

      // Fetch email again to verify read status
      const updatedEmail = await inbox.getEmail(email.id);
      expect(updatedEmail.isRead).toBe(true);
    }, 40000);

    it('should mark email as read via Email.markAsRead', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Send email
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Test Email Read', 'Testing email.markAsRead()');

      // Wait for email
      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Verify initial read status
      expect(email.isRead).toBe(false);

      // Mark as read using Email instance method
      await email.markAsRead();

      // Email instance should be updated
      expect(email.isRead).toBe(true);

      // Verify via fresh fetch
      const verifiedEmail = await inbox.getEmail(email.id);
      expect(verifiedEmail.isRead).toBe(true);
    }, 40000);

    it('should delete email via Email.delete method', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const waitPromise = inbox.waitForEmailCount(2, { timeout: 30000 });

      // Send two emails
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 1', 'First email');
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 2', 'Second email');

      // Wait for both emails
      await waitPromise;

      // Get all emails
      const emails = await inbox.listEmails();
      expect(emails.length).toBe(2);

      // Delete first email using Email instance method
      await emails[0].delete();

      // Verify deletion
      const remainingEmails = await inbox.listEmails();
      expect(remainingEmails.length).toBe(1);
      expect(remainingEmails[0].id).toBe(emails[1].id);
    }, 50000);

    it('should handle multiple read/unread operations', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const waitPromise = inbox.waitForEmailCount(3, { timeout: 30000 });

      // Send multiple emails
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 1', 'Content 1');
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 2', 'Content 2');
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Email 3', 'Content 3');

      // Wait for all emails
      await waitPromise;

      // Get all emails
      const emails = await inbox.listEmails();
      expect(emails.length).toBe(3);

      // All should be unread initially
      expect(emails[0].isRead).toBe(false);
      expect(emails[1].isRead).toBe(false);
      expect(emails[2].isRead).toBe(false);

      // Mark first and third as read
      await emails[0].markAsRead();
      await inbox.markEmailAsRead(emails[2].id);

      // Verify read status
      const updated = await inbox.listEmails();
      expect(updated[0].isRead).toBe(true);
      expect(updated[1].isRead).toBe(false);
      expect(updated[2].isRead).toBe(true);
    }, 50000);
  });

  describe('Email Headers and Metadata', () => {
    it('should access email headers', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Header Test', 'Testing headers');

      const email = await inbox.waitForEmail({ timeout: 30000 });

      expect(email.headers).toBeDefined();
      expect(typeof email.headers).toBe('object');

      // Check standard headers exist
      expect(email.headers['from']).toBeDefined();
      expect(email.headers['subject']).toBeDefined();
      expect(email.headers['date']).toBeDefined();
    }, 40000);

    it('should have valid metadata', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Metadata Test', 'Testing metadata');

      const email = await inbox.waitForEmail({ timeout: 30000 });
      expect(email.id).toBeDefined();
      expect(email.receivedAt).toBeInstanceOf(Date);
    }, 40000);
  });

  describe('Email Authentication Results', () => {
    it('should have auth results structure', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Auth Test', 'Testing auth results');

      const email = await inbox.waitForEmail({ timeout: 30000 });

      expect(email.authResults).toBeDefined();

      // Auth results should have validate method
      const validation = email.authResults.validate();
      expect(validation).toBeDefined();
      expect(typeof validation.passed).toBe('boolean');
      expect(typeof validation.spfPassed).toBe('boolean');
      expect(typeof validation.dkimPassed).toBe('boolean');
      expect(typeof validation.dmarcPassed).toBe('boolean');
      expect(Array.isArray(validation.failures)).toBe(true);
    }, 40000);
  });

  describe('Raw Email Access', () => {
    it('should get raw email content via Inbox.getRawEmail', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const testSubject = `Raw Email Test ${Date.now()}`;

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, testSubject, 'Raw content test');

      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Get raw email via inbox
      const rawEmail = await inbox.getRawEmail(email.id);

      expect(rawEmail).toBeDefined();
      expect(rawEmail.id).toBe(email.id);
      expect(rawEmail.raw).toBeDefined();
      expect(typeof rawEmail.raw).toBe('string');

      // Raw email should contain the original SMTP content
      expect(rawEmail.raw).toContain(testSubject);
      expect(rawEmail.raw).toContain('From: sender@example.com');
    }, 40000);

    it('should get raw email content via Email.getRaw', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const testSubject = `Raw Email Instance Test ${Date.now()}`;
      const testBody = 'Testing Email.getRaw() instance method';

      await smtp.sendEmail('sender@example.com', inbox.emailAddress, testSubject, testBody);

      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Get raw email via Email instance method
      const rawEmail = await email.getRaw();

      expect(rawEmail).toBeDefined();
      expect(rawEmail.id).toBe(email.id);
      expect(rawEmail.raw).toBeDefined();
      expect(typeof rawEmail.raw).toBe('string');

      // Raw email should contain the original SMTP content
      expect(rawEmail.raw).toContain(testSubject);
      expect(rawEmail.raw).toContain(testBody);
      expect(rawEmail.raw).toContain('From: sender@example.com');
      expect(rawEmail.raw).toContain(inbox.emailAddress);

      // Should contain standard email headers
      expect(rawEmail.raw).toMatch(/^From:/im);
      expect(rawEmail.raw).toMatch(/^Subject:/im);
    }, 40000);
  });

  describe('Timeout Handling', () => {
    it('should timeout when email never arrives', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Don't send any email, just wait
      await expect(inbox.waitForEmail({ timeout: 3000 })).rejects.toThrow('No matching email received within timeout');
    }, 10000);

    it('should timeout when waiting for non-matching email', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Send email with one subject
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Wrong Subject', 'Content');

      // Wait for different subject (should timeout)
      await expect(
        inbox.waitForEmail({
          timeout: 5000,
          subject: /NonExistent/,
        }),
      ).rejects.toThrow('No matching email received within timeout');
    }, 30000);
  });

  describe('Sync Status', () => {
    it('should update sync status when emails arrive', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      // Get initial sync status
      const initialSync = await inbox.getSyncStatus();
      expect(initialSync.emailCount).toBe(0);

      // Send email
      await smtp.sendEmail('sender@example.com', inbox.emailAddress, 'Sync Test', 'Testing sync');

      // Wait for email
      await inbox.waitForEmail({ timeout: 30000 });

      // Get updated sync status
      const updatedSync = await inbox.getSyncStatus();
      expect(updatedSync.emailCount).toBe(1);
      expect(updatedSync.emailsHash).not.toBe(initialSync.emailsHash);
    }, 40000);
  });

  describe('Real-World Scenarios', () => {
    it('should handle password reset email flow', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const resetToken = 'abc123xyz789';
      const resetLink = `https://example.com/reset-password?token=${resetToken}`;

      const htmlBody = `
        <html>
          <body>
            <h2>Password Reset Request</h2>
            <p>You requested a password reset. Click the link below:</p>
            <a href="${resetLink}">Reset Password</a>
            <p>This link expires in 1 hour.</p>
          </body>
        </html>
      `;

      await smtp.sendHtmlEmail(
        'noreply@example.com',
        inbox.emailAddress,
        'Reset Your Password',
        `Reset your password: ${resetLink}`,
        htmlBody,
      );

      const email = await inbox.waitForEmail({
        timeout: 30000,
        subject: /Reset/,
      });

      // Verify email content
      expect(email.from).toContain('noreply@example.com');
      expect(email.subject).toContain('Password');

      // Extract reset link
      const links = email.links;
      expect(links.length).toBeGreaterThan(0);

      const passwordResetLink = links.find((link) => link.includes('/reset-password'));
      expect(passwordResetLink).toBeDefined();
      expect(passwordResetLink).toContain(resetToken);
    }, 40000);

    it('should handle welcome email with multiple links', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const htmlBody = `
        <html>
          <body>
            <h1>Welcome to Our Service!</h1>
            <p>Get started:</p>
            <ul>
              <li><a href="https://example.com/docs">Documentation</a></li>
              <li><a href="https://example.com/tutorials">Tutorials</a></li>
              <li><a href="https://example.com/support">Support</a></li>
            </ul>
            <p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
          </body>
        </html>
      `;

      await smtp.sendHtmlEmail(
        'welcome@example.com',
        inbox.emailAddress,
        'Welcome to Our Service',
        'Welcome! Visit https://example.com/docs to get started.',
        htmlBody,
      );

      const email = await inbox.waitForEmail({ timeout: 30000 });

      // Verify all links are extracted
      expect(email.links.length).toBeGreaterThanOrEqual(4);
      expect(email.links).toContain('https://example.com/docs');
      expect(email.links).toContain('https://example.com/tutorials');
      expect(email.links).toContain('https://example.com/support');
      expect(email.links).toContain('https://example.com/unsubscribe');
    }, 40000);
  });
});
