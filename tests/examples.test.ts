/**
 * Documentation-driven tests that mirror the README examples.
 *
 * These tests exercise the same flows demonstrated in the README to keep
 * examples from drifting from real behavior.
 */
import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';
import { SimpleSmtpClient } from './helpers/smtp-helper';
import type { IEmail } from '../src/types';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:9999';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';
const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25');

// Skip if we don't have a real gateway configured
const describeExamples = API_KEY === 'test-api-key' ? describe.skip : describe;

describeExamples('README Examples', () => {
  let client: VaultSandboxClient;
  let smtp: SimpleSmtpClient;
  let createdInboxes: Inbox[] = [];

  const createInbox = async (): Promise<Inbox> => {
    const inbox = await client.createInbox();
    createdInboxes.push(inbox);
    return inbox;
  };

  beforeAll(() => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
      strategy: 'polling',
      pollingInterval: 1000,
    });
    smtp = new SimpleSmtpClient(SMTP_HOST, SMTP_PORT);
  });

  afterEach(async () => {
    for (const inbox of createdInboxes) {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors in examples
      }
    }
    createdInboxes = [];
  });

  afterAll(async () => {
    await client.close();
  });

  it('Quick Start example', async () => {
    const inbox = await createInbox();
    const subject = `README Quick Start ${Date.now()}`;

    await smtp.sendHtmlEmail(
      'quickstart@example.com',
      inbox.emailAddress,
      subject,
      'Plain text body from README quick start',
      '<p>HTML body from README quick start</p>',
    );

    const email = await inbox.waitForEmail({
      timeout: 20000,
      subject: /README Quick Start/,
    });

    expect(email.from).toBe('quickstart@example.com');
    expect(email.subject).toBe(subject);
    expect(email.text).toContain('Plain text body');
    expect(email.html).toContain('HTML body');
  }, 30000);

  it('Testing Password Reset Emails example', async () => {
    const inbox = await createInbox();
    const resetLink = `https://app.example.com/reset-password?token=${Date.now()}`;

    await smtp.sendHtmlEmail(
      'support@example.com',
      inbox.emailAddress,
      'Reset your password',
      `Reset using ${resetLink}`,
      `<a href="${resetLink}">Reset password</a>`,
    );

    const email = await inbox.waitForEmail({
      timeout: 20000,
      subject: /Reset your password/,
    });

    const discoveredResetLink = email.links.find((url) => url.includes('/reset-password'));
    expect(discoveredResetLink).toBeDefined();
    expect(discoveredResetLink).toContain('https://');

    const authValidation = email.authResults.validate();
    expect(typeof authValidation.passed).toBe('boolean');
    expect(Array.isArray(authValidation.failures)).toBe(true);
  }, 30000);

  it('Testing Email Authentication (SPF/DKIM/DMARC) example', async () => {
    const inbox = await createInbox();
    await smtp.sendEmail('auth@example.com', inbox.emailAddress, 'Auth example', 'Auth results demo');

    const email = await inbox.waitForEmail({ timeout: 20000 });
    const validation = email.authResults.validate();

    // We cannot guarantee a pass/fail outcome in all environments, but the shape should align with the README.
    expect(validation).toEqual(
      expect.objectContaining({
        passed: expect.any(Boolean),
        spfPassed: expect.any(Boolean),
        dkimPassed: expect.any(Boolean),
        dmarcPassed: expect.any(Boolean),
        failures: expect.any(Array),
      }),
    );

    if (email.authResults.spf?.result) {
      expect(email.authResults.spf.result).toMatch(/pass|fail|softfail|neutral|temperror|permerror/);
    }
    if (email.authResults.dkim) {
      expect(email.authResults.dkim.length).toBeGreaterThan(0);
    }
    if (email.authResults.dmarc?.result) {
      expect(email.authResults.dmarc.result).toMatch(/pass|fail|neutral|temperror|permerror/);
    }
  }, 30000);

  it('Extracting and Validating Links example', async () => {
    const inbox = await createInbox();
    const verifyLink = `https://app.example.com/verify?token=${Date.now()}`;

    await smtp.sendHtmlEmail(
      'verify@example.com',
      inbox.emailAddress,
      'Verify your email',
      `Verify at ${verifyLink}`,
      `<a href="${verifyLink}">Verify</a>`,
    );

    const email = await inbox.waitForEmail({ subject: /Verify your email/, timeout: 20000 });

    const discoveredLink = email.links.find((url) => url.includes('/verify'));
    expect(discoveredLink).toBeDefined();
    expect(discoveredLink).toContain('https://');

    const mockResponse = { ok: true } as unknown as Response;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    try {
      const response = await fetch(discoveredLink!);
      expect(response.ok).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 30000);

  describe('Testing with Jest example', () => {
    test('should receive welcome email', async () => {
      const inbox = await createInbox();
      const subject = `Welcome ${Date.now()}`;

      await smtp.sendEmail('noreply@example.com', inbox.emailAddress, subject, 'Thank you for signing up');

      const email = await inbox.waitForEmail({
        timeout: 20000,
        subject: /Welcome/,
      });

      expect(email.from).toBe('noreply@example.com');
      expect(email.text).toContain('Thank you for signing up');
    }, 30000);
  });

  it('Waiting for Multiple Emails example', async () => {
    const inbox = await createInbox();
    const emailCount = 3;

    for (let i = 0; i < emailCount; i++) {
      await smtp.sendEmail(
        'notify@example.com',
        inbox.emailAddress,
        `Notification ${i + 1}`,
        `Notification body ${i + 1}`,
      );
    }

    await inbox.waitForEmailCount(emailCount, { timeout: 30000 });

    const emails = await inbox.listEmails();
    expect(emails.length).toBe(emailCount);
    expect(emails[0].subject).toContain('Notification');
  }, 40000);

  it('Real-time Monitoring example (onNewEmail subscription)', async () => {
    const inbox = await createInbox();
    const subject = `Realtime ${Date.now()}`;

    const emailPromise = new Promise<IEmail>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const subscription = inbox.onNewEmail((email) => {
        subscription.unsubscribe();
        clearTimeout(timeoutId);
        resolve(email);
      });
      timeoutId = setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error('Timed out waiting for onNewEmail callback'));
      }, 30000);
    });

    await smtp.sendEmail('updates@example.com', inbox.emailAddress, subject, 'Watching for emails');

    const email = await emailPromise;
    expect(email.subject).toBe(subject);
  }, 40000);

  it('InboxMonitor example from API reference', async () => {
    const inbox1 = await createInbox();
    const inbox2 = await createInbox();
    const subject = `Monitor inbox example ${Date.now()}`;

    const monitor = client.monitorInboxes([inbox1, inbox2]);
    const emailPromise = new Promise<{ inbox: Inbox; email: IEmail }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        monitor.unsubscribe();
        reject(new Error('Timed out waiting for monitor event'));
      }, 30000);

      monitor.on('email', (inbox, email) => {
        clearTimeout(timeoutId);
        monitor.unsubscribe();
        resolve({ inbox, email });
      });
    });

    await smtp.sendEmail('monitor@example.com', inbox2.emailAddress, subject, 'Monitor body');

    const { inbox, email } = await emailPromise;
    expect(inbox.emailAddress).toBe(inbox2.emailAddress);
    expect(email.subject).toBe(subject);
  }, 40000);

  it('WaitOptions example variations', async () => {
    const inbox = await createInbox();
    const resetSubject = `Password Reset ${Date.now()}`;
    await smtp.sendEmail('reset@example.com', inbox.emailAddress, 'Ignore me', 'first email');
    await smtp.sendEmail('reset@example.com', inbox.emailAddress, resetSubject, 'reset email body');

    const emailBySubject = await inbox.waitForEmail({
      timeout: 20000,
      subject: /Password Reset/,
    });
    expect(emailBySubject.subject).toBe(resetSubject);

    const predicateSubject = `Predicate Match ${Date.now()}`;
    await smtp.sendEmail('predicate@example.com', inbox.emailAddress, predicateSubject, 'predicate body');

    const emailByPredicate = await inbox.waitForEmail({
      timeout: 20000,
      predicate: (email) => email.subject === predicateSubject && email.to.includes(inbox.emailAddress),
    });
    expect(emailByPredicate.subject).toBe(predicateSubject);
  }, 40000);

  it('Working with Email Attachments example', async () => {
    const inbox = await createInbox();

    // Create sample attachments
    const textFileContent = 'This is a sample text file attachment.';
    const jsonFileContent = JSON.stringify({ message: 'Hello from JSON', timestamp: Date.now() }, null, 2);

    await smtp.sendEmailWithAttachments(
      'attachments@example.com',
      inbox.emailAddress,
      'Documents Attached',
      'Please find the attached documents.',
      [
        {
          filename: 'readme.txt',
          contentType: 'text/plain',
          content: textFileContent,
        },
        {
          filename: 'data.json',
          contentType: 'application/json',
          content: jsonFileContent,
        },
      ],
    );

    const email = await inbox.waitForEmail({ timeout: 20000 });

    // Verify email has attachments
    expect(email.attachments).toBeDefined();
    expect(email.attachments.length).toBe(2);

    // Check first attachment (text file)
    const textAttachment = email.attachments.find((att) => att.filename === 'readme.txt');
    expect(textAttachment).toBeDefined();
    expect(textAttachment!.contentType).toContain('text/plain');
    expect(textAttachment!.size).toBeGreaterThan(0);

    // Decode and verify text file content
    if (textAttachment!.content) {
      const decodedText = new TextDecoder().decode(textAttachment!.content);
      expect(decodedText).toBe(textFileContent);
    }

    // Check second attachment (JSON file)
    const jsonAttachment = email.attachments.find((att) => att.filename === 'data.json');
    expect(jsonAttachment).toBeDefined();
    expect(jsonAttachment!.contentType).toContain('application/json');
    expect(jsonAttachment!.size).toBeGreaterThan(0);

    // Decode and parse JSON content
    if (jsonAttachment!.content) {
      const decodedJson = new TextDecoder().decode(jsonAttachment!.content);
      const parsedData = JSON.parse(decodedJson);
      expect(parsedData.message).toBe('Hello from JSON');
      expect(parsedData.timestamp).toBeDefined();
    }
  }, 30000);

  describe('Error Handling example', () => {
    it('should handle successful email receipt', async () => {
      const { ApiError, TimeoutError, VaultSandboxError } = await import('../src/index');

      const inbox = await createInbox();
      const subject = `Error handling success ${Date.now()}`;

      try {
        // Send email to ensure success path
        await smtp.sendEmail('errorhandling@example.com', inbox.emailAddress, subject, 'Test body');

        // This should succeed
        const email = await inbox.waitForEmail({ timeout: 20000 });

        expect(email.subject).toBe(subject);
        await inbox.delete();
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw new Error('Should not timeout when email is sent');
        } else if (error instanceof ApiError) {
          throw new Error(`Unexpected API Error (${error.statusCode}): ${error.message}`);
        } else if (error instanceof VaultSandboxError) {
          throw new Error(`Unexpected SDK error: ${error.message}`);
        } else {
          throw error;
        }
      }
    }, 30000);

    it('should handle TimeoutError when no email arrives', async () => {
      const { ApiError, TimeoutError, VaultSandboxError } = await import('../src/index');

      const inbox = await createInbox();
      let caughtError: Error | null = null;

      try {
        // Don't send email - this should timeout
        await inbox.waitForEmail({ timeout: 2000 });

        throw new Error('Should have thrown TimeoutError');
      } catch (error) {
        caughtError = error as Error;
        if (error instanceof TimeoutError) {
          // Expected - verify the error message exists
          expect(error.message).toBeTruthy();
          expect(error.name).toBe('TimeoutError');
        } else if (error instanceof ApiError) {
          throw new Error(`Unexpected API Error (${error.statusCode}): ${error.message}`);
        } else if (error instanceof VaultSandboxError) {
          throw new Error(`Unexpected SDK error: ${error.message}`);
        } else {
          throw error;
        }
      }

      // Verify we actually caught a TimeoutError
      expect(caughtError).toBeInstanceOf(TimeoutError);
    }, 30000);
  });
});
