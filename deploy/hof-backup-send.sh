#!/bin/bash
# Единственная команда SSH-ключа hof-backup (docs/OPERATIONS.md, раздел «Копия на Mac»):
#
#   list          имена готовых копий, по одному в строке
#   fetch <имя>   содержимое копии или её файла .meta
#   status        итог последней попытки создать копию
#
# Ввод не разбирается shell: SSH_ORIGINAL_COMMAND сравнивается с точными формами, а имя файла — со
# строгим шаблоном. Блокировку не берёт: копии появляются под рабочим именем атомарно, а файл,
# который удаляют во время чтения, дочитывается до конца.
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
  # Время забора показывает hof-check. Неудачная запись не отменяет уже переданную копию.
  if [[ $name != *.meta ]]; then
    date -u +%Y%m%dT%H%M%SZ >"$LAST_PULL" || echo 'hof-backup-send: время забора не записано' >&2
  fi
  ;;
*)
  echo 'hof-backup-send: команда не разрешена' >&2
  exit 2
  ;;
esac
