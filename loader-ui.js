export function setEmbeddedTokenLoader({ id, key = '', input, status, copyButton }) {
    const rawUrl = new URL('/api/raw', window.location.origin);
    rawUrl.searchParams.set('id', id);
    if (key) rawUrl.searchParams.set('key', key);

    // Keep the copied loadstring stable and token-free. /api/raw mints a fresh
    // short-lived token into its _bsdata0 response each time this URL is fetched.
    input.value = `loadstring(game:HttpGet("${rawUrl.href}"))()`;
    if (copyButton) copyButton.disabled = !id;
    if (status) status.textContent = 'The loader URL has no token. A fresh short-lived token is placed inside _bsdata0 each time it runs.';
    return () => {};
}
