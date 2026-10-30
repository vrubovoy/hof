#!/bin/bash
# Забор резервных копий Hof на Mac (docs/OPERATIONS.md, раздел «Копия на Mac»).
#
# launchd запускает его при загрузке и каждый час, пока Mac не спит, и не начинает второй запуск,
# пока идёт первый. Повтор после сбоя — следующий часовой запуск. Сервер задан псевдонимом
# hof-backup в ~/.ssh/config. Написано для bash 3.2 из macOS.
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

# Не чаще раза в 12 часов для каждого вида сигнала. В текст идут только постоянные строки этого
# файла: ответ сервера в AppleScript не попадает.
notify() {
  local flag="$DIR/.notified-$1"
  say "$2"
  [ -n "$(find "$flag" -mmin -720 2>/dev/null)" ] && return 0
  touch "$flag"
  osascript -e "display notification \"$2\" with title \"Hof: резервные копии\"" >/dev/null ||
    say 'уведомление не показано'
}

# Самая новая метка времени из имён копий на входе.
newest_stamp() { sed -E 's/^hof-[a-z]+-//; s/\.dump$//' | sort | tail -n 1; }

local_copies() { ls -1 "$DIR" | grep -E "^hof-$1-$STAMP\\.dump\$" | sort; }

hours_ago() {
  date -u -v-"$1"H +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d "$1 hours ago" +%Y%m%dT%H%M%SZ
}

# Новейшая локальная копия: выключенный Mac этого сообщить не может, сигнал приходит при включении.
check_local_age() {
  local newest
  newest=$(ls -1 "$DIR" | grep -E "$NAME" | newest_stamp)
  if [ -z "$newest" ] || [[ $newest < $(hours_ago 36) ]]; then
    notify stale-local 'На Mac нет копии моложе 36 часов'
  fi
}

# Архив под рабочим именем появляется только после сверки SHA-256 с файлом .meta.
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
      mv -f "$meta" "$DIR/$name.meta"
      mv -f "$part" "$DIR/$name"
      say "забрана $name, $(wc -c <"$DIR/$name" | tr -d ' ') байт"
      return 0
    fi
    notify integrity 'Копия с сервера не совпала по SHA-256 и не сохранена'
  else
    say "$name не забрана"
  fi
  rm -f "$part" "$meta"
  return 1
}

# Только после новой проверенной копии. Считаем по количеству, поэтому долгий простой Mac не
# удаляет историю. Новейшая копия входит в последние 30 или 5 и не удаляется.
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
tmutil addexclusion "$DIR" >/dev/null 2>&1 || say 'исключение из Time Machine не установлено'

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
  check_local_age
  exit 1
fi
touch "$DIR/.last-contact"
list=$(printf '%s\n' "$raw_list" | grep -E "$NAME" | sort)

# Сравниваем до забора: новые копии скрыли бы разрыв.
oldest_remote=$(printf '%s\n' "$list" | grep '^hof-nightly-' | head -n 1 | newest_stamp)
newest_local=$(local_copies nightly | newest_stamp)
if [ -n "$oldest_remote" ] && [ -n "$newest_local" ] && [[ $newest_local < $oldest_remote ]]; then
  notify gap 'На сервере уже нет части копий: в истории на Mac возможен разрыв'
fi

fetched=0
result=0
for name in $list; do
  [ -f "$DIR/$name" ] && continue
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
check_local_age

status=$(remote status)
case $status in
FAIL*)
  say "сервер: $(printf '%s\n' "$status" | head -n 1 | cut -c1-200)"
  notify failed 'Последняя копия на сервере не создана'
  ;;
esac

say "готово: забрано $fetched"
exit "$result"
