#!/bin/sh
# Installs rgd-git for every repo on this machine. Uses Node.js when present,
# otherwise the prebuilt executable from the latest release. Re-run to update.
#
#   curl -fsSL https://raw.githubusercontent.com/CannibalToast/RGD-Git/main/install.sh | sh
set -e
repo=https://github.com/CannibalToast/RGD-Git
command -v git >/dev/null || {
	echo "rgd-git needs git: https://git-scm.com" >&2
	exit 1
}

# spin <pid> <label>: heartbeat while a background job runs (tty only —
# piped installs keep quiet). wait $pid surfaces the job's exit code.
spin() {
	[ -t 1 ] || {
		echo "$2..."
		return
	}
	while kill -0 "$1" 2>/dev/null; do
		for c in '-' '\' '|' '/'; do
			printf '\r%s %s' "$c" "$2"
			sleep 0.1
		done
	done
	printf '\r%-40s\r' ''
}

if command -v node >/dev/null; then
	# ponytail: tracks main; pin to a release tag if the text format ever changes.
	dir=${XDG_DATA_HOME:-$HOME/.local/share}/rgd-git
	rm -rf "$dir" && mkdir -p "$dir"
	echo "installing rgd-git into $dir"
	{ curl -fsSL "$repo/archive/refs/heads/main.tar.gz" | tar -xz -C "$dir" --strip-components=1; } &
	spin $! 'downloading + extracting'
	wait $!
	node "$dir/rgd-git.js" setup --global
else
	case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) asset=rgd-git-linux-x64 ;;
	Darwin-arm64) asset=rgd-git-macos-arm64 ;;
	*)
		echo "No Node.js and no prebuilt rgd-git for $(uname -sm): install Node.js and re-run." >&2
		exit 1
		;;
	esac
	bin=$HOME/.local/bin/rgd-git
	mkdir -p "$(dirname "$bin")"
	echo "Node.js not found; downloading the standalone rgd-git executable..."
	curl -fsSL -o "$bin" "$repo/releases/latest/download/$asset" &
	spin $! 'downloading rgd-git (~100 MB)'
	wait $!
	chmod +x "$bin"
	"$bin" setup --global
fi
echo "rgd-git installed — every repo on this machine is set up."
