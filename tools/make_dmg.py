#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
"""Build a compressed .dmg from a .app on Linux (HFS+ via libdmg-hfsplus), preserving symlinks and permissions."""
import os, stat, subprocess, sys
HFS = os.environ.get('HFSPLUS', '/tmp/claude-0/tools/libdmg-hfsplus/build/hfs/hfsplus')
DMG = os.environ.get('DMGTOOL', '/tmp/claude-0/tools/dmgfq/build/dmg/dmg')
app, out, vol = sys.argv[1], sys.argv[2], sys.argv[3]
extras = sys.argv[4:]  # extra files placed at the volume root
img = out + '.hfs'
size = sum(os.lstat(os.path.join(r, f)).st_size for r, d, fs in os.walk(app) for f in fs)
mb = int(size / 1048576 * 1.25) + 60
subprocess.run(['dd', 'if=/dev/zero', 'of=' + img, 'bs=1M', 'count=%d' % mb], check=True, capture_output=True)
subprocess.run(['mkfs.hfsplus', '-v', vol, img], check=True, capture_output=True)
cmds = []
def run(*a):
    r = subprocess.run([HFS, img] + list(a), capture_output=True, text=True)
    if r.returncode != 0: raise SystemExit('hfsplus failed: %s %s' % (a, r.stderr))
name = os.path.basename(app.rstrip('/'))
def walk(src, dst):
    run('mkdir', dst)
    run('chmod', '755', dst)
    for e in sorted(os.listdir(src)):
        s, d = os.path.join(src, e), dst + '/' + e
        st = os.lstat(s)
        if stat.S_ISLNK(st.st_mode): run('symlink', d, os.readlink(s))
        elif stat.S_ISDIR(st.st_mode): walk(s, d)
        else:
            run('add', s, d)
            run('chmod', '%o' % (0o755 if st.st_mode & 0o111 else 0o644), d)
walk(app, '/' + name)
run('symlink', '/Applications', '/Applications')
for x in extras:
    run('add', x, '/' + os.path.basename(x)); run('chmod', '644', '/' + os.path.basename(x))
r = subprocess.run([DMG, img, out], capture_output=True, text=True)
if r.returncode != 0: raise SystemExit('dmg build failed: ' + r.stderr + r.stdout)
os.remove(img)
print('wrote', out, os.path.getsize(out) // 1048576, 'MB')
