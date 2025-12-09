<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/logo-light.svg">
  <img alt="VaultSandbox" src="./assets/logo-dark.svg">
</picture>

# @vaultsandbox/client

[![npm version](https://img.shields.io/npm/v/@vaultsandbox/client.svg)](https://www.npmjs.com/package/@vaultsandbox/client)
[![CI](https://github.com/vaultsandbox/client-node/actions/workflows/ci.yml/badge.svg)](https://github.com/vaultsandbox/client-node/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/vaultsandbox/client-node/graph/badge.svg)](https://codecov.io/gh/vaultsandbox/client-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Production-like email testing. Self-hosted & secure.**

The official Node.js SDK for [VaultSandbox Gateway](https://github.com/vaultsandbox/gateway) — a secure, receive-only SMTP server for QA/testing environments. This SDK abstracts quantum-safe encryption complexity, making email testing workflows transparent and effortless.

Stop mocking your email stack. If your app sends real emails in production, it must send real emails in testing. VaultSandbox provides isolated inboxes that behave exactly like production without exposing a single byte of customer data.

> **Node.js 20+** required. Not intended for browsers or edge runtimes.

## Why VaultSandbox?

| Feature             | Simple Mocks     | Public SaaS  | **VaultSandbox**    |
| :------------------ | :--------------- | :----------- | :------------------ |
| **TLS/SSL**         | Ignored/Disabled | Partial      | **Real ACME certs** |
| **Data Privacy**    | Local only       | Shared cloud | **Private VPC**     |
| **Inbound Mail**    | Outbound only    | Yes          | **Real MX**         |
| **Auth (SPF/DKIM)** | None             | Limited      | **Full Validation** |
| **Crypto**          | Plaintext        | Varies       | **Zero-Knowledge**  |

## Features

- **Quantum-Safe Encryption** — Automatic ML-KEM-768 (Kyber768) key encapsulation + AES-256-GCM encryption
- **Zero Crypto Knowledge Required** — All cryptographic operations are invisible to the user
- **Real-Time Email Delivery** — SSE-based delivery with smart polling fallback
- **Built for CI/CD** — Deterministic tests without sleeps, polling, or flakiness
- **Full Email Access** — Decrypt and access email content, headers, links, and attachments
- **Email Authentication** — Built-in SPF/DKIM/DMARC validation helpers
- **Type-Safe** — Full TypeScript support with comprehensive type definitions

## Installation

```bash
npm install @vaultsandbox/client
```

## Quick Start

```javascript
import { VaultSandboxClient } from '@vaultsandbox/client';

// Initialize client with your API key
const client = new VaultSandboxClient({
  url: 'https://smtp.vaultsandbox.com',
  apiKey: 'your-api-key',
});

// Create inbox (keypair generated automatically)
const inbox = await client.createInbox();
console.log(`Send email to: ${inbox.emailAddress}`);

// Wait for email with timeout
const email = await inbox.waitForEmail({
  timeout: 30000, // 30 seconds
  subject: /Test/, // Optional filter
});

// Email is already decrypted - just use it!
console.log('From:', email.from);
console.log('Subject:', email.subject);
console.log('Text:', email.text);
console.log('HTML:', email.html);

// Cleanup
await inbox.delete();
```

## Usage Examples

### Testing Password Reset Emails

```javascript
import { VaultSandboxClient } from '@vaultsandbox/client';

const client = new VaultSandboxClient({ url, apiKey });
const inbox = await client.createInbox();

// Trigger password reset in your app (replace with your own implementation)
await yourApp.requestPasswordReset(inbox.emailAddress);

// Wait for and validate the reset email
const email = await inbox.waitForEmail({
  timeout: 10000,
  subject: /Reset your password/,
});

// Extract reset link
const resetLink = email.links.find((url) => url.includes('/reset-password'));
console.log('Reset link:', resetLink);

// Validate email authentication
const authValidation = email.authResults.validate();
// In a real test, this may not pass if the sender isn't fully configured.
// A robust check verifies the validation was performed and has the correct shape.
expect(typeof authValidation.passed).toBe('boolean');
expect(Array.isArray(authValidation.failures)).toBe(true);

await inbox.delete();
```

### Testing Email Authentication (SPF/DKIM/DMARC)

```javascript
const email = await inbox.waitForEmail({ timeout: 5000 });
const validation = email.authResults.validate();

if (!validation.passed) {
  console.error('Email authentication failed:');
  validation.failures.forEach((reason) => {
    console.error(`  - ${reason}`);
  });
}

// Or check individual results. Statuses can vary based on the sending source.
if (email.authResults.spf?.status) {
  expect(email.authResults.spf.status).toMatch(/pass|fail|softfail|neutral|temperror|permerror/);
}
if (email.authResults.dkim) {
  expect(email.authResults.dkim.length).toBeGreaterThan(0);
}
if (email.authResults.dmarc?.status) {
  expect(email.authResults.dmarc.status).toMatch(/pass|fail|neutral|temperror|permerror/);
}
```

### Extracting and Validating Links

```javascript
const email = await inbox.waitForEmail({ subject: /Verify your email/ });

// All links are automatically extracted
const verifyLink = email.links.find((url) => url.includes('/verify'));
expect(verifyLink).toBeDefined();
expect(verifyLink).toContain('https://');

// Test the verification flow
const response = await fetch(verifyLink);
expect(response.ok).toBe(true);
```

### Working with Email Attachments

Email attachments are automatically decrypted and available as `Uint8Array` buffers, ready to be processed or saved.

```javascript
import { writeFileSync } from 'fs';

const email = await inbox.waitForEmail({ subject: /Documents Attached/ });

// Access attachments array
console.log(`Found ${email.attachments.length} attachments`);

// Iterate through attachments
for (const attachment of email.attachments) {
  console.log(`Filename: ${attachment.filename}`);
  console.log(`Content-Type: ${attachment.contentType}`);
  console.log(`Size: ${attachment.size} bytes`);

  if (!attachment.content) continue;

  // Decode text-based attachments
  if (attachment.contentType.includes('text')) {
    const textContent = new TextDecoder().decode(attachment.content);
    console.log('Content:', textContent);
  }

  // Parse JSON attachments
  if (attachment.contentType.includes('json')) {
    const jsonContent = new TextDecoder().decode(attachment.content);
    const data = JSON.parse(jsonContent);
    console.log('Parsed data:', data);
  }

  // Save binary files to disk
  if (attachment.contentType.includes('pdf') || attachment.contentType.includes('image')) {
    writeFileSync(`./downloads/${attachment.filename}`, attachment.content);
    console.log(`Saved ${attachment.filename}`);
  }
}

// Find and verify specific attachment in tests
const pdfAttachment = email.attachments.find((att) => att.filename === 'invoice.pdf');
expect(pdfAttachment).toBeDefined();
expect(pdfAttachment!.contentType).toBe('application/pdf');
expect(pdfAttachment!.size).toBeGreaterThan(0);

// Verify attachment content exists and has expected size
if (pdfAttachment?.content) {
  expect(pdfAttachment.content.length).toBe(pdfAttachment.size);
}
```

### Testing with Jest

```javascript
describe('Email Flow', () => {
  let client, inbox;

  beforeEach(async () => {
    client = new VaultSandboxClient({ url, apiKey });
    inbox = await client.createInbox();
  });

  afterEach(async () => {
    await inbox?.delete();
  });

  test('should receive welcome email', async () => {
    await sendWelcomeEmail(inbox.emailAddress);

    const email = await inbox.waitForEmail({
      timeout: 5000,
      subject: /Welcome/,
    });

    expect(email.from).toBe('noreply@example.com');
    expect(email.text).toContain('Thank you for signing up');
  });
});
```

### Waiting for Multiple Emails

When testing scenarios that send multiple emails, use `waitForEmailCount()` instead of arbitrary timeouts for faster and more reliable tests:

```javascript
test('should receive multiple notification emails', async () => {
  // Send multiple emails
  await sendNotifications(inbox.emailAddress, 3);

  // Wait for all 3 emails to arrive (polls every 1s by default)
  await inbox.waitForEmailCount(3, { timeout: 30000 });

  // Now list and verify all emails
  const emails = await inbox.listEmails();
  expect(emails.length).toBe(3);
  expect(emails[0].subject).toContain('Notification');
});
```

### Real-time Monitoring

For scenarios where you need to process emails as they arrive without blocking, you can use the `onNewEmail` subscription.

```javascript
import { VaultSandboxClient } from '@vaultsandbox/client';

const client = new VaultSandboxClient({ url, apiKey });
const inbox = await client.createInbox();

console.log(`Watching for emails at: ${inbox.emailAddress}`);

// Subscribe to new emails
const subscription = inbox.onNewEmail((email) => {
  console.log(`New email received: "${email.subject}"`);
  // Process the email here...
});

// To stop listening for emails later:
// subscription.unsubscribe();
```

## API Reference

### VaultSandboxClient

The main client class for interacting with the VaultSandbox Gateway.

#### Constructor

```typescript
new VaultSandboxClient(config: ClientConfig)
```

**ClientConfig:**

- `url: string` - Gateway URL
- `apiKey: string` - Your API key
- `strategy?: 'sse' | 'polling' | 'auto'` - Delivery strategy (default: 'auto')
- `pollingInterval?: number` - Polling interval in ms (default: 2000)
- `maxRetries?: number` - Max retry attempts for HTTP requests (default: 3)
- `retryDelay?: number` - Delay in ms between retry attempts (default: 1000)
- `retryOn?: number[]` - HTTP status codes that trigger a retry (default: [408, 429, 500, 502, 503, 504])
- `sseReconnectInterval?: number` - Initial delay in ms before SSE reconnection (default: 5000)
- `sseMaxReconnectAttempts?: number` - Max SSE reconnection attempts (default: 10)

#### Methods

- `createInbox(options?: CreateInboxOptions): Promise<Inbox>` - Creates a new inbox
- `deleteAllInboxes(): Promise<number>` - Deletes all inboxes for this API key
- `getServerInfo(): Promise<ServerInfo>` - Gets server information
- `checkKey(): Promise<boolean>` - Validates API key
- `monitorInboxes(inboxes: Inbox[]): InboxMonitor` - Monitors multiple inboxes and emits an `email` event when a new email arrives in any of them. Returns a monitor with an `unsubscribe()` method.
- `exportInbox(inboxOrEmail: Inbox | string): ExportedInboxData` - Exports an inbox's data for backup or sharing
- `importInbox(data: ExportedInboxData): Promise<Inbox>` - Imports an inbox from exported data
- `exportInboxToFile(inboxOrEmail: Inbox | string, filePath: string): void` - Exports an inbox to a JSON file
- `importInboxFromFile(filePath: string): Promise<Inbox>` - Imports an inbox from a JSON file
- `close(): Promise<void>` - Closes the client, terminates any active SSE or polling connections, and cleans up resources.

**Inbox Import/Export:** For advanced use cases like test reproducibility or sharing inboxes between environments, you can export an inbox (including its encryption keys) to a JSON file and import it later. This allows you to persist inboxes across test runs or share them with other tools.

**Testing with an Exported File:**
A manual test script is available at `tests/manual/check-inbox.manual-test.ts` to quickly test importing an inbox from a file and monitoring for new emails.

1.  **Export Inbox:** From the VaultSandbox Web UI, export your inbox to a JSON file.
2.  **Place File:** Create a `tmp` directory at the root of this project and place the exported file there (e.g., `tmp/my-inbox.json`).
3.  **Update Script:** Open `tests/manual/check-inbox.manual-test.ts` and change the `jsonPath` variable to point to your file.
4.  **Run Test:** Execute the script using `tsx`:
    ```bash
    npx tsx tests/manual/check-inbox.manual-test.ts
    ```
    The script will import the inbox and print a message whenever a new email is received.

### InboxMonitor

An event emitter for monitoring multiple inboxes simultaneously. Returned by `VaultSandboxClient.monitorInboxes()`.

#### Events

- `email(inbox: Inbox, email: Email)` - Emitted when a new email arrives in any monitored inbox

#### Methods

- `on(event: 'email', listener: (inbox: Inbox, email: Email) => void): this` - Subscribe to email events
- `unsubscribe(): void` - Unsubscribe from all inboxes and stop monitoring

#### Example

```typescript
const inbox1 = await client.createInbox();
const inbox2 = await client.createInbox();

const monitor = client.monitorInboxes([inbox1, inbox2]);

console.log(`Monitoring inboxes: ${inbox1.emailAddress}, ${inbox2.emailAddress}`);

monitor.on('email', (inbox, email) => {
  console.log(`New email in ${inbox.emailAddress}: ${email.subject}`);
  // Further processing...
});

// Later, to stop monitoring all inboxes:
// monitor.unsubscribe();
```

### Inbox

Represents a single email inbox.

#### Properties

- `emailAddress: string` - The inbox email address
- `inboxHash: string` - Unique inbox identifier
- `expiresAt: Date` - When the inbox expires

#### Methods

- `listEmails(): Promise<Email[]>` - Lists all emails (decrypted)
- `getEmail(emailId: string): Promise<Email>` - Gets a specific email
- `waitForEmail(options: WaitOptions): Promise<Email>` - Waits for an email matching criteria
- `waitForEmailCount(count: number, options?: WaitForCountOptions): Promise<void>` - Waits until the inbox has at least the specified number of emails. More efficient than using arbitrary timeouts in tests.
- `onNewEmail(callback: (email: Email) => void): Subscription` - Subscribes to new emails in real-time. Returns a subscription with an `unsubscribe()` method.
- `getSyncStatus(): Promise<SyncStatus>` - Gets inbox sync status
- `getRawEmail(emailId: string): Promise<RawEmail>` - Gets the raw, decrypted source of a specific email.
- `markEmailAsRead(emailId: string): Promise<void>` - Marks email as read
- `deleteEmail(emailId: string): Promise<void>` - Deletes an email
- `delete(): Promise<void>` - Deletes this inbox
- `export(): ExportedInboxData` - Exports inbox data and key material for backup/sharing (treat output as sensitive)

### Email

Represents a decrypted email.

#### Properties

- `id: string` - Email ID
- `from: string` - Sender address
- `to: string[]` - Recipient addresses
- `subject: string` - Email subject
- `text: string | null` - Plain text content
- `html: string | null` - HTML content
- `receivedAt: Date` - When the email was received
- `isRead: boolean` - Read status
- `links: string[]` - Extracted URLs from email
- `headers: Record<string, unknown>` - All email headers
- `attachments: AttachmentData[]` - Email attachments
- `authResults: AuthResults` - Email authentication results
- `metadata: Record<string, unknown>` - Other metadata associated with the email

#### Methods

- `markAsRead(): Promise<void>` - Marks this email as read
- `delete(): Promise<void>` - Deletes this email
- `getRaw(): Promise<RawEmail>` - Gets raw email source

### AuthResults

Returned by `email.authResults`, this object contains email authentication results (SPF, DKIM, DMARC) and a validation helper.

#### Properties

- `spf?: SPFResult` - SPF result
- `dkim?: DKIMResult[]` - All DKIM results
- `dmarc?: DMARCResult` - DMARC result
- `reverseDns?: ReverseDNSResult` - Reverse DNS result

#### Methods

- `validate(): AuthValidation` - Validates all authentication results and returns a summary object with `passed`, per-check booleans (`spfPassed`, `dkimPassed`, `dmarcPassed`, `reverseDnsPassed`), and a list of `failures`.

### CreateInboxOptions

Options for creating an inbox with `client.createInbox()`.

**Properties:**

- `ttl?: number` - Time-to-live for the inbox in seconds (default: server-defined).
- `emailAddress?: string` - A specific email address to request (e.g., `test@inbox.vaultsandbox.com`). If unavailable, the server will generate one.

### WaitOptions

Options for waiting for emails with `inbox.waitForEmail()`.

**Properties:**

- `timeout?: number` - Maximum time to wait in milliseconds (default: 30000)
- `pollInterval?: number` - Polling interval in milliseconds (default: 2000)
- `subject?: string | RegExp` - Filter emails by subject
- `from?: string | RegExp` - Filter emails by sender address
- `predicate?: (email: Email) => boolean` - Custom filter function

**Example:**

```typescript
// Wait for email with specific subject
const email = await inbox.waitForEmail({
  timeout: 10000,
  subject: /Password Reset/,
});

// Wait with custom predicate
const email = await inbox.waitForEmail({
  timeout: 15000,
  predicate: (email) => email.to.includes('user@example.com'),
});
```

### WaitForCountOptions

Options for waiting for a specific number of emails with `inbox.waitForEmailCount()`.

**Properties:**

- `timeout?: number` - Maximum time to wait in milliseconds (default: 30000)
- `pollInterval?: number` - Polling interval in milliseconds (default: 1000)

**Example:**

```typescript
// Trigger multiple emails
await sendMultipleNotifications(inbox.emailAddress);

// Wait for all 3 to arrive
await inbox.waitForEmailCount(3, { timeout: 30000 });

const emails = await inbox.listEmails();
expect(emails.length).toBe(3);
```

## Error Handling

The SDK is designed to be resilient and provide clear feedback when issues occur. It includes automatic retries for transient network and server errors, and throws specific, catchable errors for different failure scenarios.

All custom errors thrown by the SDK extend from the base `VaultSandboxError` class, so you can catch all SDK-specific errors with a single `catch` block if needed.

### Automatic Retries

By default, the client automatically retries failed HTTP requests that result in one of the following status codes: `408`, `429`, `500`, `502`, `503`, `504`. This helps mitigate transient network or server-side issues.

The retry behavior can be configured via the `VaultSandboxClient` constructor:

- `maxRetries`: The maximum number of retry attempts (default: `3`).
- `retryDelay`: The base delay in milliseconds between retries (default: `1000`). The delay uses exponential backoff.
- `retryOn`: An array of HTTP status codes that should trigger a retry.

### Custom Error Types

The following custom error classes may be thrown:

- **`ApiError`**: Thrown for API-level errors (e.g., invalid request, permission denied). Includes a `statusCode` property.
- **`NetworkError`**: Thrown when there is a network-level failure (e.g., the client cannot connect to the server).
- **`TimeoutError`**: Thrown by methods like `waitForEmail` and `waitForEmailCount` when the timeout is reached before the condition is met.
- **`InboxNotFoundError`**: Thrown when an operation targets an inbox that does not exist (HTTP 404).
- **`EmailNotFoundError`**: Thrown when an operation targets an email that does not exist (HTTP 404).
- **`InboxAlreadyExistsError`**: Thrown when attempting to import an inbox that already exists in the client.
- **`InvalidImportDataError`**: Thrown when imported inbox data fails validation (missing fields, invalid keys, server mismatch, etc.).
- **`DecryptionError`**: Thrown if the client fails to decrypt an email. This is rare and may indicate data corruption or a bug.
- **`SignatureVerificationError`**: Thrown if the cryptographic signature of a message from the server cannot be verified. This is a critical error that may indicate a man-in-the-middle (MITM) attack.
- **`SSEError`**: Thrown for errors related to the Server-Sent Events (SSE) connection.

### Example

You can use a `try...catch` block to handle errors and use `instanceof` to check for specific error types.

```javascript
import { VaultSandboxClient, ApiError, TimeoutError, VaultSandboxError } from '@vaultsandbox/client';

const client = new VaultSandboxClient({ url, apiKey });

try {
  const inbox = await client.createInbox();
  console.log(`Send email to: ${inbox.emailAddress}`);

  // This might throw a TimeoutError
  const email = await inbox.waitForEmail({ timeout: 5000 });

  console.log('Email received:', email.subject);
  await inbox.delete();
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error('Timed out waiting for email:', error.message);
  } else if (error instanceof ApiError) {
    console.error(`API Error (${error.statusCode}):`, error.message);
  } else if (error instanceof VaultSandboxError) {
    // Catch any other SDK-specific error
    console.error('An unexpected SDK error occurred:', error.message);
  } else {
    // Handle other unexpected errors
    console.error('An unexpected error occurred:', error);
  }
}
```

## Requirements

- Node.js >= 20.0.0 (tested on Node 20 and 22; ES2022 target)
- Not supported in browsers/edge runtimes
- VaultSandbox Gateway server
- Valid API key

## Testing

```bash
# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:cov
```

## Building

```bash
# Build TypeScript
npm run build

# Clean build artifacts
npm run clean
```

## Architecture

The SDK is built on several layers:

1. **Crypto Layer**: Handles ML-KEM-768 keypair generation, AES-256-GCM encryption/decryption, and ML-DSA-65 signature verification
2. **HTTP Layer**: REST API client with automatic retry and error handling
3. **Domain Layer**: Email, Inbox, and Client classes with intuitive APIs
4. **Strategy Layer**: SSE and polling strategies for email delivery

All cryptographic operations are performed transparently - developers never need to handle keys, encryption, or signatures directly.

## Security

- Cryptography: ML-KEM-768 (Kyber768) for key encapsulation + AES-256-GCM for payload encryption, with HKDF-SHA-512 key derivation.
- Signatures: ML-DSA-65 (Dilithium3) signatures are verified **before** any decryption using the gateway-provided transcript context (`vaultsandbox:email:v1` today).
- Threat model: protects confidentiality/integrity of gateway responses and detects tampering/mitm. Skipping signature verification defeats these guarantees.
- Key handling: inbox keypairs stay in memory only; exported inbox data contains secrets and must be treated as sensitive.
- Validation: signature verification failures throw `SignatureVerificationError`; decryption issues throw `DecryptionError`. Always surface these in logs/alerts for investigation.

## Related

- [VaultSandbox Gateway](https://github.com/vaultsandbox/gateway) — The self-hosted SMTP server this SDK connects to
- [VaultSandbox Documentation](https://vaultsandbox.dev) — Full documentation and guides

## Support

- [Documentation](https://vaultsandbox.dev/client-node/installation)
- [Issue Tracker](https://github.com/vaultsandbox/client-node/issues)
- [Discussions](https://github.com/vaultsandbox/client-node/discussions)
- [Website](https://www.vaultsandbox.com)

## Contributing

Contributions are welcome! Please read our [contributing guidelines](CONTRIBUTING.md) before submitting PRs.

## License

MIT — see [LICENSE](LICENSE) for details.
