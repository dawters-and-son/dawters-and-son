#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Serves The Increaser at http://localhost:8756 and opens it. Works on Mac, Windows and Linux with Python 3.
# (Safari needs a web address for audio; Chrome and Edge also run index.html straight from the folder.)
import http.server, os, socketserver, threading, webbrowser
PORT = 8756
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H) as httpd:
    url = 'http://localhost:%d/' % PORT
    print('The Increaser is pouring at', url, '- close this window to stop.')
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    httpd.serve_forever()
