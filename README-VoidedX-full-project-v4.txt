VoidedX Obfuscator — Full project update

This project keeps the product name VoidedX Obfuscator. The site language control supports English and Português (Brasil).

Obfuscation and vault size
- The script is compiled to register bytecode; the delivered file contains an encrypted program blob and a bundled interpreter, not the original source text or a loadstring of it.
- Fast and Low use one encryption layer; Medium uses one layer plus decoy functions; High and Absolute use two layers with more checks and debug-hook detection.
- Auto uses High for scripts under 16 KiB and Medium for larger scripts.
- The program blob is LZSS-compressed, encrypted with layered LCG-derived masks, split into independently encoded segments, and checked with Adler32 plus a weighted checksum before parsing.
- Vault saves use a 920 KiB serialized-document budget. If an output does not fit, the save is stopped and the generated copy remains downloadable.
- Obfuscation profile version 10 causes older saved copies, including wrapper-engine and Prometheus-generated ones, to be regenerated with the current engine.

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
