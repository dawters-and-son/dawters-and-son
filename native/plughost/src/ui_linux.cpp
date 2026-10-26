// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// Linux: a plain task loop. Plug-ins process audio here; their editor windows come later
// (they need an X11 window and the VST3 IRunLoop).
#include "ui.h"
#include <condition_variable>
#include <deque>
#include <mutex>

namespace UI {

static std::mutex mtx;
static std::condition_variable cv;
static std::deque<std::function<void ()>> tasks;
static bool quitting = false;

void init () {}

void run ()
{
	for (;;)
	{
		std::function<void ()> fn;
		{
			std::unique_lock<std::mutex> lk (mtx);
			cv.wait (lk, [] { return quitting || !tasks.empty (); });
			if (tasks.empty () && quitting) return;
			fn = std::move (tasks.front ());
			tasks.pop_front ();
		}
		fn ();
	}
}

void quit ()
{
	std::lock_guard<std::mutex> lk (mtx);
	quitting = true;
	cv.notify_all ();
}

void post (std::function<void ()> fn)
{
	std::lock_guard<std::mutex> lk (mtx);
	tasks.push_back (std::move (fn));
	cv.notify_all ();
}

bool editorsSupported () { return false; }
const char* platformType () { return "X11EmbedWindowID"; }
Window* openWindow (const std::string&, int, int, bool, WindowCallbacks) { return nullptr; }
void* nativeHandle (Window*) { return nullptr; }
void resizeWindow (Window*, int, int) {}
void focusWindow (Window*) {}
void closeWindow (Window*) {}

} // namespace UI
