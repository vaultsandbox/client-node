/**
 * A simple SMTP client for sending emails in integration tests.
 *
 * This helper is used to send emails to the VaultSandbox SMTP server,
 * allowing end-to-end testing of the email receiving and decryption flow.
 */
import * as net from 'net';

/**
 * Simple SMTP client for sending test emails
 * Used in integration tests to send emails to VaultSandbox inboxes
 */
export class SimpleSmtpClient {
  constructor(
    private readonly host: string = 'localhost',
    private readonly port: number = 25,
  ) {}

  /**
   * Core SMTP connection and command flow handler
   * @param from - Sender email address
   * @param to - Recipient email address
   * @param messageContent - Complete email message content (including headers and body)
   * @returns Promise that resolves when email is sent
   */
  private async sendWithSmtp(from: string, to: string, messageContent: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.port, this.host);

      const readResponse = (expectedCodes: number[], stage: string): Promise<string> => {
        return new Promise((innerResolve, innerReject) => {
          const timeout = setTimeout(() => {
            cleanup();
            innerReject(new Error(`SMTP timeout while waiting for ${stage}`));
          }, 5000);

          const cleanup = () => {
            clearTimeout(timeout);
            socket.off('data', onData);
            socket.off('error', onError);
          };

          const onError = (err: Error) => {
            cleanup();
            innerReject(new Error(`SMTP error during ${stage}: ${err.message}`));
          };

          const onData = (data: Buffer) => {
            const response = data.toString();
            const lines = response.split(/\r?\n/).filter(Boolean);
            const lastLine = lines.at(-1) ?? '';
            const code = parseInt(lastLine.slice(0, 3), 10);

            if (!expectedCodes.includes(code)) {
              cleanup();
              innerReject(new Error(`SMTP rejected ${stage}: ${lastLine || response.trim()}`));
              return;
            }

            cleanup();
            innerResolve(response);
          };

          socket.once('data', onData);
          socket.once('error', onError);
        });
      };

      const sendCommand = async (command: string, expectedCodes: number[], stage: string): Promise<void> => {
        socket.write(`${command}\r\n`);
        await readResponse(expectedCodes, stage);
      };

      socket.once('error', (err: Error) => {
        reject(new Error(`SMTP connection error: ${err.message}`));
      });

      socket.once('connect', async () => {
        try {
          await readResponse([220], 'server greeting');
          await sendCommand('EHLO test.local', [250], 'EHLO');
          await sendCommand(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
          await sendCommand(`RCPT TO:<${to}>`, [250], 'RCPT TO');
          await sendCommand('DATA', [354], 'DATA');

          socket.write(`${messageContent}\r\n`);
          await readResponse([250], 'message body');

          await sendCommand('QUIT', [221], 'QUIT');

          socket.end();
          resolve();
        } catch (error) {
          socket.end();
          reject(error);
        }
      });
    });
  }

  /**
   * Send a simple test email
   * @param from - Sender email address
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param body - Email body (plain text)
   * @returns Promise that resolves when email is sent
   */
  async sendEmail(from: string, to: string, subject: string, body: string): Promise<void> {
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      '',
      body,
      '.',
    ].join('\r\n');

    return this.sendWithSmtp(from, to, message);
  }

  /**
   * Send an email with HTML content
   */
  async sendHtmlEmail(from: string, to: string, subject: string, textBody: string, htmlBody: string): Promise<void> {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      textBody,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      htmlBody,
      '',
      `--${boundary}--`,
      '.',
    ].join('\r\n');

    return this.sendWithSmtp(from, to, message);
  }

  /**
   * Send an email with attachments
   */
  async sendEmailWithAttachments(
    from: string,
    to: string,
    subject: string,
    body: string,
    attachments: Array<{ filename: string; contentType: string; content: string | Buffer }>,
  ): Promise<void> {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const messageParts = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      body,
      '',
    ];

    // Add each attachment
    for (const attachment of attachments) {
      const contentBuffer =
        typeof attachment.content === 'string' ? Buffer.from(attachment.content) : attachment.content;
      const base64Content = contentBuffer.toString('base64');

      messageParts.push(`--${boundary}`);
      messageParts.push(`Content-Type: ${attachment.contentType}`);
      messageParts.push(`Content-Transfer-Encoding: base64`);
      messageParts.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
      messageParts.push('');
      messageParts.push(base64Content);
      messageParts.push('');
    }

    messageParts.push(`--${boundary}--`);
    messageParts.push('.');

    const message = messageParts.join('\r\n');
    return this.sendWithSmtp(from, to, message);
  }
}
