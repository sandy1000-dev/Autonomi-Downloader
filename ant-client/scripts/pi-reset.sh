#!/bin/sh
# Reset an ant node host to a completely clean state.
#
#   - gracefully stops all nodes and the daemon (if `ant` is present)
#   - kills any lingering ant-node workers / daemon processes
#   - removes the installed `ant` binary (~/.local/bin/ant)
#   - clears all daemon + registry state (~/.local/share/ant)
#   - clears node data and logs under /mnt/nodes
#
# POSIX sh (works under Alpine/busybox). Safe to re-run.
# Usage:  sh pi-reset.sh
set -u

ANT_BIN="$HOME/.local/bin/ant"
DATA_DIR="$HOME/.local/share/ant"
NODES_ROOT="/mnt/nodes"

# kill_matching <cmdline-substring> [SIGNAL]
kill_matching() {
    sig="${2:-TERM}"
    for p in $(ps -ef 2>/dev/null | grep "$1" | grep -v grep | awk '{print $1}'); do
        kill "-$sig" "$p" 2>/dev/null || true
    done
}

echo "==> Graceful stop via ant (if installed)"
if [ -x "$ANT_BIN" ]; then
    "$ANT_BIN" node stop 2>/dev/null || true
    "$ANT_BIN" node daemon stop 2>/dev/null || true
fi

echo "==> Killing lingering ant-node workers and daemon"
kill_matching "ant-node" TERM
kill_matching "ant node daemon run" TERM
sleep 2
kill_matching "ant-node" KILL
kill_matching "ant node daemon run" KILL

echo "==> Removing ant binary: $ANT_BIN"
rm -f "$ANT_BIN"

echo "==> Removing daemon/registry state: $DATA_DIR"
rm -rf "$DATA_DIR"

echo "==> Clearing node data and logs under $NODES_ROOT"
rm -rf "$NODES_ROOT"/data/* "$NODES_ROOT"/logs/* 2>/dev/null || true

echo
echo "==> Clean state check:"
if [ -e "$ANT_BIN" ]; then echo "  ant binary: STILL PRESENT ($ANT_BIN)"; else echo "  ant binary: removed"; fi
if [ -e "$DATA_DIR" ]; then echo "  state dir : STILL PRESENT ($DATA_DIR)"; else echo "  state dir : removed"; fi
left=$(ps -ef 2>/dev/null | grep -e "ant-node" -e "ant node daemon" | grep -v grep)
if [ -n "$left" ]; then
    echo "  processes : STILL RUNNING:"
    echo "$left" | sed 's/^/    /'
else
    echo "  processes : none"
fi
echo "==> Done."
