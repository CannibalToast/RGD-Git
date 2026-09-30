'use strict';
// Contract of the rgd git filter. Run: node test/rgd-git.test.js
// Against a built executable: RGD_GIT=build/rgd-git node test/rgd-git.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDictionary } = require('../lib/dictionary');
const { buildRgd, createTable, createEntry } = require('../lib/writer');
const { RgdDataType } = require('../lib/types');

const CLI = path.join(__dirname, '..', 'rgd-git.js');
const EXE = process.env.RGD_GIT && path.resolve(process.env.RGD_GIT);
const run = (args, input, cwd) => execFileSync(EXE || 'node', EXE ? args : [CLI, ...args], { input, cwd, stdio: 'pipe' });
const clean = input => run(['clean'], input);
const smudge = input => run(['smudge'], input);

// A small synthetic RGD: no game data in this repo.
function makeRgd(health, speed) {
    const dict = createDictionary();
    const root = createTable('');
    const mod = createTable('modifiers\\health_maximum_modifier.lua');
    mod.entries.push(createEntry('value', RgdDataType.Float, health, dict));
    mod.entries.push(createEntry('exclusive', RgdDataType.Bool, false, dict));
    root.entries.push(createEntry('modifier_01', RgdDataType.Table, mod, dict));
    root.entries.push(createEntry('speed', RgdDataType.Float, speed, dict));
    root.entries.push(createEntry('ui_name', RgdDataType.String, 'test_unit', dict));
    return buildRgd(root, dict, 1);
}

const bin = makeRgd(1000, 5);
const text = clean(bin);

// Filter round trip
assert.ok(text.toString().startsWith('# RGD Text Format'), 'clean stores text');
assert.ok(smudge(text).equals(bin), 'smudge restores byte-identical binary');
assert.ok(clean(text).equals(text), 'clean accepts already-text input (resolved merge)');
assert.ok(smudge(bin).equals(bin), 'smudge passes binary blobs (pre-filter history) through');

// Merge conflicts: left on disk as text; adding them unresolved is refused
const conflicted = Buffer.from(text.toString().replace(/^(\s*speed.*)$/m, '<<<<<<< HEAD\n$1\n=======\n$1\n>>>>>>> other'));
assert.ok(smudge(conflicted).equals(conflicted), 'smudge leaves conflict markers for the user');
assert.throws(() => clean(conflicted), 'clean refuses unresolved conflicts');

// Anything the text can't reproduce exactly is stored as binary, never altered
const at = bin.indexOf(Buffer.from([0x00, 0x00, 0x7a, 0x44])); // 1000.0f
assert.ok(at > 0, 'fixture contains 1000.0f');
const negNaN = Buffer.from(bin);
negNaN.writeUInt32LE(0xffc00000, at);
assert.ok(clean(negNaN).equals(negNaN), 'lossy file (negative NaN) stored as binary');
const corrupt = bin.subarray(0, 40);
assert.ok(clean(corrupt).equals(corrupt), 'unparseable RGD stored unchanged');
assert.ok(smudge(corrupt).equals(corrupt), 'and handed back unchanged');

// End to end in a real repo
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-git-'));
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString();
const file = path.join(repo, 'unit.rgd');
try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.rgd -text filter=rgd diff=rgd\n');
    // Committed before setup: git stores (and later checks out) whatever is on disk.
    fs.writeFileSync(file, text);
    git('add', '.');
    git('commit', '-qm', 'text on disk, no filter yet');
    run(['setup'], undefined, repo);
    assert.ok(fs.readFileSync(file).equals(bin), 'setup restores a pre-setup text checkout to binary');
    assert.strictEqual(git('status', '--porcelain'), '', 'tree clean after setup');

    fs.writeFileSync(file, makeRgd(1500, 5));
    assert.match(git('diff'), /-\s+value: float = 1000\.0\n\+\s+value: float = 1500\.0/, 'git diff shows a text line diff');
    git('commit', '-qam', 'health 1500');
    assert.match(git('cat-file', '-p', 'HEAD:unit.rgd'), /^# RGD Text Format/, 'blob stored as text');

    // Edits to different keys on two branches merge automatically
    git('checkout', '-qb', 'other', 'HEAD~1');
    fs.writeFileSync(file, makeRgd(1000, 9));
    git('commit', '-qam', 'speed 9');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-edit', 'other');
    assert.ok(fs.readFileSync(file).equals(makeRgd(1500, 9)), 'auto-merge of different keys yields both edits, as binary');

    // Opt-in key-level external diff
    fs.writeFileSync(file, makeRgd(2000, 9));
    const semantic = execFileSync('git', ['-C', repo, '-c', `diff.rgd.command=node "${CLI}" diff`, 'diff'], { stdio: 'pipe' }).toString();
    assert.match(semantic, /\[CHANGED\] modifier_01\.value: 1500 -> 2000/, 'diff driver reports the changed key');
} finally {
    fs.rmSync(repo, { recursive: true, force: true });
}

// An uncommitted edit must survive setup: dirty files convert in place, never deleted
const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-git-edit-'));
const git2 = (...a) => execFileSync('git', ['-C', repo2, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString();
const file2 = path.join(repo2, 'unit.rgd');
try {
    git2('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo2, '.gitattributes'), '*.rgd -text filter=rgd diff=rgd\n');
    fs.writeFileSync(file2, text);
    git2('add', '.');
    git2('commit', '-qm', 'text on disk, no filter yet');
    fs.writeFileSync(file2, Buffer.from(text.toString().replace('value: float = 1000.0', 'value: float = 1500.0')));
    run(['setup'], undefined, repo2);
    assert.ok(fs.readFileSync(file2).equals(makeRgd(1500, 5)), 'setup keeps uncommitted edits (converted to binary in place)');
    assert.strictEqual(git2('status', '--porcelain'), ' M unit.rgd\n', 'edited file stays modified until committed');
} finally {
    fs.rmSync(repo2, { recursive: true, force: true });
}

console.log('rgd-git tests passed');
