VOIDEDX CUSTOM LUAU OBFUSCATION ENGINE

Vercel deployment note: API endpoints dispatch through api/[...path].js. The underscore-prefixed api/_route-*.js files are internal handlers, so the project deploys as one API function instead of exceeding the Vercel function-count limit. Existing /api/... URLs are preserved.

Loader anti-tamper update: this patch adds an encrypted bootstrap, split and shuffled payload delivery, runtime hook checks, a tamper-report endpoint, and per-session leak tracing. Upload or replace these files together:

  api/_loaderShield.js        (new) keystream, chunk order, CRC32, flag allowlist
  api/_loaderSource.js        (new) bootstrap packer and loader runtime source
  api/_route-integrity.js     (new) GET /api/integrity tamper reports
  api/_loaderToken.js         token binding, bootstrap seed, trace derivation
  api/_route-raw.js           encrypted bootstrap and seed-releasing gate
  api/_route-verify.js        shield state, delivery trace, report token
  api/_route-payload.js       encrypted parts, tamper block, v4 delivery
  api/[...path].js            registers the integrity route
  README.md                   updated protection notes

Flow: the outer loadstring still fetches /api/raw with no token. The response carries the inner loader only as Xorshift32 ciphertext. A separate token-check request releases the HMAC-derived seed after the token, network binding, vault version, and key checks pass, so a captured response body cannot be decrypted offline. /api/verify returns a random payload seed, a shuffled chunk order, a CRC32, and a 16-hex trace; /api/payload returns only the shuffled, encrypted chunks. Capturing either response alone is not enough. The runtime compares game.HttpGet, loadstring/load, HttpService.JSONDecode, string.char/byte/sub, table.concat, pcall, rawequal, and debug.info against references captured at start, reports swapped functions to /api/integrity, and high-confidence reports mark the one-use ticket blocked so /api/payload refuses delivery. Every payload carries a --[[vx:TRACE]] watermark; loaderDeliveries/{trace} maps it to the vault, player, key issue, and delivery IP. The fast-load plaintext cache is bypassed for shielded payloads because an on-disk plaintext copy defeats the protection. Set LOADER_TOKEN_IP_BIND=0 if legitimate executor HTTP egress IPs change between the bootstrap and gate requests; set LOADER_TOKEN_SECRET to a random value of at least 32 bytes for stable signing and seed derivation. These checks raise the cost of runtime dumping and make leaks attributable, but they are not DRM: a hook installed before the loader starts, a patched executor, or a loader modified to strip checks can still capture executed code.

This patch replaces the Prometheus engine with a custom VoidedX engine that runs locally in the browser. It does not include the separate Prometheus website interface, and the prometheus-engine/ build is no longer used.

Upload files into the matching repository paths and replace files when GitHub asks. The engine files must stay together:

  lua-vault.js                (new) thin facade over the VM engine
  lua-vault-worker.js         (new) browser worker entry for the engine
  lua-medium.js               (replaced) size limits, worker wiring, storage encoding
  lua-vm-parser.js            (new) Luau tokenizer and parser
  lua-vm-compiler.js          (new) AST to register bytecode
  lua-vm-codec.js             (new) LZSS, mask passes, base64 segments
  lua-vm-engine.js            (new) program serializer, interpreter generator, shields

The strength selector offers Fast, Low, Medium, High, and Absolute in Luau mode. The engine compiles the source to register bytecode and serializes it into a binary program blob; the delivered file contains that encrypted blob and a bundled interpreter, not the original source text. Instructions are 8 bytes with 24-bit jump and count operands. Fast and Low use one encryption layer; High and Absolute use two and add extra integrity checks and debug-hook detection. Medium and above add decoy functions, and extra transforms adds more. Auto uses High up to 16 KiB of UTF-8 source and Medium above. Every level LZSS-compresses the blob, encrypts it with layered LCG-derived additive masks, encodes it with a per-build shuffled base64url alphabet, and randomizes interpreter names and handler order. The runtime verifies length, Adler32, and a weighted checksum before parsing, and compares captured builtin references (string.byte/char/sub/len, table.concat, rawequal, and debug.gethook at High and above) before decoding and again before running. Large multi-assignments are staged through tables so they stay below Luau's 255-register per-function limit. Obfuscation failures stop saving and preserve the existing vault. Source up to 128 KiB is stored as readable text in Firestore for owner audits; larger source is gzip-base64 compressed to preserve document space, not encrypted. Older plain-text and gzip-base64 records remain supported. The execution copy is stored as plain text when it is ASCII and smaller than its gzip-base64 form, otherwise gzip-base64; the API decompresses base64 records for delivery. Browser previews accept source up to 4 MiB and generated output up to 32 MiB; saving source to a vault remains capped at 2 MiB. Output above 1 MiB is download-only to avoid freezing the page. Saved outputs are capped at 4 MiB, and the estimated Firestore document cap is about 870 KiB, so the document cap can be reached first. Obfuscation jobs may take a few seconds; Absolute is the slowest. Bytecode runs slower than the original source. Unkeyed raw loaders fetch the generated body rather than embedding a second copy inside the bootstrap. Existing /api/raw, /api/verify, and /api/payload routes deliver it. Client code can still be captured and analyzed while running.

Vaults saved before this engine, including wrapper-engine and Prometheus-generated execution copies, carry an older obfuscation profile number. Open and save them again to regenerate the execution copy. Keep a backup and try the output in a private test place before broad use. A saved vault document is capped at an estimated 870 KiB to leave headroom under Firestore's document-size limit.

DISCORD /obfuscate VOID TOKENS

/obfuscate now gives each Discord user 5 void tokens and a private link of the form https://voidedx.vercel.app/obfuscation?vx=<token>; /obfuscationvx=<token> is rewritten to the same page. Upload a .lua/.txt file or paste code in the command, or open the link and paste it there. Each successful obfuscation spends one token, and the page can also save the generated copy to a new vault.

Upload or replace these files together:

  api/_obfuscationSessions.js       (new) token creation, reuse, expiry, atomic spend
  api/_route-obfuscation-session.js (new) GET/POST /api/obfuscation-session
  api/_route-discord-interactions.js (replaced) /obfuscate creates the token link
  api/_discordConfig.js             (replaced) command description and option text
  api/[...path].js                  (replaced) registers the obfuscation-session route
  obfuscation.html                  (new) token page
  obfuscation.js                    (new) page logic, obfuscation, download, vault save
  vercel.json                       (replaced) adds the /obfuscationvx= rewrite

New Firestore collections: obfuscationSessions/{token} stores the preloaded source, level, filename, credits, and expiry; obfuscationSessionOwners/{discordUserId} points to the user's current token so a new /obfuscate reuses the link while credits remain. Tokens are 24-byte base64url values, last 7 days, and spending uses a transaction so the fifth token cannot be double-spent. A user has one active link at a time; issuing a new token deletes the previous session document. The link is bearer-style: anyone who has it can spend its remaining tokens until they run out or the session expires. Vault saving uses anonymous Firebase auth and the same record shape as the Creator Panel, including the 5-vault limit and 10-hour auto-delete, and the vault is owned by that browser session.

Discord command registration is unchanged for names and options; only the /obfuscate description and the file/code help text changed, so the existing registered command still works and re-registering is optional.

The link page obfuscates in the browser with the same engine file (lua-medium.js, lua-vault.js, lua-vault-worker.js) used by the Creator Panel, so those files must be deployed with the page.
