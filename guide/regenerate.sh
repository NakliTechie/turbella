#!/bin/sh
# Regenerate the guide: capture every route against a fresh daemon on a
# temporary socket, then build guide/index.html. Needs Chrome (CHROME_BIN).
set -e
cd "$(dirname "$0")/.."
node guide/capture.mjs
node guide/build.mjs
