/**
 * Integration and unit tests for inbox import/export functionality.
 *
 * These tests verify that inboxes can be exported to JSON format and
 * imported back, allowing for inbox persistence, test reproducibility,
 * and interoperability with other tools.
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
import {
  InboxNotFoundError,
  InboxAlreadyExistsError,
  InvalidImportDataError,
  ExportedInboxData,
} from '../src/types/index';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const GATEWAY_URL = process.env.VAULTSANDBOX_URL || 'http://localhost:9999';
const API_KEY = process.env.VAULTSANDBOX_API_KEY || 'dev_api_key_12345_change_in_production';
const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25');

// Skip integration tests if using test API key
const describeIntegration = API_KEY === 'test-api-key' ? describe.skip : describe;

describeIntegration('Inbox Import/Export Tests', () => {
  let client: VaultSandboxClient;
  let createdInboxes: Inbox[] = [];
  let tempDir: string;
  let tempFiles: string[] = [];

  beforeAll(() => {
    client = new VaultSandboxClient({
      url: GATEWAY_URL,
      apiKey: API_KEY,
      strategy: 'polling',
      pollingInterval: 1000,
    });

    // Create a temporary directory for test files
    tempDir = mkdtempSync(join(tmpdir(), 'vaultsandbox-test-'));
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

    // Clean up temporary files
    for (const file of tempFiles) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    tempFiles = [];
  });

  afterAll(() => {
    // Clean up temporary directory
    try {
      if (existsSync(tempDir)) {
        unlinkSync(tempDir);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('exportInbox', () => {
    it('should export an inbox with all required fields', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);

      // Verify structure
      expect(exportedData).toBeDefined();
      expect(exportedData.emailAddress).toBe(inbox.emailAddress);
      expect(exportedData.inboxHash).toBe(inbox.inboxHash);
      expect(exportedData.expiresAt).toBeDefined();
      expect(exportedData.serverSigPk).toBeDefined();
      expect(exportedData.publicKeyB64).toBeDefined();
      expect(exportedData.secretKeyB64).toBeDefined();
      expect(exportedData.exportedAt).toBeDefined();

      // Verify field types
      expect(typeof exportedData.emailAddress).toBe('string');
      expect(typeof exportedData.inboxHash).toBe('string');
      expect(typeof exportedData.expiresAt).toBe('string');
      expect(typeof exportedData.serverSigPk).toBe('string');
      expect(typeof exportedData.publicKeyB64).toBe('string');
      expect(typeof exportedData.secretKeyB64).toBe('string');
      expect(typeof exportedData.exportedAt).toBe('string');

      // Verify timestamps are valid ISO strings
      expect(() => new Date(exportedData.expiresAt).toISOString()).not.toThrow();
      expect(() => new Date(exportedData.exportedAt).toISOString()).not.toThrow();

      // Verify keys are valid base64 (can contain +, /, and = characters)
      expect(exportedData.publicKeyB64).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(exportedData.secretKeyB64).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Verify keys are non-empty
      expect(exportedData.publicKeyB64.length).toBeGreaterThan(0);
      expect(exportedData.secretKeyB64.length).toBeGreaterThan(0);
    });

    it('should export an inbox by email address string', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox.emailAddress);

      expect(exportedData).toBeDefined();
      expect(exportedData.emailAddress).toBe(inbox.emailAddress);
    });

    it('should throw InboxNotFoundError for non-existent inbox', () => {
      expect(() => client.exportInbox('nonexistent@example.com')).toThrow(InboxNotFoundError);
      expect(() => client.exportInbox('nonexistent@example.com')).toThrow('Inbox not found');
    });
  });

  describe('importInbox', () => {
    it('should import a valid exported inbox', async () => {
      // Create and export an inbox with client A
      const clientA = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });
      const originalInbox = await clientA.createInbox();
      createdInboxes.push(originalInbox);

      const exportedData = clientA.exportInbox(originalInbox);

      // Import with client B (new instance)
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });
      const importedInbox = await clientB.importInbox(exportedData);

      // Verify imported inbox
      expect(importedInbox).toBeDefined();
      expect(importedInbox.emailAddress).toBe(originalInbox.emailAddress);
      expect(importedInbox.inboxHash).toBe(originalInbox.inboxHash);
      expect(importedInbox.expiresAt.toISOString()).toBe(originalInbox.expiresAt.toISOString());

      // Cleanup
      await clientA.close();
      await clientB.close();
    });

    it('should throw InboxAlreadyExistsError when importing duplicate', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);

      await expect(client.importInbox(exportedData)).rejects.toThrow(InboxAlreadyExistsError);
      await expect(client.importInbox(exportedData)).rejects.toThrow('already exists');
    });

    it('should throw InvalidImportDataError for missing fields', async () => {
      const invalidData = {
        emailAddress: 'test@example.com',
        // Missing other required fields
      } as ExportedInboxData;

      await expect(client.importInbox(invalidData)).rejects.toThrow(InvalidImportDataError);
    });

    it('should throw InvalidImportDataError for empty fields', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);
      const invalidData = { ...exportedData, emailAddress: '' };

      // Need a new client since the original inbox already exists
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });

      await expect(clientB.importInbox(invalidData)).rejects.toThrow(InvalidImportDataError);
      await clientB.close();
    });

    it('should throw InvalidImportDataError for invalid timestamp', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);
      const invalidData = { ...exportedData, expiresAt: 'not-a-timestamp' };

      // Need a new client
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });

      await expect(clientB.importInbox(invalidData)).rejects.toThrow(InvalidImportDataError);
      await expect(clientB.importInbox(invalidData)).rejects.toThrow('Invalid timestamp');
      await clientB.close();
    });

    it('should throw InvalidImportDataError for invalid base64 encoding', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);
      const invalidData = { ...exportedData, publicKeyB64: 'invalid!!!base64' };

      // Need a new client
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });

      await expect(clientB.importInbox(invalidData)).rejects.toThrow(InvalidImportDataError);
      await clientB.close();
    });

    it('should throw InvalidImportDataError for incorrect key lengths', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);
      // Create a short invalid key (valid base64 but wrong length)
      const invalidData = { ...exportedData, publicKeyB64: 'dGVzdA==' };

      // Need a new client
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });

      await expect(clientB.importInbox(invalidData)).rejects.toThrow(InvalidImportDataError);
      await expect(clientB.importInbox(invalidData)).rejects.toThrow('Invalid public key length');
      await clientB.close();
    });

    it('should throw InvalidImportDataError for server mismatch', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const exportedData = client.exportInbox(inbox);
      // Change server public key to simulate cross-server import
      const invalidData = { ...exportedData, serverSigPk: 'different-server-key' };

      // Need a new client
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });

      await expect(clientB.importInbox(invalidData)).rejects.toThrow(InvalidImportDataError);
      await expect(clientB.importInbox(invalidData)).rejects.toThrow('Server public key mismatch');
      await clientB.close();
    });
  });

  describe('File I/O', () => {
    it('should export inbox to file and import it back', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const filePath = join(tempDir, `inbox-${Date.now()}.json`);
      tempFiles.push(filePath);

      // Export to file
      await client.exportInboxToFile(inbox, filePath);

      // Verify file exists and contains valid JSON
      expect(existsSync(filePath)).toBe(true);
      const fileContents = readFileSync(filePath, 'utf-8');
      const parsedData = JSON.parse(fileContents);
      expect(parsedData.emailAddress).toBe(inbox.emailAddress);

      // Import from file with a new client
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
      });
      const importedInbox = await clientB.importInboxFromFile(filePath);

      // Verify imported inbox matches original
      expect(importedInbox.emailAddress).toBe(inbox.emailAddress);
      expect(importedInbox.inboxHash).toBe(inbox.inboxHash);

      await clientB.close();
    });

    it('should export inbox by email address to file', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const filePath = join(tempDir, `inbox-byemail-${Date.now()}.json`);
      tempFiles.push(filePath);

      // Export to file using email address string
      await client.exportInboxToFile(inbox.emailAddress, filePath);

      // Verify file exists
      expect(existsSync(filePath)).toBe(true);
      const fileContents = readFileSync(filePath, 'utf-8');
      const parsedData = JSON.parse(fileContents);
      expect(parsedData.emailAddress).toBe(inbox.emailAddress);
    });

    it('should throw InvalidImportDataError for invalid JSON file', async () => {
      const filePath = join(tempDir, `invalid-${Date.now()}.json`);
      tempFiles.push(filePath);

      // Write invalid JSON
      writeFileSync(filePath, 'not valid json', 'utf-8');

      await expect(client.importInboxFromFile(filePath)).rejects.toThrow(InvalidImportDataError);
      await expect(client.importInboxFromFile(filePath)).rejects.toThrow('Failed to read or parse');
    });

    it('should throw InvalidImportDataError for non-existent file', async () => {
      const filePath = join(tempDir, `nonexistent-${Date.now()}.json`);

      await expect(client.importInboxFromFile(filePath)).rejects.toThrow(InvalidImportDataError);
    });

    it('should format exported JSON with indentation', async () => {
      const inbox = await client.createInbox();
      createdInboxes.push(inbox);

      const filePath = join(tempDir, `formatted-${Date.now()}.json`);
      tempFiles.push(filePath);

      await client.exportInboxToFile(inbox, filePath);

      const fileContents = readFileSync(filePath, 'utf-8');

      // Verify JSON is formatted with indentation (contains newlines and spaces)
      expect(fileContents).toContain('\n');
      expect(fileContents).toContain('  ');
    });
  });

  describe('End-to-End: Full Email Cycle', () => {
    it('should receive email in imported inbox', async () => {
      const smtp = new SimpleSmtpClient(SMTP_HOST, SMTP_PORT);

      // Client A: Create inbox and export it
      const clientA = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
        strategy: 'polling',
        pollingInterval: 1000,
      });

      const originalInbox = await clientA.createInbox();
      createdInboxes.push(originalInbox);
      const exportedData = clientA.exportInbox(originalInbox);

      // Client B: Import the inbox
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
        strategy: 'polling',
        pollingInterval: 1000,
      });

      const importedInbox = await clientB.importInbox(exportedData);

      // Send email to the inbox
      const testSubject = `Import Test ${Date.now()}`;
      const testBody = 'Testing imported inbox email reception';

      await smtp.sendEmail('sender@example.com', importedInbox.emailAddress, testSubject, testBody);

      // Wait for email using imported inbox
      const email = await importedInbox.waitForEmail({ timeout: 30000 });

      // Verify email was received and decrypted correctly
      expect(email).toBeDefined();
      expect(email.subject).toBe(testSubject);
      expect(email.text).toContain(testBody);
      expect(email.from).toBe('sender@example.com');

      await clientA.close();
      await clientB.close();
    }, 40000);

    it('should support full inbox operations on imported inbox', async () => {
      const smtp = new SimpleSmtpClient(SMTP_HOST, SMTP_PORT);

      // Create and export
      const clientA = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
        strategy: 'polling',
        pollingInterval: 1000,
      });

      const originalInbox = await clientA.createInbox();
      createdInboxes.push(originalInbox);
      const exportedData = clientA.exportInbox(originalInbox);

      // Import
      const clientB = new VaultSandboxClient({
        url: GATEWAY_URL,
        apiKey: API_KEY,
        strategy: 'polling',
        pollingInterval: 1000,
      });

      const importedInbox = await clientB.importInbox(exportedData);

      // Send test email
      const testSubject = `Full Operations Test ${Date.now()}`;
      const testBody = 'Testing all operations';

      await smtp.sendEmail('sender@example.com', importedInbox.emailAddress, testSubject, testBody);

      // Wait for email
      const email = await importedInbox.waitForEmail({ timeout: 30000 });

      // Test listEmails
      const emails = await importedInbox.listEmails();
      expect(emails.length).toBeGreaterThan(0);
      expect(emails[0].subject).toBe(testSubject);

      // Test markAsRead
      await importedInbox.markEmailAsRead(email.id);

      // Test getEmail
      const fetchedEmail = await importedInbox.getEmail(email.id);
      expect(fetchedEmail.subject).toBe(testSubject);

      // Test getSyncStatus
      const syncStatus = await importedInbox.getSyncStatus();
      expect(syncStatus.emailCount).toBeGreaterThan(0);

      // Test deleteEmail
      await importedInbox.deleteEmail(email.id);

      // Verify deletion
      const emailsAfterDelete = await importedInbox.listEmails();
      expect(emailsAfterDelete.length).toBe(0);

      await clientA.close();
      await clientB.close();
    }, 50000);
  });
});
