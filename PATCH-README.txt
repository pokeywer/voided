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

  lua-vault.js                (new) LZSS, keystream segments, decoder, shields
  lua-vault-worker.js         (new) browser worker entry for the engine
  lua-medium.js               (replaced) size limits, worker wiring, storage encoding

The strength selector offers Fast, Low, Medium, High, and Absolute in Luau mode. Fast, Low, and Medium use one wrapper layer; High uses two and Absolute uses three. Auto uses High up to 16 KiB of UTF-8 source and Medium above. Every level compresses the source with LZSS, encrypts each segment with its own LCG-derived keystream, uses a shuffled base64url alphabet per layer, and randomizes decoder names. Medium and above add decoy functions, and extra transforms adds more. The runtime shield is always on: Adler32 is verified before execution, and tamper mode also checks a weighted checksum and captured hook references. The wrapper compiles as a small chunk and avoids `#` on executor-provided values, so it does not hit Luau's 255-register limit or the userdata length crash. Obfuscation failures stop saving and preserve the existing vault. Source up to 128 KiB is stored as readable text in Firestore for owner audits; larger source is gzip-base64 compressed to preserve document space, not encrypted. Older plain-text and gzip-base64 records remain supported. The execution copy is stored as plain text when it is ASCII and smaller than its gzip-base64 form, otherwise gzip-base64; the API decompresses base64 records for delivery. Browser previews accept source up to 4 MiB and generated output up to 32 MiB; saving source to a vault remains capped at 2 MiB. Output above 1 MiB is download-only to avoid freezing the page. Saved outputs are capped at 4 MiB, and the estimated Firestore document cap is about 870 KiB, so the document cap can be reached first. Obfuscation jobs may take a few seconds; Absolute with several layers is the slowest. Unkeyed raw loaders fetch the generated body rather than embedding a second copy inside the bootstrap. Existing /api/raw, /api/verify, and /api/payload routes deliver it. Client code can still be captured and analyzed while running.

Vaults saved before this engine, including Prometheus-generated execution copies, carry an older obfuscation profile number. Open and save them again to regenerate the execution copy. Keep a backup and try the output in a private test place before broad use. A saved vault document is capped at an estimated 870 KiB to leave headroom under Firestore's document-size limit.
