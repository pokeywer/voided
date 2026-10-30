export function setEmbeddedTokenLoader({ id, key = '', input, copyButton }) {
    const rawUrl = new URL('/api/raw', window.location.origin);
    rawUrl.searchParams.set('id', id);
    if (key) rawUrl.searchParams.set('key', key);
    input.value = `loadstring(game:HttpGet("${rawUrl.href}"))()`;
    if (copyButton) copyButton.disabled = !id;
    return () => {};
}
