#!/bin/sh
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1 && python3 -c "import http.server" >/dev/null 2>&1; then
  exec python3 serve.py
else
  echo "Python 3 not found — opening the studio directly in your browser instead."
  open -a "Google Chrome" index.html 2>/dev/null || open index.html
fi
