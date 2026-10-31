# Patch: Roblox engine header enforcement

## What changed and why

`_clientGate.js` now has a **second check** after the User-Agent check.
When Roblox's `HttpService` makes a request the game *engine* automatically
injects these headers — scripts cannot override them, and nothing outside the
Roblox client can produce them:

| Header | Value |
|---|---|
| `Roblox-Session-Id` | A GUID, unique per game session |
| `Roblox-Id` / `Roblox-Place-Id` / `Roblox-Game-Id` | Numeric place/game ID |

An external fetcher can spoof the `User-Agent` in one line, but it cannot
forge these engine-injected headers. We now **require `Roblox-Session-Id`**
(GUID-shaped) to be present on every request. A missing or malformed header
blocks the request the same way a bad UA does.

Additionally, the session GUID is hashed and stored in Firestore at ticket
issuance, then compared again at payload delivery — so the bootstrap hop and
the payload hop must come from the **same Roblox game session**. An intercepted
ticket replayed from a different machine (different session GUID) is refused.

---

## Drop-in files

- `_clientGate.js`          — replace the existing file entirely
- `_route-verify.js`        — apply the two hunks below
- `_route-payload.js`       — apply the one hunk below

---

## _route-verify.js patches

### 1. Update the import at the top (add `robloxSessionBinding`)

```diff
-import { EXECUTOR_ONLY_MESSAGE, inspectFetch } from './_clientGate.js';
+import { EXECUTOR_ONLY_MESSAGE, inspectFetch, robloxSessionBinding } from './_clientGate.js';
```

### 2. Store `robloxSessionHash` alongside `bindIp` / `bindUa`
   Find the `sessionBase` object spread (two locations, both use `...requestBinding(req)`).
   Add `...robloxSessionBinding(req)` right after each one:

```diff
                 ...requestBinding(req),
+                ...robloxSessionBinding(req),
                 ...shieldFields
```

```diff
             tx.set(db.collection('loaderDeliveries').doc(shield.trace), {
                 ...
                 ...requestBinding(req),
+                ...robloxSessionBinding(req),
                 placeId,
```

---

## _route-payload.js patches

### 1. Update the import (add `robloxSessionMatches`)

```diff
-import { EXECUTOR_ONLY_MESSAGE, inspectFetch } from './_clientGate.js';
+import { EXECUTOR_ONLY_MESSAGE, inspectFetch, robloxSessionMatches } from './_clientGate.js';
```

### 2. Add Roblox session check inside `bindingMismatch`
   The existing function checks `bindIp`, `bindUa`, `placeId`.
   Add the Roblox session GUID check:

```diff
 function bindingMismatch(session, req, placeId) {
     if (process.env.DELIVERY_TICKET_BIND === '0') return false;
     if (session.bindIp && session.bindIp !== bindHash(getClientIp(req))) return true;
     if (session.bindUa && session.bindUa !== bindHash(String(req.headers['user-agent'] || '').slice(0, 200))) return true;
     if (session.placeId && String(session.placeId) !== placeId) return true;
+    if (session.robloxSessionHash && !robloxSessionMatches(req, session.robloxSessionHash)) return true;
     return false;
 }
```

---

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `LOADER_FETCH_GUARD` | `enforce` | `off` / `log` / `enforce` — unchanged |
| `LOADER_ROBLOX_HEADER_GUARD` | `enforce` | Set to `off` to disable header check only (e.g. local dev) |
| `DELIVERY_TICKET_BIND` | `1` | Set to `0` to disable ALL binding checks |

---

## Why this stops the fetcher

Before: attacker sets `User-Agent: RobloxPlayer/...` → passes every check.

After:
1. UA passes (they spoofed it) ✓
2. **`Roblox-Session-Id` header is absent** → blocked with 415 ✗

Even if they somehow faked the header on the bootstrap hop, the session GUID
hash is bound into the Firestore session. Their payload hop comes from a
different process with a different (or missing) GUID → `bindingMismatch`
returns `true` → ticket rejected with 403.
