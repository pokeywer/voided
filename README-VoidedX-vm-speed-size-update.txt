VoidedX custom engine and vault-size update

This is the complete VoidedX project with the existing vault recovery and staff panel work, plus the bytecode-VM obfuscation engine and vault-size fixes.

Changes in this update
- Luau source is compiled to register bytecode and serialized into an encrypted program blob; the delivered file contains no source text and no loadstring of user code.
- Instructions are 8 bytes with 24-bit jump/count operands, so a single function can carry about 16.7 million instructions.
- Fast and Low use one encryption layer; High and Absolute use two and add extra integrity checks and debug-hook detection. Auto uses High only for scripts under 16 KiB; larger scripts use Medium.
- The program blob is LZSS-compressed, encrypted with layered LCG-derived additive masks, and encoded with a per-build shuffled base64url alphabet. Interpreter names and handler order are randomized.
- The runtime verifies length, Adler32, and a weighted checksum before parsing, and compares captured builtin references before decoding and before running.
- Large multi-assignments are staged through tables so they stay inside the 255-register per-function limit instead of failing to compile.
- Browser and admin vault saves use a 920 KiB serialized-document budget, leaving headroom below Firestore's 1 MiB document limit.
- If a generated copy cannot fit in a vault, the save is stopped and the generated copy remains available to download in the preview panel.
- Obfuscation profile version 10 marks old saved copies, including wrapper-engine and Prometheus-generated ones, for rebuild with the current engine.

Files changed for this update
- lua-vault.js
- lua-vault-worker.js
- lua-medium.js
- lua-vm-parser.js
- lua-vm-compiler.js
- lua-vm-codec.js
- lua-vm-engine.js
- script.js
- admin.js
- index.html
- admin.html
- obfuscation.html
- i18n.js
- api/_route-admin-vaults.js

The speed change has not been benchmarked here. Bytecode execution is slower than running the original source, so test generated scripts in a private vault before replacing a live script; stronger settings change transformation settings and some scripts may behave differently.
