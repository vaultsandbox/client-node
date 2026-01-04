import { VaultSandboxClient } from '../src/index.js';
import type { ExportedInboxData, AttachmentData } from '../src/types/index.js';

interface EmailOutput {
  id: string;
  subject: string;
  from: string;
  to: string[];
  text: string;
  html?: string;
  attachments?: AttachmentOutput[];
  receivedAt: string;
}

interface AttachmentOutput {
  filename: string;
  contentType: string;
  size: number;
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    fatal('usage: testhelper <command> [args]');
  }

  const client = new VaultSandboxClient({
    url: process.env.VAULTSANDBOX_URL!,
    apiKey: process.env.VAULTSANDBOX_API_KEY!,
  });

  try {
    switch (command) {
      case 'create-inbox':
        await createInbox(client);
        break;
      case 'import-inbox':
        await importInbox(client);
        break;
      case 'read-emails':
        await readEmails(client);
        break;
      case 'cleanup': {
        const address = process.argv[3];
        if (!address) {
          fatal('usage: testhelper cleanup <address>');
        }
        await cleanup(client, address);
        break;
      }
      default:
        fatal(`unknown command: ${command}`);
    }
  } finally {
    await client.close();
  }
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

async function createInbox(client: VaultSandboxClient): Promise<void> {
  const inbox = await client.createInbox();
  const exported = inbox.export();
  console.log(JSON.stringify(exported));
}

async function importInbox(client: VaultSandboxClient): Promise<void> {
  const input = await readStdin();
  const exportData: ExportedInboxData = JSON.parse(input);

  await client.importInbox(exportData);
  console.log(JSON.stringify({ success: true }));
}

async function readEmails(client: VaultSandboxClient): Promise<void> {
  const input = await readStdin();
  const exportData: ExportedInboxData = JSON.parse(input);

  const inbox = await client.importInbox(exportData);
  const emails = await inbox.listEmails();

  const output = {
    emails: emails.map(
      (email): EmailOutput => ({
        id: email.id,
        subject: email.subject,
        from: email.from,
        to: email.to,
        text: email.text ?? '',
        html: email.html || undefined,
        attachments: email.attachments?.map(
          (att: AttachmentData): AttachmentOutput => ({
            filename: att.filename,
            contentType: att.contentType,
            size: att.content?.length ?? att.size,
          }),
        ),
        receivedAt: email.receivedAt.toISOString(),
      }),
    ),
  };

  console.log(JSON.stringify(output));
}

async function cleanup(client: VaultSandboxClient, address: string): Promise<void> {
  await client.deleteInbox(address);
  console.log(JSON.stringify({ success: true }));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
