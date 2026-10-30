#!/bin/bash
# Pulls the backups of Hof to the Mac (docs/OPERATIONS.md, section «Копия на Mac»).
#
# launchd starts it at load and every hour while the Mac is awake, and never starts a second run
# during the first. A retry after a failure is the next hourly run. The server is the alias
# hof-backup in ~/.ssh/config. Written for the bash 3.2 of macOS.
set -u
umask 077
export LC_ALL=C

DIR=$HOME/hof-backups
HOST=hof-backup
STAMP='[0-9]{8}T[0-9]{6}Z'
NAME="^hof-(nightly|predeploy)-$STAMP\\.dump\$"

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1"; }

remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -o StrictHostKeyChecking=yes "$HOST" "$@"
}

# At most once in 12 hours for each kind of signal. The text holds only constant strings of this
# file: no answer of the server reaches AppleScript.
notify() {
  local flag="$DIR/.notified-$1"
  say "$2"
  [ -n "$(find "$flag" -mmin -720 2>/dev/null)" ] && return 0
  # The mark only after it is shown: otherwise a failure would silence the retry for 12 hours.
  if osascript -e "display notification \"$2\" with title \"Hof: резервные копии\"" >/dev/null; then
    touch "$flag"
  else
    say 'уведомление не показано'
  fi
}

# The newest time among the names of copies on stdin.
newest_stamp() { sed -E 's/^hof-[a-z]+-//; s/\.dump$//' | sort | tail -n 1; }

local_copies() { ls -1 "$DIR" | grep -E "^hof-$1-$STAMP\\.dump\$" | sort; }

hours_ago() {
  date -u -v-"$1"H +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d "$1 hours ago" +%Y%m%dT%H%M%SZ
}

# A complete copy: the archive has a .meta with SHA-256 and the size written there. The contents
# are not read here: SHA-256 is computed on a pull, not every hour over the whole history.
is_complete() {
  local file="$DIR/$1"
  [ -f "$file" ] && [ -f "$file.meta" ] || return 1
  grep -Eq '^sha256=[0-9a-f]{64}$' "$file.meta" || return 1
  [ "$(sed -n 's/^size=//p' "$file.meta")" = "$(wc -c <"$file" | tr -d ' ')" ]
}

# An incomplete archive is not deleted: it may be the only copy of that day. If the server still
# has it, the pull has already replaced it with a verified one. Age counts complete copies only.
# A Mac that is off cannot say any of this: the signal comes when it is on again.
check_local_copies() {
  local name complete='' incomplete=''
  for name in $(ls -1 "$DIR" | grep -E "$NAME"); do
    if is_complete "$name"; then
      complete="$complete$name"$'\n'
    else
      incomplete="$incomplete $name"
    fi
  done
  if [ -n "$incomplete" ]; then
    say "копии без проверяемых сведений:$incomplete"
    notify incomplete 'Есть копия без проверяемых сведений: она сохранена, но не считается полной'
  fi
  local newest
  newest=$(printf '%s' "$complete" | newest_stamp)
  if [ -z "$newest" ] || [[ $newest < $(hours_ago 36) ]]; then
    notify stale-local 'На Mac нет копии моложе 36 часов'
  fi
}

# An archive gets its name only after SHA-256 matches the .meta. The .meta is published last: a
# failure at any step leaves the copy incomplete, so it is pulled again, and an earlier archive is
# replaced only by a verified one.
fetch_copy() {
  local name=$1 part meta want got
  part=$(mktemp "$DIR/.$name.part.XXXXXX") || return 1
  meta=$(mktemp "$DIR/.$name.meta.part.XXXXXX") || {
    rm -f "$part"
    return 1
  }
  if remote fetch "$name.meta" >"$meta" && remote fetch "$name" >"$part"; then
    want=$(sed -n 's/^sha256=//p' "$meta")
    got=$(shasum -a 256 "$part")
    got=${got%% *}
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
      rm -f "$DIR/$name.meta"
      if mv -f "$part" "$DIR/$name" && mv -f "$meta" "$DIR/$name.meta"; then
        say "забрана $name, $(wc -c <"$DIR/$name" | tr -d ' ') байт"
        return 0
      fi
      say "$name не сохранена"
    else
      notify integrity 'Копия с сервера не совпала по SHA-256 и не сохранена'
    fi
  else
    say "$name не забрана"
  fi
  rm -f "$part" "$meta"
  return 1
}

# Only after a new verified copy. Copies are counted, so a long downtime of the Mac does not delete
# history. The newest copy is among the last 30 or 5 and stays.
thin_copies() {
  local nightly keep name
  nightly=$(local_copies nightly)
  keep=$({
    printf '%s\n' "$nightly" | tail -n 30
    printf '%s\n' "$nightly" |
      awk '{ month = substr($0, 13, 6); if (month != seen) { print; seen = month } }' |
      tail -n 12
    local_copies predeploy | tail -n 5
  } | sort -u)
  for name in $({
    local_copies nightly
    local_copies predeploy
  } | grep -vxF -e "$keep"); do
    rm -f "$DIR/$name" "$DIR/$name.meta"
    say "удалена старая копия $name"
  done
}

mkdir -p "$DIR" && chmod 700 "$DIR" || exit 1
touch "$DIR/.metadata_never_index"

# Copies must not reach a Time Machine disk. Without the exclusion the pull goes on only by the
# decision of the owner: the file .time-machine-allowed in the folder of copies.
if ! tmutil addexclusion "$DIR" >/dev/null; then
  if [ -f "$DIR/.time-machine-allowed" ]; then
    say 'исключение из Time Machine не установлено, забор разрешён владельцем'
  else
    notify time-machine 'Каталог копий не исключён из Time Machine: копии не забираются'
    exit 1
  fi
fi

case $(fdesetup status 2>/dev/null) in
*'FileVault is On'*) ;;
*)
  notify filevault 'FileVault выключен: копии не забираются'
  exit 1
  ;;
esac

raw_list=$(remote list)
if [ "$?" -ne 0 ]; then
  say 'сервер недоступен'
  [ -f "$DIR/.last-contact" ] || touch "$DIR/.last-contact"
  if [ -n "$(find "$DIR/.last-contact" -mmin +1440 2>/dev/null)" ]; then
    notify unreachable 'Сервер недоступен больше суток'
  fi
  check_local_copies
  exit 1
fi
touch "$DIR/.last-contact"
list=$(printf '%s\n' "$raw_list" | grep -E "$NAME" | sort)

# Compared before the pull: new copies would hide the gap.
oldest_remote=$(printf '%s\n' "$list" | grep '^hof-nightly-' | head -n 1 | newest_stamp)
newest_local=$(local_copies nightly | newest_stamp)
if [ -n "$oldest_remote" ] && [ -n "$newest_local" ] && [[ $newest_local < $oldest_remote ]]; then
  notify gap 'На сервере уже нет части копий: в истории на Mac возможен разрыв'
fi

fetched=0
result=0
for name in $list; do
  is_complete "$name" && continue
  if [ -f "$DIR/$name" ]; then say "$name: нет проверяемых сведений, забираем заново"; fi
  if ! fetch_copy "$name"; then
    result=1
    break
  fi
  fetched=$((fetched + 1))
done
if [ "$fetched" -gt 0 ]; then thin_copies; fi

newest_remote=$(printf '%s\n' "$list" | newest_stamp)
if [ -z "$newest_remote" ] || [[ $newest_remote < $(hours_ago 36) ]]; then
  notify stale-server 'На сервере нет копии моложе 36 часов'
fi
check_local_copies

status=$(remote status)
case $status in
FAIL*)
  say "сервер: $(printf '%s\n' "$status" | head -n 1 | cut -c1-200)"
  notify failed 'Последняя копия на сервере не создана'
  ;;
esac

say "готово: забрано $fetched"
exit "$result"
