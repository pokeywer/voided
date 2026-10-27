export function setEmbeddedTokenLoader({ id, key = '', input, copyButton }) {
    const rawUrl = new URL('/api/raw', window.location.origin);
    rawUrl.searchParams.set('id', id);
    if (key) rawUrl.searchParams.set('key', key);

    // Keep the copied loadstring stable and token-free. /api/raw mints a fresh
    // short-lived token into its encrypted bootstrap each time this URL is fetched.
    input.value = `loadstring(game:HttpGet("${rawUrl.href}"))()`;
    if (copyButton) copyButton.disabled = !id;
    return () => {};
}
