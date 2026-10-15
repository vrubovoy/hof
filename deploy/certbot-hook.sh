#!/bin/sh
# certbot hook for the nginx container of Hof (ARCHITECTURE.md §9).
#
#   hof-certbot-hook pre    before a renewal: stops nginx of Hof if it runs, so that certbot can
#                           answer on port 80, and leaves a flag that it did so
#   hof-certbot-hook post   after the renewal attempt: starts nginx again only if pre stopped it
#
# certbot runs it as root with a minimal PATH, for the certificate of Hof only (the hooks are set in
# /etc/letsencrypt/renewal/<domain>.conf). It reads neither compose.yaml nor .env and does not use
# Docker Compose: a renewal must work while the working copy is in the middle of an update.
#
# The container is found by the labels Compose puts on it, so a recreated container is found as
# well. Nothing but that one container is touched; when the labels match more than one, nothing at
# all. A nginx stopped on purpose leaves no flag and stays stopped.
#
# After a failed post the flag stays in /run until post succeeds. If nginx is then started another
# way, finish with `hof-certbot-hook post`: with nginx running it only checks the network and
# removes the flag. A flag left behind makes the next renewal start nginx even if it was stopped
# on purpose in the meantime. A reboot clears /run.

PROJECT=${HOF_COMPOSE_PROJECT:-hof}
DOCKER=/usr/bin/docker
FLAG=/run/hof-certbot-nginx-$PROJECT

fail() {
  echo "hof-certbot-hook: $1" >&2
  exit 1
}

# IDs of the nginx containers of the project: the running ones, or with --all those in any state.
nginx_ids() {
  "$DOCKER" ps --quiet "$@" \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.service=nginx \
    --filter label=com.docker.compose.oneoff=False
}

case $1 in
pre)
  ids=$(nginx_ids) || fail "docker не ответил; nginx не тронут"
  # The IDs become the positional parameters, $# is their number. Unquoted on purpose: the IDs
  # are hex strings separated by line breaks.
  set -- $ids
  # Not created yet, or stopped on purpose: left as it is. A flag of an earlier pre stays, so a
  # repeated pre still lets post start the nginx that was stopped for the renewal.
  [ $# -eq 0 ] && exit 0
  [ $# -eq 1 ] || fail "под метки проекта $PROJECT подходит больше одного nginx ($#); ничего не тронуто"
  # The flag goes first: if nginx ends up stopped, post starts it again.
  echo "$1" > "$FLAG" || fail "флаг $FLAG не записан; nginx не тронут"
  "$DOCKER" stop "$1" > /dev/null || fail "nginx $1 не остановлен"
  echo "hof-certbot-hook: nginx $1 остановлен"
  ;;
post)
  [ -f "$FLAG" ] || exit 0
  ids=$(nginx_ids --all) || fail "docker не ответил; nginx не запущен, флаг $FLAG оставлен"
  set -- $ids
  [ $# -eq 1 ] || fail "под метки проекта $PROJECT подходит не один nginx ($#); ничего не запущено, флаг $FLAG оставлен"
  "$DOCKER" start "$1" > /dev/null || fail "nginx $1 не запущен; флаг $FLAG оставлен. Повторите: $0 post (и после запуска nginx вручную тоже: при работающем nginx он только снимет флаг)"
  # After a start that failed on the network (a port taken), Docker leaves the container without
  # its network, and a later start succeeds with none: nginx cannot reach hof and publishes no
  # port. Only recreating the container helps.
  networks=$("$DOCKER" inspect --format '{{len .NetworkSettings.Networks}}' "$1")
  [ "${networks:-0}" -gt 0 ] || fail "nginx $1 запущен без сети Docker; в каталоге Hof выполните docker compose up -d --force-recreate nginx и повторите: $0 post"
  rm -f "$FLAG"
  echo "hof-certbot-hook: nginx $1 запущен"
  ;;
*)
  echo "Использование: $0 pre|post" >&2
  exit 2
  ;;
esac
