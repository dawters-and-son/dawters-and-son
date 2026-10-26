// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// Windows: the message loop, and top-level windows that plug-in editors (HWND children) live in.
#include "ui.h"
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <deque>
#include <mutex>

struct UI::Window {
	HWND hwnd = nullptr;
	UI::WindowCallbacks cb;
	bool closingByHost = false;
	bool resizable = false;
};

namespace UI {

static DWORD mainThread = 0;
static HWND msgWindow = nullptr;
static std::mutex mtx;
static std::deque<std::function<void ()>> tasks;
static const UINT WM_RUN_TASKS = WM_APP + 1;
static const wchar_t* kWindowClass = L"DAWtersPlugEditor";
static const wchar_t* kMsgClass = L"DAWtersPlugHostMsg";

static std::wstring widen (const std::string& s)
{
	if (s.empty ()) return {};
	int n = MultiByteToWideChar (CP_UTF8, 0, s.data (), (int)s.size (), nullptr, 0);
	std::wstring w (n, 0);
	MultiByteToWideChar (CP_UTF8, 0, s.data (), (int)s.size (), &w[0], n);
	return w;
}

static void runTasks ()
{
	for (;;)
	{
		std::function<void ()> fn;
		{
			std::lock_guard<std::mutex> lk (mtx);
			if (tasks.empty ()) return;
			fn = std::move (tasks.front ());
			tasks.pop_front ();
		}
		fn ();
	}
}

static LRESULT CALLBACK msgProc (HWND h, UINT m, WPARAM wp, LPARAM lp)
{
	if (m == WM_RUN_TASKS) { runTasks (); return 0; }
	return DefWindowProcW (h, m, wp, lp);
}

static LRESULT CALLBACK winProc (HWND h, UINT m, WPARAM wp, LPARAM lp)
{
	auto* W = reinterpret_cast<Window*> (GetWindowLongPtrW (h, GWLP_USERDATA));
	switch (m)
	{
		case WM_CLOSE:
			if (W && !W->closingByHost && W->cb.onClose) { auto cb = W->cb.onClose; cb (); return 0; }
			break;
		case WM_SIZE:
			if (W && W->cb.onSize && wp != SIZE_MINIMIZED) W->cb.onSize (LOWORD (lp), HIWORD (lp));
			return 0;
		case WM_ERASEBKGND:
			return 1;
	}
	return DefWindowProcW (h, m, wp, lp);
}

void init ()
{
	mainThread = GetCurrentThreadId ();
	// plug-in editors measure themselves in physical pixels on Windows
	using SetCtx = BOOL (WINAPI*) (HANDLE);
	if (auto fn = (SetCtx)GetProcAddress (GetModuleHandleW (L"user32.dll"), "SetProcessDpiAwarenessContext"))
		fn ((HANDLE)-4 /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */);
	OleInitialize (nullptr);
	HINSTANCE inst = GetModuleHandleW (nullptr);
	WNDCLASSW mc {}; mc.lpfnWndProc = msgProc; mc.hInstance = inst; mc.lpszClassName = kMsgClass;
	RegisterClassW (&mc);
	msgWindow = CreateWindowExW (0, kMsgClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, inst, nullptr);
	WNDCLASSW wc {}; wc.lpfnWndProc = winProc; wc.hInstance = inst; wc.lpszClassName = kWindowClass;
	wc.hCursor = LoadCursor (nullptr, IDC_ARROW); wc.hbrBackground = (HBRUSH)GetStockObject (BLACK_BRUSH);
	wc.hIcon = LoadIcon (inst, MAKEINTRESOURCE (1));
	RegisterClassW (&wc);
}

void run ()
{
	MSG msg;
	while (GetMessageW (&msg, nullptr, 0, 0) > 0)
	{
		TranslateMessage (&msg);
		DispatchMessageW (&msg);
	}
}

void quit () { PostThreadMessageW (mainThread, WM_QUIT, 0, 0); }

void post (std::function<void ()> fn)
{
	{
		std::lock_guard<std::mutex> lk (mtx);
		tasks.push_back (std::move (fn));
	}
	PostMessageW (msgWindow, WM_RUN_TASKS, 0, 0);
}

bool editorsSupported () { return true; }
const char* platformType () { return "HWND"; }

static DWORD styleFor (bool resizable)
{
	DWORD s = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
	if (resizable) s |= WS_THICKFRAME | WS_MAXIMIZEBOX;
	return s;
}

Window* openWindow (const std::string& title, int w, int h, bool resizable, WindowCallbacks cb)
{
	auto* W = new Window;
	W->cb = std::move (cb);
	W->resizable = resizable;
	RECT r {0, 0, w, h};
	AdjustWindowRectEx (&r, styleFor (resizable), FALSE, 0);
	W->hwnd = CreateWindowExW (WS_EX_APPWINDOW, kWindowClass, widen (title).c_str (), styleFor (resizable), CW_USEDEFAULT, CW_USEDEFAULT,
	                           r.right - r.left, r.bottom - r.top, nullptr, nullptr, GetModuleHandleW (nullptr), nullptr);
	SetWindowLongPtrW (W->hwnd, GWLP_USERDATA, (LONG_PTR)W);
	ShowWindow (W->hwnd, SW_SHOWNORMAL);
	SetForegroundWindow (W->hwnd);
	return W;
}

void* nativeHandle (Window* w) { return w ? (void*)w->hwnd : nullptr; }

void resizeWindow (Window* w, int width, int height)
{
	if (!w) return;
	RECT r {0, 0, width, height};
	AdjustWindowRectEx (&r, styleFor (w->resizable), FALSE, 0);
	SetWindowPos (w->hwnd, nullptr, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void focusWindow (Window* w)
{
	if (!w) return;
	if (IsIconic (w->hwnd)) ShowWindow (w->hwnd, SW_RESTORE);
	SetForegroundWindow (w->hwnd);
}

void closeWindow (Window* w)
{
	if (!w) return;
	w->closingByHost = true;
	SetWindowLongPtrW (w->hwnd, GWLP_USERDATA, 0);
	DestroyWindow (w->hwnd);
	delete w;
}

} // namespace UI
