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

This patch uses the bundled Prometheus fork locally in the browser and then repacks its output in the VoidedX armor container, so delivered copies do not carry Prometheus's recognizable layout. It does not include the separate Prometheus website interface.

Upload files into the matching repository paths and replace files when GitHub asks. The engine files must stay together:

  prometheus-engine/          (new) prebuilt Prometheus fork: worker, runner, wasm, glue
  LICENSE-PROMETHEUS.txt      (new) fork license and attribution terms
  lua-voidedx-armor.js        (new) VoidedX armor: disguise, LZSS, masks, segments, loader
  lua-medium.js               (replaced) worker wiring, timeout, length patch, armor, storage encoding
  lua-vault-worker.js         (removed) no longer used
  lua-vault.js                (removed) no longer used
  lua-vm-parser.js            (removed) no longer used
  lua-vm-compiler.js          (removed) no longer used
  lua-vm-codec.js             (removed) no longer used
  lua-vm-engine.js            (removed) no longer used

The strength selector offers Fast, Low, Medium, High, and Absolute in Luau mode. The Prometheus fork starts in a module worker and compiles the script to VM bytecode, then lua-voidedx-armor.js repacks that output: the watermark is rebuilt from split literals, helper names are renamed, decoys and opaque guards are added, and the payload is LZSS-compressed, masked in passes, split into shuffled segments, and wrapped in a randomized loader with integrity checks and a Roblox gate. Fast uses the Weak preset; Low and Medium use Medium; High and Absolute use Strong. Fast, Low, and Medium use one VM layer; High and Absolute use two. Low, Medium, High, and Absolute each apply a progressively heavier armor pass. Absolute also turns on tamper checking and extra string splitting. Auto uses High up to 16 KiB of UTF-8 source and Low above. The page rewrites bare `#` length operators in the generated decoder to a safe helper so executors that return userdata objects do not crash. Obfuscation failures stop saving and preserve the existing vault. Source up to 128 KiB is stored as readable text in Firestore for owner audits; larger source is gzip-base64 compressed to preserve document space, not encrypted. Older plain-text and gzip-base64 records remain supported. The execution copy is stored as plain text when it is ASCII and smaller than its gzip-base64 form, otherwise gzip-base64; the API decompresses base64 records for delivery. Browser previews accept source up to 4 MiB and generated output up to 32 MiB; saving source to a vault remains capped at 2 MiB. Output above 1 MiB is download-only to avoid freezing the page. Saved outputs are capped at 4 MiB, and the estimated Firestore document cap is about 870 KiB, so the document cap can be reached first. Obfuscation jobs may take several minutes; Absolute is the slowest and most fragile. Unkeyed raw loaders fetch the generated body rather than embedding a second copy inside the bootstrap. Existing /api/raw, /api/verify, and /api/payload routes deliver it. Client code can still be captured and analyzed while running.

Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus. See LICENSE-PROMETHEUS.txt.

Obfuscation profile 12 marks the armor container. Vaults saved before it, including bytecode-VM (profile 10) and unarmored Prometheus-generated execution copies (profile 11), carry an older profile number. Open and save them again to regenerate the execution copy. Keep a backup and try the output in a private test place before broad use. A saved vault document is capped at an estimated 870 KiB to leave headroom under Firestore's document-size limit.

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

The link page obfuscates in the browser with the same engine (lua-medium.js plus lua-voidedx-armor.js and the prometheus-engine assets) used by the Creator Panel, so those files must be deployed with the page.
