#!/usr/bin/env bash
# Replay polarismusic history through the substreams sink, one bounded window at
# a time.
#
# Providers cap blocks-per-request (`limit-processed-blocks`), so a long span has
# to be walked in chunks rather than asked for in a single request. With
# production mode enabled (sink/args.mjs), blocks holding no action for the
# contract are skipped entirely — an empty 10,000-block window costs 0 processed
# blocks — so the cap bounds the span you may *ask* for, not what you pay.
#
# Resumable: if a window fails, re-run with START=<that block>.
#
#   ~/polaris-music/substreams/scripts/replay.sh            # from first setcode
#   START=283275000 WINDOW=1000 .../replay.sh               # one narrow window
#
set -euo pipefail

START=${START:-282075751}    # first setcode for polarismusic
WINDOW=${WINDOW:-10000}      # provider cap per request
RPC=${RPC:-https://jungle4.greymass.com}

# Substreams accounts for whole 1,000-block segments, so an unaligned start
# makes a 10,000-block window span ELEVEN segments and blow the 10,000 cap:
#
#   FailedPrecondition: request needs to process a total of 11000 blocks but
#   only 10000 are allowed according to the 'limit-processed-blocks' request
#   argument
#
# ceil((282075751 + 10000)/1000) - floor(282075751/1000) = 11. Rounding the
# start down to a segment boundary makes every window exactly 10 segments.
SEGMENT=1000
START=$(( START / SEGMENT * SEGMENT ))

HEAD=$(curl -sS -X POST "$RPC/v1/chain/get_info" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["head_block_num"])')

# Stop short of head: the always-on sink already covers the last 10k blocks.
END=$(( (HEAD - 10000) / SEGMENT * SEGMENT ))
SPAN=$((END - START))
WINDOWS=$(( (SPAN + WINDOW - 1) / WINDOW ))

echo "head:    $HEAD"
echo "range:   $START -> $END  ($SPAN blocks, $((SPAN / 172800)) days of chain)"
echo "windows: $WINDOWS passes of $WINDOW blocks"
echo

read -rp "Run $WINDOWS replay passes? [y/N] " ok
[[ $ok == y ]] || exit 0

cd "$(dirname "$0")/../.."

n=0
for ((b=START; b<END; b+=WINDOW)); do
  n=$((n+1))
  echo "=== [$n/$WINDOWS] blocks $b .. +$WINDOW"
  START_BLOCK=$b STOP_BLOCK=+$WINDOW \
    docker compose run --rm --no-deps substreams-sink || {
      echo "window $b failed — resume with:  START=$b $0" >&2
      exit 1
    }
done
echo "replay complete"
