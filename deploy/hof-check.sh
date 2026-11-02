#!/bin/bash
# The check of the server of Hof (docs/OPERATIONS.md, section «Проверка сервера»).
#
#   hof-check   prints the report and writes it to /var/lib/hof-check/status.txt
#
# hof-check.timer runs it every hour; by hand it is the same command. It only reads the state of
# the server: the one file it writes is its own status. Whatever it finds, nothing is restarted,
# cleaned up or rotated. The containers of Hof are found by the labels Compose puts on them, like
# in hof-backup and certbot-hook, so the containers of other projects are never touched.
#
# The first line of the report is the result and the time of the check, every other line is one
# finding: OK; WARN, Hof works but something needs attention; FAIL, Hof does not work or the data
# are at risk. Exit code: 0 OK, 1 WARN, 2 FAIL, 3 a wrong argument or the status not written.
#
# Runs as root: it needs Docker, the kernel log and the certificate.
set -u
export LC_ALL=C

PROJECT=hof
DOCKER=/usr/bin/docker
STATUS=/var/lib/hof-check/status.txt
BACKUPS=/var/backups/hof
LAST_PULL=/var/lib/hof-backup/state/last-pull
HOOK_FLAG=/run/hof-certbot-nginx-$PROJECT

# hof-backup refuses a copy with less free space than 1.5 GiB plus twice its last copy.
RESERVE_MB=1536
# Below this PostgreSQL may fail to write at any moment.
FAIL_FREE_MB=512
# The threshold of docs/OPERATIONS.md for available memory after work.
WARN_AVAILABLE_MB=150
# A nightly copy every 24 hours; the Mac signals the same age.
COPY_HOURS=36
# certbot renews 30 days before the end.
CERT_WARN_DAYS=21
CERT_FAIL_DAYS=7

# The request of the healthcheck in compose.yaml. Any answer counts: an image before M11.5 has no
# /healthz.
PROBE='exec 3<>/dev/tcp/127.0.0.1/3000 &&
  printf "GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n" >&3 &&
  IFS= read -r -t 3 line <&3 && printf "%s\n" "$line"'

if [ $# -ne 0 ]; then
  echo 'Использование: hof-check' >&2
  exit 3
fi

now=$(date -u +%s)
checked=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)
result=OK
findings=''

found() {
  findings+=$(printf '%-4s %s' "$1" "$2")$'\n'
  case $1 in
  FAIL) result=FAIL ;;
  WARN) if [ "$result" = OK ]; then result=WARN; fi ;;
  esac
}

# The status gets its name only when written in full: a reader never sees half of it.
publish() {
  local tmp
  if tmp=$(mktemp "${STATUS%/*}/.status.XXXXXX" 2>/dev/null); then
    if printf '%s %s\n%s' "$result" "$checked" "$findings" >"$tmp" && chmod 640 "$tmp" &&
      mv -f "$tmp" "$STATUS"; then
      return 0
    fi
    rm -f "$tmp"
  fi
  echo "hof-check: статус не записан в $STATUS" >&2
  return 1
}

# A check that did not finish leaves FAIL instead of the earlier result: an old OK must not look
# current. A stop by systemd ends the script through the same path.
finished=false
on_exit() {
  if $finished; then return; fi
  found FAIL 'hof-check: проверка не завершилась'
  printf '%s %s\n%s' "$result" "$checked" "$findings"
  publish
  exit 2
}
trap on_exit EXIT
trap 'exit 2' TERM INT HUP

# Every call has a time limit: a Docker that hangs gives FAIL instead of a check that never ends.
run_docker() { timeout 30 "$DOCKER" "$@"; }

epoch() { date -u -d "$1" +%s 2>/dev/null; }

# The time in the name of a copy or in last-pull, 20261102T033000Z.
stamp_epoch() { epoch "${1:0:8} ${1:9:2}:${1:11:2}:${1:13:2}"; }

# Containers of Hof.

declare -A count id state restarts oom health started log_type log_size log_files
docker_ok=false
if ids=$(run_docker ps --all --quiet \
  --filter "label=com.docker.compose.project=$PROJECT" \
  --filter label=com.docker.compose.oneoff=False 2>/dev/null); then
  docker_ok=true
fi
containers=''
if $docker_ok && [ -n "$ids" ]; then
  # The IDs are hex strings separated by line breaks.
  # shellcheck disable=SC2086
  if ! containers=$(run_docker inspect --format \
    '{{index .Config.Labels "com.docker.compose.service"}}|{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}|{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}|{{index .HostConfig.LogConfig.Config "max-file"}}' \
    $ids 2>/dev/null); then
    docker_ok=false
  fi
fi
while IFS='|' read -r s i st r o h t lt ls lf; do
  [ -n "$s" ] || continue
  count[$s]=$((${count[$s]:-0} + 1))
  id[$s]=$i state[$s]=$st restarts[$s]=$r oom[$s]=$o health[$s]=$h started[$s]=$t
  log_type[$s]=$lt log_size[$s]=${ls#<no value>} log_files[$s]=${lf#<no value>}
done <<<"$containers"

# The one container of a service, running.
running() { [ "${count[$1]:-0}" = 1 ] && [ "${state[$1]}" = running ]; }

if ! $docker_ok; then
  found FAIL 'Docker не ответил: контейнеры, живость hof, база и логи не проверены'
else
  logs=''
  for s in postgres hof nginx; do
    case ${count[$s]:-0} in
    0)
      found FAIL "контейнер $s: не найден"
      continue
      ;;
    1) ;;
    *)
      found FAIL "контейнер $s: их ${count[$s]}, ожидается один"
      continue
      ;;
    esac
    if [ "${state[$s]}" = running ]; then
      found OK "контейнер $s: running"
    else
      found FAIL "контейнер $s: ${state[$s]}"
    fi
    # RestartCount counts the restarts by the restart policy since the last start by hand, so it
    # warns about a recent failure only and does not stay a warning for ever.
    if [ "${restarts[$s]}" != 0 ]; then
      last=$(epoch "${started[$s]}")
      if [ -z "$last" ] || ((now - last < 86400)); then
        found WARN "контейнер $s: Docker перезапускал его после сбоя ${restarts[$s]} раз, последний запуск ${started[$s]}"
      else
        found OK "контейнер $s: перезапусков после сбоя ${restarts[$s]}, последний больше суток назад"
      fi
    fi
    if [ "${oom[$s]}" = true ]; then
      found WARN "контейнер $s: прошлый раз завершён по нехватке памяти (OOMKilled)"
    fi
    if [ "${log_type[$s]}" = json-file ] && [ -z "${log_size[$s]}" ]; then
      found WARN "логи $s: json-file без max-size, растут без предела"
    else
      logs+="${logs:+; }$s ${log_type[$s]}${log_size[$s]:+ ${log_size[$s]}}${log_files[$s]:+ × ${log_files[$s]}}"
    fi
  done
  if [ -n "$logs" ]; then found OK "логи: $logs"; fi

  # Whether the process answers, apart from the database.
  if running hof; then
    case ${health[hof]} in
    healthy) found OK 'живость hof: healthy' ;;
    starting) found WARN 'живость hof: starting, Hof запускается' ;;
    unhealthy) found FAIL 'живость hof: unhealthy, процесс не отвечает на /healthz' ;;
    none)
      # A container created before M11.5 has no healthcheck until an update recreates it. The same
      # request is made here instead, once.
      if answer=$(run_docker exec "${id[hof]}" bash -c "$PROBE" 2>/dev/null) &&
        [[ $answer =~ ^HTTP/1\.[01]\ [0-9]{3} ]]; then
        found WARN 'живость hof: процесс отвечает по HTTP; healthcheck в контейнере не настроен, контейнер создан до M11.5'
      else
        found FAIL 'живость hof: процесс не отвечает по HTTP; healthcheck в контейнере не настроен'
      fi
      ;;
    *) found WARN "живость hof: ${health[hof]}" ;;
    esac
  else
    found FAIL 'живость hof: не проверена, контейнер hof не работает'
  fi

  if running postgres; then
    ready=no
    selected=no
    if run_docker exec "${id[postgres]}" \
      pg_isready --host=127.0.0.1 --username=postgres --dbname=hof --timeout=5 >/dev/null 2>&1; then
      ready=yes
    fi
    if [ "$(run_docker exec -e PGCONNECT_TIMEOUT=5 "${id[postgres]}" \
      psql --username=postgres --dbname=hof --no-psqlrc -At -c 'SELECT 1' 2>/dev/null)" = 1 ]; then
      selected=yes
    fi
    case $ready$selected in
    yesyes) found OK 'база: pg_isready и SELECT 1 выполнены' ;;
    yesno) found FAIL 'база: pg_isready отвечает, SELECT 1 не выполнен' ;;
    noyes) found FAIL 'база: SELECT 1 выполнен, pg_isready не отвечает' ;;
    *) found FAIL 'база: не отвечает, ни pg_isready, ни SELECT 1' ;;
    esac
  else
    found FAIL 'база: не проверена, контейнер postgres не работает'
  fi
fi

# Copies and the space for the next one.

shopt -s nullglob
nightly=0
predeploy=0
newest=
newest_stamp=
# The names hof-backup gives, as hof-backup-send checks them.
for file in "$BACKUPS"/hof-*.dump; do
  [[ ${file##*/} =~ ^hof-(nightly|predeploy)-([0-9]{8}T[0-9]{6}Z)\.dump$ ]] || continue
  if [ "${BASH_REMATCH[1]}" = nightly ]; then
    nightly=$((nightly + 1))
  else
    predeploy=$((predeploy + 1))
  fi
  if [[ ${BASH_REMATCH[2]} > $newest_stamp ]]; then
    newest=$file
    newest_stamp=${BASH_REMATCH[2]}
  fi
done
last_mb=0
if [ -z "$newest" ]; then
  found FAIL "копии: в $BACKUPS нет ни одной"
else
  last_mb=$(($(stat -c %s "$newest") / 1048576))
  hours=$(((now - $(stamp_epoch "$newest_stamp")) / 3600))
  text="копии: ночных $nightly, предрелизных $predeploy, новейшая ${newest##*/}, $hours ч назад"
  if ((hours >= COPY_HOURS)); then
    found FAIL "$text: новых копий нет"
  else
    found OK "$text"
  fi
fi
if read -r attempt attempted reason 2>/dev/null <"$BACKUPS/backup-status.txt"; then
  if [ "$attempt" != OK ]; then
    found WARN "копии: попытка $attempted не удалась: $reason"
  fi
else
  found WARN 'копии: итога последней попытки нет'
fi
if read -r pulled 2>/dev/null <"$LAST_PULL" && [[ $pulled =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  hours=$(((now - $(stamp_epoch "$pulled")) / 3600))
  if ((hours >= COPY_HOURS)); then
    found WARN "забор на Mac: последний $hours ч назад"
  else
    found OK "забор на Mac: $hours ч назад"
  fi
else
  found WARN 'забор на Mac: времени забора нет, Mac ещё не забирал копий'
fi

root=
if $docker_ok; then root=$(run_docker info --format '{{.DockerRootDir}}' 2>/dev/null); fi
places=(/)
for dir in "$root" "$BACKUPS"; do
  if [ -n "$dir" ] && [ -d "$dir" ]; then places+=("$dir"); fi
done
need=$((RESERVE_MB + 2 * last_mb))
if space=$(df --output=target,avail -B1M "${places[@]}" 2>/dev/null); then
  while read -r target avail; do
    if ! [[ $avail =~ ^[0-9]+$ ]]; then
      found WARN "диск $target: свободное место не получено"
    elif ((avail < FAIL_FREE_MB)); then
      found FAIL "диск $target: свободно $avail МБ"
    elif ((avail < need)); then
      found WARN "диск $target: свободно $avail МБ, ночной копии нужно $need МБ"
    else
      found OK "диск $target: свободно $avail МБ"
    fi
  done < <(printf '%s\n' "$space" | tail -n +2 | sort -u)
else
  found WARN 'диск: df не ответил'
fi

# Memory.

memory=$(free -m 2>/dev/null)
read -r available < <(awk '$1 == "Mem:" { print $7 }' <<<"$memory")
read -r swap_total swap_used swap_free < <(awk '$1 == "Swap:" { print $2, $3, $4 }' <<<"$memory")
if [[ "$available $swap_total $swap_used $swap_free" =~ ^[0-9]+\ [0-9]+\ [0-9]+\ [0-9]+$ ]]; then
  if ((available < WARN_AVAILABLE_MB)); then
    found WARN "память: доступно $available МБ"
  else
    found OK "память: доступно $available МБ"
  fi
  if ((swap_total == 0)); then
    found OK 'swap: нет'
  elif ((swap_free * 10 < swap_total)); then
    found WARN "swap: занято $swap_used из $swap_total МБ, почти полон"
  else
    found OK "swap: занято $swap_used из $swap_total МБ"
  fi
else
  found WARN 'память: сведения free не получены'
fi

# journalctl -k would show the current boot only.
if kills=$(
  journalctl _TRANSPORT=kernel --since=-7d --no-pager --quiet --output=cat 2>/dev/null |
    grep -ci 'out of memory: kill'
  exit "${PIPESTATUS[0]}"
); then
  if ((kills > 0)); then
    found WARN "OOM ядра за 7 дней: $kills, подробности в journalctl -k"
  else
    found OK 'OOM ядра за 7 дней: нет'
  fi
else
  found WARN 'OOM ядра: журнал не прочитан'
fi

# The certificate nginx is given, its renewal and what the hook may have left.

live=
if $docker_ok && [ "${count[nginx]:-0}" = 1 ]; then
  live=$(run_docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "${id[nginx]}" \
    2>/dev/null | grep -m 1 '^/etc/letsencrypt/live/')
fi
if [ -z "$live" ]; then
  found WARN 'сертификат: не проверен, нет контейнера nginx с каталогом сертификата'
elif ! end=$(openssl x509 -in "$live/cert.pem" -noout -enddate 2>/dev/null) ||
  ! end=$(epoch "${end#notAfter=}"); then
  found WARN "сертификат ${live##*/}: не прочитан"
else
  days=$(((end - now) / 86400))
  if ((end <= now)); then
    found FAIL "сертификат ${live##*/}: истёк"
  elif ((days < CERT_FAIL_DAYS)); then
    found FAIL "сертификат ${live##*/}: осталось $days дн."
  elif ((days < CERT_WARN_DAYS)); then
    found WARN "сертификат ${live##*/}: осталось $days дн., продление не удаётся"
  else
    found OK "сертификат ${live##*/}: осталось $days дн."
  fi
fi
timer=$(systemctl is-active certbot.timer 2>/dev/null)
if [ "$timer" = active ]; then
  found OK 'certbot.timer: active'
else
  found WARN "certbot.timer: ${timer:-не найден}, сертификат не продлится"
fi
if [ -e "$HOOK_FLAG" ]; then
  found WARN "хук certbot: остался флаг $HOOK_FLAG, раздел «Диагностика»"
fi

usage=$(journalctl --disk-usage 2>/dev/null | sed -n 's/.* take up \([^ ]*\) .*/\1/p')
found OK "journald: ${usage:-размер не получен}, только показывается"

finished=true
printf '%s %s\n%s' "$result" "$checked" "$findings"
publish || exit 3
case $result in
OK) exit 0 ;;
WARN) exit 1 ;;
*) exit 2 ;;
esac
