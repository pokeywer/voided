export function setEmbeddedTokenLoader({ id, key = '', input, copyButton }) {
    const rawUrl = new URL('/api/raw', window.location.origin);
    rawUrl.searchParams.set('id', id);
    if (key) rawUrl.searchParams.set('key', key);

    // Keep the copied loadstring stable and token-free. /api/raw mints a fresh
    // short-lived token into its encrypted bootstrap each time this URL is fetched.
    // This first fetch runs in the player's executor, before any loader code can
    // guard it, so the paste itself guards it: game:HttpGet first, the generic
    // request/http_request APIs second, and a readable message instead of a bare
    // "winhttp error 12007" when the host name cannot be resolved.
    input.value = [
        `local u="${rawUrl.href}"`,
        'local s',
        'local ok,res=pcall(game.HttpGet,game,u)',
        'if ok then s=res end',
        'if type(s)~="string" then',
        'local q=request or http_request or http.request or (syn and syn.request)',
        'if q then local ok2,res2=pcall(q,{Url=u,Method="GET"}) if ok2 then s=type(res2)=="table" and (res2.Body or res2.body) or res2 end end',
        'end',
        'if type(s)~="string" then return error("[VoidedX] Could not reach the loader server. Your network or DNS blocked it (winhttp 12007). Set DNS to 1.1.1.1 or turn off your VPN, then run the loader again.",0) end',
        'return loadstring(s)()'
    ].join(' ');
    if (copyButton) copyButton.disabled = !id;
    return () => {};
}
