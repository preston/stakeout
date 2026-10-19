#!/bin/sh
set -eu
# JSON encoding also handles quotes, backslashes and newlines in deployment titles.
{
  printf '(function(window) { Object.assign(window, '
  jq -cn --arg url "$STAKEOUT_UI_SERVER_URL" --arg title "$STAKEOUT_UI_TITLE" \
    '{STAKEOUT_UI_SERVER_URL: $url, STAKEOUT_UI_TITLE: $title}'
  printf '); })(window);\n'
} > /usr/share/nginx/html/assets/configuration.js
