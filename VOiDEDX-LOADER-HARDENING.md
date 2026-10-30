# VoidedX loader hardening review

## Changes in this patch

- Loader tokens now use format version 2.
- Key fingerprints inside signed tokens are now HMAC-SHA256 values derived with the server-side loader secret, rather than plain SHA-256 hashes. This prevents someone who can inspect a token from checking guesses for weak keys offline without the server secret.
- Fingerprint comparisons use constant-time comparison after strict hexadecimal validation.
- Token parsing now rejects non-base64url payload/signature characters, malformed bindings, invalid version fields, unsafe timestamps, and malformed nonces.
- Added automated tests for valid tokens, vault/key/version mismatches, tampering, expiry, malformed input, and network binding.

## Compatibility

Token format version 2 intentionally rejects version 1 tickets. Loader tokens currently have a 10-second lifetime, so users should fetch a fresh loader after deployment. Stored vault data and existing key records are not migrated or changed.

Keep `LOADER_TOKEN_SECRET` stable and set it to a random value of at least 32 bytes. The existing fallback chain remains enabled in this patch to avoid unexpectedly breaking deployments that have not configured the dedicated variable yet.

## Obfuscator review (not modified)

`api/_loaderObfuscator.js` is a hand-written token lexer and global-name collector, not a scope-aware Lua parser. It can rename same-spelled identifiers without understanding lexical scope, so a local declaration can affect a same-named global reference. It also rewrites string literals and injects a decoy branch. I did not add more anti-hook, anti-dump, anti-analysis, or concealment behavior. A safe correctness rework should replace the token heuristics with a parser for the exact Lua/Luau dialect being accepted, then test transformed output against original output on a benign compatibility corpus before enabling it.

## Important limitation

Client-executed code must be present in a form the client can execute. Obfuscation and transport encryption can raise the effort required to inspect it, but cannot guarantee that a determined client operator cannot recover it. Keep truly sensitive decisions and secrets on the server.

## Test

Run `npm run test:loader-token`.
