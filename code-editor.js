/* VoidedX Luau editor: syntax overlay, gutter, find/goto, indent helpers.
   Loaded on index.html before script.js; exposes window.VoidedXEditor so the
   vault code can refresh the view after it writes #source-code directly. */
(() => {
    'use strict';

    const shell = document.getElementById('vx-code-shell');
    const textarea = document.getElementById('source-code');
    if (!shell || !textarea) return;

    const stage = shell.closest('.editor-stage');
    const canvas = document.getElementById('vx-code-canvas');
    const highlightInner = document.getElementById('vx-code-highlight-inner');
    const gutterInner = document.getElementById('vx-code-gutter-inner');
    const activeLineEl = document.getElementById('vx-code-active-line');
    const fileNameEl = document.getElementById('editor-file-name');
    const titleInput = document.getElementById('script-title');
    const saveStatus = document.getElementById('editor-save-status');

    const findBar = document.getElementById('vx-find-bar');
    const findInput = document.getElementById('vx-find-input');
    const findCount = document.getElementById('vx-find-count');
    const findPrev = document.getElementById('vx-find-prev');
    const findNext = document.getElementById('vx-find-next');
    const findClose = document.getElementById('vx-find-close');
    const findIcon = document.getElementById('vx-find-icon');

    const posEl = document.getElementById('ed-stat-pos');
    const selEl = document.getElementById('ed-stat-sel');
    const selCountEl = document.getElementById('ed-stat-sel-count');
    const linesEl = document.getElementById('ed-stat-lines');
    const sizeEl = document.getElementById('ed-stat-size');
    const wrapBtn = document.getElementById('ed-wrap-btn');
    const wrapLabel = document.getElementById('ed-wrap-label');

    const fontDec = document.getElementById('ed-font-dec');
    const fontInc = document.getElementById('ed-font-inc');
    const fontLabel = document.getElementById('ed-font-size');
    const fileInput = document.getElementById('ed-file-input');
    const copyBtn = document.getElementById('ed-copy-btn');

    const mobileQuery = window.matchMedia('(max-width: 768px)');
    const MAX_HIGHLIGHT_CHARS = 140000;
    const MAX_FIND_MATCHES = 4000;
    const INDENT = '    ';
    const FONT_KEY = 'vx-editor-font-size';
    const WRAP_KEY = 'vx-editor-wrap';

    const state = {
        fontPx: 13,
        wrap: false,
        plain: false,
        lineStarts: [0],
        lhPx: 21,
        padPx: 16,
        digits: 1,
        highlighted: null,
        findMatches: [],
        findIndex: -1,
        mode: 'find',
        fileNameOverride: '',
        frame: 0,
        scrollFrame: 0,
        findTimer: 0,
        paintTimer: 0,
        scrollTimer: 0
    };

    /* ---------------- storage ---------------- */
    function readStore(key) {
        try { return window.localStorage.getItem(key); } catch (_) { return null; }
    }
    function writeStore(key, value) {
        try { window.localStorage.setItem(key, value); } catch (_) { /* ignore */ }
    }
    function clampFont(value) {
        return Math.min(22, Math.max(10, Math.round(Number(value) || 13)));
    }

    /* ---------------- Luau highlighting ---------------- */
    const KEYWORDS = new Set(('and break do else elseif end false for function if in local nil not or ' +
        'repeat return then true until while continue export type typeof').split(' '));

    const BUILTINS = new Set(('_G _VERSION game workspace script shared plugin task ' +
        'wait spawn delay tick time elapsedTime print warn error assert pcall xpcall select ' +
        'tonumber tostring type typeof unpack next pairs ipairs require loadstring rawequal rawget ' +
        'rawlen rawset setmetatable getmetatable collectgarbage newproxy gcinfo settings getgenv ' +
        'getrenv getreg getgc getloadedmodules getscripts getrunningscripts getinstances getnilinstances ' +
        'string table math os io coroutine debug utf8 bit32 buffer vector Vector3 Vector2 CFrame Color3 ' +
        'ColorSequence UDim UDim2 Enum Instance BrickColor Ray Region3 TweenInfo NumberRange NumberSequence ' +
        'Rect DateTime PhysicalProperties Random Font OverlapParams RaycastParams Path2D CatmullRomCurve3 ' +
        'RotationCurve NumberSequenceKeypoint ColorSequenceKeypoint Color3fromRGB Drawable Drawing syn ' +
        'secure_call hookfunction hookmetamethod getrawmetatable setreadonly islclosure checkcaller ' +
        'newcclosure setclipboard getconstant getupvalue setupvalue fireclickdetector firetouchinterest ' +
        'getconnections queue_on_teleport identifyexecutor request http_request getcustomasset writefile ' +
        'readfile isfile listfiles makefolder setfpscap setthreadidentity getthreadidentity gethui ' +
        'setrenderproperty cloneref compareinstances getnamecallmethod setnamecallmethod').split(' '));

    const TOKEN_RE = /--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|\[(=*)\[[\s\S]*?\]\2\]|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?|0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\.\.\.|\.\.=?|==|~=|<=|>=|\/\/|\+=|-=|\*=|\/=|%=|\^=|[\s\S]/g;

    function escapeHtml(text) {
        return text.replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
    }

    function highlight(code) {
        TOKEN_RE.lastIndex = 0;
        let out = '';
        let last = 0;
        let match;
        while ((match = TOKEN_RE.exec(code))) {
            if (match.index > last) out += escapeHtml(code.slice(last, match.index));
            last = TOKEN_RE.lastIndex;
            const token = match[0];
            let cls = '';
            if (token.charCodeAt(0) === 45 && token.charCodeAt(1) === 45) {
                cls = 'tok-com';
            } else if (match[1] !== undefined || match[2] !== undefined) {
                cls = 'tok-str';
            } else if (token.charCodeAt(0) === 34 || token.charCodeAt(0) === 39 || token.charCodeAt(0) === 96) {
                cls = 'tok-str';
            } else if (/[0-9]/.test(token.charAt(0))) {
                cls = 'tok-num';
            } else if (/[A-Za-z_]/.test(token.charAt(0))) {
                if (KEYWORDS.has(token)) cls = 'tok-kw';
                else if (BUILTINS.has(token)) cls = 'tok-bi';
                else if (/^[ \t]*\(/.test(code.slice(last, last + 40))) cls = 'tok-fn';
            } else if (!/^\s$/.test(token)) {
                cls = 'tok-op';
            }
            out += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
        }
        if (last < code.length) out += escapeHtml(code.slice(last));
        return out;
    }

    /* ---------------- layout ---------------- */
    function computePlainMode() {
        return mobileQuery.matches || state.wrap || textarea.value.length > MAX_HIGHLIGHT_CHARS;
    }

    function applyMode() {
        state.plain = computePlainMode();
        shell.classList.toggle('is-plain', state.plain);
        shell.classList.toggle('is-wrap', state.wrap || mobileQuery.matches);
        textarea.wrap = state.plain ? 'soft' : 'off';
        if (wrapLabel) wrapLabel.textContent = state.wrap ? 'Wrap on' : 'No wrap';
        if (wrapBtn) wrapBtn.classList.toggle('is-active', state.wrap);
    }

    function rebuildLineStarts() {
        const value = textarea.value;
        const starts = [0];
        for (let i = 0; i < value.length; i++) {
            if (value.charCodeAt(i) === 10) starts.push(i + 1);
        }
        state.lineStarts = starts;
    }

    function measure() {
        const cs = window.getComputedStyle(textarea);
        const lh = parseFloat(cs.lineHeight);
        state.lhPx = Number.isFinite(lh) && lh > 0 ? lh : Math.round(state.fontPx * 1.62);
        const pad = parseFloat(cs.paddingTop);
        state.padPx = Number.isFinite(pad) ? pad : 16;
    }

    function posToLine(pos) {
        const starts = state.lineStarts;
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    }

    function lineColAt(pos) {
        const line = posToLine(pos);
        return { line, col: pos - state.lineStarts[line - 1] + 1 };
    }

    function renderGutter(scrollTop) {
        if (!gutterInner || state.plain) return;
        const total = state.lineStarts.length;
        const viewH = canvas ? canvas.clientHeight : 0;
        const lh = state.lhPx;
        const visible = Math.max(1, Math.ceil(viewH / lh) + 10);
        const first = Math.max(1, Math.floor(scrollTop / lh) - 4);
        const last = Math.min(total, first + visible);
        const nums = [];
        for (let n = first; n <= last; n++) nums.push(n);
        gutterInner.textContent = nums.join('\n');
        gutterInner.style.transform = `translateY(${state.padPx + (first - 1) * lh - scrollTop}px)`;

        const digits = Math.max(2, String(total).length);
        if (digits !== state.digits) {
            state.digits = digits;
            shell.style.setProperty('--ed-gutter-w', `${Math.round(digits * state.fontPx * 0.62) + 26}px`);
        }
    }

    function positionActiveLine() {
        if (!activeLineEl || state.plain) return;
        const line = posToLine(textarea.selectionStart);
        const top = state.padPx + (line - 1) * state.lhPx - textarea.scrollTop;
        activeLineEl.style.top = `${top}px`;
        activeLineEl.hidden = top < -state.lhPx || top > textarea.clientHeight;
    }

    function syncScroll() {
        if (state.plain) return;
        if (highlightInner) {
            highlightInner.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
        }
        renderGutter(textarea.scrollTop);
        positionActiveLine();
    }

    function paint() {
        if (state.frame) cancelAnimationFrame(state.frame);
        if (state.paintTimer) window.clearTimeout(state.paintTimer);
        state.frame = 0;
        state.paintTimer = 0;
        const value = textarea.value;
        if (!state.plain && value !== state.highlighted && highlightInner) {
            highlightInner.innerHTML = highlight(value);
            state.highlighted = value;
        }
        if (state.plain) state.highlighted = null;
        renderGutter(textarea.scrollTop);
        syncScroll();
        updateStatus();
    }

    function schedulePaint() {
        if (state.frame || state.paintTimer) return;
        state.frame = requestAnimationFrame(paint);
        // Hidden/background tabs throttle rAF; a timer keeps the view in sync.
        state.paintTimer = window.setTimeout(() => {
            state.paintTimer = 0;
            paint();
        }, 200);
    }

    function scheduleScroll() {
        if (state.scrollFrame || state.scrollTimer) return;
        state.scrollFrame = requestAnimationFrame(() => {
            if (state.scrollTimer) window.clearTimeout(state.scrollTimer);
            state.scrollTimer = 0;
            state.scrollFrame = 0;
            syncScroll();
        });
        state.scrollTimer = window.setTimeout(() => {
            if (state.scrollFrame) cancelAnimationFrame(state.scrollFrame);
            state.scrollTimer = 0;
            state.scrollFrame = 0;
            syncScroll();
        }, 200);
    }

    function byteLength(text) {
        if (text.length > 400000) return text.length;
        let bytes = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code < 0x80) bytes += 1;
            else if (code < 0x800) bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
            else bytes += 3;
        }
        return bytes;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(2)} MB`;
    }

    function updateStatus() {
        const value = textarea.value;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const spot = lineColAt(start);
        if (posEl) posEl.textContent = `Ln ${spot.line}, Col ${spot.col}`;
        const selected = Math.abs(end - start);
        if (selEl) selEl.classList.toggle('hidden', selected === 0);
        if (selCountEl) selCountEl.textContent = String(selected);
        if (linesEl) linesEl.textContent = String(state.lineStarts.length);
        if (sizeEl) sizeEl.textContent = formatBytes(byteLength(value));
    }

    /* ---------------- editing helpers ---------------- */
    function replaceRange(start, end, text, selectStart, selectEnd) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(start, end);
        let done = false;
        try { done = document.execCommand('insertText', false, text); } catch (_) { done = false; }
        if (!done) {
            const value = textarea.value;
            textarea.value = value.slice(0, start) + text + value.slice(end);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (typeof selectStart === 'number') {
            textarea.setSelectionRange(selectStart, typeof selectEnd === 'number' ? selectEnd : selectStart);
        }
        schedulePaint();
    }

    function lineBoundsForSelection(start, end) {
        const value = textarea.value;
        const blockStart = value.lastIndexOf('\n', start - 1) + 1;
        const probe = end > start && value.charAt(end - 1) === '\n' ? end - 1 : end;
        let blockEnd = value.indexOf('\n', probe);
        if (blockEnd === -1) blockEnd = value.length;
        return { blockStart, blockEnd };
    }

    function indentSelection(outdent) {
        const value = textarea.value;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        if (start === end && !outdent) {
            const spot = lineColAt(start);
            const rest = INDENT.slice((spot.col - 1) % INDENT.length);
            replaceRange(start, start, rest);
            return;
        }
        const { blockStart, blockEnd } = lineBoundsForSelection(start, end);
        const block = value.slice(blockStart, blockEnd);
        let changed = false;
        const next = block.split('\n').map(line => {
            if (outdent) {
                if (line.startsWith('\t')) { changed = true; return line.slice(1); }
                const spaces = /^ {1,4}/.exec(line);
                if (spaces) { changed = true; return line.slice(spaces[0].length); }
                return line;
            }
            if (!line.length) return line;
            changed = true;
            return INDENT + line;
        }).join('\n');
        if (!changed) return;
        replaceRange(blockStart, blockEnd, next, blockStart, blockStart + next.length);
    }

    function toggleComment() {
        const value = textarea.value;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const { blockStart, blockEnd } = lineBoundsForSelection(start, end);
        const lines = value.slice(blockStart, blockEnd).split('\n');
        const meaningful = lines.filter(line => line.trim());
        if (!meaningful.length) return;
        const allCommented = meaningful.every(line => /^\s*--/.test(line));
        const next = lines.map(line => {
            if (!line.trim()) return line;
            if (allCommented) return line.replace(/^(\s*)-- ?/, '$1');
            return line.replace(/^(\s*)(.*)$/, (_, lead, rest) => `${lead}-- ${rest}`);
        }).join('\n');
        replaceRange(blockStart, blockEnd, next, blockStart, blockStart + next.length);
    }

    function autoIndentNewline() {
        const value = textarea.value;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const before = value.slice(lineStart, start);
        const indent = (/^[ \t]*/.exec(before) || [''])[0];
        const trimmed = before.trim();
        let extra = '';
        if (/(\bthen|\bdo|\belse|\brepeat)$/.test(trimmed)) extra = INDENT;
        else if (/^(local\s+)?function\b.*\)$/.test(trimmed)) extra = INDENT;
        else if (/[{\[(,]$/.test(trimmed)) extra = INDENT;
        const insert = `\n${indent}${extra}`;
        replaceRange(start, end, insert, start + insert.length, start + insert.length);
    }

    const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    const CLOSERS = new Set([')', ']', '}', '"', "'", '`']);

    function handleOpenPair(event, open) {
        const close = PAIRS[open];
        const value = textarea.value;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        if (start !== end) {
            event.preventDefault();
            const inner = value.slice(start, end);
            replaceRange(start, end, open + inner + close, start + 1, end + 1);
            return;
        }
        const nextChar = value.charAt(start);
        const prevChar = value.charAt(start - 1);
        if (open === '"' || open === "'" || open === '`') {
            const safeNext = nextChar === '' || /[\s)\]},;]/.test(nextChar);
            const safePrev = prevChar === '' || /[\s([{,;:=+\-*/%<>~]/.test(prevChar);
            if (!safeNext || !safePrev) return;
        }
        event.preventDefault();
        replaceRange(start, start, open + close, start + 1, start + 1);
    }

    /* ---------------- keyboard ---------------- */
    textarea.addEventListener('keydown', event => {
        if (event.isComposing) return;
        const mod = event.ctrlKey || event.metaKey;
        if (mod || event.altKey) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;

        if (event.key === 'Tab') {
            event.preventDefault();
            indentSelection(event.shiftKey);
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            autoIndentNewline();
            return;
        }
        if (event.key === 'Backspace' && start === end && start > 0) {
            const value = textarea.value;
            const prev = value.charAt(start - 1);
            const next = value.charAt(start);
            if (PAIRS[prev] && PAIRS[prev] === next) {
                event.preventDefault();
                replaceRange(start - 1, start + 1, '', start - 1, start - 1);
            }
            return;
        }
        if (CLOSERS.has(event.key) && start === end && textarea.value.charAt(start) === event.key) {
            event.preventDefault();
            textarea.setSelectionRange(start + 1, start + 1);
            schedulePaint();
            return;
        }
        if (PAIRS[event.key]) handleOpenPair(event, event.key);
    });

    /* ---------------- mouse + selection ---------------- */
    textarea.addEventListener('input', () => {
        rebuildLineStarts();
        state.highlighted = null;
        applyMode();
        schedulePaint();
        if (!findBar || findBar.hidden) return;
        window.clearTimeout(state.findTimer);
        state.findTimer = window.setTimeout(() => {
            if (findBar.dataset.mode === 'find' && findInput && findInput.value) {
                refreshFind(true);
            }
        }, 140);
    });

    textarea.addEventListener('scroll', scheduleScroll, { passive: true });
    textarea.addEventListener('focus', () => { shell.classList.add('has-caret'); schedulePaint(); });
    textarea.addEventListener('blur', () => shell.classList.remove('has-caret'));
    ['click', 'keyup', 'select'].forEach(evt => textarea.addEventListener(evt, schedulePaint));
    document.addEventListener('selectionchange', () => {
        if (document.activeElement === textarea) schedulePaint();
    });

    /* ---------------- find / go to ---------------- */
    function collectMatches() {
        const query = findInput ? findInput.value : '';
        const matches = [];
        if (!query) return matches;
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        let hit;
        while ((hit = pattern.exec(textarea.value)) && matches.length < MAX_FIND_MATCHES) {
            matches.push({ start: hit.index, end: hit.index + hit[0].length });
            if (hit.index === pattern.lastIndex) pattern.lastIndex += 1;
        }
        return matches;
    }

    function updateFindCount() {
        if (!findCount) return;
        const total = state.findMatches.length;
        findCount.textContent = `${total ? state.findIndex + 1 : 0} / ${total}`;
        if (findInput) findInput.classList.toggle('is-empty', !!findInput.value && total === 0);
    }

    function revealMatch(index) {
        const match = state.findMatches[index];
        if (!match) return;
        textarea.setSelectionRange(match.start, match.end);
        const line = posToLine(match.start);
        const top = state.padPx + (line - 1) * state.lhPx;
        const viewH = textarea.clientHeight;
        if (top < textarea.scrollTop + state.lhPx) {
            textarea.scrollTop = Math.max(0, top - state.lhPx * 2);
        } else if (top > textarea.scrollTop + viewH - state.lhPx * 2) {
            textarea.scrollTop = Math.max(0, top - viewH + state.lhPx * 3);
        }
        syncScroll();
        positionActiveLine();
        updateStatus();
        updateFindCount();
    }

    function refreshFind(keepIndex) {
        if (!findInput) return;
        const anchor = keepIndex && state.findMatches[state.findIndex]
            ? state.findMatches[state.findIndex].start
            : textarea.selectionStart;
        state.findMatches = collectMatches();
        if (!state.findMatches.length) {
            state.findIndex = -1;
            updateFindCount();
            return;
        }
        let index = state.findMatches.findIndex(match => match.start >= anchor);
        if (index === -1) index = 0;
        state.findIndex = index;
        revealMatch(index);
    }

    function stepMatch(direction) {
        if (!state.findMatches.length) {
            refreshFind(false);
            return;
        }
        state.findIndex = (state.findIndex + direction + state.findMatches.length) % state.findMatches.length;
        revealMatch(state.findIndex);
    }

    function openBar(mode) {
        if (!findBar || !findInput) return;
        state.mode = mode;
        findBar.dataset.mode = mode;
        const goto = mode === 'goto';
        findBar.hidden = false;
        requestAnimationFrame(() => findBar.classList.add('is-open'));
        if (findIcon) findIcon.className = goto ? 'fa-solid fa-arrow-right-to-line' : 'fa-solid fa-magnifying-glass';
        findInput.placeholder = goto ? 'Line number' : 'Find in script';
        findInput.setAttribute('aria-label', goto ? 'Go to line' : 'Find in script');
        if (findCount) findCount.style.display = goto ? 'none' : '';
        if (findPrev) findPrev.style.display = goto ? 'none' : '';
        if (findNext) findNext.style.display = goto ? 'none' : '';
        if (!goto && !findInput.value) {
            const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
            if (selected && !selected.includes('\n') && selected.length <= 80) findInput.value = selected;
        }
        if (goto) findInput.value = '';
        window.setTimeout(() => {
            findInput.focus({ preventScroll: true });
            findInput.select();
        }, 20);
        if (!goto && findInput.value) refreshFind(false);
        else updateFindCount();
    }

    function closeBar(focusEditor = true) {
        if (!findBar) return;
        findBar.classList.remove('is-open');
        const bar = findBar;
        window.setTimeout(() => { if (!bar.classList.contains('is-open')) bar.hidden = true; }, 160);
        if (focusEditor) textarea.focus({ preventScroll: true });
    }

    function jumpToLine() {
        const raw = parseInt(findInput.value.trim(), 10);
        if (!Number.isFinite(raw)) { findInput.select(); return; }
        const line = Math.min(Math.max(1, raw), state.lineStarts.length);
        const pos = line === state.lineStarts.length && textarea.value.endsWith('\n')
            ? textarea.value.length
            : state.lineStarts[line - 1];
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(pos, pos);
        const top = state.padPx + (line - 1) * state.lhPx;
        textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
        syncScroll();
        updateStatus();
        positionActiveLine();
        closeBar(false);
    }

    if (findInput) {
        findInput.addEventListener('input', () => {
            if (state.mode === 'goto') return;
            window.clearTimeout(state.findTimer);
            state.findTimer = window.setTimeout(() => refreshFind(true), 120);
        });
        findInput.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); closeBar(); return; }
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (state.mode === 'goto') { jumpToLine(); return; }
            stepMatch(event.shiftKey ? -1 : 1);
        });
    }
    if (findNext) findNext.addEventListener('click', () => stepMatch(1));
    if (findPrev) findPrev.addEventListener('click', () => stepMatch(-1));
    if (findClose) findClose.addEventListener('click', () => closeBar());

    /* ---------------- toolbar ---------------- */
    const findBtn = document.getElementById('ed-find-btn');
    const gotoBtn = document.getElementById('ed-goto-btn');
    const commentBtn = document.getElementById('ed-comment-btn');
    const openBtn = document.getElementById('ed-open-btn');
    const saveFileBtn = document.getElementById('ed-save-file-btn');
    const clearBtn = document.getElementById('ed-clear-btn');

    if (findBtn) findBtn.addEventListener('click', () => openBar('find'));
    if (gotoBtn) gotoBtn.addEventListener('click', () => openBar('goto'));
    if (commentBtn) commentBtn.addEventListener('click', toggleComment);

    function flash(button, label) {
        if (!button) return;
        const labelEl = button.querySelector('span');
        const original = labelEl ? labelEl.textContent : '';
        button.classList.add('is-active');
        if (labelEl) labelEl.textContent = label;
        window.setTimeout(() => {
            button.classList.remove('is-active');
            if (labelEl) labelEl.textContent = original;
        }, 1400);
    }

    function slugify(text) {
        return String(text).trim().toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^[-.]+|[-.]+$/g, '')
            .slice(0, 48);
    }

    function updateFileName() {
        if (!fileNameEl) return;
        const title = titleInput ? titleInput.value.trim() : '';
        const base = state.fileNameOverride || slugify(title) || 'untitled';
        fileNameEl.textContent = /\.(lua|luau|txt)$/i.test(base) ? base : `${base}.lua`;
    }

    function downloadSource() {
        const value = textarea.value;
        if (!value) return;
        const name = fileNameEl ? fileNameEl.textContent.trim() || 'voidedx-script.lua' : 'voidedx-script.lua';
        const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        flash(saveFileBtn, 'Saved');
    }

    async function confirmAction(message, title, confirmLabel) {
        if (window.vxDialog && typeof window.vxDialog.confirm === 'function') {
            return !!(await window.vxDialog.confirm(message, { title, confirmLabel, tone: 'danger' }));
        }
        return window.confirm(message);
    }

    async function clearEditor() {
        if (!textarea.value) return;
        const ok = await confirmAction('Clear the editor? Anything not saved to a vault will be lost.', 'Clear editor', 'Clear');
        if (!ok) return;
        replaceRange(0, textarea.value.length, '', 0, 0);
        textarea.scrollTop = 0;
        syncScroll();
        textarea.focus({ preventScroll: true });
    }

    async function copyAll() {
        const value = textarea.value;
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            flash(copyBtn, 'Copied');
        } catch (_) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.focus({ preventScroll: true });
            textarea.select();
            try { document.execCommand('copy'); } catch (__) { /* ignore */ }
            textarea.setSelectionRange(start, end);
            flash(copyBtn, 'Copied');
        }
    }

    if (saveFileBtn) saveFileBtn.addEventListener('click', downloadSource);
    if (copyBtn) copyBtn.addEventListener('click', copyAll);
    if (clearBtn) clearBtn.addEventListener('click', clearEditor);
    if (openBtn && fileInput) openBtn.addEventListener('click', () => fileInput.click());

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                const text = String(reader.result || '');
                if (textarea.value.trim()) {
                    const ok = await confirmAction(
                        `Replace the current source with “${file.name}”?`,
                        'Open file',
                        'Replace'
                    );
                    if (!ok) return;
                }
                replaceRange(0, textarea.value.length, text, 0, 0);
                textarea.scrollTop = 0;
                textarea.setSelectionRange(0, 0);
                state.fileNameOverride = file.name;
                updateFileName();
                applyMode();
                state.highlighted = null;
                schedulePaint();
                textarea.focus({ preventScroll: true });
            };
            reader.readAsText(file);
        });
    }

    if (titleInput) {
        titleInput.addEventListener('input', () => {
            state.fileNameOverride = '';
            updateFileName();
        });
    }

    /* ---------------- wrap + font ---------------- */
    if (wrapBtn) {
        wrapBtn.addEventListener('click', () => {
            state.wrap = !state.wrap;
            writeStore(WRAP_KEY, state.wrap ? '1' : '0');
            applyMode();
            state.highlighted = null;
            schedulePaint();
        });
    }

    function applyFont() {
        const lh = Math.round(state.fontPx * 1.62);
        shell.style.setProperty('--ed-fs', `${state.fontPx}px`);
        shell.style.setProperty('--ed-lh', `${lh}px`);
        if (fontLabel) fontLabel.textContent = String(state.fontPx);
        if (fontDec) fontDec.disabled = state.fontPx <= 10;
        if (fontInc) fontInc.disabled = state.fontPx >= 22;
        window.requestAnimationFrame(() => {
            measure();
            state.digits = 0;
            state.highlighted = null;
            schedulePaint();
        });
    }

    function changeFont(delta) {
        const next = clampFont(state.fontPx + delta);
        if (next === state.fontPx) return;
        state.fontPx = next;
        writeStore(FONT_KEY, String(next));
        applyFont();
    }

    if (fontInc) fontInc.addEventListener('click', () => changeFont(1));
    if (fontDec) fontDec.addEventListener('click', () => changeFont(-1));

    /* ---------------- global shortcuts ---------------- */
    document.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (document.body.classList.contains('vx-dialog-open')) return;
        if (!stage || !stage.offsetParent) return;
        if (!stage.contains(document.activeElement)) return;
        if (event.defaultPrevented) return;
        const key = event.key.toLowerCase();
        if (key === 'f') { event.preventDefault(); openBar('find'); }
        else if (key === 'g') { event.preventDefault(); openBar('goto'); }
        else if (key === '/' && document.activeElement === textarea) { event.preventDefault(); toggleComment(); }
    });

    /* ---------------- dirty dot + resize ---------------- */
    if (saveStatus && stage) {
        const syncDirty = () => stage.classList.toggle('is-dirty', saveStatus.classList.contains('unsaved'));
        new MutationObserver(syncDirty).observe(saveStatus, { attributes: true, attributeFilter: ['class'] });
        syncDirty();
    }

    if (window.ResizeObserver && canvas) {
        new ResizeObserver(() => {
            measure();
            state.digits = 0;
            schedulePaint();
        }).observe(canvas);
    }
    window.addEventListener('resize', () => { measure(); state.digits = 0; schedulePaint(); });

    if (mobileQuery.addEventListener) {
        mobileQuery.addEventListener('change', () => { applyMode(); state.highlighted = null; schedulePaint(); });
    }

    /* ---------------- public API ---------------- */
    function refresh() {
        applyMode();
        rebuildLineStarts();
        state.highlighted = null;
        state.digits = 0;
        measure();
        updateFileName();
        schedulePaint();
    }

    window.VoidedXEditor = {
        refresh,
        applyViewport: refresh,
        setFileName(name) {
            state.fileNameOverride = name ? slugify(name) : '';
            updateFileName();
        }
    };

    state.fontPx = clampFont(readStore(FONT_KEY));
    state.wrap = readStore(WRAP_KEY) === '1';
    applyMode();
    rebuildLineStarts();
    applyFont();
    updateFileName();
    measure();
    schedulePaint();
})();
