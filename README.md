# rgd-git

Store Relic Chunky `.rgd` game data (Dawn of War attribute files) in git as
readable text, while the files on disk stay the real, byte-identical binaries.

Commit history, pull requests and GitHub Desktop then show normal line diffs:

```diff
   modifier_01 : "modifiers\\health_maximum_modifier.lua" {
-    value: float = 750.0
+    value: float = 1000.0
```

## How it works

rgd-git is a git [clean/smudge filter](https://git-scm.com/docs/gitattributes#_filter),
the same mechanism Git LFS uses:

- `git add` converts each `.rgd` to text, and the text is what git stores.
- `git checkout` converts the text back and writes the binary to disk.

There's one file per asset and no sidecars. Tools and the game read the
binary as always. Anything that shows git's stored content sees text:
GitHub, GitHub Desktop, commit views in editors, `git log -p`, `git show`.

## Install (once per machine)

Git never runs code from a repository, so each machine needs this one step.
After it, every repo that opts in just works: clone, pull and commit as usual.

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/CannibalToast/RGD-Git/main/install.ps1 | iex
```

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/CannibalToast/RGD-Git/main/install.sh | sh
```

If Node.js is installed, the script fetches the small JavaScript version
(about 300 KB). Otherwise it downloads the standalone executable from the
[latest release](https://github.com/CannibalToast/RGD-Git/releases/latest)
(about 100 MB, bundles its own Node.js). Both register the filter for every
repo on the machine. Re-run the script to update.

You can also download an executable from the release yourself and
double-click it. It is unsigned, so Windows SmartScreen may ask you to
confirm.

To enable a single repo instead of every repo, run `rgd-git setup` inside it.
Setup is safe to re-run. It also repairs `.rgd` files that were checked out
as text before rgd-git was installed.

## Enable a repo (once per repo)

Add this line to the repo's `.gitattributes`, then convert the existing files
in one commit:

```sh
echo '*.rgd -text filter=rgd diff=rgd' >> .gitattributes
git add --renormalize .
git commit -m "Store .rgd files as text via rgd-git"
```

Commits from before this one stay binary in history. `git log -p` still shows
them as text through the textconv driver that setup installs.

## What you'll see

| Where | Committed changes | Uncommitted changes |
| --- | --- | --- |
| GitHub web, pull requests | Text diff | n/a |
| GitHub Desktop, editor commit views | Text diff | Binary |
| `git diff`, `git log -p` | Text diff | Text diff |

Uncommitted changes show as binary in GUI panels because they compare git's
text against the binary on disk without running the filter.

For a compact key-level summary in the terminal, opt in to the diff driver:

```sh
git config diff.rgd.command '"<path to rgd-git>" diff'
```

```md
RGD diff: attrib/ebps/races/space_marines/unit.rgd
[CHANGED] modifiers.modifier_01.value: 750 -> 1000
```

## Merges

Edits to different keys on two branches merge automatically. If both
branches change the same key, the `.rgd` is left on disk as text with
conflict markers:

1. Edit the markers out and `git add` the file. Adding it with markers still
   present is refused.
2. After committing, restore the binary with
   `rm file.rgd && git checkout -- file.rgd`.

## Guarantees

- **Byte-identical checkouts.** Before storing text, `clean` rebuilds the
  binary from it and compares. If the bytes differ, or the file can't be
  parsed at all, the original binary is stored unchanged. A tiny fraction of
  real files hit this, for example floats stored as negative NaN. Checked
  against 66,681 real Dawn of War `.rgd` files: all came back byte-identical,
  and 13 were stored as binary.
- **No silent failures.** `filter.rgd.required` makes git stop with an error
  if the filter can't run, instead of storing or checking out the wrong
  content.

## Limits

- **Per-machine install.** Without rgd-git, a clone gets text in its `.rgd`
  files. Running setup afterwards repairs them.
- **Archives contain text.** GitHub's "Download ZIP" and release archives
  skip filters, so build releases from a checkout.
- **Speed.** Each file runs a separate process, about 40 ms per `.rgd`. A
  first checkout of 10,000 files takes several minutes; day-to-day commits
  are unaffected.

## Development

```sh
node test/rgd-git.test.js                         # contract test
node build.js                                     # standalone executable in build/ (Node >= 26.9)
RGD_GIT=build/rgd-git node test/rgd-git.test.js   # test the executable
```

`lib/` holds the RGD parser, writer and text format from
[rgd-suite](https://github.com/CannibalToast/rgd-suite), plus its hash
dictionary (`lib/rgd-dic.js`). Both tools produce identical text, so they can
be used on the same repo.

## License

MIT
