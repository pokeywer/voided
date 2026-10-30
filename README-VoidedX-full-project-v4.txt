VoidedX Obfuscator — Full project update

This project keeps the product name VoidedX Obfuscator. The site language control supports English and Português (Brasil).

Obfuscation and vault size
- Vault protection uses the bundled Prometheus fork, which compiles the script to VM bytecode in a module worker, then repacks the result in the VoidedX armor container (lua-voidedx-armor.js): disguised watermark, renamed internals, decoys, LZSS compression, layered masks, shuffled segments, and a randomized loader with integrity checks.
- Fast, Low, and Medium use the Medium preset; High and Absolute use Strong. No level uses the readable Weak preset, so every copy is VM-compiled. Every level keeps one VM layer, and Absolute adds tamper checking and extra string splitting. Fast, Low, Medium, High, and Absolute each apply a progressively heavier armor pass.
- Auto uses High for scripts under 16 KiB and Low for larger scripts.
- The page patches bare `#` length operators in the generated decoder so executors that return userdata objects do not crash.
- Vault saves use a 920 KiB serialized-document budget. If an output does not fit, the save is stopped and the generated copy remains downloadable.
- Obfuscation profile version 13 marks the hardened container. Low and above add string encryption and anti-tamper inside the VM, the armor uses more mask passes and segments, and High/Absolute add a second guard; older copies (profiles 10-12) are regenerated with the current engine.
- Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus. See LICENSE-PROMETHEUS.txt.

Vault recovery
- Existing vaults are backed up before save, delete, and restore operations.
- Vault backup contents are stored in small Firestore chunk documents, avoiding the single-document size limit that could make a save fail during its backup step.
- Existing inline-format backups remain readable. Administrators can restore backups, and owners can submit restore requests.
- Backups with open restore requests are protected from cleanup until an administrator handles the request.

Staff panel
- Admins grant access to a signed-in Firebase account (email account or guest account), set its expiry, and select viewing and action permissions separately.
- Staff can review vaults and source, execution totals, announcements, ideas, restore requests, and pending community scripts according to their scopes.
- Optional staff actions include publishing or pausing announcements, triaging ideas, claiming or escalating restore requests, and approving or rejecting community submissions. Moderation changes create backups.
- Only admins can restore or decline restore requests or change staff grants. Access is rechecked by the API for each request.

The speed/size tuning has not been benchmarked in this update. Test generated scripts in a private vault before replacing a live script because transformation settings can affect runtime behavior.
