// The shared public key (k_public) and keys issued through the owner's custom
// gate only work while the vault's Public Key toggle is on. Turning the toggle
// off has to revoke them everywhere, not just hide the Get-Key page.

export function publicAccessEnabled(vaultData) {
    return !!(vaultData && vaultData.publicKeyConfig && vaultData.publicKeyConfig.enabled === true);
}

export function isPublicKeyEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return entry.id === 'k_public' || entry.visibility === 'public' || entry.issuedByCustomGate === true;
}

export function publicKeyDisabled(vaultData, entry) {
    return isPublicKeyEntry(entry) && !publicAccessEnabled(vaultData);
}
