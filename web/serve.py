#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
"""DAWters and Son — local launcher. Serves the studio on http://localhost so the browser allows the microphone."""
import http.server, os, socket, socketserver, sys, threading, webbrowser
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{'.js': 'application/javascript', '.wasm': 'application/wasm', '.html': 'text/html; charset=utf-8'})
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a): pass
def free_port(start=8737):
    for p in range(start, start + 50):
        with socket.socket() as s:
            try: s.bind(('127.0.0.1', p)); return p
            except OSError: continue
    return 0
port = free_port()
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), H)
url = 'http://localhost:%d/' % port
print('DAWters and Son is playing at', url)
print('Keep this window open while you work. Press Ctrl+C to stop.')
if '--no-browser' not in sys.argv: threading.Timer(0.6, lambda: webbrowser.open(url)).start()
try: httpd.serve_forever()
except KeyboardInterrupt: print('\nStopped.')
