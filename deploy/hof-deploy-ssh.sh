#!/bin/bash
# The only command of the SSH keys of hof-deploy (docs/OPERATIONS.md, section «Обновление»):
#
#   status                  the release that runs, the containers, the last update
#   deploy sha256:<64 hex>  update Hof to the image of that digest
#
# No shell parses the input, and the input is never printed back. hof-deploy checks the argument
# again, and sudo lets this user run only that script with these two forms of arguments.
set -u

request=${SSH_ORIGINAL_COMMAND:-}
if [ "$request" = status ]; then
  exec /usr/bin/sudo -n /usr/local/sbin/hof-deploy status
elif [[ $request =~ ^deploy\ (sha256:[0-9a-f]{64})$ ]]; then
  exec /usr/bin/sudo -n /usr/local/sbin/hof-deploy deploy "${BASH_REMATCH[1]}"
fi
echo 'hof-deploy-ssh: команда не разрешена; можно status или deploy sha256:<64 шестнадцатеричных знака>' >&2
exit 2
