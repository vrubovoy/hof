#!/bin/bash
# The only command of the SSH key of hof-backup (docs/OPERATIONS.md, section «Копия на Mac»):
#
#   list          the names of the ready copies, one per line
#   fetch <name>  a copy or its .meta file
#   status        the result of the last attempt to make a copy
#
# No shell parses the input: SSH_ORIGINAL_COMMAND is compared with exact forms and the file name
# with a strict pattern. It takes no lock: a copy appears under its name atomically, and a file
# deleted while it is read is still read to the end.
set -euo pipefail
export LC_ALL=C

DIR=/var/backups/hof
LAST_PULL=/var/lib/hof-backup/state/last-pull
NAME='^hof-(nightly|predeploy)-[0-9]{8}T[0-9]{6}Z\.dump(\.meta)?$'

request=${SSH_ORIGINAL_COMMAND:-}
case $request in
list)
  shopt -s nullglob
  for file in "$DIR"/hof-*.dump; do
    name=${file##*/}
    if [[ $name =~ $NAME ]]; then echo "$name"; fi
  done
  ;;
status)
  if [ -f "$DIR/backup-status.txt" ]; then cat "$DIR/backup-status.txt"; else echo 'NONE'; fi
  ;;
'fetch '*)
  name=${request#fetch }
  if ! [[ $name =~ $NAME ]]; then
    echo 'hof-backup-send: команда не разрешена' >&2
    exit 2
  fi
  if [ ! -f "$DIR/$name" ]; then
    echo 'hof-backup-send: такой копии нет' >&2
    exit 1
  fi
  cat -- "$DIR/$name"
  # hof-check shows the time of the pull. A failed write does not undo a copy already sent.
  if [[ $name != *.meta ]]; then
    date -u +%Y%m%dT%H%M%SZ >"$LAST_PULL" || echo 'hof-backup-send: время забора не записано' >&2
  fi
  ;;
*)
  echo 'hof-backup-send: команда не разрешена' >&2
  exit 2
  ;;
esac
