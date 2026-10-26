// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// A small JSON value: enough for the control messages between DAWters and the plug-in host.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace J {

struct Value {
	enum Type { Null, Bool, Num, Str, Arr, Obj } t = Null;
	bool b = false;
	double n = 0;
	std::string s;
	std::vector<Value> a;
	std::map<std::string, Value> o;

	Value () = default;
	Value (bool v) : t (Bool), b (v) {}
	Value (int v) : t (Num), n (v) {}
	Value (int64_t v) : t (Num), n ((double)v) {}
	Value (uint32_t v) : t (Num), n (v) {}
	Value (double v) : t (Num), n (v) {}
	Value (const char* v) : t (Str), s (v) {}
	Value (std::string v) : t (Str), s (std::move (v)) {}
	static Value array () { Value v; v.t = Arr; return v; }
	static Value object () { Value v; v.t = Obj; return v; }

	Value& operator[] (const std::string& k) { t = Obj; return o[k]; }
	const Value* get (const std::string& k) const { auto it = o.find (k); return it == o.end () ? nullptr : &it->second; }
	std::string str (const std::string& k, const std::string& def = "") const { auto v = get (k); return v && v->t == Str ? v->s : def; }
	double num (const std::string& k, double def = 0) const { auto v = get (k); return v && v->t == Num ? v->n : def; }
	bool flag (const std::string& k, bool def = false) const { auto v = get (k); return v && v->t == Bool ? v->b : def; }
	void push (Value v) { t = Arr; a.push_back (std::move (v)); }
};

inline void escape (std::string& out, const std::string& s)
{
	out += '"';
	for (unsigned char c : s)
	{
		switch (c)
		{
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if (c < 0x20) { char b[8]; snprintf (b, sizeof b, "\\u%04x", c); out += b; }
				else out += (char)c;
		}
	}
	out += '"';
}

inline void dump (std::string& out, const Value& v)
{
	switch (v.t)
	{
		case Value::Null: out += "null"; break;
		case Value::Bool: out += v.b ? "true" : "false"; break;
		case Value::Num:
		{
			if (!std::isfinite (v.n)) { out += "0"; break; }
			char b[40];
			if (v.n == std::floor (v.n) && std::fabs (v.n) < 9e15) snprintf (b, sizeof b, "%lld", (long long)v.n);
			else snprintf (b, sizeof b, "%.17g", v.n);
			out += b;
			break;
		}
		case Value::Str: escape (out, v.s); break;
		case Value::Arr:
		{
			out += '[';
			for (size_t i = 0; i < v.a.size (); i++) { if (i) out += ','; dump (out, v.a[i]); }
			out += ']';
			break;
		}
		case Value::Obj:
		{
			out += '{';
			bool first = true;
			for (auto& kv : v.o) { if (!first) out += ','; first = false; escape (out, kv.first); out += ':'; dump (out, kv.second); }
			out += '}';
			break;
		}
	}
}
inline std::string dump (const Value& v) { std::string s; dump (s, v); return s; }

struct Parser {
	const char* p; const char* e; bool ok = true;
	void ws () { while (p < e && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) p++; }
	static void utf8 (std::string& out, uint32_t cp)
	{
		if (cp < 0x80) out += (char)cp;
		else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
		else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
		else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
	}
	uint32_t hex4 ()
	{
		uint32_t v = 0;
		for (int i = 0; i < 4 && p < e; i++, p++)
		{
			char c = *p; v <<= 4;
			if (c >= '0' && c <= '9') v |= c - '0'; else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10; else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10; else ok = false;
		}
		return v;
	}
	std::string string ()
	{
		std::string out; p++;
		while (p < e && *p != '"')
		{
			if (*p == '\\' && p + 1 < e)
			{
				p++;
				char c = *p++;
				switch (c)
				{
					case 'n': out += '\n'; break; case 't': out += '\t'; break; case 'r': out += '\r'; break;
					case 'b': out += '\b'; break; case 'f': out += '\f'; break;
					case 'u':
					{
						uint32_t cp = hex4 ();
						if (cp >= 0xD800 && cp < 0xDC00 && p + 6 <= e && p[0] == '\\' && p[1] == 'u') { p += 2; uint32_t lo = hex4 (); cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); }
						utf8 (out, cp);
						break;
					}
					default: out += c;
				}
			}
			else out += *p++;
		}
		if (p < e) p++; else ok = false;
		return out;
	}
	Value value (int depth = 0)
	{
		ws ();
		if (p >= e || depth > 64) { ok = false; return {}; }
		char c = *p;
		if (c == '{')
		{
			Value v = Value::object (); p++; ws ();
			if (p < e && *p == '}') { p++; return v; }
			while (ok && p < e)
			{
				ws (); if (p >= e || *p != '"') { ok = false; break; }
				std::string k = string (); ws ();
				if (p >= e || *p != ':') { ok = false; break; }
				p++; v.o[k] = value (depth + 1); ws ();
				if (p < e && *p == ',') { p++; continue; }
				if (p < e && *p == '}') { p++; break; }
				ok = false;
			}
			return v;
		}
		if (c == '[')
		{
			Value v = Value::array (); p++; ws ();
			if (p < e && *p == ']') { p++; return v; }
			while (ok && p < e)
			{
				v.a.push_back (value (depth + 1)); ws ();
				if (p < e && *p == ',') { p++; continue; }
				if (p < e && *p == ']') { p++; break; }
				ok = false;
			}
			return v;
		}
		if (c == '"') return Value (string ());
		if (e - p >= 4 && std::string (p, 4) == "true") { p += 4; return Value (true); }
		if (e - p >= 5 && std::string (p, 5) == "false") { p += 5; return Value (false); }
		if (e - p >= 4 && std::string (p, 4) == "null") { p += 4; return {}; }
		char* end = nullptr;
		std::string num (p, std::min<size_t> (e - p, 64));
		double d = strtod (num.c_str (), &end);
		if (end == num.c_str ()) { ok = false; return {}; }
		p += end - num.c_str ();
		return Value (d);
	}
};

inline Value parse (const std::string& s, bool* ok = nullptr)
{
	Parser ps {s.data (), s.data () + s.size ()};
	Value v = ps.value ();
	if (ok) *ok = ps.ok;
	return v;
}

// base64 for plug-in state blobs
inline std::string b64enc (const uint8_t* d, size_t n)
{
	static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::string out; out.reserve ((n + 2) / 3 * 4);
	for (size_t i = 0; i < n; i += 3)
	{
		uint32_t v = d[i] << 16 | (i + 1 < n ? d[i + 1] << 8 : 0) | (i + 2 < n ? d[i + 2] : 0);
		out += T[v >> 18 & 63]; out += T[v >> 12 & 63];
		out += i + 1 < n ? T[v >> 6 & 63] : '='; out += i + 2 < n ? T[v & 63] : '=';
	}
	return out;
}
inline std::vector<uint8_t> b64dec (const std::string& s)
{
	auto val = [] (char c) -> int {
		if (c >= 'A' && c <= 'Z') return c - 'A'; if (c >= 'a' && c <= 'z') return c - 'a' + 26;
		if (c >= '0' && c <= '9') return c - '0' + 52; if (c == '+' || c == '-') return 62; if (c == '/' || c == '_') return 63; return -1;
	};
	std::vector<uint8_t> out; uint32_t acc = 0; int bits = 0;
	for (char c : s)
	{
		int v = val (c); if (v < 0) continue;
		acc = acc << 6 | v; bits += 6;
		if (bits >= 8) { bits -= 8; out.push_back ((uint8_t)(acc >> bits & 0xFF)); }
	}
	return out;
}

} // namespace J
