# Security policy

## Supported versions

Security fixes land on the latest supported major release. Upgrade promptly
when a patch is released.

| Version      | Supported |
| ------------ | --------- |
| latest `1.x` | yes       |
| `0.x`        | no        |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's "Report a vulnerability" flow on the
repository's Security tab, which opens a private advisory visible only to the
maintainers. Include the affected version, a description, and a reproduction if
you have one. We aim to acknowledge a report within a few business days and to
ship a fix or a mitigation as quickly as the severity warrants.

## How the plugin handles secrets

The plugin is built so that a host never has to store a platform token as
plaintext.

- **Token encryption at rest.** OAuth refresh tokens, and any access tokens the
  plugin persists between requests, are stored as AES-256-GCM envelopes
  (`{ version, iv, ciphertext, authTag }`) on the `socials-connections` global.
  The host supplies a 32-byte key through `options.encryptionKey`. The key is
  validated at plugin-init time, so a malformed key fails the boot rather than
  the first publish. Decryption fails closed on any tag mismatch, with no
  plaintext fallback.
- **No secret logging.** The plugin's logger redacts secret-bearing keys
  (access tokens, refresh tokens, client and app secrets, the appsecret proof,
  the encryption key, private keys, authorization and cookie headers, API keys,
  and passwords) at any nesting depth, including prefixed variants, before
  anything reaches the host's logger. The plugin never writes to the console.
- **Constant-time key comparison.** The internal scheduler endpoints compare the
  pre-shared API key with `crypto.timingSafeEqual`, and the comparison is flat
  in time even for keys of different lengths.
- **OAuth state validation.** The OAuth callback verifies a state cookie minted
  by the start route, so a forged callback cannot complete a connection.
- **Webhook authentication.** Meta webhook bodies are capped at 1 MB and their
  raw bytes are authenticated with `X-Hub-Signature-256` before host code runs.
- **Remote-media boundary.** Pinterest video transfer accepts only HTTPS source
  hosts explicitly listed in `platforms.pinterest.allowedVideoHosts`, including
  every redirect target.
- **Key rotation.** A temporary `previousEncryptionKeys` ring permits old
  envelopes to be decrypted and immediately rewritten under the active key.

## What the host is responsible for

- Generating and protecting the 32-byte `encryptionKey` (for example through a
  secrets manager). During rotation, retain the old key in
  `previousEncryptionKeys` until every stored connection has been read and
  rewritten.
- Supplying an `authorize` function that correctly gates the publisher and admin
  scopes for your roles.
- Protecting the `scheduling.internalApiKey` if you use the internal endpoints,
  and serving the admin and OAuth routes over HTTPS so the state cookie is sent.
- Providing a distributed lock and request-lease implementation when global
  token rotation and quotas must span more than one process.
