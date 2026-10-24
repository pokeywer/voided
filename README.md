# VoidedX

VoidedX is a static website with Vercel serverless API routes. Deploy the repository root with the project's existing Firebase and Vercel configuration. API paths dispatch through one catch-all Vercel function to stay within Vercel Hobby's function-count limit; the underscore-prefixed files in `api/` are internal handlers and helpers, not separate routes.

## Admin setup

The admin page at `/admin.html` uses the `/api/admin-auth` route. Configure these Vercel environment variables before deployment:

- `FIREBASE_SERVICE_ACCOUNT`: the Firebase service-account JSON used by the server-side API routes.
- `ADMIN_USERNAME`: the admin sign-in name.
- `ADMIN_PASSWORD`: a private password of at least 12 bytes.
- `ADMIN_SESSION_SECRET`: a separate random secret of at least 32 bytes. Changing it signs out existing admin sessions.

Admin sessions use signed, HTTP-only, same-site cookies and expire after eight hours. Sign-in is limited to five failed attempts per network address in a 15-minute window. The client-side Firebase security rules are not part of this archive; review the rules configured in Firebase separately, especially for direct vault and key-manager writes.

The authenticated Admin dashboard includes a private vault source manager. It lists vault metadata, loads readable source only when a vault is selected, and can update its title, source, obfuscation settings, and execution copy. Admin edits are protected by the same-origin check and session cookie, and update only the chosen vault's script fields while preserving owner keys and execution counts. Saving there changes the live vault used by that vault's loader.

## Loader and key protection

The copied loader keeps the stable `loadstring(game:HttpGet(".../api/raw?id=..."))()` form and contains no token query parameter or format flag. Executor requests to `/api/raw` receive the bootstrap by default; normal browser requests are redirected to the vault page. Each `/api/raw` fetch mints a new signed 45-second loader token and masks it inside the returned `_bsdata0` bootstrap; that bootstrap rechecks the token when run. A copied bootstrap body expires, while the token-free outer URL can fetch a new bootstrap whenever the vault remains available. Owners can increment the vault version to invalidate already-issued bootstrap bodies, pause the vault to block new launches, or revoke a key to block future keyed access. Each successful `/api/verify` call also issues a cryptographically random, one-use delivery ticket; it expires after the vault's configured 20, 30, 45, or 60 seconds (45 by default) and `/api/payload` consumes it once while rechecking the vault, key, player binding, ban, IP-lock state, and pause status. Keyed verification limits can be set to 5, 10, 20, 30, or 50 checks per network in 15 minutes (30 by default); the counter includes successful checks. Pausing does not stop a script that has already been downloaded and is running. Newly generated keys use 16 cryptographically random characters; existing keys continue to work.

Generated bootstrap loaders use an `_bsdata0` envelope containing a per-response masked byte string and the short-lived token-check URL. The mask and token change on each fetch; copied bootstrap bodies expire after 45 seconds. The separate one-use delivery ticket changes whenever the bootstrap runs. `LOADER_TOKEN_SECRET` may be set to a random secret of at least 32 bytes; if unset, signing uses `ADMIN_SESSION_SECRET`, then `FIREBASE_SERVICE_ACCOUNT`. The token is hidden from the copied outer loadstring, but can still be recovered from the bootstrap or captured at runtime. These are access-control and obfuscation layers, not encryption or DRM. Keep secrets and private API credentials out of client scripts.

## Vault protection and obfuscation

Vault Protection offers Auto, Low, Medium, and High obfuscation strengths in Luau mode. Auto selects High up to 10,000 UTF-8 bytes and Medium above that; owners can override the selection. Every strength splits string literals using native concatenation, while High also uses Prometheus's stronger numeric representation pass. A mild watermark check is enabled by default. Optional experimental VM protection runs Prometheus's `Vmify` pass by itself, so string splitting, watermark checks, and strength-specific passes are paused while VM mode is selected. This avoids known interactions between the VM and the other Luau passes. Unsupported syntax or VM compile errors stop the save before Firestore is updated; turn VM mode off to use the regular Luau profile.

The optional **More string splitting** setting splits ordinary string literals into shorter two- or three-character chunks, while leaving literals longer than 4 KiB intact to keep large scripts manageable. It uses native Luau concatenation. The regular Luau profile skips Prometheus VM, string-encryption, and constant-array passes because they can corrupt Roblox API strings or break scripts. Vaults saved with an earlier obfuscation profile should be opened and saved again to regenerate their execution copy. Prometheus describes its Luau support as basic and unfinished; keep a backup and try generated code in a private test place before using it broadly.

Source up to 128 KiB is stored as readable text in Firestore for owner audits; larger source is gzip-base64 compressed to preserve Firestore document space. Compression is not encryption. Older plain-text and gzip-base64 records remain supported, and loading a vault decodes compressed source into the editor. The obfuscated execution copy is gzip-base64 encoded in storage and decompressed by the API for delivery. Browser previews accept source up to 4 MiB and generated output up to 32 MiB; saving source to a vault remains capped at 2 MiB. Outputs above 1 MiB are download-only so a very large string does not freeze the editor. Saved vault copies are limited to 4 MiB and each vault document is kept below an estimated 870 KiB; the combined source and execution copy can hit the document limit first. Large scripts can take several minutes to process or time out. Re-saving unchanged source with the same strength and protection settings reuses the last generated copy in that browser session.

Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus
