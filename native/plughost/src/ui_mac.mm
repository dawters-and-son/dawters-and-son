// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// macOS: the Cocoa run loop, and plain NSWindows that plug-in editors (NSView) live in.
#include "ui.h"
#import <Cocoa/Cocoa.h>

struct UI::Window {
	NSWindow* win = nil;
	id delegate = nil;
	UI::WindowCallbacks cb;
	bool closingByHost = false;
};

@interface DSWindowDelegate : NSObject <NSWindowDelegate>
@property (assign) UI::Window* owner;
@end

@implementation DSWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender
{
	if (self.owner && !self.owner->closingByHost && self.owner->cb.onClose)
	{
		// the host detaches the editor and then closes the window itself (after this call returns)
		auto cb = self.owner->cb.onClose;
		dispatch_async (dispatch_get_main_queue (), ^{ cb (); });
		return NO;
	}
	return YES;
}
- (void)windowDidResize:(NSNotification*)note
{
	if (!self.owner || !self.owner->cb.onSize) return;
	NSRect r = [self.owner->win contentRectForFrameRect:self.owner->win.frame];
	self.owner->cb.onSize ((int)r.size.width, (int)r.size.height);
}
@end

namespace UI {

void init ()
{
	[NSApplication sharedApplication];
	// no Dock icon of its own: the editors belong to DAWters and Son
	[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
	[NSApp finishLaunching];
}

void run () { [NSApp run]; }

void quit ()
{
	dispatch_async (dispatch_get_main_queue (), ^{
		[NSApp stop:nil];
		// stop only takes effect after an event arrives
		NSEvent* ev = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
		                                timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
		[NSApp postEvent:ev atStart:YES];
	});
}

void post (std::function<void ()> fn)
{
	auto* heap = new std::function<void ()> (std::move (fn));
	dispatch_async (dispatch_get_main_queue (), ^{
		(*heap) ();
		delete heap;
	});
}

bool editorsSupported () { return true; }
const char* platformType () { return "NSView"; }

Window* openWindow (const std::string& title, int w, int h, bool resizable, WindowCallbacks cb)
{
	auto* W = new Window;
	W->cb = std::move (cb);
	NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
	if (resizable) style |= NSWindowStyleMaskResizable;
	W->win = [[NSWindow alloc] initWithContentRect:NSMakeRect (0, 0, w, h) styleMask:style backing:NSBackingStoreBuffered defer:NO];
	W->win.releasedWhenClosed = NO;
	W->win.title = [NSString stringWithUTF8String:title.c_str ()];
	DSWindowDelegate* d = [DSWindowDelegate new];
	d.owner = W;
	W->delegate = d;
	W->win.delegate = d;
	[W->win center];
	[W->win makeKeyAndOrderFront:nil];
	[NSApp activateIgnoringOtherApps:YES];
	return W;
}

void* nativeHandle (Window* w) { return w ? (__bridge void*)w->win.contentView : nullptr; }

void resizeWindow (Window* w, int width, int height)
{
	if (!w) return;
	NSRect frame = [w->win frameRectForContentRect:NSMakeRect (0, 0, width, height)];
	NSRect cur = w->win.frame;
	frame.origin.x = cur.origin.x;
	frame.origin.y = cur.origin.y + cur.size.height - frame.size.height; // keep the top edge in place
	[w->win setFrame:frame display:YES];
}

void focusWindow (Window* w)
{
	if (!w) return;
	[w->win makeKeyAndOrderFront:nil];
	[NSApp activateIgnoringOtherApps:YES];
}

void closeWindow (Window* w)
{
	if (!w) return;
	w->closingByHost = true;
	w->win.delegate = nil;
	[w->win orderOut:nil];
	[w->win close];
	w->win = nil;
	w->delegate = nil;
	delete w;
}

} // namespace UI
