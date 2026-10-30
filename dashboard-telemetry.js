// Owner dashboard cards: the world reach map and the players who ran a vault.
// Network access is injected so the module can be mounted against mocks.
const MAP_URL = '/world-map.svg';
const MAX_COUNTRY_ROWS = 6;

function fallbackEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fallbackRelative(ms) {
    if (!ms) return '';
    const diff = Math.max(0, Date.now() - ms);
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function createDashboardTelemetry(options = {}) {
    const getToken = typeof options.getToken === 'function' ? options.getToken : async () => null;
    const escapeText = typeof options.escapeHtml === 'function' ? options.escapeHtml : fallbackEscape;
    const escapeAttr = fallbackEscape;
    const relativeTime = typeof options.relativeTime === 'function' ? options.relativeTime : fallbackRelative;
    const notify = typeof options.showToast === 'function' ? options.showToast : () => {};

    const els = {
        select: document.getElementById('dash-reach-vault'),
        map: document.getElementById('dash-world-map'),
        shell: document.getElementById('dash-map-shell'),
        tip: document.getElementById('dash-map-tip'),
        empty: document.getElementById('dash-map-empty'),
        summary: document.getElementById('dash-reach-summary'),
        countries: document.getElementById('dash-top-countries'),
        runners: document.getElementById('dash-runners'),
        runnersChip: document.getElementById('dash-runners-chip')
    };

    const countryNames = {};
    let vaults = [];
    let mapPromise = null;
    let data = null;
    let requestId = 0;
    let mounted = false;

    function countryName(cc) {
        return countryNames[cc] || cc;
    }

    function loadMap() {
        if (!els.map || mapPromise) return mapPromise;
        mapPromise = fetch(MAP_URL, { cache: 'force-cache' })
            .then(response => {
                if (!response.ok) throw new Error('map');
                return response.text();
            })
            .then(svg => {
                els.map.innerHTML = svg;
                els.map.querySelectorAll('path[data-cc]').forEach(path => {
                    countryNames[path.dataset.cc] = path.dataset.name || path.dataset.cc;
                });
                if (data) {
                    applyCountries();
                    renderCountries();
                }
            })
            .catch(() => {
                mapPromise = null;
            });
        return mapPromise;
    }

    function setVaults(list) {
        vaults = Array.isArray(list) ? list : [];
        if (!els.select) return;
        const previous = els.select.value;
        const rows = ['<option value="">All vaults</option>'].concat(
            vaults.map(vault => `<option value="${escapeAttr(vault.id)}">${escapeAttr(String(vault.title || 'Untitled Vault'))}</option>`)
        );
        els.select.innerHTML = rows.join('');
        els.select.value = vaults.some(vault => vault.id === previous) ? previous : '';
    }

    function applyCountries() {
        if (!els.map) return;
        const counts = new Map();
        const entries = data && Array.isArray(data.countries) ? data.countries : [];
        entries.forEach(item => {
            const cc = String(item.cc || '').toUpperCase();
            const count = Math.floor(Number(item.executions) || 0);
            if (/^[A-Z]{2}$/.test(cc) && count > 0) counts.set(cc, count);
        });
        const max = Math.max(1, ...counts.values());
        els.map.querySelectorAll('path[data-cc]').forEach(path => {
            const count = counts.get(path.dataset.cc) || 0;
            path.classList.remove('heat-1', 'heat-2', 'heat-3', 'heat-4');
            path.classList.toggle('has-runs', count > 0);
            path.dataset.runs = String(count);
            if (count > 0) {
                const level = Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
                path.classList.add(`heat-${level}`);
            }
        });
        if (els.empty) els.empty.classList.toggle('hidden', counts.size > 0);
    }

    function renderCountries() {
        if (!els.countries) return;
        const totals = data && data.totals ? data.totals : {};
        if (els.summary) {
            const parts = [];
            const executions = Math.floor(Number(totals.executions) || 0);
            const countries = Math.floor(Number(totals.countries) || 0);
            const players = Math.floor(Number(totals.players) || 0);
            if (executions) parts.push(`${executions.toLocaleString()} executions`);
            if (countries) parts.push(`${countries} ${countries === 1 ? 'country' : 'countries'}`);
            if (players) parts.push(`${players.toLocaleString()} players`);
            els.summary.textContent = parts.length ? parts.join(' · ') : '—';
        }
        const list = (data && Array.isArray(data.countries) ? data.countries : []).slice(0, MAX_COUNTRY_ROWS);
        if (!list.length) {
            els.countries.innerHTML = '<div class="vx-empty"><i class="fa-solid fa-globe"></i><span>Country totals appear once a loader is verified.</span></div>';
            return;
        }
        const max = Math.max(...list.map(item => Math.floor(Number(item.executions) || 0)), 1);
        els.countries.innerHTML = list.map(item => {
            const cc = String(item.cc || '').toUpperCase();
            const count = Math.floor(Number(item.executions) || 0);
            const width = Math.max(6, Math.round((count / max) * 100));
            return `<div class="vx-country-row">
                <div class="vx-country-bar"><span class="vx-country-fill" style="width:${width}%"></span><span class="vx-country-name"><span class="vx-country-cc">${escapeText(cc)}</span><span>${escapeText(countryName(cc))}</span></span></div>
                <span class="vx-country-value">${count.toLocaleString()}</span>
            </div>`;
        }).join('');
    }

    function renderRunners() {
        if (!els.runners) return;
        const players = data && Array.isArray(data.players) ? data.players : [];
        if (!players.length) {
            els.runners.innerHTML = '<div class="vx-empty"><i class="fa-solid fa-users"></i><span>No players recorded yet. Share a loadstring and runs will appear here.</span></div>';
            return;
        }
        els.runners.innerHTML = players.map(player => {
            const username = String(player.username || 'Unknown');
            const initial = username.trim().charAt(0).toUpperCase() || '?';
            const cc = /^[A-Z]{2}$/.test(String(player.country || '')) ? String(player.country) : '';
            const region = /^[A-Z0-9]{1,3}$/.test(String(player.region || '')) ? String(player.region) : '';
            const regionLabel = cc && region ? `${cc}-${region}` : cc;
            const executor = player.executor ? String(player.executor) : 'Unknown executor';
            const hwid = player.hwid ? String(player.hwid) : '';
            const runs = Math.floor(Number(player.runs) || 0);
            const when = relativeTime(Number(player.lastSeenAt) || 0) || '—';
            return `<div class="vx-runner">
                <span class="vx-runner-avatar">${escapeText(initial)}</span>
                <div class="vx-runner-main">
                    <div class="vx-runner-line">
                        <strong title="${escapeAttr(username)}">${escapeText(username)}</strong>
                        ${regionLabel ? `<span class="vx-runner-cc">${escapeText(regionLabel)}</span>` : ''}
                        <span class="vx-runner-runs">${runs.toLocaleString()} run${runs === 1 ? '' : 's'}</span>
                    </div>
                    <div class="vx-runner-meta">
                        <span class="vx-runner-exec" title="${escapeAttr(executor)}">${escapeText(executor)}</span>
                        <span class="sep">·</span>
                        ${hwid
                            ? `<button type="button" class="vx-runner-hwid" data-copy-hwid="${escapeAttr(hwid)}" title="Copy HWID: ${escapeAttr(hwid)}">${escapeText(hwid)}</button>`
                            : '<span class="vx-runner-hwid" title="The executor did not report a HWID">no HWID</span>'}
                    </div>
                </div>
                <span class="vx-runner-when">${escapeText(when)}</span>
            </div>`;
        }).join('');
    }

    function clear(message = '') {
        data = null;
        if (els.map) {
            els.map.querySelectorAll('path[data-cc]').forEach(path => {
                path.classList.remove('heat-1', 'heat-2', 'heat-3', 'heat-4', 'has-runs');
                path.dataset.runs = '0';
            });
        }
        if (els.empty) els.empty.classList.remove('hidden');
        if (els.summary) els.summary.textContent = message || '—';
        if (els.countries) {
            els.countries.innerHTML = `<div class="vx-empty"><i class="fa-solid fa-globe"></i><span>${escapeText(message || 'Country totals appear once a loader is verified.')}</span></div>`;
        }
        if (els.runners) {
            els.runners.innerHTML = `<div class="vx-empty"><i class="fa-solid fa-users"></i><span>${escapeText(message || 'No players recorded yet. Share a loadstring and runs will appear here.')}</span></div>`;
        }
    }

    async function refresh() {
        if (!els.map) return;
        let token = null;
        try {
            token = await getToken();
        } catch {
            token = null;
        }
        if (!token) {
            clear('Sign in to see who ran your vaults.');
            return;
        }
        const vaultId = els.select ? els.select.value : '';
        const currentRequest = ++requestId;
        if (els.runnersChip) els.runnersChip.textContent = 'LOADING';
        try {
            const url = vaultId
                ? `/api/vault-activity?id=${encodeURIComponent(vaultId)}`
                : '/api/vault-activity?all=1';
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store'
            });
            const payload = await response.json().catch(() => null);
            if (currentRequest !== requestId) return;
            if (!response.ok || !payload || !payload.ok) {
                throw new Error(payload && payload.message ? String(payload.message) : 'Could not load activity.');
            }
            data = payload;
            applyCountries();
            renderCountries();
            renderRunners();
        } catch (error) {
            if (currentRequest !== requestId) return;
            clear(error && error.message ? String(error.message) : '');
        } finally {
            if (currentRequest === requestId && els.runnersChip) {
                els.runnersChip.textContent = vaultId ? 'THIS VAULT' : 'ALL TIME';
            }
        }
    }

    function showTip(path, clientX, clientY) {
        const tip = els.tip;
        if (!tip || !path) {
            if (tip) tip.hidden = true;
            return;
        }
        const cc = path.dataset.cc;
        const runs = Math.floor(Number(path.dataset.runs) || 0);
        tip.innerHTML = `<strong>${escapeText(path.dataset.name || countryName(cc))}</strong><span>${runs.toLocaleString()} execution${runs === 1 ? '' : 's'}</span>`;
        tip.hidden = false;
        const rect = els.shell.getBoundingClientRect();
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const half = Math.min(width / 2, Math.max(12, rect.width / 2 - 2));
        const x = Math.min(Math.max(clientX - rect.left, half + 2), Math.max(half + 2, rect.width - half - 2));
        let y = clientY - rect.top;
        // The shell clips its overflow, so a tooltip anchored near the top edge
        // has to flip under the pointer instead of above it.
        const below = y - height * 1.18 < 4;
        tip.classList.toggle('is-below', below);
        if (!below) y = Math.max(y, height * 1.18 + 4);
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
    }

    function pathFromEvent(event) {
        return event.target && event.target.closest ? event.target.closest('path[data-cc]') : null;
    }

    function mount() {
        if (mounted) return;
        mounted = true;

        if (els.shell) {
            els.shell.addEventListener('pointermove', event => showTip(pathFromEvent(event), event.clientX, event.clientY));
            // Phones have no hover; a tap reads the country it landed on. The
            // tooltip is dismissed on the next scroll or a tap on the ocean.
            els.shell.addEventListener('pointerdown', event => {
                const path = pathFromEvent(event);
                if (path) showTip(path, event.clientX, event.clientY);
            });
            els.shell.addEventListener('pointerleave', () => {
                if (els.tip) els.tip.hidden = true;
            });
            window.addEventListener('scroll', () => {
                if (els.tip) els.tip.hidden = true;
            }, { passive: true });
        }

        if (els.runners) {
            els.runners.addEventListener('click', async event => {
                const button = event.target.closest('[data-copy-hwid]');
                if (!button) return;
                const value = button.dataset.copyHwid || '';
                if (!value) return;
                try {
                    await navigator.clipboard.writeText(value);
                    notify('HWID copied to clipboard.', 'success', 2200);
                } catch {
                    notify(value, 'info', 6000);
                }
            });
        }

        if (els.select) {
            els.select.addEventListener('change', () => refresh());
        }

        document.addEventListener('vx:viewchange', event => {
            if (event.detail && event.detail.view === 'dashboard') refresh();
        });

        loadMap();
    }

    return { mount, refresh, setVaults, clear };
}
