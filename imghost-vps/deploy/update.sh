#!/bin/bash
# Upload a complete release to a separate directory, then run this as root.
set -euo pipefail
release_dir="$(cd -P -- "$(dirname -- "$0")/.." && pwd)"
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    exec node "$release_dir/scripts/update-vps.js" --help
fi
if [[ $EUID -ne 0 ]]; then
    echo 'Run this updater as root over SSH.' >&2
    exit 1
fi
command -v flock >/dev/null || { echo 'Missing flock (Debian util-linux package).' >&2; exit 1; }
# /run/lock can be shared-writable. Keep the lock in a private root directory
# and never truncate an existing path when opening it.
umask 077
lock_dir=/run/imagehost-update
if [[ ! -e $lock_dir && ! -L $lock_dir ]]; then
    mkdir -- "$lock_dir"
fi
if [[ ! -d $lock_dir || -L $lock_dir || $(stat -c '%u:%a' -- "$lock_dir") != 0:700 ]]; then
    echo 'Refusing an unsafe /run/imagehost-update directory (requires root ownership and mode 700).' >&2
    exit 1
fi
if [[ -L $lock_dir/lock || ( -e $lock_dir/lock && ! -f $lock_dir/lock ) ]]; then
    echo 'Refusing an unsafe update lock file.' >&2
    exit 1
fi
# The lock stays open across exec and is released even if the updater exits.
exec 9>>"$lock_dir/lock"
flock -n 9 || { echo 'Another imagehost update is already running.' >&2; exit 1; }
exec /usr/bin/node "$release_dir/scripts/update-vps.js" "$@"
