#!/bin/sh
# Installs dependencies, builds, and links the CLI globally. Works from any cwd.
cd "$(dirname "$0")/.." || exit 1
npm install && npm run build && npm link
chmod +x dist/cli.js
