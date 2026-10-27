// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
//
// dawters-plughost: runs VST3 plug-ins for DAWters and Son in their own process, so a plug-in that
// crashes takes down only this helper, never the song. Built on the Steinberg VST3 SDK (MIT).
//
// Modes
//   --serve                 talk to DAWters over stdin/stdout (binary frames, below)
//   --paths [dir ...]       print the VST3 bundles found in the standard folders (+ dirs) as JSON
//   --scan <bundle>         print the classes one bundle offers as JSON (run once per bundle, so a
//                           plug-in that crashes while being scanned only fails its own scan)
//   --selftest <bundle> [cid]  load, play a test signal through it, round-trip its state; print JSON
//
// Frames (little-endian): u32 type, u32 byteLength, payload
//   1  JSON, both ways. Requests carry "q" (a number) and "cmd"; replies echo "q". Events carry "ev".
//   2  audio in:  u32 id, u32 frames, u32 channels, u32 events, f64 tempo, f64 ppq, u32 flags,
//                 u32 timesig (num | den << 8), events × {i32 offset, u8 kind, u8 chan, u8 data1,
//                 u8 0, f32 value}, then channels × frames f32 (planar)
//      flags: 1 playing, 2 offline render.  kind: 0 note off, 1 note on, 2 all notes off,
//      3 controller (data1 = CC number, value 0..1), 4 pitch bend (value -1..1)
//   3  audio out: u32 id, u32 frames, u32 channels, u32 status (0 ok, 1 passed through), samples
#include "json.h"
#include "ui.h"

#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <future>
#include <map>
#include <mutex>
#include <thread>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define DUP _dup
#define DUP2 _dup2
#define READ _read
#define WRITE _write
#else
#include <unistd.h>
#define DUP dup
#define DUP2 dup2
#define READ read
#define WRITE write
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

static const char* kVersion = "1.0.0";
#if defined(__APPLE__)
static const char* kPlatform = "mac";
#elif defined(_WIN32)
static const char* kPlatform = "windows";
#else
static const char* kPlatform = "linux";
#endif

// ------------------------------------------------------------------------------------------- I/O
static int protoOut = -1, protoIn = 0;
static std::mutex outMtx;

static bool writeAll (const void* p, size_t n)
{
	auto* c = static_cast<const char*> (p);
	while (n)
	{
		auto w = WRITE (protoOut, c, (unsigned)std::min<size_t> (n, 1 << 20));
		if (w <= 0) return false;
		c += w; n -= (size_t)w;
	}
	return true;
}
static bool readAll (void* p, size_t n)
{
	auto* c = static_cast<char*> (p);
	while (n)
	{
		auto r = READ (protoIn, c, (unsigned)std::min<size_t> (n, 1 << 20));
		if (r <= 0) return false;
		c += r; n -= (size_t)r;
	}
	return true;
}
static void writeFrame (uint32_t type, const void* a, size_t na, const void* b = nullptr, size_t nb = 0)
{
	std::lock_guard<std::mutex> lk (outMtx);
	uint32_t hdr[2] = {type, (uint32_t)(na + nb)};
	writeAll (hdr, sizeof hdr);
	if (na) writeAll (a, na);
	if (nb) writeAll (b, nb);
}
static void sendJson (const J::Value& v)
{
	auto s = J::dump (v);
	writeFrame (1, s.data (), s.size ());
}

// ------------------------------------------------------------------------------------- instances
struct Instance;
static void notifyDirty (Instance* inst);
static void reactivate (Instance* inst);

class Handler : public IComponentHandler
{
public:
	Instance* inst = nullptr;
	int gesture = 0;
	tresult PLUGIN_API beginEdit (ParamID) override { gesture++; return kResultOk; }
	tresult PLUGIN_API performEdit (ParamID id, ParamValue v) override;
	tresult PLUGIN_API endEdit (ParamID) override { if (gesture > 0) gesture--; notifyDirty (inst); return kResultOk; }
	tresult PLUGIN_API restartComponent (int32 flags) override
	{
		if (flags & (kLatencyChanged | kIoChanged)) reactivate (inst);
		if (flags & (kParamValuesChanged | kReloadComponent)) notifyDirty (inst);
		return kResultOk;
	}
	tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override
	{
		if (FUnknownPrivate::iidEqual (iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual (iid, FUnknown::iid))
		{
			*obj = static_cast<IComponentHandler*> (this);
			return kResultOk;
		}
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1; }
	uint32 PLUGIN_API release () override { return 1; }
};

class Frame : public IPlugFrame
{
public:
	Instance* inst = nullptr;
	tresult PLUGIN_API resizeView (IPlugView* view, ViewRect* r) override;
	tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override
	{
		if (FUnknownPrivate::iidEqual (iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual (iid, FUnknown::iid))
		{
			*obj = static_cast<IPlugFrame*> (this);
			return kResultOk;
		}
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1; }
	uint32 PLUGIN_API release () override { return 1; }
};

struct Instance
{
	int id = 0;
	std::string name, vendor, path, cid;
	VST3::Hosting::Module::Ptr module;
	IPtr<PlugProvider> provider;
	IPtr<IComponent> comp;
	IPtr<IEditController> ctrl;
	IPtr<IAudioProcessor> proc;
	IPtr<IMidiMapping> midiMap; // where a plug-in wants pitch bend, mod wheel and other controllers
	HostProcessData pd;
	ParameterChanges inChanges;
	ParameterChangeTransfer xfer;
	EventList events {512};
	ProcessContext ctx {};
	double sr = 48000;
	int maxBlock = 1024;
	int nIn = 0, nOut = 0;
	bool instrument = false, active = false;
	int latency = 0;
	int64_t continuous = 0;
	std::mutex procMtx;
	Handler handler;
	Frame frame;
	IPtr<IPlugView> view;
	UI::Window* win = nullptr;
	bool inResize = false;
	std::chrono::steady_clock::time_point lastDirty {};

	~Instance () { shutdown (); }

	void shutdown ()
	{
		closeEditor ();
		{
			std::lock_guard<std::mutex> lk (procMtx);
			if (active && proc) { proc->setProcessing (false); comp->setActive (false); }
			active = false;
			pd.unprepare ();
		}
		if (ctrl) ctrl->setComponentHandler (nullptr);
		midiMap = nullptr; proc = nullptr; ctrl = nullptr; comp = nullptr;
		provider = nullptr; // terminates and disconnects the plug-in
	}

	void closeEditor ()
	{
		if (view) { view->setFrame (nullptr); view->removed (); view = nullptr; }
		if (win) { UI::closeWindow (win); win = nullptr; }
	}
};

tresult PLUGIN_API Handler::performEdit (ParamID id, ParamValue v)
{
	inst->xfer.addChange (id, v, 0);
	if (!gesture) notifyDirty (inst);
	return kResultOk;
}

tresult PLUGIN_API Frame::resizeView (IPlugView* view, ViewRect* r)
{
	if (!inst->win || !r) return kInvalidArgument;
	inst->inResize = true;
	UI::resizeWindow (inst->win, r->getWidth (), r->getHeight ());
	inst->inResize = false;
	view->onSize (r);
	return kResultOk;
}

static std::mutex instMtx;
static std::map<int, std::shared_ptr<Instance>> instances;
static int nextId = 1;
static HostApplication* hostApp = nullptr;
static std::map<std::string, VST3::Hosting::Module::Ptr> modules;

static std::shared_ptr<Instance> findInstance (int id)
{
	std::lock_guard<std::mutex> lk (instMtx);
	auto it = instances.find (id);
	return it == instances.end () ? nullptr : it->second;
}

static void notifyDirty (Instance* inst)
{
	if (!inst || inst->id == 0) return;
	auto now = std::chrono::steady_clock::now ();
	if (now - inst->lastDirty < std::chrono::milliseconds (150)) return;
	inst->lastDirty = now;
	J::Value ev = J::Value::object ();
	ev["ev"] = "dirty"; ev["id"] = inst->id;
	sendJson (ev);
}

static int queryLatency (Instance* inst) { return inst->proc ? (int)inst->proc->getLatencySamples () : 0; }

// set the main buses to stereo (or what the plug-in insists on), switch side buses off, prepare buffers
static bool setupBuses (Instance* inst)
{
	auto& comp = inst->comp;
	int32 nInBus = comp->getBusCount (kAudio, kInput), nOutBus = comp->getBusCount (kAudio, kOutput);
	std::vector<SpeakerArrangement> ins (nInBus), outs (nOutBus);
	for (int32 i = 0; i < nInBus; i++) inst->proc->getBusArrangement (kInput, i, ins[i]);
	for (int32 i = 0; i < nOutBus; i++) inst->proc->getBusArrangement (kOutput, i, outs[i]);
	if (nInBus) ins[0] = SpeakerArr::kStereo;
	if (nOutBus) outs[0] = SpeakerArr::kStereo;
	if (inst->proc->setBusArrangements (nInBus ? ins.data () : nullptr, nInBus, nOutBus ? outs.data () : nullptr, nOutBus) != kResultTrue)
	{
		for (int32 i = 0; i < nInBus; i++) inst->proc->getBusArrangement (kInput, i, ins[i]);
		for (int32 i = 0; i < nOutBus; i++) inst->proc->getBusArrangement (kOutput, i, outs[i]);
	}
	for (int32 i = 0; i < nInBus; i++) comp->activateBus (kAudio, kInput, i, i == 0);
	for (int32 i = 0; i < nOutBus; i++) comp->activateBus (kAudio, kOutput, i, i == 0);
	int32 nEv = comp->getBusCount (kEvent, kInput);
	for (int32 i = 0; i < nEv; i++) comp->activateBus (kEvent, kInput, i, i == 0);
	inst->nIn = nInBus ? SpeakerArr::getChannelCount (ins[0]) : 0;
	inst->nOut = nOutBus ? SpeakerArr::getChannelCount (outs[0]) : 0;
	ProcessSetup setup {kRealtime, kSample32, inst->maxBlock, inst->sr};
	if (inst->proc->setupProcessing (setup) != kResultOk) return false;
	return inst->pd.prepare (*comp, inst->maxBlock, kSample32);
}

static bool activate (Instance* inst)
{
	if (inst->comp->setActive (true) != kResultOk) return false;
	inst->proc->setProcessing (true);
	inst->active = true;
	inst->latency = queryLatency (inst);
	return true;
}

static void reactivate (Instance* inst)
{
	if (!inst || !inst->proc) return;
	{
		std::lock_guard<std::mutex> lk (inst->procMtx);
		if (inst->active) { inst->proc->setProcessing (false); inst->comp->setActive (false); inst->active = false; }
		inst->pd.unprepare ();
		setupBuses (inst);
		activate (inst);
	}
	if (inst->id)
	{
		J::Value ev = J::Value::object ();
		ev["ev"] = "latency"; ev["id"] = inst->id; ev["latency"] = inst->latency;
		ev["ins"] = inst->nIn; ev["outs"] = inst->nOut;
		sendJson (ev);
	}
}

static VST3::Hosting::Module::Ptr loadModule (const std::string& path, std::string& err)
{
	auto it = modules.find (path);
	if (it != modules.end ()) return it->second;
	auto m = VST3::Hosting::Module::create (path, err);
	if (m) modules[path] = m;
	return m;
}

static bool isInstrument (const VST3::Hosting::ClassInfo& ci)
{
	return ci.subCategoriesString ().find ("Instrument") != std::string::npos;
}

// create a plug-in instance (main thread)
static std::shared_ptr<Instance> createInstance (const std::string& path, const std::string& cid, double sr, int block, std::string& err)
{
	auto module = loadModule (path, err);
	if (!module) { if (err.empty ()) err = "Could not load " + path; return nullptr; }
	auto factory = module->getFactory ();
	VST3::Hosting::ClassInfo found;
	bool have = false;
	for (auto& ci : factory.classInfos ())
	{
		if (ci.category () != kVstAudioEffectClass) continue;
		if (cid.empty () || ci.ID ().toString () == cid) { found = ci; have = true; break; }
	}
	if (!have) { err = "That plug-in is not in " + path; return nullptr; }
	auto inst = std::make_shared<Instance> ();
	inst->module = module; inst->path = path; inst->cid = found.ID ().toString ();
	inst->name = found.name (); inst->vendor = found.vendor (); inst->instrument = isInstrument (found);
	inst->sr = sr > 0 ? sr : 48000; inst->maxBlock = block > 0 ? block : 1024;
	inst->handler.inst = inst.get (); inst->frame.inst = inst.get ();
	inst->provider = owned (new PlugProvider (factory, found, true));
	if (!inst->provider->initialize ()) { err = "The plug-in would not start"; return nullptr; }
	inst->comp = inst->provider->getComponentPtr ();
	inst->ctrl = inst->provider->getControllerPtr ();
	inst->proc = U::cast<IAudioProcessor> (inst->comp);
	if (inst->ctrl) inst->midiMap = U::cast<IMidiMapping> (inst->ctrl);
	if (!inst->comp || !inst->proc) { err = "This plug-in does not process audio"; return nullptr; }
	if (inst->proc->canProcessSampleSize (kSample32) != kResultTrue) { err = "This plug-in needs 64-bit processing, which is not supported yet"; return nullptr; }
	if (inst->ctrl)
	{
		MemoryStream s;
		if (inst->comp->getState (&s) == kResultOk) { s.seek (0, IBStream::kIBSeekSet, nullptr); inst->ctrl->setComponentState (&s); }
		inst->ctrl->setComponentHandler (&inst->handler);
		int32 n = inst->ctrl->getParameterCount ();
		inst->inChanges.setMaxParameters (std::max<int32> (n, 16));
		inst->xfer.setMaxParameters (std::max<int32> (n, 16) * 4);
	}
	else { inst->inChanges.setMaxParameters (16); inst->xfer.setMaxParameters (64); }
	if (!setupBuses (inst.get ())) { err = "The plug-in refused the audio setup"; return nullptr; }
	if (!activate (inst.get ())) { err = "The plug-in would not switch on"; return nullptr; }
	inst->pd.inputParameterChanges = &inst->inChanges;
	inst->pd.inputEvents = &inst->events;
	inst->pd.processContext = &inst->ctx;
	return inst;
}

static J::Value describe (Instance* inst)
{
	J::Value v = J::Value::object ();
	v["id"] = inst->id; v["name"] = inst->name; v["vendor"] = inst->vendor; v["cid"] = inst->cid;
	v["ins"] = inst->nIn; v["outs"] = inst->nOut; v["instrument"] = inst->instrument; v["latency"] = inst->latency;
	bool editor = false;
	if (inst->ctrl && UI::editorsSupported ())
	{
		// asking for the view is the only reliable test; it is released straight away
		IPtr<IPlugView> v2 = owned (inst->ctrl->createView (ViewType::kEditor));
		editor = v2 && v2->isPlatformTypeSupported (UI::platformType ()) == kResultTrue;
	}
	v["editor"] = editor;
	v["params"] = inst->ctrl ? (int)inst->ctrl->getParameterCount () : 0;
	return v;
}

// ------------------------------------------------------------------------------------ processing
struct InEvent { int32_t offset; uint8_t kind, chan, data1, pad; float value; };

static void fillContext (Instance* inst, double tempo, double ppq, uint32_t flags, uint32_t ts, int frames)
{
	auto& c = inst->ctx;
	c.sampleRate = inst->sr;
	c.tempo = tempo > 0 ? tempo : 120;
	c.projectTimeMusic = ppq;
	c.projectTimeSamples = (TSamples)std::llround (ppq * 60.0 / c.tempo * inst->sr);
	c.continousTimeSamples = inst->continuous;
	c.timeSigNumerator = (ts & 0xFF) ? (ts & 0xFF) : 4;
	c.timeSigDenominator = ((ts >> 8) & 0xFF) ? ((ts >> 8) & 0xFF) : 4;
	double barLen = c.timeSigNumerator * 4.0 / c.timeSigDenominator;
	c.barPositionMusic = std::floor (ppq / barLen) * barLen;
	c.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid |
	          ProcessContext::kBarPositionValid | ProcessContext::kContTimeValid | ((flags & 1) ? ProcessContext::kPlaying : 0);
	inst->continuous += frames;
}

static void addEvent (Instance* inst, const InEvent& e, int offset)
{
	Event ev {};
	ev.busIndex = 0;
	ev.sampleOffset = offset;
	ev.flags = Event::kIsLive;
	if (e.kind == 1)
	{
		ev.type = Event::kNoteOnEvent;
		ev.noteOn.channel = e.chan; ev.noteOn.pitch = e.data1; ev.noteOn.velocity = e.value; ev.noteOn.noteId = -1;
		inst->events.addEvent (ev);
	}
	else if (e.kind == 0)
	{
		ev.type = Event::kNoteOffEvent;
		ev.noteOff.channel = e.chan; ev.noteOff.pitch = e.data1; ev.noteOff.velocity = 0; ev.noteOff.noteId = -1;
		inst->events.addEvent (ev);
	}
	else if (e.kind == 3 || e.kind == 4)
	{
		// a controller (3: data1 = CC number, value 0..1) or pitch bend (4: value -1..1), as a parameter change
		if (!inst->midiMap) return;
		ParamID pid = kNoParamId;
		CtrlNumber cn = e.kind == 4 ? (CtrlNumber)kPitchBend : (CtrlNumber)e.data1;
		if (inst->midiMap->getMidiControllerAssignment (0, e.chan, cn, pid) != kResultTrue || pid == kNoParamId) return;
		double v = e.kind == 4 ? (e.value + 1.0) * 0.5 : e.value;
		int32 idx = 0, pi = 0;
		if (auto q = inst->inChanges.addParameterData (pid, idx)) q->addPoint (offset, std::min (1.0, std::max (0.0, v)), pi);
	}
	else if (e.kind == 2)
	{
		for (int p = 0; p < 128; p++)
		{
			ev.type = Event::kNoteOffEvent;
			ev.noteOff.channel = e.chan; ev.noteOff.pitch = (int16)p; ev.noteOff.velocity = 0; ev.noteOff.noteId = -1;
			inst->events.addEvent (ev);
		}
	}
}

// process frames of planar input into planar output (2 channels max each way)
static void processBlock (Instance* inst, const float* in, int nin, float* out, int nout, int frames, const InEvent* evs, int nev,
                          double tempo, double ppq, uint32_t flags, uint32_t ts)
{
	std::lock_guard<std::mutex> lk (inst->procMtx);
	if (!inst->active)
	{
		for (int c = 0; c < nout; c++) for (int i = 0; i < frames; i++) out[c * frames + i] = c < nin ? in[c * frames + i] : 0.f;
		return;
	}
	int done = 0;
	double secsPerQ = 60.0 / (tempo > 0 ? tempo : 120);
	while (done < frames)
	{
		int n = std::min (inst->maxBlock, frames - done);
		auto& pd = inst->pd;
		if (pd.numInputs > 0 && pd.inputs[0].numChannels > 0)
		{
			auto& bus = pd.inputs[0];
			for (int c = 0; c < bus.numChannels; c++)
			{
				int src = nin ? std::min (c, nin - 1) : -1;
				if (src >= 0) std::memcpy (bus.channelBuffers32[c], in + src * frames + done, n * sizeof (float));
				else std::memset (bus.channelBuffers32[c], 0, n * sizeof (float));
			}
			bus.silenceFlags = 0;
		}
		inst->xfer.transferChangesTo (inst->inChanges); // edits from the plug-in's window first (offset 0), then this block's events
		for (int i = 0; i < nev; i++)
			if (evs[i].offset >= done && evs[i].offset < done + n) addEvent (inst, evs[i], evs[i].offset - done);
		fillContext (inst, tempo, ppq + done / inst->sr / secsPerQ, flags, ts, n);
		pd.numSamples = n;
		inst->proc->process (pd);
		if (pd.numOutputs > 0 && pd.outputs[0].numChannels > 0)
		{
			auto& bus = pd.outputs[0];
			for (int c = 0; c < nout; c++)
			{
				int src = std::min (c, bus.numChannels - 1);
				std::memcpy (out + c * frames + done, bus.channelBuffers32[src], n * sizeof (float));
			}
		}
		else for (int c = 0; c < nout; c++) std::memset (out + c * frames + done, 0, n * sizeof (float));
		inst->events.clear ();
		inst->inChanges.clearQueue ();
		done += n;
	}
}

static void handleAudio (const std::vector<uint8_t>& buf)
{
	if (buf.size () < 40) return;
	uint32_t id, frames, nin, nev, flags, ts;
	double tempo, ppq;
	std::memcpy (&id, &buf[0], 4); std::memcpy (&frames, &buf[4], 4); std::memcpy (&nin, &buf[8], 4); std::memcpy (&nev, &buf[12], 4);
	std::memcpy (&tempo, &buf[16], 8); std::memcpy (&ppq, &buf[24], 8); std::memcpy (&flags, &buf[32], 4); std::memcpy (&ts, &buf[36], 4);
	size_t need = 40 + (size_t)nev * sizeof (InEvent) + (size_t)nin * frames * 4;
	if (buf.size () < need || frames > (1u << 20) || nin > 8) return;
	std::vector<InEvent> evs (nev);
	if (nev) std::memcpy (evs.data (), &buf[40], nev * sizeof (InEvent));
	std::vector<float> in ((size_t)nin * frames);
	if (!in.empty ()) std::memcpy (in.data (), &buf[40 + nev * sizeof (InEvent)], in.size () * 4);
	auto inst = findInstance ((int)id);
	uint32_t nout = inst ? (uint32_t)std::max (1, std::min (2, inst->nOut)) : nin;
	uint32_t status = inst ? 0 : 1;
	std::vector<float> out ((size_t)nout * frames, 0.f);
	if (inst) processBlock (inst.get (), in.data (), (int)nin, out.data (), (int)nout, (int)frames, evs.data (), (int)nev, tempo, ppq, flags, ts);
	else out = in;
	uint32_t hdr[4] = {id, frames, nout, status};
	writeFrame (3, hdr, sizeof hdr, out.data (), out.size () * 4);
}

// -------------------------------------------------------------------------------------- commands
static std::string streamToB64 (MemoryStream& s)
{
	int64 size = 0;
	s.seek (0, IBStream::kIBSeekEnd, &size);
	return J::b64enc (reinterpret_cast<const uint8_t*> (s.getData ()), (size_t)size);
}

static J::Value getState (Instance* inst)
{
	J::Value v = J::Value::object ();
	MemoryStream c, e;
	{
		std::lock_guard<std::mutex> lk (inst->procMtx);
		if (inst->comp->getState (&c) == kResultOk) v["c"] = streamToB64 (c);
	}
	if (inst->ctrl && inst->ctrl->getState (&e) == kResultOk) v["e"] = streamToB64 (e);
	return v;
}

static void setState (Instance* inst, const std::string& cb64, const std::string& eb64)
{
	auto c = J::b64dec (cb64), e = J::b64dec (eb64);
	if (!c.empty ())
	{
		{
			std::lock_guard<std::mutex> lk (inst->procMtx);
			MemoryStream s (c.data (), (TSize)c.size ());
			inst->comp->setState (&s);
		}
		if (inst->ctrl) { MemoryStream s (c.data (), (TSize)c.size ()); inst->ctrl->setComponentState (&s); }
	}
	if (!e.empty () && inst->ctrl) { MemoryStream s (e.data (), (TSize)e.size ()); inst->ctrl->setState (&s); }
}

static bool openEditor (Instance* inst, std::string& err)
{
	if (inst->win) { UI::focusWindow (inst->win); return true; }
	if (!UI::editorsSupported ()) { err = "Plug-in windows are not available on this system yet"; return false; }
	if (!inst->ctrl) { err = "This plug-in has no editor"; return false; }
	inst->view = owned (inst->ctrl->createView (ViewType::kEditor));
	if (!inst->view || inst->view->isPlatformTypeSupported (UI::platformType ()) != kResultTrue) { inst->view = nullptr; err = "This plug-in has no editor"; return false; }
	ViewRect r {0, 0, 640, 400};
	inst->view->getSize (&r);
	bool resizable = inst->view->canResize () == kResultTrue;
	int id = inst->id;
	UI::WindowCallbacks cb;
	cb.onClose = [id] () {
		auto in = findInstance (id); if (!in || !in->win) return;
		in->closeEditor ();
		J::Value ev = J::Value::object (); ev["ev"] = "editor"; ev["id"] = id; ev["open"] = false; sendJson (ev);
	};
	cb.onSize = [id] (int w, int h) {
		auto in = findInstance (id); if (!in || !in->view || in->inResize) return;
		if (in->view->canResize () != kResultTrue) return;
		ViewRect nr {0, 0, w, h};
		in->view->checkSizeConstraint (&nr);
		if (nr.getWidth () != w || nr.getHeight () != h) { in->inResize = true; UI::resizeWindow (in->win, nr.getWidth (), nr.getHeight ()); in->inResize = false; }
		in->view->onSize (&nr);
	};
	inst->win = UI::openWindow (inst->name, r.getWidth (), r.getHeight (), resizable, cb);
	inst->view->setFrame (&inst->frame);
	if (inst->view->attached (UI::nativeHandle (inst->win), UI::platformType ()) != kResultOk)
	{
		inst->closeEditor ();
		err = "The plug-in window could not be opened";
		return false;
	}
	return true;
}

static void handleCommand (J::Value req)
{
	// everything that touches a plug-in's controller or lifetime runs on the main thread
	UI::post ([req] () {
		J::Value rep = J::Value::object ();
		if (auto q = req.get ("q")) rep["q"] = *q;
		std::string cmd = req.str ("cmd");
		int id = (int)req.num ("id");
		auto fail = [&] (const std::string& e) { rep["ok"] = false; rep["error"] = e; };
		if (cmd == "hello")
		{
			rep["ok"] = true; rep["version"] = kVersion; rep["platform"] = kPlatform; rep["editors"] = UI::editorsSupported ();
		}
		else if (cmd == "create")
		{
			std::string err;
			auto inst = createInstance (req.str ("path"), req.str ("cid"), req.num ("sr", 48000), (int)req.num ("block", 1024), err);
			if (!inst) fail (err);
			else
			{
				{
					std::lock_guard<std::mutex> lk (instMtx);
					inst->id = nextId++;
					instances[inst->id] = inst;
				}
				if (auto st = req.get ("state")) if (st->t == J::Value::Obj) setState (inst.get (), st->str ("c"), st->str ("e"));
				rep = describe (inst.get ());
				if (auto q = req.get ("q")) rep["q"] = *q;
				rep["ok"] = true;
			}
		}
		else if (cmd == "destroy")
		{
			std::shared_ptr<Instance> inst;
			{
				std::lock_guard<std::mutex> lk (instMtx);
				auto it = instances.find (id);
				if (it != instances.end ()) { inst = it->second; instances.erase (it); }
			}
			if (inst) inst->shutdown ();
			rep["ok"] = true;
		}
		else if (auto inst = findInstance (id))
		{
			if (cmd == "getState") { rep["ok"] = true; rep["state"] = getState (inst.get ()); }
			else if (cmd == "setState")
			{
				if (auto st = req.get ("state")) setState (inst.get (), st->str ("c"), st->str ("e"));
				rep["ok"] = true;
			}
			else if (cmd == "editor")
			{
				std::string err;
				if (req.flag ("open", true)) { if (openEditor (inst.get (), err)) rep["ok"] = true; else fail (err); }
				else { inst->closeEditor (); rep["ok"] = true; }
			}
			else if (cmd == "reset")
			{
				// stop hanging notes and tails: switch processing off and on
				std::lock_guard<std::mutex> lk (inst->procMtx);
				if (inst->active) { inst->proc->setProcessing (false); inst->proc->setProcessing (true); }
				rep["ok"] = true;
			}
			else fail ("unknown command " + cmd);
		}
		else fail ("no such plug-in instance");
		sendJson (rep);
	});
}

static void ioLoop ()
{
	std::vector<uint8_t> buf;
	for (;;)
	{
		uint32_t hdr[2];
		if (!readAll (hdr, sizeof hdr)) break;
		if (hdr[1] > (256u << 20)) break;
		buf.resize (hdr[1]);
		if (hdr[1] && !readAll (buf.data (), hdr[1])) break;
		if (hdr[0] == 2) handleAudio (buf);
		else if (hdr[0] == 1)
		{
			bool ok = false;
			auto v = J::parse (std::string (buf.begin (), buf.end ()), &ok);
			if (!ok) continue;
			if (v.str ("cmd") == "quit") break;
			handleCommand (std::move (v));
		}
	}
	// DAWters went away: release every plug-in on the main thread, then stop
	UI::post ([] () {
		std::map<int, std::shared_ptr<Instance>> all;
		{ std::lock_guard<std::mutex> lk (instMtx); all.swap (instances); }
		for (auto& kv : all) kv.second->shutdown ();
		all.clear ();
		UI::quit ();
	});
}

// ------------------------------------------------------------------------------------ CLI modes
static void printJson (const J::Value& v) { auto s = J::dump (v) + "\n"; writeAll (s.data (), s.size ()); }

static int cmdPaths (int argc, char** argv)
{
	J::Value list = J::Value::array ();
	for (auto& p : VST3::Hosting::Module::getModulePaths ()) list.push (p);
	(void)argc; (void)argv;
	printJson (list);
	return 0;
}

static int cmdScan (const std::string& path)
{
	J::Value out = J::Value::object ();
	out["path"] = path;
	std::string err;
	auto m = VST3::Hosting::Module::create (path, err);
	if (!m) { out["ok"] = false; out["error"] = err.empty () ? "could not load" : err; printJson (out); return 1; }
	auto fi = m->getFactory ().info ();
	J::Value classes = J::Value::array ();
	for (auto& ci : m->getFactory ().classInfos ())
	{
		if (ci.category () != kVstAudioEffectClass) continue;
		J::Value c = J::Value::object ();
		c["cid"] = ci.ID ().toString (); c["name"] = ci.name (); c["vendor"] = ci.vendor ().empty () ? fi.vendor () : ci.vendor ();
		c["sub"] = ci.subCategoriesString (); c["version"] = ci.version (); c["instrument"] = isInstrument (ci);
		classes.push (c);
	}
	out["ok"] = true; out["classes"] = classes;
	printJson (out);
	return 0;
}

static int cmdSelftest (const std::string& path, const std::string& cid)
{
	J::Value out = J::Value::object ();
	std::string err;
	const double sr = 48000; const int block = 256, total = (int)sr * 2;
	auto inst = createInstance (path, cid, sr, block, err);
	if (!inst) { out["ok"] = false; out["error"] = err; printJson (out); return 1; }
	inst->id = 0;
	out = describe (inst.get ());
	std::vector<float> in (2 * block), o (2 * block);
	double sumIn = 0, sumOut = 0; bool finite = true; int64_t firstSound = -1;
	for (int pos = 0; pos < total; pos += block)
	{
		for (int i = 0; i < block; i++)
		{
			float s = inst->instrument ? 0.f : 0.5f * (float)std::sin (2 * 3.14159265358979 * 440.0 * (pos + i) / sr);
			if (!inst->instrument && pos + i > sr) s = 0; // a second of tone, then silence for any tail
			in[i] = in[block + i] = s; sumIn += (double)s * s;
		}
		std::vector<InEvent> evs;
		if (inst->instrument && pos == 0) evs.push_back ({0, 1, 0, 60, 0, 0.8f});
		if (inst->instrument && pos == (int)sr / block * block) evs.push_back ({0, 0, 0, 60, 0, 0.f});
		processBlock (inst.get (), in.data (), 2, o.data (), 2, block, evs.data (), (int)evs.size (), 120, pos / sr * 2, 1, 4 | 4 << 8);
		for (int i = 0; i < 2 * block; i++)
		{
			if (!std::isfinite (o[i])) finite = false;
			sumOut += (double)o[i] * o[i];
			if (firstSound < 0 && std::fabs (o[i]) > 1e-4) firstSound = pos + (i % block);
		}
	}
	auto db = [] (double s, int n) { return s > 0 ? 10 * std::log10 (s / n) : -999.0; };
	out["rmsInDb"] = db (sumIn, total * 2); out["rmsOutDb"] = db (sumOut, total * 2); out["finite"] = finite;
	out["firstSoundAt"] = (double)firstSound;
	// state round trip: save, change nothing, load, save again — must match
	auto s1 = getState (inst.get ());
	setState (inst.get (), s1.str ("c"), s1.str ("e"));
	auto s2 = getState (inst.get ());
	out["stateBytes"] = (int)(J::b64dec (s1.str ("c")).size () + J::b64dec (s1.str ("e")).size ());
	out["stateRoundTrip"] = s1.str ("c") == s2.str ("c") && s1.str ("e") == s2.str ("e");
	out["ok"] = finite && sumOut > 0;
	printJson (out);
	inst->shutdown ();
	inst = nullptr;
	modules.clear ();
	return finite && sumOut > 0 ? 0 : 2;
}

// open a plug-in's editor window for a moment (CI checks that windows work on each platform)
static int cmdEdtest (const std::string& path, const std::string& cid)
{
	static int code = 3;
	UI::post ([path, cid] () {
		J::Value out = J::Value::object ();
		std::string err;
		auto inst = createInstance (path, cid, 48000, 1024, err);
		if (!inst) { out["ok"] = false; out["error"] = err; printJson (out); code = 1; UI::quit (); return; }
		{ std::lock_guard<std::mutex> lk (instMtx); inst->id = nextId++; instances[inst->id] = inst; }
		bool ok = openEditor (inst.get (), err);
		out["name"] = inst->name; out["editorOpened"] = ok; if (!ok) out["error"] = err;
		if (ok) { ViewRect r; if (inst->view && inst->view->getSize (&r) == kResultOk) { out["w"] = r.getWidth (); out["h"] = r.getHeight (); } }
		std::thread ([inst, out] () mutable {
			std::this_thread::sleep_for (std::chrono::milliseconds (1500));
			UI::post ([inst, out] () mutable {
				inst->closeEditor ();
				out["closed"] = inst->win == nullptr;
				out["ok"] = out.flag ("editorOpened") && out.flag ("closed");
				code = out.flag ("ok") ? 0 : 2;
				printJson (out);
				inst->shutdown ();
				{ std::lock_guard<std::mutex> lk (instMtx); instances.clear (); }
				UI::quit ();
			});
		}).detach ();
	});
	UI::run ();
	modules.clear ();
	return code;
}

int main (int argc, char** argv)
{
	// The protocol keeps the real stdout; anything a plug-in prints goes to stderr instead.
#ifdef _WIN32
	_setmode (_fileno (stdin), _O_BINARY);
	_setmode (_fileno (stdout), _O_BINARY);
#endif
	fflush (stdout);
	protoOut = DUP (1);
	DUP2 (2, 1);
#ifdef _WIN32
	_setmode (protoOut, _O_BINARY);
#endif

	std::string mode = argc > 1 ? argv[1] : "--serve";
	if (mode == "--version") { printJson (J::Value (kVersion)); return 0; }
	if (mode == "--paths") return cmdPaths (argc, argv);

	hostApp = new HostApplication ();
	PluginContextFactory::instance ().setPluginContext (hostApp);
	UI::init ();

	if (mode == "--scan" && argc > 2) return cmdScan (argv[2]);
	if (mode == "--selftest" && argc > 2) return cmdSelftest (argv[2], argc > 3 ? argv[3] : "");
	if (mode == "--edtest" && argc > 2) return cmdEdtest (argv[2], argc > 3 ? argv[3] : "");
	if (mode != "--serve") { fprintf (stderr, "usage: dawters-plughost --serve | --paths | --scan <bundle> | --selftest <bundle> [cid]\n"); return 64; }

	std::thread io (ioLoop);
	io.detach ();
	UI::run ();
	modules.clear ();
	return 0;
}
