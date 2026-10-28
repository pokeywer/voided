(() => {
    'use strict';

    const body = document.body;
    if (!body || body.dataset.vxShell === 'off') return;
    body.classList.add('vx-app');

    const PAGE_TITLES = {
        '/': 'Dashboard',
        '/index.html': 'Dashboard',
        '/scripts': 'Script library',
        '/scripts.html': 'Script library',
        '/leaderboard': 'Leaderboard',
        '/leaderboard.html': 'Leaderboard',
        '/panel.html': 'Creator panel',
        '/staff.html': 'Staff panel',
        '/keysystem.html': 'Key system',
        '/key.html': 'Get key',
        '/vault.html': 'Script vault',
        '/obfuscation': 'Obfuscator',
        '/obfuscation.html': 'Obfuscator',
        '/admin.html': 'Admin',
        '/discord.html': 'Discord control'
    };

    const path = location.pathname || '/';
    const isBuilder = !!document.getElementById('vx-dashboard') && !!document.getElementById('vx-editor');
    const isPublic = body.dataset.vxRail === 'public';
    const isAdmin = body.dataset.vxRail === 'admin';

    const GROUPS = [
        {
            label: 'Overview',
            items: [
                { label: 'Dashboard', href: '/', icon: 'fa-table-cells-large', view: 'dashboard' },
                { label: 'Leaderboard', href: '/leaderboard', icon: 'fa-ranking-star' }
            ]
        },
        {
            label: 'Build',
            items: [
                { label: 'Script editor', href: '/', icon: 'fa-code', view: 'editor' },
                { label: 'Community scripts', href: '/scripts', icon: 'fa-compass' },
                { label: 'Obfuscator', href: '/obfuscation', icon: 'fa-wand-magic-sparkles' }
            ]
        },
        {
            label: 'Manage',
            items: [
                { label: 'Creator panel', href: '/panel.html', icon: 'fa-shield-halved' },
                { label: 'Staff panel', href: '/staff.html', icon: 'fa-user-shield' }
            ]
        }
    ];
    const PUBLIC_GROUP = [
        {
            label: 'Explore',
            items: [
                { label: 'Create a vault', href: '/', icon: 'fa-plus' },
                { label: 'Script library', href: '/scripts', icon: 'fa-compass' },
                { label: 'Leaderboard', href: '/leaderboard', icon: 'fa-ranking-star' }
            ]
        }
    ];
    const ADMIN_GROUP = [
        {
            label: 'Admin',
            items: [
                { label: 'Admin panel', href: '/admin.html', icon: 'fa-user-gear' },
                { label: 'Discord control', href: '/discord.html', icon: 'fa-comments' }
            ]
        }
    ];

    const groups = isPublic ? PUBLIC_GROUP : (isAdmin ? GROUPS.concat(ADMIN_GROUP) : GROUPS);

    function navKey(href) {
        let p = String(href || '/').split('?')[0];
        if (p.length > 1) p = p.replace(/\/index\.html$/, '/').replace(/\/$/, '');
        return p
            .replace(/^\/scripts\.html$/, '/scripts')
            .replace(/^\/leaderboard\.html$/, '/leaderboard')
            .replace(/^\/obfuscation\.html$/, '/obfuscation')
            .replace(/^\/index\.html$/, '/');
    }

    const currentKey = navKey(path);
    const title = PAGE_TITLES[path] || PAGE_TITLES[currentKey] || 'VoidedX';

    /* ---------------- Rail ---------------- */
    const rail = document.createElement('aside');
    rail.className = 'vx-rail';
    rail.setAttribute('aria-label', 'Main navigation');
    rail.innerHTML = `
        <a class="vx-rail-brand" href="/">
            <img src="/logo.png" alt="">
            <div><strong>VOIDEDX</strong><small>SCRIPT VAULT</small></div>
        </a>
        <button type="button" class="vx-rail-close" aria-label="Close navigation"><i class="fa-solid fa-xmark"></i></button>
        <div class="vx-rail-scroll"></div>
        <div class="vx-rail-footer">
            <button type="button" class="vx-rail-share" id="vx-share-btn"><i class="fa-solid fa-arrow-up-from-bracket"></i> <span>Share VoidedX</span></button>
            <div class="vx-rail-meta"><span>FREE VAULT</span><span>PROFILE 14</span></div>
        </div>
    `;
    const railScroll = rail.querySelector('.vx-rail-scroll');
    groups.forEach(group => {
        const section = document.createElement('div');
        section.className = 'vx-rail-group';
        const label = document.createElement('div');
        label.className = 'vx-rail-label';
        label.textContent = group.label;
        section.appendChild(label);
        group.items.forEach(item => {
            const a = document.createElement('a');
            a.className = 'vx-rail-link';
            a.href = item.href;
            a.dataset.vxKey = navKey(item.href);
            if (item.view) a.dataset.vxView = item.view;
            a.innerHTML = `<i class="fa-solid ${item.icon}"></i><span>${item.label}</span>`;
            section.appendChild(a);
        });
        railScroll.appendChild(section);
    });

    const scrim = document.createElement('div');
    scrim.className = 'vx-rail-scrim';
    body.append(rail, scrim);

    /* ---------------- Topbar ---------------- */
    const header = document.querySelector('.top-nav, .admin-topbar, .creator-panel-nav, .dc-topbar');
    if (header) {
        header.classList.add('vx-topbar');
        const lead = document.createElement('div');
        lead.className = 'vx-topbar-lead';
        lead.innerHTML = `
            <button type="button" class="vx-menu-btn" aria-label="Open navigation" aria-expanded="false">
                <i class="fa-solid fa-bars-staggered"></i>
            </button>
            <div class="vx-crumb"><span>VoidedX</span><i class="fa-solid fa-angle-right"></i><strong>${title}</strong></div>
        `;
        header.prepend(lead);
    }

    const menuBtn = header ? header.querySelector('.vx-menu-btn') : null;
    function setRailOpen(open) {
        body.classList.toggle('vx-rail-open', open);
        if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
    }
    if (menuBtn) menuBtn.addEventListener('click', () => setRailOpen(!body.classList.contains('vx-rail-open')));
    const railClose = rail.querySelector('.vx-rail-close');
    if (railClose) railClose.addEventListener('click', () => setRailOpen(false));
    scrim.addEventListener('click', () => setRailOpen(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && body.classList.contains('vx-rail-open')) setRailOpen(false);
    });
    window.addEventListener('resize', () => {
        if (window.innerWidth > 1080 && body.classList.contains('vx-rail-open')) setRailOpen(false);
    });

    /* ---------------- View switching (builder page) ---------------- */
    const dash = document.getElementById('vx-dashboard');
    const editor = document.getElementById('vx-editor');

    function currentView() {
        if (!dash || !editor) return null;
        return editor.classList.contains('hidden') ? 'dashboard' : 'editor';
    }

    function setActiveState() {
        const view = currentView();
        rail.querySelectorAll('.vx-rail-link').forEach(link => {
            const key = link.dataset.vxKey;
            const linkView = link.dataset.vxView;
            let active;
            if (linkView) {
                active = isBuilder ? view === linkView : (linkView === 'dashboard' && currentKey === '/');
            } else {
                active = key === currentKey;
                if (isBuilder && currentKey === '/' && linkView) active = false;
            }
            link.classList.toggle('active', active);
        });
    }

    function showView(view) {
        if (!dash || !editor) {
            if (view === 'editor') {
                const target = document.querySelector('.vx-rail-link[data-vx-view="editor"]');
                if (target) location.href = target.href;
            }
            return;
        }
        dash.classList.toggle('hidden', view !== 'dashboard');
        editor.classList.toggle('hidden', view !== 'editor');
        body.dataset.vxView = view;
        const crumb = document.querySelector('.vx-crumb strong');
        if (crumb) crumb.textContent = view === 'editor' ? 'Script editor' : title;
        const workspace = document.querySelector('.workspace');
        if (workspace) workspace.scrollTop = 0;
        setActiveState();
    }

    rail.querySelectorAll('.vx-rail-link').forEach(link => {
        link.addEventListener('click', event => {
            setRailOpen(false);
            if (!isBuilder || !link.dataset.vxView) return;
            event.preventDefault();
            showView(link.dataset.vxView);
        });
    });

    const dashNewVault = document.getElementById('dash-new-vault');
    if (dashNewVault) {
        dashNewVault.addEventListener('click', () => {
            showView('editor');
            const newVaultBtn = document.getElementById('new-vault-btn');
            if (newVaultBtn) newVaultBtn.click();
        });
    }
    ['dash-open-editor', 'dash-open-library'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => showView('editor'));
    });

    /* ---------------- Share ---------------- */
    const shareBtn = document.getElementById('vx-share-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', async () => {
            const url = location.origin + '/';
            const label = shareBtn.querySelector('span');
            try {
                if (navigator.share) {
                    await navigator.share({ title: 'VoidedX Script Vault', text: 'Free Roblox script hosting with a key system.', url });
                    return;
                }
                await navigator.clipboard.writeText(url);
                if (label) {
                    label.textContent = 'Link copied';
                    setTimeout(() => { label.textContent = 'Share VoidedX'; }, 1800);
                }
            } catch (_) { /* Share cancelled or unavailable. */ }
        });
    }

    window.vxShell = { showView, currentView, setActiveState, navKey };
    setActiveState();
})();
