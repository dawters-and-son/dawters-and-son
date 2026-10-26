// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// The host's main thread: a platform run loop that also runs work posted from the I/O thread,
// and the windows that plug-in editors are attached to.
#pragma once
#include <functional>
#include <string>

namespace UI {

struct Window;

struct WindowCallbacks {
	std::function<void ()> onClose;            // the person closed the window
	std::function<void (int w, int h)> onSize; // the content area changed size
};

void init ();                                  // call once, on the main thread
void run ();                                   // run the loop until quit()
void quit ();                                  // safe from any thread
void post (std::function<void ()> fn);         // run fn on the main thread; safe from any thread

bool editorsSupported ();
const char* platformType ();                   // kPlatformTypeNSView / HWND
Window* openWindow (const std::string& title, int w, int h, bool resizable, WindowCallbacks cb);
void* nativeHandle (Window* w);
void resizeWindow (Window* w, int width, int height);
void focusWindow (Window* w);
void closeWindow (Window* w);                  // closes without calling onClose

} // namespace UI
