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

const COMMANDS = {
    // git add: binary -> text. Stores the binary unchanged when the text can't rebuild its
    // exact bytes (e.g. a negative NaN) or it doesn't parse, so checkout never alters a file.
    clean() {
        const buf = stdin();
        if (isRgdBinary(buf)) {
            try {
                const text = toText(buf);
                if (fromText(text).equals(buf)) return out(text);
            } catch { /* fall through: store as-is */ }
            return out(buf);
        }
        // Text here is a hand-resolved merge being added: refuse leftover markers, else canonicalize.
        const text = utf8(buf);
        if (CONFLICT.test(text)) throw new Error('unresolved merge conflict markers');
        if (!text.startsWith(TEXT_HEADER)) return out(buf); // not an RGD at all
        out(toText(fromText(text)));
    },

    // git checkout: text -> binary. Binary blobs (pre-filter history, lossy files) and merge
    // conflicts pass through untouched, so the user can resolve conflicts in the text.
    smudge() {
        const buf = stdin();
        const text = utf8(buf);
        if (isRgdBinary(buf) || !text.startsWith(TEXT_HEADER) || CONFLICT.test(text)) return out(buf);
        out(fromText(text));
    },

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
            'filter.rgd.required': 'true',
            'diff.rgd.textconv': `${cmd} textconv`,
            'diff.rgd.cachetextconv': 'true',
        };
        const git = (a, input) => execFileSync('git', root ? ['-C', root, ...a] : a, { encoding: 'utf8', input });
        for (const [key, value] of Object.entries(config)) git(['config', scope, key, value]);
        console.log(`rgd-git enabled (${scope === '--global' ? 'every repo on this machine' : root})`);
        if (!root) return;
        const stale = git(['ls-files', '-z', '--', '*.rgd']).split('\0').filter(f => {
            const abs = path.join(root, f);
            return f && fs.existsSync(abs) && utf8(fs.readFileSync(abs)).startsWith(TEXT_HEADER);
        });
        for (const f of stale) fs.unlinkSync(path.join(root, f));
        if (stale.length) {
            git(['checkout', '--pathspec-from-file=-', '--pathspec-file-nul', '--'], stale.join('\0'));
            console.log(`restored ${stale.length} .rgd file(s) from text to binary`);
        }
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
        console.error(`rgd-git ${name}: ${e.message}`);
        process.exitCode = 1;
    }
    // Keep a double-clicked console window open long enough to read the result.
    if (!cmd && process.platform === 'win32') {
        console.log('\nPress Enter to close.');
        try { fs.readSync(0, Buffer.alloc(1)); } catch { /* no console */ }
    }
}

main();
