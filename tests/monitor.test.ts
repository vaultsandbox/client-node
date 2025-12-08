/**
 * Integration tests for real-time and long-polling email monitoring.
 *
 * This file contains tests for the `onNewEmail` and `monitorInboxes` methods,
 * covering both 'sse' (Server-Sent Events) and 'polling' strategies.
 * It also includes end-to-end tests for real email delivery and reception
 * through these monitoring functions.
 */

import { VaultSandboxClient } from '../src/client';
import { Inbox } from '../src/inbox';
import { SimpleSmtpClient } from './helpers/smtp-helper';
import { IEmail } from '../src/types';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:9999';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'test-api-key';
const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25');

// Skip integration tests if no API key is provided
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

const runMonitoringTests = (strategy: 'sse' | 'polling') => {
  describeIntegration(`onNewEmail Integration Tests with ${strategy} strategy`, () => {
    let client: VaultSandboxClient;
    let createdInboxes: Inbox[] = [];

    beforeAll(() => {
      client = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
        strategy,
      });
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

    afterAll(async () => {
      await client.close();
    });

    describe('Basic Subscription', () => {
      it('should create a subscription successfully', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const callback = jest.fn();
        const subscription = inbox.onNewEmail(callback);

        expect(subscription).toBeDefined();
        expect(typeof subscription.unsubscribe).toBe('function');

        // Clean up
        subscription.unsubscribe();
      });

      it('should not call callback when no emails arrive', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const callback = jest.fn();
        const subscription = inbox.onNewEmail(callback);

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 1000));

        expect(callback).not.toHaveBeenCalled();

        subscription.unsubscribe();
      });
    });

    describe('Unsubscribe Behavior', () => {
      it('should unsubscribe without errors', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const subscription = inbox.onNewEmail(() => {});

        expect(() => subscription.unsubscribe()).not.toThrow();
      });

      it('should handle multiple unsubscribe calls', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const subscription = inbox.onNewEmail(() => {});

        expect(() => {
          subscription.unsubscribe();
          subscription.unsubscribe();
          subscription.unsubscribe();
        }).not.toThrow();
      });
    });

    describe('Multiple Subscriptions', () => {
      it('should support multiple callbacks on the same inbox', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const callback1 = jest.fn();
        const callback2 = jest.fn();

        const sub1 = inbox.onNewEmail(callback1);
        const sub2 = inbox.onNewEmail(callback2);

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Clean up
        sub1.unsubscribe();
        sub2.unsubscribe();

        expect(callback1).not.toHaveBeenCalled();
        expect(callback2).not.toHaveBeenCalled();
      });
    });
  });

  describeIntegration(`monitorInboxes Integration Tests with ${strategy} strategy`, () => {
    let client: VaultSandboxClient;
    let createdInboxes: Inbox[] = [];

    beforeAll(() => {
      client = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
        strategy,
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

    afterAll(async () => {
      await client.close();
    });

    describe('Basic Monitoring', () => {
      it('should create monitor for multiple inboxes', async () => {
        const inboxes = await Promise.all([client.createInbox(), client.createInbox()]);
        createdInboxes.push(...inboxes);

        const monitor = client.monitorInboxes(inboxes);

        expect(monitor).toBeDefined();
        expect(typeof monitor.on).toBe('function');
        expect(typeof monitor.unsubscribe).toBe('function');

        monitor.unsubscribe();
      });

      it('should support event listener pattern', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const monitor = client.monitorInboxes([inbox]);
        const callback1 = jest.fn();
        const callback2 = jest.fn();

        monitor.on('email', callback1);
        monitor.on('email', callback2);

        expect(monitor.listenerCount('email')).toBe(2);

        monitor.unsubscribe();

        expect(monitor.listenerCount('email')).toBe(0);
      });
    });

    describe('Unsubscribe Behavior', () => {
      it('should unsubscribe from all inboxes', async () => {
        const inboxes = await Promise.all([client.createInbox(), client.createInbox()]);
        createdInboxes.push(...inboxes);

        const monitor = client.monitorInboxes(inboxes);
        const callback = jest.fn();
        monitor.on('email', callback);

        expect(monitor.listenerCount('email')).toBe(1);
        monitor.unsubscribe();
        expect(monitor.listenerCount('email')).toBe(0);
      });
    });

    describe('Edge Cases', () => {
      it('should handle empty inbox array', () => {
        const monitor = client.monitorInboxes([]);
        expect(monitor).toBeDefined();
        expect(() => monitor.unsubscribe()).not.toThrow();
      });
    });
  });
};

// Run all monitoring tests for both SSE and Polling strategies
runMonitoringTests('sse');
runMonitoringTests('polling');

describeIntegration('Real Email Delivery Tests', () => {
  let client: VaultSandboxClient;
  let smtp: SimpleSmtpClient;
  let createdInboxes: Inbox[] = [];

  beforeAll(() => {
    smtp = new SimpleSmtpClient(SMTP_HOST, SMTP_PORT);
  });

  afterEach(async () => {
    for (const inbox of createdInboxes) {
      try {
        await inbox.delete();
      } catch {
        /* ignore */
      }
    }
    createdInboxes = [];
    if (client) {
      await client.close();
    }
  });

  const runDeliveryTests = (strategy: 'sse' | 'polling') => {
    describe(`with ${strategy} strategy`, () => {
      beforeEach(() => {
        client = new VaultSandboxClient({
          url: GATEWAY_URL,
          apiKey: API_KEY,
          strategy,
        });
      });

      it('should receive email via onNewEmail callback', async () => {
        const inbox = await client.createInbox();
        createdInboxes.push(inbox);

        const receivedEmails: IEmail[] = [];
        const callback = jest.fn((email: IEmail) => {
          receivedEmails.push(email);
          return undefined;
        });
        const subscription = inbox.onNewEmail(callback);

        // Give connection time to establish for SSE
        if (strategy === 'sse') await new Promise((resolve) => setTimeout(resolve, 2000));

        const testSubject = `Test ${strategy} ${Date.now()}`;
        await smtp.sendEmail('sender@example.com', inbox.emailAddress, testSubject, 'Test body');

        const maxWait = 15000;
        const startTime = Date.now();
        while (receivedEmails.length === 0 && Date.now() - startTime < maxWait) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        expect(callback).toHaveBeenCalled();
        expect(receivedEmails.length).toBe(1);
        expect(receivedEmails[0].subject).toBe(testSubject);

        subscription.unsubscribe();
      }, 30000);

      it('should receive emails from multiple inboxes via monitorInboxes', async () => {
        const inboxes = await Promise.all([client.createInbox(), client.createInbox()]);
        createdInboxes.push(...inboxes);

        const received: { inbox: Inbox; email: IEmail }[] = [];
        const monitor = client.monitorInboxes(inboxes);
        monitor.on('email', (inbox, email) => received.push({ inbox, email }));

        if (strategy === 'sse') await new Promise((resolve) => setTimeout(resolve, 2000));

        await smtp.sendEmail('sender@example.com', inboxes[0].emailAddress, 'To Inbox 1', 'Content 1');
        await smtp.sendEmail('sender@example.com', inboxes[1].emailAddress, 'To Inbox 2', 'Content 2');

        const maxWait = 20000;
        const startTime = Date.now();
        while (received.length < 2 && Date.now() - startTime < maxWait) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        expect(received.length).toBe(2);
        expect(received.map((r) => r.email.subject)).toContain('To Inbox 1');
        expect(received.map((r) => r.email.subject)).toContain('To Inbox 2');

        monitor.unsubscribe();
      }, 40000);
    });
  };

  runDeliveryTests('sse');
  runDeliveryTests('polling');
});
