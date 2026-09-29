'use strict';
// Builds the standalone rgd-git executable for the current platform into build/.
// Needs Node >= 26.9 (single executable apps with a virtual file system for lib/).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.chdir(__dirname);
const exe = process.platform === 'win32' ? 'rgd-git.exe' : 'rgd-git';
const assets = Object.fromEntries(fs.readdirSync('lib').map(f => [`lib/${f}`, `lib/${f}`]));
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/sea-config.json', JSON.stringify({
    main: 'rgd-git.js',
    output: path.join('build', exe),
    useVfs: true,
    disableExperimentalSEAWarning: true,
    assets,
}, null, 2));
execFileSync(process.execPath, ['--build-sea', 'build/sea-config.json'], { stdio: 'inherit' });
console.log(`built build/${exe}`);
