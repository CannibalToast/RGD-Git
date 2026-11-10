#!/usr/bin/env node
'use strict';
// rgd-git: stores Relic Chunky .rgd binaries in git as readable text, via a clean/smudge
// filter, while the working tree keeps the real binary. See README.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDictionary, loadDictionaryText } = require('./lib/dictionary');
const { parseRgd } = require('./lib/reader');
const { buildRgd } = require('./lib/writer');
const { rgdToText, textToRgd } = require('./lib/textFormat');
const { RgdDataType } = require('./lib/types');

const dict = createDictionary();
loadDictionaryText(dict, require('./lib/rgd-dic'));

const TEXT_HEADER = '# RGD Text Format';
const CONFLICT = /^<<<<<<< /m;
const isRgdBinary = buf => buf.subarray(0, 12).toString('latin1') === 'Relic Chunky';
const utf8 = buf => buf.toString('utf8').replace(/^\uFEFF/, '');
const toText = buf => rgdToText(parseRgd(buf, dict), '-', null);
const fromText = text => {
    const { gameData, version } = textToRgd(text, dict);
    return buildRgd(gameData, dict, version);
};
const parseAny = buf => parseRgd(isRgdBinary(buf) ? buf : fromText(utf8(buf)), dict);
const stdin = () => fs.readFileSync(0);
const out = data => process.stdout.write(data);

function isSea() {
    try { return require('node:sea').isSea(); } catch { return false; }
}

// Command git runs for the filter; absolute so GUI clients with a bare PATH still find it.
function selfCommand() {
    const q = p => `"${p.replace(/\\/g, '/')}"`;
    return isSea() ? q(process.execPath) : `${q(process.execPath)} ${q(__filename)}`;
}

function gitRoot() {
    try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
    catch { return null; }
}

// ── Key-level diff ───────────────────────────────────────────────────────

function flatten(table, prefix = '', result = new Map()) {
    for (const entry of table.entries) {
        const key = entry.name || ('#' + entry.hash.toString(16).padStart(8, '0'));
        const full = prefix ? `${prefix}.${key}` : key;
        if (entry.type === RgdDataType.Table || entry.type === RgdDataType.TableInt) {
            if (entry.value) flatten(entry.value, full, result);
        } else if (entry.type === RgdDataType.Float || entry.type === RgdDataType.Integer) {
            result.set(full, { numeric: true, value: entry.value });
        } else if (entry.type === RgdDataType.Bool) {
            result.set(full, { value: entry.value });
        } else if ((entry.type === RgdDataType.String || entry.type === RgdDataType.WString) && key !== '$REF') {
            result.set(full, { value: entry.value });
        }
    }
    return result;
}

function tableDiff(baseRgd, curRgd) {
    const same = (a, b) => (a.numeric && b.numeric ? Math.abs(a.value - b.value) <= 1e-4 : a.value === b.value);
    const base = flatten(baseRgd.gameData);
    const cur = flatten(curRgd.gameData);
    const lines = [];
    for (const [key, now] of cur) {
        const old = base.get(key);
        if (!old) lines.push([key, `[ADDED]   ${key}: ${JSON.stringify(now.value)}`]);
        else if (!same(old, now)) lines.push([key, `[CHANGED] ${key}: ${JSON.stringify(old.value)} -> ${JSON.stringify(now.value)}`]);
    }
    for (const [key, old] of base) if (!cur.has(key)) lines.push([key, `[REMOVED] ${key}: ${JSON.stringify(old.value)}`]);
    return lines.sort((a, b) => a[0].localeCompare(b[0])).map(([, line]) => line);
}

// ── Commands ─────────────────────────────────────────────────────────────

// git add: binary -> text. Stores the binary unchanged when the text can't rebuild its
// exact bytes (e.g. a negative NaN) or it doesn't parse, so checkout never alters a file.
function cleanBuffer(buf) {
    if (isRgdBinary(buf)) {
        try {
            const text = toText(buf);
            if (fromText(text).equals(buf)) return text;
        } catch { /* fall through: store as-is */ }
        return buf;
    }
    // Text here is a hand-resolved merge being added: refuse leftover markers, else canonicalize.
    const text = utf8(buf);
    if (CONFLICT.test(text)) throw new Error('unresolved merge conflict markers');
    if (!text.startsWith(TEXT_HEADER)) return buf; // not an RGD at all
    return toText(fromText(text));
}

// git checkout: text -> binary. Binary blobs (pre-filter history, lossy files) and merge
// conflicts pass through untouched, so the user can resolve conflicts in the text.
function smudgeBuffer(buf) {
    const text = utf8(buf);
    if (isRgdBinary(buf) || !text.startsWith(TEXT_HEADER) || CONFLICT.test(text)) return buf;
    return fromText(text);
}

// ── Long-running filter process (git filter.<drv>.process, protocol v2) ──
// One node process serves every file via pkt-line frames on stdin/stdout, instead
// of forking per file. ~50x faster on bulk ops (status/checkout over many .rgd).

const PKT_FLUSH = 'FLUSH', PKT_EOF = 'EOF';
const MAX_PKT_DATA = 65516;

function readAll(buf) {
    let off = 0;
    while (off < buf.length) {
        let n;
        try { n = fs.readSync(0, buf, off, buf.length - off, null); }
        catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
        if (n === 0) return false; // EOF
        off += n;
    }
    return true;
}

function readPacket() {
    const hdr = Buffer.allocUnsafe(4);
    if (!readAll(hdr)) return PKT_EOF;
    const len = parseInt(hdr.toString('latin1'), 16);
    if (len === 0) return PKT_FLUSH;
    if (!(len >= 4) || len > 0xffff) throw new Error(`bad pkt-line header ${hdr.toString('latin1')}`);
    const body = Buffer.allocUnsafe(len - 4);
    if (!readAll(body)) throw new Error('EOF mid-packet');
    return body;
}

function readPacketList() { // text packets until flush; null on clean EOF
    const lines = [];
    for (; ;) {
        const p = readPacket();
        if (p === PKT_EOF) return lines.length ? lines : null;
        if (p === PKT_FLUSH) return lines;
        lines.push(p.toString('utf8').replace(/\n$/, ''));
    }
}

function readPacketData() { // binary packets until flush
    const parts = [];
    for (; ;) {
        const p = readPacket();
        if (p === PKT_EOF) throw new Error('EOF mid-file content');
        if (p === PKT_FLUSH) return parts.length === 1 ? parts[0] : Buffer.concat(parts);
        parts.push(p);
    }
}

function writeAll(buf) {
    let off = 0;
    while (off < buf.length) {
        try { off += fs.writeSync(1, buf, off, buf.length - off); }
        catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
    }
}

function sendPacket(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    writeAll(Buffer.from((buf.length + 4).toString(16).padStart(4, '0'), 'latin1'));
    writeAll(buf);
}

function sendFlush() { writeAll(Buffer.from('0000', 'latin1')); }

function sendData(buf) {
    for (let i = 0; i < buf.length; i += MAX_PKT_DATA) sendPacket(buf.subarray(i, Math.min(i + MAX_PKT_DATA, buf.length)));
}

function filterProcess() {
    {
        const hello = readPacketList();
        if (!hello || hello[0] !== 'git-filter-client' || !hello.includes('version=2')) {
            throw new Error(`bad filter-process handshake: ${hello && hello.join(' ')}`);
        }
        sendPacket('git-filter-server\n'); sendPacket('version=2\n'); sendFlush();
        readPacketList(); // git's capabilities
        sendPacket('capability=clean\n'); sendPacket('capability=smudge\n'); sendFlush();

        for (; ;) {
            const request = readPacketList();
            if (request === null) return; // git closed stdin — clean shutdown
            const command = request.find(l => l.startsWith('command='))?.slice(8);
            const content = readPacketData();
            let result, status = 'success';
            try {
                if (command === 'clean') result = cleanBuffer(content);
                else if (command === 'smudge') result = smudgeBuffer(content);
                else status = 'error';
            } catch { status = 'error'; } // git falls back to the clean/smudge commands
            sendPacket(`status=${status}\n`); sendFlush();
            if (status === 'success') {
                sendData(Buffer.isBuffer(result) ? result : Buffer.from(result, 'utf8')); sendFlush();
                sendPacket('status=success\n'); sendFlush(); // git reads a second status after the data
            }
        }
    }
}

const COMMANDS = {
    clean() { out(cleanBuffer(stdin())); },
    smudge() { out(smudgeBuffer(stdin())); },
    'filter-process': filterProcess,

    // diff.rgd.textconv: shows binary blobs from pre-filter history as text too.
    textconv([file]) {
        const buf = fs.readFileSync(file);
        if (!isRgdBinary(buf)) return out(buf);
        try { out(toText(buf)); } catch { out(`(unreadable RGD, ${buf.length} bytes)\n`); }
    },

    // diff.rgd.command (opt-in): git's 7-argument external diff -> key-level changes.
    diff([file, oldFile, , , newFile]) {
        const load = f => { try { return parseAny(fs.readFileSync(f)); } catch { return { gameData: { entries: [] } }; } };
        const lines = tableDiff(load(oldFile), load(newFile));
        if (lines.length) out(`RGD diff: ${file}\n${lines.join('\n')}\n`);
        // Must exit 0: git reports any nonzero status as "external diff died".
    },

    // Wire git to this program (current repo, or --global for every repo on the machine),
    // then restore .rgd files that a checkout before setup left as text on disk.
    setup(args) {
        const scope = args.includes('--global') ? '--global' : '--local';
        const root = gitRoot();
        if (scope === '--local' && !root) throw new Error('not inside a git repository (use --global for every repo)');
        const cmd = selfCommand();
        const config = {
            'filter.rgd.clean': `${cmd} clean`,
            'filter.rgd.smudge': `${cmd} smudge`,
            'filter.rgd.process': `${cmd} filter-process`,
            'filter.rgd.required': 'true',
            'diff.rgd.textconv': `${cmd} textconv`,
            'diff.rgd.cachetextconv': 'true',
        };
        const git = (a, input) => execFileSync('git', root ? ['-C', root, ...a] : a, { encoding: 'utf8', input, maxBuffer: Infinity });
        try {
            for (const [key, value] of Object.entries(config)) git(['config', scope, key, value]);
        } catch (e) {
            throw new Error(`could not write git config (${scope}) — is git working? run 'git status' to check\n  ${e.message}`);
        }
        console.log(`rgd-git enabled (${scope === '--global' ? 'every repo on this machine' : root})`);
        if (!root) return;

        const attrs = path.join(root, '.gitattributes');
        const ATTR_LINE = '*.rgd -text filter=rgd diff=rgd';
        if (!/^\*\.rgd\b.*filter=rgd/m.test(fs.existsSync(attrs) ? fs.readFileSync(attrs, 'utf8') : '')) {
            try {
                fs.appendFileSync(attrs, (fs.existsSync(attrs) && fs.readFileSync(attrs, 'utf8').trim() ? '\n' : '') + ATTR_LINE + '\n');
            } catch (e) {
                throw new Error(`could not write .gitattributes — check permissions on ${root}\n  fix: add '${ATTR_LINE}' to it yourself`);
            }
            console.log(`wrote '${ATTR_LINE}' to .gitattributes`);
        }
        this.verify(root);

        // Clean stale checkouts go back through git; files with local edits convert in
        // place so the edit survives (and keeps showing as modified until committed).
        const head = abs => {
            let fd;
            try { fd = fs.openSync(abs, 'r'); } catch { return Buffer.alloc(0); }
            try { const b = Buffer.alloc(32); return b.subarray(0, fs.readSync(fd, b, 0, 32, 0)); }
            finally { fs.closeSync(fd); }
        };
        const isTextDump = abs => utf8(head(abs)).startsWith(TEXT_HEADER);
        const isBinary = abs => isRgdBinary(head(abs));
        console.log('scanning tracked .rgd files...');
        const tracked = git(['ls-files', '-z', '--', '*.rgd']).split('\0').filter(Boolean);
        // required=false so one file clean rejects fails per-file, not the whole scan
        const dirty = new Set(git(['-c', 'filter.rgd.required=false', 'diff', '--name-only', '-z', '--', '*.rgd']).split('\0').filter(Boolean));
        const stale = tracked.filter(f => !dirty.has(f) && isTextDump(path.join(root, f)));
        const edited = tracked.filter(f => dirty.has(f) && isTextDump(path.join(root, f)));
        const failed = [];
        const total = stale.length + edited.length;
        let n = 0;
        const tick = f => process.stdout.write(`\rrestoring .rgd files  ${++n}/${total}  ${f}          `);
        for (const f of stale) {
            tick(f);
            // Fast path: a clean text dump smudges to exactly the blob's binary —
            // convert in place (~2ms) instead of rm+git checkout (~50ms per file,
            // which made 12k-file restores a 15-minute operation).
            const abs = path.join(root, f);
            try {
                fs.writeFileSync(abs, fromText(utf8(fs.readFileSync(abs))));
            } catch (e) {
                // Unparseable text (corrupt dump, old format): git's own checkout is
                // the authoritative smudge. File must be deleted first or git's stat
                // cache calls it unchanged and smudge never runs.
                try {
                    const backup = fs.readFileSync(abs);
                    fs.rmSync(abs);
                    git(['--literal-pathspecs', 'checkout', '--', f]);
                    if (!isBinary(abs)) { fs.writeFileSync(abs, backup); failed.push(`${f}: still not binary after checkout`); }
                } catch (e2) {
                    failed.push(`${f}: ${String(e2.message || e2).split('\n')[0]}`);
                }
            }
        }
        for (const f of edited) {
            tick(f);
            const abs = path.join(root, f);
            if (!fs.existsSync(abs)) continue; // deleted locally — leave it gone
            try { fs.writeFileSync(abs, fromText(utf8(fs.readFileSync(abs)))); }
            catch (e) { failed.push(`${f}: ${e.message}`); }
        }
        if (total) process.stdout.write(`\r${' '.repeat(60)}\r`);
        // In-place writes leave stat dirt: file mtime/size differ from the index
        // entry, and `git update-index --refresh` won't heal it (its content check
        // disagrees with the filtered diff — the entry reports ' M' forever).
        // `git add` rehashes to the identical blob so it only refreshes stat data.
        for (let i = 0; i < stale.length; i += 500) git(['add', '--', ...stale.slice(i, i + 500)]);
        if (!stale.length && !edited.length) return;
        const restored = [...stale, ...edited].filter(f => isBinary(path.join(root, f))).length;
        console.log(`restored ${restored} .rgd file(s) from text to binary`);
        if (edited.length) console.log(`${edited.length} file(s) had local edits and stay modified until committed`);
        for (const f of failed) console.error(`  failed: ${f}`);
    },

    // End of setup: prove the filter actually works through git — filtered hash must
    // differ from raw hash on a real tracked file. Only a binary worktree file can
    // prove it: on a text dump clean(text)=text so the hashes match either way.
    verify(root) {
        const git = (a, input) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', input, maxBuffer: Infinity }).trim();
        const head32 = abs => { const b = Buffer.alloc(32); try { const fd = fs.openSync(abs, 'r'); fs.readSync(fd, b, 0, 32, 0); fs.closeSync(fd); } catch { return Buffer.alloc(0); } return b; };
        const f = git(['ls-files', '--', '*.rgd']).split('\n').filter(Boolean)
            .find(f => isRgdBinary(head32(path.join(root, f))));
        if (!f) { console.log('no binary .rgd on disk to verify against — skipped'); return true; }
        const ok = git(['hash-object', '--path=' + f, f]) !== git(['hash-object', '--stdin'], fs.readFileSync(path.join(root, f)));
        console.log(ok ? 'filter verified working' : `WARNING: filter configured but inactive — run 'rgd-git doctor'`);
        return ok;
    },

    // Audit the whole chain: config, .gitattributes, and a live hash-object round-trip
    // through git's own filter machinery. exit 1 if anything needed is missing.
    doctor() {
        const cfg = k => { try { return execFileSync('git', ['config', '--get', k], { encoding: 'utf8' }).trim(); } catch { return null; } };
        const git = (a, input) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', input, maxBuffer: Infinity }).trim();
        const root = gitRoot();
        let bad = 0;
        const check = (ok, label, fix) => { console.log(`${ok ? 'ok' : 'MISSING'}  ${label}`); if (!ok) { bad++; if (fix) console.log(`   fix: ${fix}`); } };
        for (const k of ['clean', 'smudge', 'process', 'required'])
            check(cfg(`filter.rgd.${k}`) !== null, `filter.rgd.${k}`, 'run: rgd-git setup' + (root ? '' : ' --global'));
        check(cfg('diff.rgd.textconv') !== null, 'diff.rgd.textconv', 'run: rgd-git setup' + (root ? '' : ' --global'));
        if (!root) {
            console.log('not inside a repo — config checks done, skipping repo checks');
        } else {
            check(!fs.existsSync(path.join(root, '.git', 'index.lock')), 'no stale .git/index.lock',
                'remove it once no git process is running');
            const f = git(['ls-files', '--', '*.rgd']).split('\n').filter(Boolean)[0];
            if (!f) console.log('info   no tracked .rgd files in this repo — filter inactive by definition');
            else {
                const attrs = path.join(root, '.gitattributes');
                check(/^\*\.rgd\b.*filter=rgd/m.test(fs.existsSync(attrs) ? fs.readFileSync(attrs, 'utf8') : ''),
                    '.gitattributes: *.rgd filter=rgd', `echo '*.rgd -text filter=rgd diff=rgd' >> .gitattributes`);
                const filtered = git(['hash-object', '--path=' + f, f]);
                const raw = git(['hash-object', '--stdin'], fs.readFileSync(path.join(root, f)));
                check(filtered !== raw, `clean filter active (git hash-object --path ${f})`, 'run: rgd-git setup');
            }
            if (cfg('core.untrackedcache') === null) console.log('info   core.untrackedCache off — speeds up status on huge trees');
            if (cfg('core.fsmonitor') === null) console.log('info   core.fsmonitor off — speeds up status on huge trees');
        }
        process.exitCode = bad ? 1 : 0;
    },

    // Standalone executable: copy to a stable per-user location, then set up git globally.
    install() {
        if (!isSea()) throw new Error('install is for the standalone executable; with Node, run: setup --global');
        const dir = process.platform === 'win32'
            ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'rgd-git')
            : path.join(os.homedir(), '.local', 'bin');
        const target = path.join(dir, path.basename(process.execPath));
        fs.mkdirSync(dir, { recursive: true });
        if (path.resolve(target) !== path.resolve(process.execPath)) fs.copyFileSync(process.execPath, target);
        fs.chmodSync(target, 0o755);
        console.log(`installed ${target}`);
        execFileSync(target, ['setup', '--global'], { stdio: 'inherit' });
    },
};

const USAGE = `rgd-git — store .rgd files in git as text

  rgd-git setup [--global]   enable for this repo (or every repo on this machine)
  rgd-git doctor             audit the filter chain; exit 1 if anything is missing
  rgd-git install            standalone executable: install + enable for every repo

Commands git runs itself: clean, smudge, textconv <file>, diff <7 git args>
Repos opt in with this .gitattributes line:  *.rgd -text filter=rgd diff=rgd
`;

function main() {
    const [cmd, ...args] = process.argv.slice(2);
    // Double-clicking the standalone executable (no arguments) installs it.
    const name = cmd || (isSea() ? 'install' : null);
    if (!COMMANDS[name]) {
        out(USAGE);
        process.exitCode = name ? 1 : 0;
        return;
    }
    try {
        COMMANDS[name](args);
    } catch (e) {
        // Translate the cryptic into the actionable for users who just clicked a file.
        let msg = e.message;
        if (/spawn git ENOENT/.test(msg)) msg = 'git is not installed or not on PATH — install from https://git-scm.com';
        console.error(`rgd-git ${name}: ${msg}`);
        process.exitCode = 1;
    }
    // Keep a double-clicked console window open long enough to read the result.
    if (!cmd && process.platform === 'win32') {
        console.log('\nPress Enter to close.');
        try { fs.readSync(0, Buffer.alloc(1)); } catch { /* no console */ }
    }
}

main();
