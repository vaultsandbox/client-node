/**
 * End-to-end tests for email authentication results.
 *
 * These tests use the test email API to create emails with controlled
 * authentication results, verifying that the SDK correctly parses and
 * validates SPF, DKIM, DMARC, and Reverse DNS results.
 */
import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:9999';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';

// Skip if we don't have a real gateway configured
const describeAuthTests = API_KEY === 'test-api-key' ? describe.skip : describe;

interface TestEmailAuth {
  spf?: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
  dkim?: 'pass' | 'fail' | 'none';
  dmarc?: 'pass' | 'fail' | 'none';
  reverseDns?: boolean;
}

interface TestEmailRequest {
  to: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  auth?: TestEmailAuth;
}

/**
 * Helper to create a test email using the test email API.
 * Only available when the server is running with VSB_DEVELOPMENT=true.
 */
async function createTestEmail(request: TestEmailRequest): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/api/test/emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create test email: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { emailId: string };
  return data.emailId;
}

describeAuthTests('Auth Results E2E', () => {
  let client: VaultSandboxClient;
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
  });

  afterEach(async () => {
    for (const inbox of createdInboxes) {
      try {
        await inbox.delete();
      } catch {
        // Ignore cleanup errors
      }
    }
    createdInboxes = [];
  });

  describe('Wire format parsing', () => {
    it('parses SPF result field correctly', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'SPF Test',
        auth: { spf: 'pass' },
      });

      const email = await inbox.waitForEmail({ subject: /SPF Test/, timeout: 15000 });

      expect(email.authResults.spf).toBeDefined();
      expect(email.authResults.spf?.result).toBe('pass');
      expect(email.authResults.spf?.domain).toBeDefined();
      expect(email.authResults.spf?.details).toBeDefined();
    }, 20000);

    it('parses DKIM result field correctly', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'DKIM Test',
        auth: { dkim: 'pass' },
      });

      const email = await inbox.waitForEmail({ subject: /DKIM Test/, timeout: 15000 });

      expect(email.authResults.dkim).toBeDefined();
      expect(Array.isArray(email.authResults.dkim)).toBe(true);
      expect(email.authResults.dkim?.length).toBeGreaterThan(0);
      expect(email.authResults.dkim?.[0].result).toBe('pass');
      expect(email.authResults.dkim?.[0].domain).toBeDefined();
      expect(email.authResults.dkim?.[0].selector).toBeDefined();
      expect(email.authResults.dkim?.[0].signature).toBeDefined();
    }, 20000);

    it('parses DMARC result field correctly', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'DMARC Test',
        auth: { dmarc: 'pass' },
      });

      const email = await inbox.waitForEmail({ subject: /DMARC Test/, timeout: 15000 });

      expect(email.authResults.dmarc).toBeDefined();
      expect(email.authResults.dmarc?.result).toBe('pass');
      expect(email.authResults.dmarc?.policy).toBeDefined();
      expect(email.authResults.dmarc?.domain).toBeDefined();
      expect(email.authResults.dmarc?.aligned).toBe(true);
    }, 20000);

    it('parses ReverseDNS verified field correctly', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'ReverseDNS Test',
        auth: { reverseDns: true },
      });

      const email = await inbox.waitForEmail({ subject: /ReverseDNS Test/, timeout: 15000 });

      expect(email.authResults.reverseDns).toBeDefined();
      expect(email.authResults.reverseDns?.verified).toBe(true);
      expect(email.authResults.reverseDns?.ip).toBeDefined();
      expect(email.authResults.reverseDns?.hostname).toBeDefined();
    }, 20000);
  });

  describe('Validation with all auth passing', () => {
    it('validates all passing auth results', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'All Pass Test',
        auth: {
          spf: 'pass',
          dkim: 'pass',
          dmarc: 'pass',
          reverseDns: true,
        },
      });

      const email = await inbox.waitForEmail({ subject: /All Pass Test/, timeout: 15000 });
      const validation = email.authResults.validate();

      expect(validation.passed).toBe(true);
      expect(validation.spfPassed).toBe(true);
      expect(validation.dkimPassed).toBe(true);
      expect(validation.dmarcPassed).toBe(true);
      expect(validation.reverseDnsPassed).toBe(true);
      expect(validation.failures).toHaveLength(0);
    }, 20000);
  });

  describe('Validation with failing auth', () => {
    it('detects SPF failure', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'SPF Fail Test',
        auth: {
          spf: 'fail',
          dkim: 'pass',
          dmarc: 'pass',
          reverseDns: true,
        },
      });

      const email = await inbox.waitForEmail({ subject: /SPF Fail Test/, timeout: 15000 });
      const validation = email.authResults.validate();

      expect(validation.passed).toBe(false);
      expect(validation.spfPassed).toBe(false);
      expect(validation.dkimPassed).toBe(true);
      expect(validation.dmarcPassed).toBe(true);
      expect(validation.reverseDnsPassed).toBe(true);
      expect(validation.failures.length).toBeGreaterThan(0);
      expect(validation.failures.some((f) => f.includes('SPF'))).toBe(true);
    }, 20000);

    it('detects DKIM failure', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'DKIM Fail Test',
        auth: {
          spf: 'pass',
          dkim: 'fail',
          dmarc: 'pass',
          reverseDns: true,
        },
      });

      const email = await inbox.waitForEmail({ subject: /DKIM Fail Test/, timeout: 15000 });
      const validation = email.authResults.validate();

      expect(validation.passed).toBe(false);
      expect(validation.spfPassed).toBe(true);
      expect(validation.dkimPassed).toBe(false);
      expect(validation.dmarcPassed).toBe(true);
      expect(validation.reverseDnsPassed).toBe(true);
      expect(validation.failures.length).toBeGreaterThan(0);
      expect(validation.failures.some((f) => f.includes('DKIM'))).toBe(true);
    }, 20000);

    it('detects DMARC failure', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'DMARC Fail Test',
        auth: {
          spf: 'pass',
          dkim: 'pass',
          dmarc: 'fail',
          reverseDns: true,
        },
      });

      const email = await inbox.waitForEmail({ subject: /DMARC Fail Test/, timeout: 15000 });
      const validation = email.authResults.validate();

      expect(validation.passed).toBe(false);
      expect(validation.spfPassed).toBe(true);
      expect(validation.dkimPassed).toBe(true);
      expect(validation.dmarcPassed).toBe(false);
      expect(validation.reverseDnsPassed).toBe(true);
      expect(validation.failures.length).toBeGreaterThan(0);
      expect(validation.failures.some((f) => f.includes('DMARC'))).toBe(true);
    }, 20000);

    it('detects Reverse DNS failure', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'ReverseDNS Fail Test',
        auth: {
          spf: 'pass',
          dkim: 'pass',
          dmarc: 'pass',
          reverseDns: false,
        },
      });

      const email = await inbox.waitForEmail({ subject: /ReverseDNS Fail Test/, timeout: 15000 });
      const validation = email.authResults.validate();

      // Note: Reverse DNS doesn't affect overall "passed" status
      expect(validation.passed).toBe(true);
      expect(validation.spfPassed).toBe(true);
      expect(validation.dkimPassed).toBe(true);
      expect(validation.dmarcPassed).toBe(true);
      expect(validation.reverseDnsPassed).toBe(false);
      expect(validation.failures.some((f) => f.includes('Reverse DNS'))).toBe(true);
    }, 20000);

    it('detects all auth failures', async () => {
      const inbox = await createInbox();

      await createTestEmail({
        to: inbox.emailAddress,
        subject: 'All Fail Test',
        auth: {
          spf: 'fail',
          dkim: 'fail',
          dmarc: 'fail',
          reverseDns: false,
        },
      });

      const email = await inbox.waitForEmail({ subject: /All Fail Test/, timeout: 15000 });
      const validation = email.authResults.validate();

      expect(validation.passed).toBe(false);
      expect(validation.spfPassed).toBe(false);
      expect(validation.dkimPassed).toBe(false);
      expect(validation.dmarcPassed).toBe(false);
      expect(validation.reverseDnsPassed).toBe(false);
      expect(validation.failures.length).toBe(4);
    }, 20000);
  });

  describe('SPF status variations', () => {
    it.each([
      ['softfail', false],
      ['neutral', false],
      ['none', false],
      ['temperror', false],
      ['permerror', false],
    ] as const)(
      'handles SPF %s result',
      async (spfResult, expectedPass) => {
        const inbox = await createInbox();

        await createTestEmail({
          to: inbox.emailAddress,
          subject: `SPF ${spfResult} Test`,
          auth: {
            spf: spfResult,
            dkim: 'pass',
            dmarc: 'pass',
            reverseDns: true,
          },
        });

        const email = await inbox.waitForEmail({ subject: new RegExp(`SPF ${spfResult} Test`), timeout: 15000 });

        expect(email.authResults.spf?.result).toBe(spfResult);

        const validation = email.authResults.validate();
        expect(validation.spfPassed).toBe(expectedPass);
      },
      20000,
    );
  });

  describe('Custom email content with auth', () => {
    it('creates email with custom content and auth results', async () => {
      const inbox = await createInbox();
      const customFrom = 'custom-sender@example.com';
      const customSubject = 'Custom Auth Test';
      const customText = 'This is a custom test email body.';

      await createTestEmail({
        to: inbox.emailAddress,
        from: customFrom,
        subject: customSubject,
        text: customText,
        auth: {
          spf: 'pass',
          dkim: 'pass',
          dmarc: 'pass',
          reverseDns: true,
        },
      });

      const email = await inbox.waitForEmail({ subject: /Custom Auth Test/, timeout: 15000 });

      // Verify email content
      expect(email.from).toContain('custom-sender');
      expect(email.subject).toBe(customSubject);
      expect(email.text).toContain(customText);

      // Verify auth results
      const validation = email.authResults.validate();
      expect(validation.passed).toBe(true);
    }, 20000);
  });
});
