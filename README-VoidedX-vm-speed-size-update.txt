VoidedX custom engine and vault-size update

This is the complete VoidedX project with the existing vault recovery and staff panel work, plus the custom obfuscation engine and vault-size fixes.

Changes in this update
- Fast, Low, and Medium use one wrapper layer; High uses two and Absolute uses three.
- Auto uses High only for scripts under 16 KiB; larger scripts use one-layer Medium.
- The engine caps nesting at three layers.
- Source is LZSS-compressed, encrypted per segment with an LCG-derived keystream, and encoded with a per-layer shuffled base64url alphabet. Decoder names are randomized.
- The runtime shield verifies Adler32 before execution and, in tamper mode, a weighted checksum plus captured hook references.
- The wrapper compiles as a small chunk and avoids `#` on executor-provided values, so it stays below Luau's 255-register limit.
- Browser and admin vault saves use a 920 KiB serialized-document budget, leaving headroom below Firestore's 1 MiB document limit.
- If a generated copy cannot fit in a vault, the save is stopped and the generated copy remains available to download in the preview panel.
- Obfuscation profile version 9 marks old saved copies, including Prometheus-generated ones, for rebuild with the current engine.

Files changed for this update
- lua-vault.js
- lua-vault-worker.js
- lua-medium.js
- script.js
- admin.js
- index.html
- admin.html
- i18n.js
- api/_route-admin-vaults.js

The speed changes have not been benchmarked here. Test generated scripts in a private vault before replacing a live script; stronger settings change transformation settings and some scripts may behave differently.
