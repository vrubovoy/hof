#!/bin/bash
# Updates Hof on the server to the image of a digest (docs/OPERATIONS.md, section «Обновление»).
#
#   hof-deploy status                   the release that runs, the containers, the last update
#   hof-deploy deploy sha256:<64 hex>   update to the image of that digest
#
# Runs as root, by hand or through sudo from hof-deploy-ssh. The address of the image lives in a
# file of root; the client gives only the digest. Nothing is built and Git is not used: the
# configuration of the release comes from /app/release of the same image.
#
# Hof stops only after a verified copy made while it runs. The update runs on the same database,
# so records made after the snapshot stay. PostgreSQL, its volume and other services are never
# changed: only hof and nginx are recreated, with --no-deps. On a failure Hof is stopped and the
# command tells what happened to the migrations; it restores nothing.
#
# Exit code: 0 updated; 1 refused or failed, the message says what changed; 2 a wrong argument;
# 3 the lock is taken, nothing changed.

# Nothing of the caller's environment: a fixed PATH, and no COMPOSE_*, DOCKER_* or BASH_ENV.
if [ "${HOF_DEPLOY_CLEAN:-}" != 1 ]; then
  exec /usr/bin/env -i HOF_DEPLOY_CLEAN=1 HOME=/root LC_ALL=C \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash "$0" "$@"
fi
set -u
umask 027

DIR=/opt/hof
PROJECT=hof
VOLUME=hof_pgdata
IMAGE_FILE=/etc/hof-deploy/image
LOCK=/run/lock/hof-ops.lock
LOG=/var/log/hof-deploy.log
HOOK_FLAG=/run/hof-certbot-nginx-$PROJECT
# The 1.5 GiB that hof-backup keeps for its copy, and room for the new image, about 300 MB.
MIN_FREE_MB=2048
# The threshold of docs/OPERATIONS.md for a running Hof after 10 minutes idle.
MIN_AVAILABLE_MB=250

if [ "$#" -eq 1 ] && [ "$1" = status ]; then
  action=status
elif [ "$#" -eq 2 ] && [ "$1" = deploy ] && [[ $2 =~ ^sha256:[0-9a-f]{64}$ ]]; then
  action=deploy
  digest=$2
else
  echo 'Использование: hof-deploy status | hof-deploy deploy sha256:<64 шестнадцатеричных знака>' >&2
  exit 2
fi

say() {
  echo "$1"
  echo "$1" >>"$LOG"
}

# The one container of a service of the project, in any state.
container() {
  docker ps --all --quiet --no-trunc \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" \
    --filter label=com.docker.compose.oneoff=False
}

# The applied migrations as module/file, one per line.
applied() {
  docker exec "$1" psql --username=postgres --dbname=hof --no-psqlrc -At --set ON_ERROR_STOP=1 -c \
    "SELECT 'core/' || name FROM core.schema_migrations UNION ALL SELECT 'saeckel/' || name FROM saeckel.schema_migrations" |
    sort
}

# Running containers other than hof and nginx of this project: ID, start time, name.
others() {
  docker ps --quiet --no-trunc | xargs -r docker inspect --format \
    '{{.Id}} {{.State.StartedAt}} {{.Name}} {{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' |
    grep -v -e " $PROJECT/hof\$" -e " $PROJECT/nginx\$" | sort
}

# What a failed start left in the database: the sets before the update, after the failure and of
# the image, sorted, one name per line.
classify() {
  local before=$1 after=$2 image=$3
  if [ "$after" = "$before" ]; then
    echo none
  elif [ "$after" = "$image" ]; then
    echo all
  elif [ -z "$(comm -23 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))" ] &&
    [ -z "$(comm -23 <(printf '%s\n' "$after") <(printf '%s\n' "$image"))" ]; then
    echo partial
  else
    echo unknown
  fi
}

# Lines of the first set that the second does not have.
minus() { comm -23 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | grep -v '^$' | paste -sd ' ' -; }

current_digest() {
  if [ -f "$DIR/release.yaml" ]; then
    sed -n 's/^ *image: .*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$DIR/release.yaml"
  fi
}

if [ "$action" = status ]; then
  echo "Выпуск: $(current_digest | grep . || echo 'образ собран из Git, hof-deploy ещё не запускался')"
  for service in postgres hof nginx; do
    id=$(container "$service" | head -n 1)
    if [ -z "$id" ]; then
      echo "$service: контейнера нет"
    else
      docker inspect --format "$service: {{.State.Status}}{{if .State.Health}}, {{.State.Health.Status}}{{end}}, запущен {{.State.StartedAt}}" "$id"
    fi
  done
  echo 'Последнее обновление:'
  if [ -f "$LOG" ]; then
    awk '/^=== /{block=""} {block = block $0 "\n"} END {printf "%s", block}' "$LOG"
  else
    echo 'не было'
  fi
  exit 0
fi

exec 9>>"$LOCK"
if ! flock --wait 60 9; then
  echo "hof-deploy: блокировка занята дольше 60 с (последняя запись в ней: $(cat "$LOCK")); ничего не менялось" >&2
  exit 3
fi
: >"$LOCK"
echo "hof-deploy $digest, pid $$, с $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&9

touch "$LOG" && chmod 640 "$LOG"
say "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) hof-deploy deploy $digest"

stage=
extract=
cleanup() {
  if [ -n "$extract" ]; then docker rm "$extract" >/dev/null 2>&1; fi
  if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT

# A refusal before Hof stops: nothing was changed.
refuse() {
  say "ОТКАЗ: $1"
  say 'итог: отказ, Hof не останавливался, конфигурация не менялась'
  exit 1
}

# 1-2. The checks that change nothing.

if [ -e "$HOOK_FLAG" ]; then
  refuse "есть флаг $HOOK_FLAG: идёт продление сертификата или post-hook не завершился (раздел «Диагностика»)"
fi
image=$(cat "$IMAGE_FILE" 2>/dev/null)
if ! [[ $image =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$ ]]; then
  refuse "в $IMAGE_FILE нет адреса образа вида ghcr.io/vrubovoy/hof"
fi
ref=$image@$digest
cd "$DIR" || refuse "нет каталога $DIR"

# The layout: either the files of the Git working copy before the first update, or the links to the
# current release.
if [ -f compose.yaml ] && [ ! -L compose.yaml ] && [ -d deploy ] && [ ! -L deploy ] &&
  [ ! -e release ] && [ ! -L release ] && [ ! -e release.yaml ] && [ ! -e releases/git ]; then
  first=true
elif [ "$(readlink compose.yaml)" = release/compose.yaml ] && [ "$(readlink deploy)" = release/deploy ] &&
  [ "$(readlink release.yaml)" = release/release.yaml ] && [ -L release ] && [ -d release/ ]; then
  first=false
else
  refuse "раскладка $DIR не распознана: ожидаются файлы Git или ссылки на release/"
fi
compose_file=$(sed -n 's/^COMPOSE_FILE=//p' .env 2>/dev/null | tail -n 1)
if ! [[ $compose_file =~ ^compose\.yaml(:deploy/[A-Za-z0-9._-]+\.yaml)*:release\.yaml$ ]]; then
  refuse 'в .env нужна строка COMPOSE_FILE с файлами выпуска и последним release.yaml'
fi
domain=$(sed -n 's/^HOF_DOMAIN=//p' .env | tail -n 1)
if ! [[ $domain =~ ^[a-z0-9.-]+$ ]]; then refuse 'в .env нет HOF_DOMAIN'; fi

postgres=$(container postgres)
if [ "$(printf '%s\n' "$postgres" | grep -c .)" != 1 ] ||
  [ "$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres")" != 'running healthy' ]; then
  refuse 'PostgreSQL Hof не найден, не один или не здоров'
fi
pg_state=$(docker inspect --format "{{.State.StartedAt}} {{range .Mounts}}{{if eq .Destination \"/var/lib/postgresql\"}}{{.Name}}{{end}}{{end}}" "$postgres")
if [ "${pg_state##* }" != "$VOLUME" ]; then refuse "PostgreSQL Hof работает не на томе $VOLUME"; fi
pg_hash=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$postgres")
free_mb=$(df --output=avail -m "$(docker info --format '{{.DockerRootDir}}')" | tail -n 1 | tr -d ' ')
available_mb=$(free -m | awk '$1 == "Mem:" { print $7 }')
if ! [[ $free_mb =~ ^[0-9]+$ ]] || ((free_mb < MIN_FREE_MB)); then
  refuse "мало места: свободно ${free_mb:-?} МБ, нужно $MIN_FREE_MB МБ"
fi
if ! [[ $available_mb =~ ^[0-9]+$ ]] || ((available_mb < MIN_AVAILABLE_MB)); then
  refuse "мало памяти: доступно ${available_mb:-?} МБ, нужно $MIN_AVAILABLE_MB МБ"
fi
before_others=$(others)
if ! before=$(applied "$postgres") || [ -z "$before" ]; then
  refuse 'применённые миграции не прочитаны'
fi
previous=$(current_digest)
say "Сейчас: ${previous:-образ из Git}; миграции: $(paste -sd ' ' - <<<"$before")"

# 3. The image by its digest, and its release configuration and migrations without starting it.

say "Загрузка $ref"
if ! docker pull --quiet "$ref" >/dev/null; then refuse "образ $ref не загружен"; fi
if ! docker image inspect --format '{{join .RepoDigests "\n"}}' "$ref" | grep -qxF "$ref"; then
  refuse "загруженный образ не имеет digest $digest"
fi
say "Коммит образа: $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")"
# The lock is ours, so a stage left here belongs to a run that was killed.
rm -rf -- releases/.stage.*
stage=$DIR/releases/.stage.$$
extract=hof-deploy-extract-$$
mkdir -p "$stage/migrations" || refuse "не создан каталог $stage"
if ! docker create --name "$extract" "$ref" >/dev/null ||
  ! docker cp "$extract:/app/release" "$stage/config" ||
  ! docker cp "$extract:/app/src/core/migrations" "$stage/migrations/core" ||
  ! docker cp "$extract:/app/src/saeckel/migrations" "$stage/migrations/saeckel"; then
  refuse 'конфигурация выпуска не извлечена из образа'
fi
docker rm "$extract" >/dev/null
extract=
printf '%s\n' \
  '# Written by hof-deploy: Hof runs the image of this digest and is never built on the server.' \
  'services:' \
  '  hof:' \
  "    image: $ref" \
  '    build: !reset null' >"$stage/config/release.yaml"
image_set=$(cd "$stage/migrations" && ls core/*.sql saeckel/*.sql 2>/dev/null | sort)

# 4. Refusals without downtime. The new configuration is read with the paths of $DIR, as it will
# be after the switch: the same paths give the same hash of postgres.

files=()
IFS=: read -r -a entries <<<"$compose_file"
for entry in "${entries[@]}"; do
  if [ ! -f "$stage/config/$entry" ]; then refuse "в выпуске нет $entry из COMPOSE_FILE"; fi
  files+=(--file "$stage/config/$entry")
done
staged() { docker compose --project-directory "$DIR" "${files[@]}" "$@"; }
if ! config=$(staged config 2>/dev/null); then
  refuse 'docker compose config не проходит с текущим .env'
fi
if [ "$(head -n 1 <<<"$config")" != "name: $PROJECT" ]; then refuse "проект выпуска не $PROJECT"; fi
if ! awk '/^volumes:/ { inside = 1; next } /^[^ ]/ { inside = 0 } inside' <<<"$config" | grep -qx "    name: $VOLUME"; then
  refuse "том выпуска не $VOLUME"
fi
new_hash=$(staged config --hash postgres 2>/dev/null | awk '{ print $2 }')
if [ -z "$new_hash" ] || [ "$new_hash" != "$pg_hash" ]; then
  refuse 'выпуск меняет сервис postgres: это отдельная ручная операция'
fi
unknown=$(minus "$before" "$image_set")
if [ -n "$unknown" ]; then refuse "в базе есть миграции, которых нет в образе: $unknown"; fi

# 5. What the update will apply.

pending=$(minus "$image_set" "$before")
if [ -n "$pending" ]; then
  say "Новые миграции: $pending"
  say 'После них прежний digest не запустится: возврат кода без исправления вперёд невозможен'
else
  say 'Новых миграций нет'
fi
if ! staged pull --quiet nginx; then refuse 'образ nginx выпуска не загружен'; fi

# 6-7. The copy while Hof runs; only then the downtime.

say 'Предрелизная копия, Hof работает'
if ! copy_out=$(hof-backup --pre-deploy --lock-held 2>&1); then
  say "$copy_out"
  refuse 'предрелизная копия не создана'
fi
copy=$(sed -n 's/.*копия готова: \([^,]*\),.*/\1/p' <<<"$copy_out")
snapshot=${copy#hof-predeploy-}
snapshot=${snapshot%.dump}
say "Копия: $copy, снимок $snapshot"

# Stops every container of the service hof. Success only when Docker answered and shows each of
# them stopped: a Hof that may still run must not see the switch or the migrations.
stop_hof() {
  local ids id result=0
  ids=$(container hof) || return 1
  for id in $ids; do
    docker stop "$id" >/dev/null || result=1
    case $(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null) in
    exited | created) ;;
    *) result=1 ;;
    esac
  done
  return "$result"
}

stopped=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! stop_hof; then
  say 'СБОЙ: остановка Hof не подтверждена; выпуск не переключён, миграции не запускались'
  say "итог: сбой, нужно ручное вмешательство: состояние Hof — docker compose ps в $DIR; конфигурация не менялась; копия $copy"
  exit 1
fi
say "Hof остановлен $stopped: записи после снимка $snapshot есть в базе, но не в копии"

# From here on a failure stops Hof and reports the migrations; it restores nothing.
failed() {
  local after state hof_now error halted=true
  say "СБОЙ: $1"
  if ! stop_hof; then
    halted=false
    say 'ВНИМАНИЕ: остановка Hof не подтверждена, он может перезапускаться и повторять миграции'
  fi
  hof_now=$(container hof | head -n 1)
  error=$(docker logs --since "$stopped" "${hof_now:-none}" 2>&1 | grep -o 'migration [^ ]* failed' | tail -n 1)
  if after=$(applied "$postgres") && [ -n "$after" ]; then
    state=$(classify "$before" "$after" "$image_set")
  else
    after=
    state=unknown
  fi
  say "Миграции до обновления: $(paste -sd ' ' - <<<"$before")"
  say "Миграции после сбоя: ${after:+$(paste -sd ' ' - <<<"$after")}"
  say "Миграции образа: $(paste -sd ' ' - <<<"$image_set")"
  case $state in
  none)
    say 'Состояние: миграции не применялись'
    say "Дальше: возврат прежнего кода командой hof-deploy deploy ${previous:-<прежний digest>}, все записи сохранятся; сначала проверьте, не записала ли новая версия значения, неизвестные прежней"
    ;;
  all)
    say 'Состояние: миграции применены полностью, сбой произошёл после них'
    say 'Дальше: прежний digest не запустится; исправление вперёд или образ из прежнего кода и всех применённых файлов'
    ;;
  partial)
    say "Состояние: набор применён частично; применены $(minus "$after" "$before"), не применены $(minus "$image_set" "$after")${error:+, ошибка: $error}"
    say 'Дальше: прежний digest будет отклонён; исправить неприменённый файл, выпустить новый образ и запустить hof-deploy'
    ;;
  *)
    say 'Состояние: не распознано, дальнейшие действия только вручную'
    ;;
  esac
  if $halted; then
    say "итог: сбой, Hof остановлен, данные не трогались; копия $copy"
  else
    say "итог: сбой, остановка Hof не подтверждена, нужно ручное вмешательство: docker compose ps в $DIR; данные не трогались; копия $copy"
  fi
  exit 1
}

# 8. The switch of the configuration: one rename of a link.

name=$(date -u +%Y%m%dT%H%M%SZ)-${digest:7:12}
if ! mv "$stage/config" "$DIR/releases/$name"; then failed 'конфигурация не переключена'; fi
old=$(readlink release 2>/dev/null)
if $first; then
  if ! mkdir releases/git || ! mv compose.yaml deploy releases/git/ ||
    ! ln -s release/compose.yaml compose.yaml || ! ln -s release/deploy deploy ||
    ! ln -s release/release.yaml release.yaml; then
    failed 'файлы Git не заменены ссылками на выпуск'
  fi
fi
if ! ln -sfn "releases/$name" .release.new || ! mv -T .release.new release; then
  failed 'конфигурация не переключена'
fi
say "Конфигурация: releases/$name"

# 9-10. The start, where the migrations run, and the checks.

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! docker compose up -d --no-build --no-deps --pull never --wait --wait-timeout 120 hof nginx; then
  failed 'Hof не стал healthy: docker compose up --wait завершился ошибкой'
fi
hof=$(container hof | head -n 1)
if [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$hof")" != healthy ]; then
  failed 'hof не healthy'
fi
if ! docker logs --since "$started" "$hof" 2>&1 | grep -q '^info start '; then
  failed 'в логе hof нет info start'
fi
answer=
for _ in $(seq 1 20); do
  answer=$(curl --silent --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/healthz")
  if [ "$answer" = ok ]; then break; fi
  sleep 1
done
if [ "$answer" != ok ]; then failed '/healthz через nginx не отвечает ok'; fi
if [ "$(container postgres)" != "$postgres" ] ||
  [ "$(docker inspect --format "{{.State.StartedAt}} {{range .Mounts}}{{if eq .Destination \"/var/lib/postgresql\"}}{{.Name}}{{end}}{{end}}" "$postgres")" != "$pg_state" ]; then
  failed 'контейнер PostgreSQL или его том изменились'
fi
changed=$(comm -23 <(printf '%s\n' "$before_others") <(others) | grep -v '^$')
if [ -n "$changed" ]; then failed "другие контейнеры перезапускались или пропали: $(awk '{ print $3 }' <<<"$changed" | paste -sd ' ' -)"; fi

# 11. Success: the log, and the images and configurations older than the previous one go.

ready=$(date -u +%Y-%m-%dT%H:%M:%SZ)
say "Миграции применены: ${pending:-нет}"
say "итог: обновлено ${previous:-образ из Git} -> $digest; копия $copy; снимок $snapshot; остановка $stopped; готов $ready"
docker images --digests --format '{{.Digest}}' "$image" | while read -r old_digest; do
  if [ "$old_digest" != "$digest" ] && [ "$old_digest" != "$previous" ] && [ "$old_digest" != '<none>' ]; then
    docker image rm "$image@$old_digest" >/dev/null 2>&1 || say "образ $old_digest не удалён: он ещё используется"
  fi
done
for dir in releases/*; do
  release=${dir#releases/}
  if [[ $release =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] && [ "$release" != "$name" ] && [ "$dir" != "$old" ]; then
    rm -rf -- "$dir"
  fi
done
exit 0
