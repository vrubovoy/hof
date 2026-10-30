#!/bin/bash
# Proves that a backup brings up a working court (docs/OPERATIONS.md, section «Проверить копию»).
#
#   deploy/hof-restore-check.sh <file.dump>
#
# Restores the copy into a temporary Compose project of its own, on this machine, and starts Hof on
# it, with new random passwords. It never connects to a server and never compares with a live
# database. Whatever it creates carries the name of that project, and only that is removed.
#
# Exit code: 0 the copy is good; 1 it is not, or the check failed; 2 a wrong argument or a Docker
# that is not local: nothing was started. Written for the bash 3.2 of macOS.
set -euo pipefail
export LC_ALL=C

# Values from the shell would win over the temporary .env and could point Compose elsewhere.
unset POSTGRES_PASSWORD HOF_CORE_DB_PASSWORD HOF_SAECKEL_DB_PASSWORD CURRENCY TZ HOF_DOMAIN \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES

ROOT=$(cd "$(dirname "$0")/.." && pwd)

refuse() {
  echo "hof-restore-check: $1" >&2
  exit 2
}

if [ "$#" -ne 1 ]; then refuse "использование: $0 <файл копии .dump>"; fi
copy=$1
if [ ! -f "$copy" ]; then refuse "нет файла $copy"; fi

# Only a Docker on this machine: a context or DOCKER_HOST over the network could be the server.
assert_local_docker() {
  local endpoint
  case ${DOCKER_HOST:-unix://} in
  unix://*) ;;
  *) refuse 'DOCKER_HOST указывает не на локальный Docker: ничего не запущено' ;;
  esac
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}') ||
    refuse 'не удалось определить контекст Docker: ничего не запущено'
  case $endpoint in
  unix://*) ;;
  *) refuse "контекст Docker не локальный ($endpoint): ничего не запущено" ;;
  esac
}
assert_local_docker

project=hof-drill-$(openssl rand -hex 6)
volume=${project}_pgdata
image=${project}-hof
tmp=$(mktemp -d)
env_file=$tmp/env
core_password=$(openssl rand -hex 24)
saeckel_password=$(openssl rand -hex 24)
superuser_password=$(openssl rand -hex 24)

write_env() {
  {
    echo "POSTGRES_PASSWORD=$superuser_password"
    echo "HOF_CORE_DB_PASSWORD=$core_password"
    echo "HOF_SAECKEL_DB_PASSWORD=$saeckel_password"
    echo "CURRENCY=$1"
    echo 'TZ=UTC'
  } >"$env_file"
}

dc() {
  docker compose --project-name "$project" --project-directory "$ROOT" --env-file "$env_file" \
    --file "$ROOT/compose.yaml" "$@"
}

# Before anything destructive: this Docker, this project, its own container and its own volume.
assert_ours() {
  local id
  assert_local_docker
  if ! [[ $project =~ ^hof-drill-[0-9a-f]{12}$ ]]; then exit 1; fi
  id=$(dc ps --quiet postgres)
  [ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")" = "$project" ]
  [ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' "$id")" = "$volume" ]
}

started=false
step='подготовка'
# A failure inside a command with 2> leaves that redirection in place for the trap below.
exec 3>&2
on_exit() {
  local code=$? left=''
  exec 2>&3
  trap - EXIT INT TERM
  if $started; then
    dc down --timeout 5 --remove-orphans >/dev/null 2>&1 || true
    if [ "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume" 2>/dev/null)" = "$project" ]; then
      docker volume rm "$volume" >/dev/null 2>&1 || true
    fi
    docker image rm "$image" >/dev/null 2>&1 || true
    left=$({
      docker ps --all --quiet --filter "label=com.docker.compose.project=$project"
      docker network ls --quiet --filter "label=com.docker.compose.project=$project"
      docker volume ls --quiet --filter "label=com.docker.compose.project=$project"
      docker image ls --quiet "$image"
    } 2>/dev/null) || true
  fi
  if [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then
    echo "hof-restore-check: копия НЕ прошла проверку: $step" >&2
    # Only the line of the error: CONTEXT and DETAIL of PostgreSQL may quote a record.
    if [ -s "$tmp/err" ]; then
      grep -iE 'error' "$tmp/err" | grep -vE 'CONTEXT|DETAIL' | head -n 1 | cut -c1-200 >&2 || true
    fi
  fi
  rm -rf "$tmp"
  if [ -n "$left" ]; then
    echo "hof-restore-check: не все ресурсы $project удалены (docs/OPERATIONS.md, «Проверить копию»)" >&2
    exit 1
  fi
}
trap on_exit EXIT
trap 'step=прервано; exit 130' INT
trap 'step=прервано; exit 143' TERM

say() { echo "hof-restore-check: $1"; }

step="нет файла $copy.meta: контрольную сумму не с чем сверить"
[ -f "$copy.meta" ]
step='SHA-256 архива не совпала с .meta'
want=$(sed -n 's/^sha256=//p' "$copy.meta")
got=$(shasum -a 256 "$copy")
got=${got%% *}
if [ -z "$want" ] || [ "$want" != "$got" ]; then exit 1; fi
say "SHA-256 совпала, проект $project"

step='не запустился PostgreSQL временного проекта'
write_env RUB
started=true
dc up --detach --wait --wait-timeout 120 postgres >/dev/null 2>"$tmp/err"

step='архив не читается целиком'
dc exec -T postgres pg_restore --file=/dev/null <"$copy" 2>"$tmp/err"
say 'архив прочитан целиком'

# postgres-init.sh has already made the schemas in hof, and pg_restore would fail on them. The roles
# stay: they belong to the cluster, and the archive brings the schemas with their owners.
step='контейнер или том не принадлежат этому прогону'
assert_ours
step='не удалось подготовить чистую базу'
dc exec -T postgres dropdb --username=postgres --force hof 2>"$tmp/err"
dc exec -T postgres createdb --username=postgres --template=template0 hof 2>"$tmp/err"
step='восстановление завершилось ошибкой, частичных данных нет'
dc exec -T postgres pg_restore --username=postgres --dbname=hof --single-transaction <"$copy" 2>"$tmp/err"
say 'архив восстановлен в чистую базу'

query() {
  dc exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --username=postgres --dbname=hof -At -c "$1" </dev/null 2>"$tmp/err"
}

step='не удалось прочитать структуру базы'
found=$(query "
  SELECT nspname || ':' || pg_get_userbyid(nspowner) FROM pg_namespace
   WHERE nspname IN ('core', 'saeckel')
  UNION ALL
  SELECT schemaname || '.' || tablename || ':' || tableowner FROM pg_tables
   WHERE schemaname IN ('core', 'saeckel')
  UNION ALL
  SELECT 'pk ' || n.nspname || '.' || c.relname
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE k.contype = 'p' AND n.nspname IN ('core', 'saeckel')
  UNION ALL
  SELECT 'operations foreign keys ' || count(*) FROM pg_constraint
   WHERE contype = 'f' AND conrelid = to_regclass('saeckel.operations')
  UNION ALL
  SELECT 'index users_one_admin ' || (to_regclass('core.users_one_admin') IS NOT NULL)
  UNION ALL
  SELECT 'not validated ' || count(*)
    FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
   WHERE n.nspname IN ('core', 'saeckel') AND NOT k.convalidated")
problems=''
for expected in 'core:hof_core' 'saeckel:hof_saeckel' \
  'core.users:hof_core' 'core.sessions:hof_core' 'core.schema_migrations:hof_core' \
  'saeckel.pouches:hof_saeckel' 'saeckel.operations:hof_saeckel' 'saeckel.schema_migrations:hof_saeckel' \
  'pk core.users' 'pk core.sessions' 'pk core.schema_migrations' \
  'pk saeckel.pouches' 'pk saeckel.operations' 'pk saeckel.schema_migrations' \
  'operations foreign keys 2' 'index users_one_admin true' 'not validated 0'; do
  if ! grep -qxF "$expected" <<<"$found"; then problems="$problems; $expected"; fi
done
if [ -n "$problems" ]; then
  step="в структуре базы нет:${problems#;}"
  exit 1
fi
say 'схемы, таблицы, владельцы и ограничения на месте'

step='не удалось прочитать записи'
admins=$(query 'SELECT count(*) FROM core.users WHERE is_admin')
currencies=$(query 'SELECT DISTINCT currency FROM saeckel.operations')
rows=$(query "SELECT 'пользователи ' || (SELECT count(*) FROM core.users)
  || ', сессии ' || (SELECT count(*) FROM core.sessions)
  || ', мешки ' || (SELECT count(*) FROM saeckel.pouches)
  || ', операции ' || (SELECT count(*) FROM saeckel.operations)")
newest=$(query "SELECT coalesce(max(date)::text, 'нет') FROM saeckel.operations")
applied=$(query "SELECT string_agg(name, ', ' ORDER BY name) FROM (
    SELECT 'core/' || name AS name FROM core.schema_migrations
    UNION ALL SELECT 'saeckel/' || name FROM saeckel.schema_migrations) m")
# A digest of every record, comparable between copies; it shows neither names nor amounts.
fingerprint=$(query "SELECT md5(string_agg(digest, '' ORDER BY n)) FROM (
    SELECT 1 AS n, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text COLLATE \"C\"), '')) AS digest FROM core.users t
    UNION ALL SELECT 2, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text COLLATE \"C\"), '')) FROM core.sessions t
    UNION ALL SELECT 3, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text COLLATE \"C\"), '')) FROM saeckel.pouches t
    UNION ALL SELECT 4, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text COLLATE \"C\"), '')) FROM saeckel.operations t) d")
if [ "$admins" != 1 ]; then
  step="Хозяев в копии: $admins, а должен быть один"
  exit 1
fi
if [ "$(printf '%s\n' "$currencies" | grep -c .)" -gt 1 ]; then
  step='в записях больше одной валюты'
  exit 1
fi

step='не собрался образ Hof'
write_env "${currencies:-RUB}"
dc build --quiet hof >/dev/null 2>"$tmp/err"
step='Hof не запустился на восстановленной базе'
dc up --detach --no-build hof >/dev/null 2>"$tmp/err"
logs=''
for _ in $(seq 1 60); do
  logs=$(dc logs --no-color --no-log-prefix hof 2>/dev/null) || true
  case $logs in
  *startup_failed*)
    printf '%s\n' "$logs" | grep startup_failed | tail -n 1 | sed 's/^/error: /' >"$tmp/err"
    exit 1
    ;;
  *'info start'*) break ;;
  esac
  sleep 1
done
case $logs in
*'info start'*) ;;
*)
  step='Hof не сообщил о запуске за 60 секунд'
  exit 1
  ;;
esac
case $logs in
*gate_key*)
  step='Hof считает двор не основанным'
  exit 1
  ;;
esac
start_line=$(printf '%s\n' "$logs" | grep 'info start' | tail -n 1)
new_migrations=${start_line##*migrations=}
say 'Hof запустился'

echo
echo 'Копия прошла проверку.'
echo "  файл: ${copy##*/}, $(wc -c <"$copy" | tr -d ' ') байт"
echo "  записи: $rows"
echo "  новейшая операция: $newest"
echo "  отпечаток записей: $fingerprint"
echo "  миграции в копии: ${applied:-нет}"
echo "  новые миграции этого кода: $new_migrations"
