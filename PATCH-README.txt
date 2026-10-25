VOIDEDX PROMETHEUS LUAU OBFUSCATION IMPROVEMENTS

Vercel deployment note: API endpoints dispatch through api/[...path].js. The underscore-prefixed api/_route-*.js files are internal handlers, so the project deploys as one API function instead of exceeding the Vercel function-count limit. Existing /api/... URLs are preserved.

This integrates the Prometheus engine into VoidedX's existing Vault Protection panel. It does not include the separate Prometheus website interface.

Upload files into the matching repository paths and replace files when GitHub asks. Keep all five files in prometheus-engine/assets/ together.

The strength selector offers Auto, Low, Medium, and High in Luau mode. Auto uses High up to 64 KiB of UTF-8 source and Medium above. VM mode keeps the selected strength, optional mild watermark check, and compatible string splitting; Medium and High also keep compatible numeric transforms before Vmify. Vmify stays last because it replaces the AST. VM is experimental and may slow down or break scripts; keep a readable backup and test the generated copy privately. VM compile failures stop saving, preserving the existing vault. Source up to 128 KiB is stored as readable text in Firestore for owner audits; larger source is gzip-base64 compressed to preserve document space, not encrypted. Older plain-text and gzip-base64 records remain supported. The obfuscated execution copy remains gzip-base64 encoded in storage and is decompressed by the API for delivery. Browser previews accept source up to 4 MiB and generated output up to 32 MiB; saving source to a vault remains capped at 2 MiB. Output above 1 MiB is download-only to avoid freezing the page. Saved outputs are capped at 4 MiB, and the estimated Firestore document cap is about 870 KiB, so the document cap can be reached first. Obfuscation jobs may take several minutes. Unkeyed raw loaders fetch the generated body rather than embedding a second copy inside the bootstrap. Existing /api/raw, /api/verify, and /api/payload routes deliver it. Client code can still be captured and analyzed while running.

Prometheus documents LuaU support as basic and unfinished; some Luau-specific syntax or Roblox script patterns may still be unsupported. Keep a backup and try the output in a private test place before broad use. A saved vault document is capped at an estimated 870 KiB to leave headroom under Firestore's document-size limit.

Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus
