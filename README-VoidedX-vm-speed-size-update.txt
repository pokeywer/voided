VoidedX VM speed and vault-size update

This is the complete VoidedX project with the existing vault recovery and staff panel work, plus the current VM tuning and vault-size fixes.

Changes in this update
- Fast, Low, and Medium use one VM layer; High and Absolute use two.
- Auto uses High only for scripts under 16 KiB; larger scripts use one-layer Medium.
- The runner caps VM nesting at two layers.
- Larger string chunks reduce repeated runtime concatenation: Strong uses up to 8 characters, Medium 10, Weak 12, and the extra-splitting option 4. Fast skips source string splitting.
- Browser and admin vault saves use a 920 KiB serialized-document budget, leaving headroom below Firestore's 1 MiB document limit.
- If a generated copy cannot fit in a vault, the save is stopped and the generated copy remains available to download in the preview panel.
- Obfuscation profile version 8 marks old saved copies for rebuild with the current settings.

Files changed for this update
- lua-medium.js
- script.js
- admin.js
- index.html
- admin.html
- i18n.js
- api/_route-admin-vaults.js
- prometheus-engine/assets/prometheusRunner-Bwu6uzyd.js

The runtime-speed changes have not been benchmarked here. Test generated scripts in a private vault before replacing a live script; these modes change transformation settings and some scripts may behave differently.
