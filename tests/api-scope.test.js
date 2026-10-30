// Catches the bug class that took /api/verify down: a function called by bare
// name that the file never imports or declares. That is a ReferenceError at
// request time, invisible to every offline test that mocks the server, and
// fatal for the whole catch-all API function.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const API = new URL('../api/', import.meta.url);

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
    'await', 'void', 'delete', 'in', 'of', 'do', 'else', 'case', 'throw', 'super', 'import', 'yield', 'async', 'export']);

const GLOBALS = new Set(['require', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date',
    'Buffer', 'Promise', 'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'TypeError', 'Symbol', 'BigInt', 'isNaN',
    'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'console', 'process', 'globalThis', 'fetch', 'URL', 'URLSearchParams',
    'crypto', 'structuredClone', 'AbortController', 'Intl', 'Function', 'WeakSet', 'Proxy', 'Reflect',
    'FormData', 'Blob', 'File', 'Response', 'Request', 'Headers', 'TextEncoder', 'TextDecoder', 'queueMicrotask',
    'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
    'Float32Array', 'Float64Array', 'BigUint64Array', 'BigInt64Array', 'ArrayBuffer', 'global']);

// The generated Lua lives inside template literals, so string and comment
// bodies have to come out before bare calls mean anything.
function codeOnly(text) {
    let out = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];
        if (char === '/' && next === '/') {
            while (index < text.length && text[index] !== '\n') index += 1;
            continue;
        }
        const previous = out.trimEnd().slice(-1);
        if (char === '/' && (previous === '' || '([{,;=:[!&|?+-*%<>~^'.includes(previous))) {
            index += 1;
            let inClass = false;
            while (index < text.length) {
                const current = text[index];
                if (current === '\\') { index += 2; continue; }
                if (current === '[') inClass = true;
                else if (current === ']') inClass = false;
                else if (current === '/' && !inClass) { index += 1; break; }
                else if (current === '\n') break;
                index += 1;
            }
            out += ' / ';
            continue;
        }
        if (char === '/' && next === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
            index += 2;
            continue;
        }
        if (char === '"' || char === "'") {
            index += 1;
            while (index < text.length) {
                if (text[index] === '\\') { index += 2; continue; }
                if (text[index] === char) { index += 1; break; }
                index += 1;
            }
            out += '""';
            continue;
        }
        if (char === '`') {
            index += 1;
            let braceDepth = 0;
            while (index < text.length) {
                const current = text[index];
                if (current === '\\') { index += 2; continue; }
                if (braceDepth === 0 && current === '`') { index += 1; break; }
                if (current === '$' && text[index + 1] === '{') { braceDepth += 1; index += 2; out += ' '; continue; }
                if (current === '{' && braceDepth > 0) braceDepth += 1;
                if (current === '}' && braceDepth > 0) braceDepth -= 1;
                if (braceDepth === 0) { index += 1; continue; }
                out += current;
                index += 1;
            }
            out += ' ';
            continue;
        }
        out += char;
        index += 1;
    }
    return out;
}

function declaredNames(text) {
    const names = new Set();
    const add = value => {
        const token = String(value || '').trim().split(/\s+as\s+/).pop().trim().split('=')[0].trim();
        if (token) names.add(token.replace(/^\.\.\./u, ''));
    };
    for (const pattern of [
        /import\s*\{([^}]*)\}\s*from/gu,
        /import\s+\*\s+as\s+([A-Za-z0-9_$]+)/gu,
        /import\s+([A-Za-z0-9_$]+)\s+from/gu,
        /export\s*\{([^}]*)\}/gu
    ]) {
        for (const match of text.matchAll(pattern)) {
            for (const part of match[1].split(',')) add(part);
            if (pattern.source.includes('as') || pattern.source.includes('import\\s+\\[')) add(match[1]);
        }
    }
    for (const pattern of [
        /(?:^|\s)(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/gu,
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)/gu,
        /class\s+([A-Za-z0-9_$]+)/gu,
        /catch\s*\(\s*([A-Za-z0-9_$]+)/gu,
        /for\s*\(\s*(?:await\s+)?(?:const|let|var)?\s*([A-Za-z0-9_$]+)/gu
    ]) {
        for (const match of text.matchAll(pattern)) add(match[1]);
    }
    for (const match of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/gu)) {
        for (const part of match[1].split(',')) add(part.split(':').pop());
    }
    for (const match of text.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/gu)) {
        for (const part of match[1].split(',')) add(part);
    }
    for (const match of text.matchAll(/function\s*\*?\s*([^)]*)\)/gu)) {
        for (const part of match[1].split(',')) add(part.split('=')[0].trim().replace(/^\.\.\./u, ''));
    }
    for (const match of text.matchAll(/\(([^()]*)\)\s*=>/gu)) {
        for (const part of match[1].split(',')) add(part.split('=')[0].trim().replace(/^\.\.\./u, ''));
    }
    for (const match of text.matchAll(/([A-Za-z0-9_$]+)\s*=>/gu)) add(match[1]);
    return names;
}

function unresolvedCalls(file) {
    const text = codeOnly(fs.readFileSync(file, 'utf8'));
    const declared = declaredNames(text);
    const problems = [];
    for (const match of text.matchAll(/(?<![.\w$])([A-Za-z0-9_$]+)\s*\(/gu)) {
        const name = match[1];
        if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
        if (/^(?:export|import)$/u.test(name)) continue;
        problems.push(name);
    }
    return [...new Set(problems)];
}

test('every api module calls only names it imports or declares', () => {
    const files = fs.readdirSync(API, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(API.pathname.replace(/^\//u, ''), entry.name));
    assert.ok(files.length > 20, `expected the api folder to be scanned, found ${files.length}`);
    const failures = [];
    for (const file of files) {
        for (const name of unresolvedCalls(file)) {
            failures.push(`${path.basename(file)}: ${name}(...) is never imported or declared`);
        }
    }
    assert.deepEqual(failures, []);
});
