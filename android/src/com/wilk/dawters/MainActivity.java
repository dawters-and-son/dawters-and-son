// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
package com.wilk.dawters;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/** DAWters and Son — Android shell. The studio is assets/index.html, served on a secure origin so the
 *  microphone and AudioWorklet are available. */
public class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net/";
    static final int REQ_PERMS = 7, REQ_FILE = 8;
    WebView web;
    PermissionRequest pendingPerm;
    ValueCallback<Uri[]> fileCb;
    long lastBack = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        web = new WebView(this);
        web.setBackgroundColor(0xFFFFFFFF);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "DawAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!"appassets.androidplatform.net".equals(u.getHost())) return null;
                String p = u.getPath();
                if (p == null || p.equals("/") || p.isEmpty()) p = "/index.html";
                try {
                    InputStream in = getAssets().open(p.substring(1));
                    String mime = p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "application/javascript" : p.endsWith(".css") ? "text/css" : p.endsWith(".png") ? "image/png" : p.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
                    boolean text = mime.startsWith("text/") || mime.endsWith("javascript");
                    WebResourceResponse res = new WebResourceResponse(mime, text ? "utf-8" : null, in);
                    Map<String, String> h = new HashMap<>();
                    h.put("Cache-Control", "no-cache");
                    res.setResponseHeaders(h);
                    return res;
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                }
            }
            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String u) {
                if (u.startsWith(ORIGIN)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception e) { /* none */ }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() { public void run() {
                    if (hasMic()) req.grant(req.getResources());
                    else { pendingPerm = req; askPerms(); }
                } });
            }
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(i, "Choose a file"), REQ_FILE); }
                catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        setContentView(web);
        if (b != null) web.restoreState(b);
        else web.loadUrl(ORIGIN + "index.html" + (isTuner(getIntent()) ? "#tuner" : ""));
        if (Build.VERSION.SDK_INT >= 23 && (!hasMic() || !hasStorage())) askPerms();
    }

    boolean hasMic() { return Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED; }
    boolean hasStorage() { return Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED; }
    void askPerms() {
        if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code != REQ_PERMS) return;
        if (pendingPerm != null) {
            if (hasMic()) pendingPerm.grant(pendingPerm.getResources()); else pendingPerm.deny();
            pendingPerm = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != REQ_FILE || fileCb == null) { super.onActivityResult(code, result, data); return; }
        Uri[] out = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) out = new Uri[]{data.getData()};
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }

    @Override
    protected void onPause() {
        super.onPause();
        web.evaluateJavascript("window.A && A.saveNow && A.saveNow()", null);
    }

    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) { super.onBackPressed(); return; }
        lastBack = now;
        web.evaluateJavascript("window.A && A.saveNow && A.saveNow()", null);
        Toast.makeText(this, "Press back again to leave DAWters", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() { if (web != null) { web.destroy(); } super.onDestroy(); }

    /** Chunked file writer used by the studio to save WAVs, stems and songs. */
    class Bridge {
        final Map<Integer, FileOutputStream> open = new HashMap<>();
        final Map<Integer, File> files = new HashMap<>();
        int next = 1;

        File dir() {
            File d = null;
            if (hasStorage()) d = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "DAWters and Son");
            if (d == null || (!d.isDirectory() && !d.mkdirs())) d = new File(getExternalFilesDir(Environment.DIRECTORY_MUSIC), "DAWters and Son");
            if (!d.isDirectory()) d.mkdirs();
            return d;
        }

        @JavascriptInterface
        public synchronized int begin(String name) {
            try {
                String safe = name.replaceAll("[\\\\/:*?\"<>|]+", "_");
                File d = dir(), f = new File(d, safe);
                String base = safe, ext = "";
                int dot = safe.lastIndexOf('.');
                if (dot > 0) { base = safe.substring(0, dot); ext = safe.substring(dot); }
                for (int k = 2; f.exists(); k++) f = new File(d, base + " (" + k + ")" + ext);
                int id = next++;
                open.put(id, new FileOutputStream(f));
                files.put(id, f);
                return id;
            } catch (Exception e) { return -1; }
        }

        @JavascriptInterface
        public synchronized boolean append(int id, String b64) {
            FileOutputStream o = open.get(id);
            if (o == null) return false;
            try { o.write(Base64.decode(b64, Base64.DEFAULT)); return true; } catch (Exception e) { return false; }
        }

        @JavascriptInterface
        public synchronized String finish(int id) {
            FileOutputStream o = open.remove(id);
            File f = files.remove(id);
            if (o == null || f == null) return null;
            try { o.close(); } catch (Exception e) { return null; }
            MediaScannerConnection.scanFile(MainActivity.this, new String[]{f.getAbsolutePath()}, null, null);
            return f.getAbsolutePath();
        }
    }

    // the "D&S Tuner" home-screen icon is an alias of this activity that opens the studio straight into the tuner
    static boolean isTuner(Intent it) {
        return it != null && it.getComponent() != null && it.getComponent().getClassName().endsWith(".TunerLauncher");
    }
    @Override
    protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        if (isTuner(it) && web != null) web.evaluateJavascript("location.hash='#tuner'", null);
    }
}
