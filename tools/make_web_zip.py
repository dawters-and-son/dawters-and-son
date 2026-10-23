#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
import zipfile, os, sys
W, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    files = sorted(os.path.relpath(os.path.join(d, f), W) for d, _, fs in os.walk(W) for f in fs)
    for f in files:
        p = os.path.join(W, f); zi = zipfile.ZipInfo('DAWters and Son/' + f.replace(os.sep, '/'), date_time=(2026, 10, 21, 12, 0, 0))
        zi.external_attr = (0o100000 | (0o755 if os.access(p, os.X_OK) else 0o644)) << 16; zi.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(zi, open(p, 'rb').read())
print('wrote', out, os.path.getsize(out) // 1024, 'KB')
