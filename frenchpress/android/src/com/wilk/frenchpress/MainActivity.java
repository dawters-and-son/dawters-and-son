// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. France's French Press, part of the DAWters and Son suite; see LICENSE (no warranty).
package com.wilk.frenchpress;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
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

/** France's French Press — Android shell. The app is assets/index.html, served on a secure origin so Web
 *  Workers and the Web Audio API run as in a browser. Songs open through the system file picker or from
 *  another app (Open with / Share); exports and projects are saved to Music/France's French Press. */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net", ORIGIN = "https://" + HOST + "/";
    static final int REQ_PERMS = 7, REQ_FILE = 8;
    WebView web;
    ValueCallback<Uri[]> fileCb;
    Uri incoming; String incomingName;
    boolean pageReady = false;
    long lastBack = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        web = new WebView(this);
        web.setBackgroundColor(0xFFEFE8DA);
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
        web.addJavascriptInterface(new Bridge(), "FPAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String p = u.getPath();
                if (p == null || p.equals("/") || p.isEmpty()) p = "/index.html";
                try {
                    if (p.startsWith("/__incoming__")) { // a song handed over by another app
                        if (incoming == null) throw new Exception("none");
                        InputStream in = getContentResolver().openInputStream(incoming);
                        WebResourceResponse res = new WebResourceResponse("application/octet-stream", null, in);
                        Map<String, String> h = new HashMap<>(); h.put("Cache-Control", "no-store"); res.setResponseHeaders(h);
                        return res;
                    }
                    InputStream in = getAssets().open(p.substring(1));
                    String mime = p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "application/javascript" : p.endsWith(".css") ? "text/css" : p.endsWith(".png") ? "image/png" : "application/octet-stream";
                    boolean text = mime.startsWith("text/") || mime.endsWith("javascript");
                    WebResourceResponse res = new WebResourceResponse(mime, text ? "utf-8" : null, in);
                    Map<String, String> h = new HashMap<>(); h.put("Cache-Control", "no-cache"); res.setResponseHeaders(h);
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
            @Override
            public void onPageFinished(WebView v, String url) { pageReady = true; deliverIncoming(); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/octet-stream", "application/zip"});
                try { startActivityForResult(Intent.createChooser(i, "Choose a song"), REQ_FILE); }
                catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        setContentView(web);
        takeIntent(getIntent());
        if (b != null) web.restoreState(b);
        else web.loadUrl(ORIGIN + "index.html");
        if (Build.VERSION.SDK_INT >= 23 && !hasStorage()) requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_PERMS);
    }

    @Override
    protected void onNewIntent(Intent i) { super.onNewIntent(i); takeIntent(i); deliverIncoming(); }

    void takeIntent(Intent i) {
        if (i == null) return;
        Uri u = null;
        if (Intent.ACTION_VIEW.equals(i.getAction())) u = i.getData();
        else if (Intent.ACTION_SEND.equals(i.getAction())) u = i.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u == null) return;
        incoming = u; incomingName = nameOf(u);
    }
    void deliverIncoming() {
        if (!pageReady || incoming == null) return;
        String js = "window.FPAPI&&FPAPI.openUrl(" + jsStr(ORIGIN + "__incoming__/" + System.currentTimeMillis()) + "," + jsStr(incomingName) + ")";
        web.evaluateJavascript(js, null);
    }
    String nameOf(Uri u) {
        String n = null;
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) n = c.getString(0);
        } catch (Exception e) { /* fall through */ }
        if (n == null) n = u.getLastPathSegment();
        return n == null ? "song" : n;
    }
    static String jsStr(String s) { return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'"; }

    boolean hasStorage() { return Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED; }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != REQ_FILE || fileCb == null) { super.onActivityResult(code, result, data); return; }
        Uri[] out = null;
        if (result == RESULT_OK && data != null && data.getData() != null) out = new Uri[]{data.getData()};
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }

    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) { super.onBackPressed(); return; }
        lastBack = now;
        Toast.makeText(this, "Press back again to leave French Press (your session is kept)", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }

    /** Chunked writer for exports and projects. */
    class Bridge {
        final Map<Integer, FileOutputStream> open = new HashMap<>();
        final Map<Integer, File> files = new HashMap<>();
        int next = 1;

        File dir() {
            File d = null;
            if (hasStorage()) d = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "France's French Press");
            if (d == null || (!d.isDirectory() && !d.mkdirs())) d = new File(getExternalFilesDir(Environment.DIRECTORY_MUSIC), "France's French Press");
            if (!d.isDirectory()) d.mkdirs();
            return d;
        }
        @JavascriptInterface
        public synchronized int begin(String name, String mime) {
            try {
                String safe = name.replaceAll("[\\\\/:*?\"<>|]+", "_");
                File d = dir(), f = new File(d, safe);
                String base = safe, ext = "";
                int dot = safe.lastIndexOf('.');
                if (dot > 0) { base = safe.substring(0, dot); ext = safe.substring(dot); }
                for (int k = 2; f.exists(); k++) f = new File(d, base + " (" + k + ")" + ext);
                int id = next++;
                open.put(id, new FileOutputStream(f)); files.put(id, f);
                runOnUiThread(new Runnable() { public void run() { getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); } });
                return id;
            } catch (Exception e) { return -1; }
        }
        @JavascriptInterface
        public synchronized boolean chunk(int id, String b64) {
            FileOutputStream o = open.get(id);
            if (o == null) return false;
            try { o.write(Base64.decode(b64, Base64.DEFAULT)); return true; } catch (Exception e) { return false; }
        }
        @JavascriptInterface
        public synchronized String end(int id) {
            FileOutputStream o = open.remove(id); File f = files.remove(id);
            if (o == null || f == null) return "nowhere (the file could not be written)";
            try { o.close(); } catch (Exception e) { return "nowhere (the file could not be written)"; }
            MediaScannerConnection.scanFile(MainActivity.this, new String[]{f.getAbsolutePath()}, null, null);
            return f.getParent().replace(Environment.getExternalStorageDirectory().getAbsolutePath(), "") + "/" + f.getName();
        }
        /** keep the screen on while pressing a long song */
        @JavascriptInterface
        public void busy(final boolean on) {
            runOnUiThread(new Runnable() { public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } });
        }
    }
}
