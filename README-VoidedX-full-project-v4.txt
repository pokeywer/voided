VoidedX Obfuscator — Full project update

This project keeps the product name VoidedX Obfuscator. The site language control supports English and Português (Brasil).

Obfuscation and vault size
- Vault protection uses the bundled Prometheus fork, which compiles the script to VM bytecode in a module worker.
- Fast and Low use the Weak preset, Medium uses Medium, and High and Absolute use Strong. Fast, Low, and Medium use one VM layer; High and Absolute use two, and Absolute adds tamper checking and extra string splitting.
- Auto uses High for scripts under 16 KiB and Medium for larger scripts.
- The page patches bare `#` length operators in the generated decoder so executors that return userdata objects do not crash.
- Vault saves use a 920 KiB serialized-document budget. If an output does not fit, the save is stopped and the generated copy remains downloadable.
- Obfuscation profile version 11 causes older saved copies, including bytecode-VM and Prometheus-generated ones, to be regenerated with the current engine.
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
