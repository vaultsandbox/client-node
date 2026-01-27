/**
 * Unit tests for Email class and AuthResults class.
 * Covers constructor variations, instance methods, and auth validation.
 */

import { Email } from '../src/email';
import type {
  EmailData,
  DecryptedMetadata,
  DecryptedParsed,
  Keypair,
  AuthResultsData,
  SpamAnalysisResult,
} from '../src/types/index';
import type { ApiClient } from '../src/http/api-client';
import * as decryptModule from '../src/crypto/decrypt';

// Mock the decrypt module
jest.mock('../src/crypto/decrypt');

describe('Email', () => {
  const mockKeypair: Keypair = {
    publicKey: new Uint8Array(1184),
    secretKey: new Uint8Array(2400),
    publicKeyB64: 'test-pk',
  };

  const mockEmailData: EmailData = {
    id: 'email-123',
    inboxId: 'inbox-456',
    receivedAt: '2024-01-01T12:00:00Z',
    isRead: false,
    encryptedMetadata: {
      v: 1,
      ct_kem: 'ct',
      nonce: 'nonce',
      aad: 'aad',
      ciphertext: 'cipher',
      sig: 'sig',
      server_sig_pk: 'pk',
      algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
    },
  };

  const mockMetadata: DecryptedMetadata = {
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    subject: 'Test Subject',
    receivedAt: '2024-01-02T12:00:00Z',
  };

  const mockParsed: DecryptedParsed = {
    text: 'Test body text',
    html: '<p>Test body HTML</p>',
    headers: { 'content-type': 'text/plain' },
    attachments: [{ filename: 'test.txt', contentType: 'text/plain', size: 100 }],
    links: ['https://example.com'],
    authResults: {
      spf: { result: 'pass', domain: 'example.com' },
      dkim: [{ result: 'pass', domain: 'example.com' }],
      dmarc: { result: 'pass', policy: 'reject' },
      reverseDns: { result: 'pass', hostname: 'mail.example.com' },
    },
  };

  const mockApiClient = {
    markEmailAsRead: jest.fn().mockResolvedValue(undefined),
    deleteEmail: jest.fn().mockResolvedValue(undefined),
    getRawEmail: jest.fn().mockResolvedValue({
      id: 'email-123',
      encryptedRaw: {
        v: 1,
        ct_kem: 'ct',
        nonce: 'nonce',
        aad: 'aad',
        ciphertext: 'cipher',
        sig: 'sig',
        server_sig_pk: 'pk',
        algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
      },
    }),
  } as unknown as ApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    (decryptModule.decryptRaw as jest.Mock).mockResolvedValue('raw email content');
  });

  describe('constructor', () => {
    it('should create email with full parsed content', () => {
      const email = new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, mockKeypair);

      expect(email.id).toBe('email-123');
      expect(email.from).toBe('sender@example.com');
      expect(email.to).toEqual(['recipient@example.com']);
      expect(email.subject).toBe('Test Subject');
      expect(email.isRead).toBe(false);
      expect(email.text).toBe('Test body text');
      expect(email.html).toBe('<p>Test body HTML</p>');
      expect(email.headers).toEqual({ 'content-type': 'text/plain' });
      expect(email.attachments).toHaveLength(1);
      expect(email.links).toEqual(['https://example.com']);
      expect(email.authResults).toBeDefined();
    });

    it('should create email with null parsed content (metadata only)', () => {
      const email = new Email(mockEmailData, mockMetadata, null, 'test@example.com', mockApiClient, mockKeypair);

      expect(email.id).toBe('email-123');
      expect(email.from).toBe('sender@example.com');
      expect(email.subject).toBe('Test Subject');
      expect(email.text).toBeNull();
      expect(email.html).toBeNull();
      expect(email.headers).toEqual({});
      expect(email.attachments).toEqual([]);
      expect(email.links).toEqual([]);
      expect(email.authResults).toBeDefined();
    });

    it('should handle to field as string instead of array', () => {
      const metadataWithStringTo = {
        ...mockMetadata,
        to: 'single@example.com' as unknown as string[],
      };
      const email = new Email(
        mockEmailData,
        metadataWithStringTo,
        mockParsed,
        'test@example.com',
        mockApiClient,
        mockKeypair,
      );

      expect(email.to).toEqual(['single@example.com']);
    });

    it('should use receivedAt from emailData when not in metadata', () => {
      const metadataWithoutReceivedAt = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
      };
      const email = new Email(
        mockEmailData,
        metadataWithoutReceivedAt,
        mockParsed,
        'test@example.com',
        mockApiClient,
        mockKeypair,
      );

      expect(email.receivedAt).toBeInstanceOf(Date);
    });

    it('should use Date.now() when receivedAt is missing from both metadata and emailData', () => {
      const metadataWithoutReceivedAt = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
      };
      const emailDataWithoutReceivedAt = {
        id: 'email-123',
        inboxId: 'inbox-456',
        isRead: false,
        encryptedMetadata: mockEmailData.encryptedMetadata,
      };
      const beforeTime = Date.now();
      const email = new Email(
        emailDataWithoutReceivedAt as EmailData,
        metadataWithoutReceivedAt,
        mockParsed,
        'test@example.com',
        mockApiClient,
        mockKeypair,
      );
      const afterTime = Date.now();

      expect(email.receivedAt).toBeInstanceOf(Date);
      expect(email.receivedAt.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(email.receivedAt.getTime()).toBeLessThanOrEqual(afterTime);
    });

    it('should handle parsed content without optional fields', () => {
      const minimalParsed: DecryptedParsed = {
        text: 'body',
        html: null,
        headers: {},
        attachments: [],
      };
      const email = new Email(
        mockEmailData,
        mockMetadata,
        minimalParsed,
        'test@example.com',
        mockApiClient,
        mockKeypair,
      );

      expect(email.attachments).toEqual([]);
      expect(email.links).toEqual([]);
      expect(email.authResults).toBeDefined();
    });

    it('should default attachments and links to empty arrays when undefined', () => {
      const parsedWithUndefinedOptionals = {
        text: 'body',
        html: null,
        headers: {},
      } as DecryptedParsed;
      const email = new Email(
        mockEmailData,
        mockMetadata,
        parsedWithUndefinedOptionals,
        'test@example.com',
        mockApiClient,
        mockKeypair,
      );

      expect(email.attachments).toEqual([]);
      expect(email.links).toEqual([]);
    });
  });

  describe('markAsRead', () => {
    it('should call API and update isRead property', async () => {
      const email = new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, mockKeypair);

      expect(email.isRead).toBe(false);

      await email.markAsRead();

      expect(mockApiClient.markEmailAsRead).toHaveBeenCalledWith('test@example.com', 'email-123');
      expect(email.isRead).toBe(true);
    });
  });

  describe('delete', () => {
    it('should call API to delete email', async () => {
      const email = new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, mockKeypair);

      await email.delete();

      expect(mockApiClient.deleteEmail).toHaveBeenCalledWith('test@example.com', 'email-123');
    });
  });

  describe('getRaw', () => {
    it('should fetch and decrypt raw email content', async () => {
      const email = new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, mockKeypair);

      const rawEmail = await email.getRaw();

      expect(mockApiClient.getRawEmail).toHaveBeenCalledWith('test@example.com', 'email-123');
      expect(decryptModule.decryptRaw).toHaveBeenCalled();
      expect(rawEmail.id).toBe('email-123');
      expect(rawEmail.raw).toBe('raw email content');
    });

    it('should throw DecryptionError when keypair is null for encrypted raw email', async () => {
      // Create email without keypair (null)
      const email = new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, null);

      // mockApiClient.getRawEmail returns encryptedRaw by default (set up in the mock)
      await expect(email.getRaw()).rejects.toThrow(
        'Cannot decrypt raw email: no keypair available for test@example.com',
      );
    });
  });
});

describe('AuthResults', () => {
  // Access AuthResults through Email since it's not exported
  function createEmailWithAuthResults(authResultsData: AuthResultsData) {
    const mockKeypair: Keypair = {
      publicKey: new Uint8Array(1184),
      secretKey: new Uint8Array(2400),
      publicKeyB64: 'test-pk',
    };

    const mockEmailData: EmailData = {
      id: 'email-123',
      inboxId: 'inbox-456',
      receivedAt: '2024-01-01T12:00:00Z',
      isRead: false,
      encryptedMetadata: {
        v: 1,
        ct_kem: 'ct',
        nonce: 'nonce',
        aad: 'aad',
        ciphertext: 'cipher',
        sig: 'sig',
        server_sig_pk: 'pk',
        algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
      },
    };

    const mockMetadata: DecryptedMetadata = {
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
    };

    const mockParsed: DecryptedParsed = {
      text: 'body',
      html: null,
      headers: {},
      attachments: [],
      authResults: authResultsData,
    };

    const mockApiClient = {} as ApiClient;

    return new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, mockKeypair);
  }

  describe('validate', () => {
    it('should return all passed when all auth checks pass', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'pass' },
        reverseDns: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.passed).toBe(true);
      expect(validation.spfPassed).toBe(true);
      expect(validation.dkimPassed).toBe(true);
      expect(validation.dmarcPassed).toBe(true);
      expect(validation.reverseDnsPassed).toBe(true);
      expect(validation.failures).toHaveLength(0);
    });

    it('should report SPF failure with domain', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'fail', domain: 'example.com' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.spfPassed).toBe(false);
      expect(validation.failures).toContain('SPF check failed: fail (domain: example.com)');
    });

    it('should report SPF failure without domain', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'softfail' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.spfPassed).toBe(false);
      expect(validation.failures).toContain('SPF check failed: softfail');
    });

    it('should report DKIM failure with domains', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [
          { result: 'fail', domain: 'domain1.com' },
          { result: 'fail', domain: 'domain2.com' },
        ],
        dmarc: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.dkimPassed).toBe(false);
      expect(validation.failures.some((f) => f.includes('DKIM signature failed: domain1.com, domain2.com'))).toBe(true);
    });

    it('should report DKIM failure without domains', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [{ result: 'fail' }],
        dmarc: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.dkimPassed).toBe(false);
      expect(validation.failures).toContain('DKIM signature failed');
    });

    it('should pass DKIM if at least one signature passes', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [
          { result: 'fail', domain: 'domain1.com' },
          { result: 'pass', domain: 'domain2.com' },
        ],
        dmarc: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.dkimPassed).toBe(true);
    });

    it('should report DMARC failure with policy', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'fail', policy: 'reject' },
      });

      const validation = email.authResults.validate();

      expect(validation.dmarcPassed).toBe(false);
      expect(validation.failures).toContain('DMARC policy: fail (policy: reject)');
    });

    it('should report DMARC failure without policy', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'none' },
      });

      const validation = email.authResults.validate();

      expect(validation.dmarcPassed).toBe(false);
      expect(validation.failures).toContain('DMARC policy: none');
    });

    it('should report reverse DNS failure with hostname', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'pass' },
        reverseDns: { result: 'fail', hostname: 'suspicious.host' },
      });

      const validation = email.authResults.validate();

      expect(validation.reverseDnsPassed).toBe(false);
      expect(validation.failures).toContain('Reverse DNS check failed (hostname: suspicious.host)');
    });

    it('should report reverse DNS failure without hostname', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [{ result: 'pass' }],
        dmarc: { result: 'pass' },
        reverseDns: { result: 'fail' },
      });

      const validation = email.authResults.validate();

      expect(validation.reverseDnsPassed).toBe(false);
      expect(validation.failures).toContain('Reverse DNS check failed');
    });

    it('should handle empty auth results', () => {
      const email = createEmailWithAuthResults({});

      const validation = email.authResults.validate();

      expect(validation.spfPassed).toBe(false);
      expect(validation.dkimPassed).toBe(false);
      expect(validation.dmarcPassed).toBe(false);
      expect(validation.reverseDnsPassed).toBe(false);
      expect(validation.failures).toHaveLength(0);
    });

    it('should handle empty DKIM array', () => {
      const email = createEmailWithAuthResults({
        spf: { result: 'pass' },
        dkim: [],
        dmarc: { result: 'pass' },
      });

      const validation = email.authResults.validate();

      expect(validation.dkimPassed).toBe(false);
      expect(validation.failures.filter((f) => f.includes('DKIM'))).toHaveLength(0);
    });
  });
});

describe('SpamAnalysis', () => {
  // Helper to create email with spam analysis data
  function createEmailWithSpamAnalysis(spamAnalysis?: SpamAnalysisResult) {
    const mockKeypair: Keypair = {
      publicKey: new Uint8Array(1184),
      secretKey: new Uint8Array(2400),
      publicKeyB64: 'test-pk',
    };

    const mockEmailData: EmailData = {
      id: 'email-123',
      inboxId: 'inbox-456',
      receivedAt: '2024-01-01T12:00:00Z',
      isRead: false,
      encryptedMetadata: {
        v: 1,
        ct_kem: 'ct',
        nonce: 'nonce',
        aad: 'aad',
        ciphertext: 'cipher',
        sig: 'sig',
        server_sig_pk: 'pk',
        algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
      },
    };

    const mockMetadata: DecryptedMetadata = {
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
    };

    const mockParsed: DecryptedParsed = {
      text: 'body',
      html: null,
      headers: {},
      attachments: [],
      spamAnalysis,
    };

    const mockApiClient = {} as ApiClient;

    return new Email(mockEmailData, mockMetadata, mockParsed, 'test@example.com', mockApiClient, mockKeypair);
  }

  describe('isSpam', () => {
    it('should return null when spamAnalysis is undefined', () => {
      const email = createEmailWithSpamAnalysis(undefined);
      expect(email.isSpam()).toBeNull();
    });

    it('should return null when status is skipped', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'skipped',
        info: 'Spam analysis disabled',
      });
      expect(email.isSpam()).toBeNull();
    });

    it('should return null when status is error', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'error',
        info: 'Rspamd timeout',
        processingTimeMs: 5000,
      });
      expect(email.isSpam()).toBeNull();
    });

    it('should return true when isSpam is true', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'analyzed',
        score: 12.5,
        requiredScore: 6.0,
        action: 'reject',
        isSpam: true,
        symbols: [{ name: 'RCVD_IN_SBL', score: 6.5 }],
        processingTimeMs: 45,
      });
      expect(email.isSpam()).toBe(true);
    });

    it('should return false when isSpam is false', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'analyzed',
        score: 2.3,
        requiredScore: 6.0,
        action: 'no action',
        isSpam: false,
        symbols: [{ name: 'DKIM_SIGNED', score: -0.1 }],
        processingTimeMs: 32,
      });
      expect(email.isSpam()).toBe(false);
    });

    it('should return false when isSpam is undefined but status is analyzed', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'analyzed',
        score: 1.0,
        requiredScore: 6.0,
        action: 'no action',
        processingTimeMs: 25,
      });
      expect(email.isSpam()).toBe(false);
    });
  });

  describe('getSpamScore', () => {
    it('should return null when spamAnalysis is undefined', () => {
      const email = createEmailWithSpamAnalysis(undefined);
      expect(email.getSpamScore()).toBeNull();
    });

    it('should return null when status is skipped', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'skipped',
        info: 'Spam analysis disabled',
      });
      expect(email.getSpamScore()).toBeNull();
    });

    it('should return null when status is error', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'error',
        info: 'Connection refused',
      });
      expect(email.getSpamScore()).toBeNull();
    });

    it('should return the score when status is analyzed', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'analyzed',
        score: 4.7,
        requiredScore: 6.0,
        action: 'add header',
        isSpam: false,
        processingTimeMs: 50,
      });
      expect(email.getSpamScore()).toBe(4.7);
    });

    it('should return negative scores correctly', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'analyzed',
        score: -2.5,
        requiredScore: 6.0,
        action: 'no action',
        isSpam: false,
        symbols: [
          { name: 'DKIM_SIGNED', score: -0.1 },
          { name: 'SPF_ALLOW', score: -0.2 },
          { name: 'RCVD_IN_DNSWL_HI', score: -7.5 },
        ],
        processingTimeMs: 40,
      });
      expect(email.getSpamScore()).toBe(-2.5);
    });

    it('should return null when score is undefined but status is analyzed', () => {
      const email = createEmailWithSpamAnalysis({
        status: 'analyzed',
        action: 'no action',
        isSpam: false,
        processingTimeMs: 30,
      });
      expect(email.getSpamScore()).toBeNull();
    });
  });

  describe('spamAnalysis property', () => {
    it('should expose full spam analysis data', () => {
      const spamAnalysis: SpamAnalysisResult = {
        status: 'analyzed',
        score: 8.2,
        requiredScore: 6.0,
        action: 'reject',
        isSpam: true,
        symbols: [
          { name: 'FORGED_SENDER', score: 3.0, description: 'Sender appears forged' },
          { name: 'SUSPICIOUS_URL', score: 2.5, options: ['http://malicious.example'] },
        ],
        processingTimeMs: 67,
      };

      const email = createEmailWithSpamAnalysis(spamAnalysis);

      expect(email.spamAnalysis).toEqual(spamAnalysis);
      expect(email.spamAnalysis?.symbols).toHaveLength(2);
      expect(email.spamAnalysis?.symbols?.[0].name).toBe('FORGED_SENDER');
      expect(email.spamAnalysis?.symbols?.[1].options).toContain('http://malicious.example');
    });

    it('should be undefined when created with null parsed content', () => {
      const mockKeypair: Keypair = {
        publicKey: new Uint8Array(1184),
        secretKey: new Uint8Array(2400),
        publicKeyB64: 'test-pk',
      };

      const mockEmailData: EmailData = {
        id: 'email-123',
        inboxId: 'inbox-456',
        receivedAt: '2024-01-01T12:00:00Z',
        isRead: false,
        encryptedMetadata: {
          v: 1,
          ct_kem: 'ct',
          nonce: 'nonce',
          aad: 'aad',
          ciphertext: 'cipher',
          sig: 'sig',
          server_sig_pk: 'pk',
          algs: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', aead: 'AES-256-GCM', kdf: 'HKDF-SHA-512' },
        },
      };

      const mockMetadata: DecryptedMetadata = {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
      };

      const mockApiClient = {} as ApiClient;

      const email = new Email(mockEmailData, mockMetadata, null, 'test@example.com', mockApiClient, mockKeypair);

      expect(email.spamAnalysis).toBeUndefined();
      expect(email.isSpam()).toBeNull();
      expect(email.getSpamScore()).toBeNull();
    });
  });
});
