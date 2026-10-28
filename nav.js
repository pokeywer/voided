/* Shared mobile navigation: one labelled menu built from the page's header controls. */
(() => {
    const MOBILE_QUERY = '(max-width: 860px)';
    const header = document.querySelector('.top-nav, .creator-panel-nav');
    if (!header) return;

    const SITE_LINKS = [
        { href: '/', icon: 'fa-house', label: 'Home' },
        { href: '/scripts', icon: 'fa-compass', label: 'Script library' },
        { href: '/leaderboard', icon: 'fa-trophy', label: 'Leaderboard' },
        { href: '/panel.html', icon: 'fa-shield-halved', label: 'Creator panel' },
        { href: '/obfuscation', icon: 'fa-code', label: 'Obfuscator' }
    ];

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-menu-toggle';
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<i class="fa-solid fa-bars" aria-hidden="true"></i><span>Menu</span>';

    const drawer = document.createElement('div');
    drawer.className = 'nav-drawer';
    drawer.hidden = true;
    drawer.innerHTML = `
        <div class="nav-drawer-backdrop" data-nav-close></div>
        <div class="nav-drawer-panel" role="dialog" aria-modal="true" aria-label="Site menu">
            <div class="nav-drawer-head">
                <a class="nav-drawer-brand" href="/">
                    <img src="/logo.png" alt="VoidedX">
                    <span>VOIDEDX</span>
                </a>
                <button type="button" class="nav-drawer-close" data-nav-close aria-label="Close menu"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </div>
            <div class="nav-drawer-body">
                <nav class="nav-drawer-group" aria-label="Site pages">
                    <span class="nav-drawer-section-label">Pages</span>
                    <div class="nav-drawer-site"></div>
                </nav>
                <nav class="nav-drawer-group nav-drawer-page-group hidden" aria-label="Page actions">
                    <span class="nav-drawer-section-label">This page</span>
                    <div class="nav-drawer-page"></div>
                </nav>
                <div class="nav-drawer-extra"></div>
            </div>
        </div>`;

    header.appendChild(toggle);
    document.body.appendChild(drawer);

    const siteEl = drawer.querySelector('.nav-drawer-site');
    const pageEl = drawer.querySelector('.nav-drawer-page');
    const pageGroup = drawer.querySelector('.nav-drawer-page-group');
    const extraEl = drawer.querySelector('.nav-drawer-extra');
    let mobile = false;
    let lastFocus = null;
    let renderQueued = false;

    function normalizePath(href) {
        try {
            const url = new URL(href, window.location.origin);
            return url.pathname.replace(/index\.html$/, '').replace(/\.html$/, '').replace(/\/$/, '') || '/';
        } catch {
            return '';
        }
    }

    const currentPath = () => normalizePath(window.location.pathname);
    const labelOf = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const iconOf = el => {
        const icon = el.querySelector('i');
        return icon ? icon.className : '';
    };
    const isHidden = el => el.hidden || el.classList.contains('hidden') || el.style.display === 'none';

    function makeRow(tag, iconClass, label) {
        const row = document.createElement(tag);
        row.className = 'nav-drawer-row';
        if (iconClass) {
            const icon = document.createElement('i');
            icon.className = iconClass;
            icon.setAttribute('aria-hidden', 'true');
            row.appendChild(icon);
        }
        const text = document.createElement('span');
        text.textContent = label;
        row.appendChild(text);
        return row;
    }

    function renderSite() {
        const here = currentPath();
        siteEl.replaceChildren();
        SITE_LINKS.forEach(link => {
            if (normalizePath(link.href) === here) return;
            const row = makeRow('a', `fa-solid ${link.icon}`, link.label);
            row.href = link.href;
            const chevron = document.createElement('i');
            chevron.className = 'fa-solid fa-chevron-right nav-drawer-chevron';
            chevron.setAttribute('aria-hidden', 'true');
            row.appendChild(chevron);
            siteEl.appendChild(row);
        });
        siteEl.closest('.nav-drawer-group').hidden = siteEl.children.length === 0;
    }

    function renderPageControls() {
        const here = currentPath();
        const seenPaths = new Set(SITE_LINKS.map(link => normalizePath(link.href)));
        const seenLabels = new Set();
        pageEl.replaceChildren();
        header.querySelectorAll('a[href], button, .user-badge').forEach(el => {
            if (el === toggle || el.closest('.brand-unit') || el.closest('.nav-menu-toggle')) return;
            if (isHidden(el)) return;
            const label = labelOf(el);
            if (!label) return;

            if (el.matches('a[href]')) {
                const path = normalizePath(el.getAttribute('href'));
                if (!path || path === here || seenPaths.has(path)) return;
                seenPaths.add(path);
                const row = makeRow('a', iconOf(el), label);
                row.href = el.getAttribute('href');
                if (el.target) row.target = el.target;
                if (el.rel) row.rel = el.rel;
                const chevron = document.createElement('i');
                chevron.className = 'fa-solid fa-chevron-right nav-drawer-chevron';
                chevron.setAttribute('aria-hidden', 'true');
                row.appendChild(chevron);
                pageEl.appendChild(row);
                return;
            }

            const key = `${el.tagName}:${el.id || label.toLowerCase()}`;
            if (seenLabels.has(key)) return;
            seenLabels.add(key);

            if (el.matches('button')) {
                const row = makeRow('button', iconOf(el), label);
                row.type = 'button';
                row.addEventListener('click', () => {
                    closeDrawer();
                    el.click();
                });
                pageEl.appendChild(row);
            } else {
                const row = makeRow('div', iconOf(el), label);
                row.classList.add('nav-drawer-static');
                pageEl.appendChild(row);
            }
        });
        pageGroup.classList.toggle('hidden', pageEl.children.length === 0);
    }

    function syncLanguage() {
        const control = header.querySelector('.site-language-control') || extraEl.querySelector('.site-language-control');
        if (!control) { extraEl.replaceChildren(); extraEl.hidden = true; return; }
        if (mobile) {
            if (control.parentElement !== extraEl) {
                control._vxHome = { parent: control.parentElement, next: control.nextSibling };
                extraEl.appendChild(control);
            }
            extraEl.hidden = false;
        } else if (control._vxHome && control.parentElement === extraEl) {
            const { parent, next } = control._vxHome;
            if (next && next.parentNode === parent) parent.insertBefore(control, next);
            else parent.appendChild(control);
            delete control._vxHome;
            extraEl.hidden = true;
        } else if (control.parentElement === extraEl) {
            extraEl.hidden = false;
        } else {
            extraEl.hidden = true;
        }
    }

    function renderDrawer() {
        renderSite();
        renderPageControls();
        syncLanguage();
    }

    function queueRender() {
        if (!mobile || renderQueued) return;
        renderQueued = true;
        window.requestAnimationFrame(() => {
            renderQueued = false;
            if (mobile) renderDrawer();
        });
    }

    function openDrawer() {
        renderDrawer();
        lastFocus = document.activeElement;
        drawer.hidden = false;
        document.body.classList.add('nav-open');
        toggle.setAttribute('aria-expanded', 'true');
        window.requestAnimationFrame(() => drawer.classList.add('open'));
        const first = drawer.querySelector('.nav-drawer-site a, .nav-drawer-page a, .nav-drawer-page button');
        if (first && window.matchMedia('(pointer: coarse)').matches === false) first.focus({ preventScroll: true });
    }

    function closeDrawer() {
        drawer.classList.remove('open');
        document.body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
        window.setTimeout(() => { if (!drawer.classList.contains('open')) drawer.hidden = true; }, 180);
        if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    }

    function syncLayout(force) {
        const next = window.matchMedia(MOBILE_QUERY).matches;
        if (next === mobile && !force) return;
        mobile = next;
        if (mobile) {
            renderDrawer();
        } else {
            closeDrawer();
            syncLanguage();
        }
    }

    toggle.addEventListener('click', () => {
        if (drawer.hidden || !drawer.classList.contains('open')) openDrawer();
        else closeDrawer();
    });

    drawer.addEventListener('click', event => {
        if (event.target.closest('[data-nav-close]')) { closeDrawer(); return; }
        if (event.target.closest('a[href]') && !event.target.closest('[target="_blank"]')) closeDrawer();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
    });

    window.addEventListener('resize', () => syncLayout(false));
    window.addEventListener('orientationchange', () => syncLayout(true));

    // Auth labels, language pickers, and page scripts update header controls
    // after load; rebuild the drawer so it never shows stale rows.
    const observer = new MutationObserver(queueRender);
    observer.observe(header, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });

    syncLayout(true);
    renderDrawer();
})();
