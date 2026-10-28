VoidedX Prometheus fork and vault-size update

This is the complete VoidedX project with the existing vault recovery and staff panel work, plus the restored Prometheus fork and vault-size fixes.

Changes in this update
- Vault protection uses the bundled Prometheus fork again; the custom VoidedX bytecode VM has been removed.
- Fork output is repacked in the VoidedX armor container (lua-voidedx-armor.js): disguised watermark, renamed internals, decoys, LZSS compression, layered masks, shuffled segments, and a randomized loader with integrity checks.
- Fast uses the Weak preset; Low and Medium use Medium; High and Absolute use Strong. Fast, Low, and Medium use one VM layer; High and Absolute use two, and Absolute adds tamper checking and extra string splitting. Low, Medium, High, and Absolute each apply a progressively heavier armor pass.
- Auto uses High only for scripts under 16 KiB; larger scripts use Low.
- The page rewrites bare `#` length operators in the generated decoder to a safe helper so executors that return userdata objects do not crash.
- Browser and admin vault saves use a 920 KiB serialized-document budget, leaving headroom below Firestore's 1 MiB document limit.
- If a generated copy cannot fit in a vault, the save is stopped and the generated copy remains available to download in the preview panel.
- Obfuscation profile version 13 marks the hardened container. Low and above add string encryption and anti-tamper inside the VM, the armor uses more mask passes and segments, and High/Absolute add a second guard; older copies (profiles 10-12) are rebuilt with the current engine.
- Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus. See LICENSE-PROMETHEUS.txt.

Files changed for this update
- prometheus-engine/ (restored prebuilt assets)
- LICENSE-PROMETHEUS.txt
- lua-voidedx-armor.js (new)
- lua-medium.js
- lua-vault.js (removed)
- lua-vault-worker.js (removed)
- lua-vm-parser.js (removed)
- lua-vm-compiler.js (removed)
- lua-vm-codec.js (removed)
- lua-vm-engine.js (removed)
- script.js
- admin.js
- index.html
- admin.html
- obfuscation.html
- i18n.js
- api/_route-admin-vaults.js

Obfuscation speed has not been benchmarked here. Test generated scripts in a private vault before replacing a live script; stronger settings change transformation settings and some scripts may behave differently.
