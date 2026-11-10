'use strict';
// Self-update: compare the installed version against the latest GitHub release,
// then swap in new files only after a verified download — a failed fetch never
// breaks the working install.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO = 'https://github.com/CannibalToast/RGD-Git';
const VERSION = require('../package.json').version;

// Follows GitHub's release redirect chain to save `url` to `dest`.
function download(url, dest, redirects = 8) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'rgd-git' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (!redirects) return reject(new Error(`too many redirects for ${url}`));
                return download(res.headers.location, dest, redirects - 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
            }
            // Buffer then writeFileSync — createWriteStream needs fs.writev,
            // which the SEA filesystem shim doesn't implement.
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve(); }
                catch (e) { reject(e); }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

// releases/latest 302s to /releases/tag/<tag> — no JSON API needed, no rate limit.
function latestTag() {
    return new Promise((resolve, reject) => {
        https.get(`${REPO}/releases/latest`, { headers: { 'User-Agent': 'rgd-git' } }, res => {
            res.resume();
            const tag = /\/tag\/([^/?#]+)/.exec(res.headers.location || '')?.[1];
            if (tag) resolve(tag);
            else reject(new Error(`couldn't find the latest release tag (HTTP ${res.statusCode})`));
        }).on('error', reject);
    });
}

const SEA_ASSET = {
    'linux-x64': 'rgd-git-linux-x64',
    'darwin-arm64': 'rgd-git-macos-arm64',
    'win32-x64': 'rgd-git-windows-x64.exe',
};

function isSea() {
    try { return require('node:sea').isSea(); } catch { return false; }
}

// The standalone exe swaps itself in place; a Node install re-fetches the
// source tarball into its own directory (repo checkouts use git pull).
async function update(args) {
    const force = args.includes('--force');
    const tag = await latestTag();
    if (!force && tag === `v${VERSION}`) {
        console.error(`rgd-git ${VERSION} is already the latest release`);
        return;
    }
    if (isSea()) {
        const asset = SEA_ASSET[`${process.platform}-${process.arch}`];
        if (!asset) throw new Error(`no prebuilt rgd-git for ${process.platform}-${process.arch} — install Node.js and re-run the installer`);
        const exe = process.execPath, tmp = exe + '.new';
        fs.rmSync(tmp, { force: true });
        fs.rmSync(exe + '.old', { force: true }); // leftover from a previous update
        console.error(`downloading ${asset}...`);
        try { await download(`${REPO}/releases/latest/download/${asset}`, tmp); }
        catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
        if (fs.statSync(tmp).size < 10_000_000) { fs.rmSync(tmp, { force: true }); throw new Error('download looks truncated — check your network and re-run'); }
        if (process.platform === 'win32') fs.renameSync(exe, exe + '.old'); // can't overwrite a running exe on Windows, but renaming works
        fs.renameSync(tmp, exe);
        fs.chmodSync(exe, 0o755);
    } else {
        const dir = path.dirname(__dirname); // lib/ -> install root
        if (fs.existsSync(path.join(dir, '.git'))) {
            console.error('this rgd-git is a repo checkout — update it with `git pull`');
            return;
        }
        // Extract beside the install dir (same filesystem = renames work),
        // then swap trees only after the new source is fully in place.
        const work = fs.mkdtempSync(path.join(path.dirname(dir), '.rgd-git-update-'));
        try {
            const tgz = path.join(work, 'src.tgz');
            console.error('downloading latest source...');
            await download(`${REPO}/archive/refs/heads/main.tar.gz`, tgz);
            execFileSync('tar', ['-xzf', tgz, '-C', work]);
            const src = path.join(work, fs.readdirSync(work).find(d => d !== 'src.tgz'));
            const backup = dir + '.old';
            fs.rmSync(backup, { recursive: true, force: true });
            fs.renameSync(dir, backup);
            try { fs.renameSync(src, dir); }
            catch (e) { fs.renameSync(backup, dir); throw e; }
            fs.rmSync(backup, { recursive: true, force: true });
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }
    console.error(`updated rgd-git ${VERSION} -> ${tag.replace(/^v/, '')}`);
}

module.exports = { update };
