import 'dotenv/config';
import { VaultSandboxClient } from '../../src/client.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ExportedInboxData, IEmail } from '../../src/types/index.js';

const main = async () => {
  try {
    console.log('Starting manual inbox import test...');

    // Ensure environment variables are loaded
    const url = process.env.VAULTSANDBOX_URL;
    const apiKey = process.env.VAULTSANDBOX_API_KEY;

    if (!url || !apiKey) {
      throw new Error('VAULTSANDBOX_URL and VAULTSANDBOX_API_KEY must be set in your .env file.');
    }

    const jsonPath = path.resolve(process.cwd(), 'tmp/inbox.json');
    console.log(`Reading inbox data from: ${jsonPath}`);

    const fileContent = await fs.readFile(jsonPath, 'utf-8');
    const inboxData: ExportedInboxData = JSON.parse(fileContent);

    const client = new VaultSandboxClient({
      url,
      apiKey,
    });

    console.log('Importing inbox...');
    const inbox = await client.importInbox(inboxData);
    console.log(`Inbox for ${inbox.emailAddress} imported successfully.`);

    inbox.onNewEmail((email: IEmail) => {
      console.log('---------------------------------');
      console.log('🎉 New email received! 🎉');
      console.log('---------------------------------');
      console.log('From:', email.from);
      console.log('Subject:', email.subject);
      console.log('Date:', email.receivedAt);
      console.log('Body (text):', email.text);
      console.log('---------------------------------');
    });

    console.log('Monitoring for new emails. Waiting for incoming messages...');
    console.log('Press Ctrl+C to stop the script.');
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
};

main();

// Keep the script running
const keepAlive = () => setTimeout(keepAlive, 1000 * 60 * 60);
keepAlive();
