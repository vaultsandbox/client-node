# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.5] - 2026-01-19

### Added

- Spam analysis support (Rspamd integration)
- Inbox creation option to enable/disable spam analysis
- Server capability detection for spam analysis

## [0.8.0] - 2026-01-16

### Added

- Webhooks support for inbox

## [0.7.0] - 2026-01-13

### Added

- Optional encryption support with `encryptionPolicy` option
- Optional email authentication feature

### Changed

- Updated ReverseDNS structure
- License changed from MIT to Apache 2.0

## [0.6.1] - 2026-01-11

### Changed

- **BREAKING**: Removed `auto` strategy; default is now `sse`
- Optimized inbox sync to reduce redundant operations
- SSE strategy bug fix and optimization

### Added

- Full test coverage

## [0.6.0] - 2026-01-04

### Changed

- `listEmails()` now fetches full email content in a single API call (eliminates N+1 queries)
- **BREAKING**: Export format now uses base64url encoding instead of base64 for keys
- **BREAKING**: Renamed `secretKeyB64` to `secretKey` in `ExportedInboxData`
- **BREAKING**: Removed `publicKeyB64` from export format; public key is now derived from secret key on import
- Added `version` field to `ExportedInboxData` (currently version 1)
- Public key derivation now uses correct offset (1152) within ML-KEM-768 secret key
- Stricter base64url validation rejects forbidden characters (+, /, =)
- Renamed `MLDSA65_PUBLIC_KEY_SIZE` to `MLDSA_PUBLIC_KEY_SIZE` for consistency

### Added

- `listEmailsMetadataOnly()` method for lightweight email listing without content
- `IEmailMetadata` type for metadata-only email responses
- `deleteInbox(emailAddress)` method for deleting a specific inbox by email address
- Protocol version and algorithm suite validation during decryption
- Export format version validation on import
- Email address validation (must contain exactly one @)
- Inbox hash validation
- Server public key size validation (1952 bytes for ML-DSA-65)
- Comprehensive cryptographic size constants for ML-KEM-768, ML-DSA-65, and AES-256-GCM
- `EXPORT_VERSION` and `PROTOCOL_VERSION` constants

## [0.5.1] - 2025-12-31

### Changed

- Standardized email authentication result structs to match wire format and other SDKs

### Added

- End-to-end integration tests for email authentication results using the test email API

## [0.5.0] - 2025-12-08

### Initial release

- Quantum-safe email testing SDK with ML-KEM-768 encryption
- Automatic keypair generation and management
- Support for both polling and real-time (SSE) email delivery
- Full email content access including attachments and headers
- Built-in SPF/DKIM/DMARC authentication validation
- TypeScript support with comprehensive type definitions
- Inbox import/export functionality for test reproducibility
- Comprehensive error handling with automatic retries
