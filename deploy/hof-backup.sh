#!/bin/bash
# Backup of the database of Hof (docs/OPERATIONS.md, section «Автоматические копии»).
#
#   hof-backup                           by hand: waits for the lock up to 60 s
#   hof-backup --timer                   from hof-backup.timer: waits for the lock up to 10 minutes
#   hof-backup --pre-deploy              a copy before an update: waits for the lock up to 60 s
#   hof-backup --pre-deploy --lock-held  the same, the update command already holds the lock
#
# Runs as root. It finds the postgres container by the labels Compose puts on it, like certbot-hook,
# so it depends on neither compose.yaml nor .env. Hof need not stop: pg_dump reads a consistent
# snapshot.
#
# Exit code: 0 the copy is ready; 1 no copy, the earlier ones are in place; 2 a wrong argument;
# 3 the lock is taken, nothing changed.
set -euo pipefail
export LC_ALL=C
umask 027

PROJECT=hof
DOCKER=/usr/bin/docker
DIR=/var/backups/hof
LOCK=/run/lock/hof-ops.lock
STATUS=$DIR/backup-status.txt
# Free space kept on top of twice the size of the last copy: the threshold of docs/OPERATIONS.md.
RESERVE_KB=$((1536 * 1024))

kind=nightly
lock_wait=60
lock_held=false
for arg in "$@"; do
  case $arg in
  --timer) lock_wait=600 ;;
  --pre-deploy) kind=predeploy ;;
  --lock-held) lock_held=true ;;
  *)
    echo "Использование: $0 [--timer] [--pre-deploy] [--lock-held]" >&2
    exit 2
    ;;
  esac
done

if ! $lock_held; then
  exec 9>>"$LOCK"
  if ! flock --wait "$lock_wait" 9; then
    echo "hof-backup: блокировка занята дольше $lock_wait с (последняя запись в ней: $(cat "$LOCK")); копия не создана, файлы не менялись" >&2
    exit 3
  fi
  # For whoever waits next: which operation holds the lock.
  : >"$LOCK"
  echo "hof-backup $kind, pid $$, с $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&9
fi

# The result of the last attempt, read by hof-backup-send and hof-check.
write_status() {
  local tmp
  tmp=$(mktemp "$DIR/.backup-status.XXXXXX")
  printf '%s %s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >"$tmp"
  chmod 640 "$tmp"
  mv -f "$tmp" "$STATUS"
}

part=
meta_part=
published_meta=
step='подготовка'
on_exit() {
  local code=$?
  rm -f -- ${part:+"$part"} ${meta_part:+"$meta_part"} ${published_meta:+"$published_meta"}
  [ "$code" -eq 0 ] && return
  echo "hof-backup: копия не создана: $step" >&2
  write_status FAIL "$kind: $step" || echo 'hof-backup: статус не записан' >&2
}
trap on_exit EXIT

step="нет каталога $DIR"
[ -d "$DIR" ]
shopt -s nullglob

# The lock is ours, so such files can only be left by a process that was killed.
leftovers=("$DIR"/.*.part.*)
if [ "${#leftovers[@]}" -gt 0 ]; then rm -f -- "${leftovers[@]}"; fi

step='контейнер postgres не найден или найден не один'
ids=$("$DOCKER" ps --quiet \
  --filter "label=com.docker.compose.project=$PROJECT" \
  --filter label=com.docker.compose.service=postgres \
  --filter label=com.docker.compose.oneoff=False)
# The IDs become the positional parameters: hex strings separated by line breaks.
# shellcheck disable=SC2086
set -- $ids
[ "$#" -eq 1 ]
postgres=$1

# Space is checked before the copy is made. Good copies are never deleted to make room for it.
step='не удалось определить свободное место'
newest=
for file in "$DIR"/hof-*.dump; do
  if [ -z "$newest" ] || [ "$file" -nt "$newest" ]; then newest=$file; fi
done
last_kb=0
if [ -n "$newest" ]; then last_kb=$(($(stat -c %s "$newest") / 1024)); fi
need_kb=$((RESERVE_KB + 2 * last_kb))
free_kb=$(df --output=avail -k "$DIR" | tail -n 1 | tr -d ' ')
if [ "$free_kb" -lt "$need_kb" ]; then
  step="мало места: свободно $free_kb КБ, нужно $need_kb КБ; прежние копии сохранены"
  exit 1
fi

step='не удалось создать временные файлы'
name=hof-$kind-$(date -u +%Y%m%dT%H%M%SZ).dump
part=$(mktemp "$DIR/.$name.part.XXXXXX")
meta_part=$(mktemp "$DIR/.$name.meta.part.XXXXXX")

step='pg_dump завершился с ошибкой'
"$DOCKER" exec "$postgres" pg_dump --username=postgres --dbname=hof --format=custom >"$part"

# --list reads the table of contents only and misses cut data; this reads the whole archive.
step='архив не читается целиком'
"$DOCKER" exec -i "$postgres" pg_restore --file=/dev/null <"$part"

step='не удалось записать сведения о копии'
sha=$(sha256sum "$part")
sha=${sha%% *}
size=$(stat -c %s "$part")
image=$("$DOCKER" ps --all \
  --filter "label=com.docker.compose.project=$PROJECT" \
  --filter label=com.docker.compose.service=hof \
  --format '{{.Image}}' | head -n 1 || true)
{
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "size=$size"
  echo "sha256=$sha"
  echo "image=${image:--}"
} >"$meta_part"
chmod 640 "$part" "$meta_part"

# ln, not mv: a file of the same name is never replaced. The .meta comes before the archive, so
# every archive in the folder already has one. If the archive cannot be published, on_exit removes
# the .meta of this attempt only: on a .meta that was already there the first ln fails earlier.
step="не удалось опубликовать $name: имя занято или ошибка записи"
ln "$meta_part" "$DIR/$name.meta"
published_meta=$DIR/$name.meta
ln "$part" "$DIR/$name"
published_meta=

# Old copies go only now and only of this kind. The glob is sorted by the time in the name.
step='копия создана, но очистка старых не удалась'
case $kind in
nightly) keep=7 ;;
predeploy) keep=3 ;;
esac
copies=("$DIR"/hof-"$kind"-[0-9]*T[0-9]*Z.dump)
for ((i = 0; i < ${#copies[@]} - keep; i++)); do
  rm -f -- "${copies[i]}" "${copies[i]}.meta"
done

write_status OK "$name"
echo "hof-backup: копия готова: $name, $size байт"
