package lt.elmo.cardscanner;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.exifinterface.media.ExifInterface;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Offline business card scanner.
 *
 * The whole UI lives in assets/index.html (WebView). Native side provides:
 * camera / gallery capture, ML Kit on-device OCR, persistent JSON storage,
 * saving generated .xlsx files into Documents/CardScanner, the share sheet and
 * an optional HTTPS call for AI field cleanup.
 */
public class MainActivity extends Activity {

    private static final int REQ_CAMERA = 101;
    private static final int REQ_PICK = 102;
    private static final int REQ_PERM_STORAGE = 201;

    private WebView web;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private final List<String> savedUris = new ArrayList<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // Frappe hands out a session cookie at /api/method/login; keep it for the
        // requests that follow, so email/password authentication works.
        if (CookieHandler.getDefault() == null) {
            CookieManager cm = new CookieManager();
            cm.setCookiePolicy(CookiePolicy.ACCEPT_ALL);
            CookieHandler.setDefault(cm);
        }

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.setBackgroundColor(0xFF0F1115);
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        WebView.setWebContentsDebuggingEnabled(false);
        web.loadUrl("file:///android_asset/index.html");

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERM_STORAGE);
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onAndroidBack && window.onAndroidBack()", null);
    }

    // ------------------------------------------------------------------ bridge

    public class Bridge {

        @JavascriptInterface
        public String appVersion() {
            return "1.2";
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        /** Launch the system camera app; the result arrives via window.onScan(). */
        @JavascriptInterface
        public void takePhoto() {
            runOnUiThread(MainActivity.this::launchCamera);
        }

        /** Pick an existing picture; the result arrives via window.onScan(). */
        @JavascriptInterface
        public void pickPhoto() {
            runOnUiThread(MainActivity.this::launchPicker);
        }

        /** Re-run OCR on a card image that was stored earlier. */
        @JavascriptInterface
        public void reOcr(final String imageName) {
            new Thread(() -> {
                File f = new File(cardsDir(), imageName);
                if (!f.exists()) {
                    postScanError("Image not found: " + imageName);
                    return;
                }
                recognize(f, imageName, false);
            }).start();
        }

        /** App-private JSON database (cards, settings). */
        @JavascriptInterface
        public String readData(String name) {
            try {
                File f = new File(getFilesDir(), name);
                if (!f.exists()) return "";
                return readFile(f);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean writeData(String name, String content) {
            try (FileOutputStream out = new FileOutputStream(new File(getFilesDir(), name))) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** Bundled asset (the ERPNext import templates) as base64. */
        @JavascriptInterface
        public String readAsset(String name) {
            try (InputStream in = getAssets().open(name)) {
                return Base64.encodeToString(readAll(in), Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        /** A stored card image as a data URL, for the preview. */
        @JavascriptInterface
        public String readCardImage(String imageName) {
            try {
                File f = new File(cardsDir(), imageName);
                if (!f.exists()) return "";
                byte[] b = readAll(new java.io.FileInputStream(f));
                return "data:image/jpeg;base64," + Base64.encodeToString(b, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean deleteCardImage(String imageName) {
            File f = new File(cardsDir(), imageName);
            return f.exists() && f.delete();
        }

        /**
         * Write a file into Documents/CardScanner so Synology Drive (or any sync
         * app) can pick it up. Returns JSON: {"ok":true,"path":...,"uri":...}
         */
        @JavascriptInterface
        public String saveToDocuments(String fileName, String base64, String mime) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String rel = Environment.DIRECTORY_DOCUMENTS + "/CardScanner";
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
                    Uri uri = getContentResolver().insert(
                            MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv);
                    if (uri == null) throw new IOException("MediaStore refused the file");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new IOException("no output stream");
                        out.write(data);
                    }
                    savedUris.add(uri.toString());
                    return json("ok", true, "path", rel + "/" + fileName, "uri", uri.toString());
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOCUMENTS), "CardScanner");
                    if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                    File f = new File(dir, fileName);
                    try (FileOutputStream out = new FileOutputStream(f)) {
                        out.write(data);
                    }
                    Uri uri = FileProvider.getUriForFile(MainActivity.this,
                            getPackageName() + ".fileprovider", f);
                    savedUris.add(uri.toString());
                    return json("ok", true, "path", f.getAbsolutePath(), "uri", uri.toString());
                }
            } catch (Exception e) {
                return json("ok", false, "error", String.valueOf(e.getMessage()));
            }
        }

        /** Offer the just-saved files to other apps (Synology Drive, Gmail, Files...). */
        @JavascriptInterface
        public void shareFiles(String urisJson, final String title) {
            try {
                JSONArray arr = new JSONArray(urisJson);
                final ArrayList<Uri> uris = new ArrayList<>();
                for (int i = 0; i < arr.length(); i++) uris.add(Uri.parse(arr.getString(i)));
                runOnUiThread(() -> {
                    Intent send;
                    if (uris.size() == 1) {
                        send = new Intent(Intent.ACTION_SEND);
                        send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                    } else {
                        send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                        send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                    }
                    send.setType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    send.putExtra(Intent.EXTRA_SUBJECT, title);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(send, title));
                });
            } catch (Exception e) {
                toast("Share failed: " + e.getMessage());
            }
        }

        /**
         * Optional AI cleanup. Returns immediately; the answer is delivered to
         * window.onHttp(reqId, payload) so the WebView never freezes. The payload
         * is either the response body or "ERR:<reason>".
         */
        @JavascriptInterface
        public void httpPostJson(final String urlStr, final String headersJson,
                                 final String body, final int timeoutSec, final String reqId) {
            new Thread(() -> {
                String payload = post(urlStr, headersJson, body, timeoutSec);
                final String js = "window.onHttp(" + JSONObject.quote(reqId) + ","
                        + JSONObject.quote(payload) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            }).start();
        }

        /**
         * General request used by the ERPNext sync layer. Supports any method,
         * keeps the session cookie Frappe hands out at /api/method/login, and
         * answers window.onHttp(reqId, payload) where payload is the JSON string
         * {"status":<int>,"body":"<text>"} or "ERR:<reason>".
         *
         * Plain http is accepted here because a self-hosted ERPNext often sits on
         * the local network without a certificate; the web layer refuses anything
         * that is not a local address.
         */
        @JavascriptInterface
        public void httpRequest(final String method, final String urlStr, final String headersJson,
                                final String body, final int timeoutSec, final String reqId) {
            new Thread(() -> {
                String payload = request(method, urlStr, headersJson, body, timeoutSec);
                final String js = "window.onHttp(" + JSONObject.quote(reqId) + ","
                        + JSONObject.quote(payload) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            }).start();
        }

        private String request(String method, String urlStr, String headersJson,
                              String body, int timeoutSec) {
            HttpURLConnection c = null;
            try {
                String m = method == null || method.isEmpty() ? "GET" : method.toUpperCase();
                URL url = new URL(urlStr);
                String proto = url.getProtocol();
                if (!"https".equalsIgnoreCase(proto) && !"http".equalsIgnoreCase(proto)) {
                    return "ERR:unsupported address";
                }
                c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod(m);
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(Math.max(5, timeoutSec) * 1000);
                c.setReadTimeout(Math.max(5, timeoutSec) * 1000);
                c.setRequestProperty("Accept", "application/json");
                JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                for (java.util.Iterator<String> it = h.keys(); it.hasNext(); ) {
                    String k = it.next();
                    c.setRequestProperty(k, h.getString(k));
                }
                if (body != null && !body.isEmpty() && !"GET".equals(m) && !"HEAD".equals(m)) {
                    c.setDoOutput(true);
                    byte[] raw = body.getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(raw.length);
                    try (OutputStream out = c.getOutputStream()) {
                        out.write(raw);
                    }
                }
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String resp = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
                JSONObject o = new JSONObject();
                o.put("status", code);
                o.put("body", resp);
                return o.toString();
            } catch (Exception e) {
                return "ERR:" + e.getClass().getSimpleName() + " "
                        + (e.getMessage() == null ? "request failed" : e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }

        private String post(String urlStr, String headersJson, String body, int timeoutSec) {
            HttpURLConnection c = null;
            try {
                URL url = new URL(urlStr);
                if (!"https".equalsIgnoreCase(url.getProtocol())) return "ERR:only https is allowed";
                c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(Math.max(5, timeoutSec) * 1000);
                c.setReadTimeout(Math.max(5, timeoutSec) * 1000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                for (java.util.Iterator<String> it = h.keys(); it.hasNext(); ) {
                    String k = it.next();
                    c.setRequestProperty(k, h.getString(k));
                }
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String resp = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
                if (code >= 400) return "ERR:HTTP " + code + " " + resp.substring(0, Math.min(300, resp.length()));
                return resp;
            } catch (Exception e) {
                return "ERR:" + e.getClass().getSimpleName() + " " + e.getMessage();
            } finally {
                if (c != null) c.disconnect();
            }
        }
    }

    // ------------------------------------------------------------------ capture

    private File cardsDir() {
        File d = new File(getFilesDir(), "cards");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private void launchCamera() {
        try {
            pendingCameraFile = new File(getCacheDir(), "capture-" + System.currentTimeMillis() + ".jpg");
            pendingCameraUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", pendingCameraFile);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_CAMERA);
        } catch (Exception e) {
            postScanError("Cannot open the camera: " + e.getMessage());
        }
    }

    private void launchPicker() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        startActivityForResult(i, REQ_PICK);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK) {
            web.post(() -> web.evaluateJavascript("window.onScanCancelled && window.onScanCancelled()", null));
            return;
        }
        if (req == REQ_CAMERA) {
            new Thread(() -> importAndRecognize(pendingCameraFile)).start();
        } else if (req == REQ_PICK && data != null && data.getData() != null) {
            final Uri uri = data.getData();
            new Thread(() -> {
                try {
                    File tmp = new File(getCacheDir(), "picked-" + System.currentTimeMillis() + ".jpg");
                    try (InputStream in = getContentResolver().openInputStream(uri);
                         FileOutputStream out = new FileOutputStream(tmp)) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                    importAndRecognize(tmp);
                } catch (Exception e) {
                    postScanError("Cannot read the picture: " + e.getMessage());
                }
            }).start();
        }
    }

    /** Downscale + rotate the capture, store it, then OCR it. */
    private void importAndRecognize(File src) {
        try {
            if (src == null || !src.exists()) {
                postScanError("The camera returned no picture.");
                return;
            }
            Bitmap bmp = decodeScaled(src, 1800);
            if (bmp == null) {
                postScanError("Unsupported image.");
                return;
            }
            bmp = applyExifRotation(src, bmp);
            String name = "card-" + System.currentTimeMillis() + ".jpg";
            File dst = new File(cardsDir(), name);
            try (FileOutputStream out = new FileOutputStream(dst)) {
                bmp.compress(Bitmap.CompressFormat.JPEG, 88, out);
            }
            src.delete();
            recognize(dst, name, true);
        } catch (Exception e) {
            postScanError("Capture failed: " + e.getMessage());
        }
    }

    private void recognize(File image, String imageName, boolean includeThumb) {
        try {
            InputImage input = InputImage.fromFilePath(this, Uri.fromFile(image));
            TextRecognizer rec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            rec.process(input)
                    .addOnSuccessListener(text -> {
                        String out = orderedText(text);
                        String thumb = includeThumb ? thumbnail(image) : "";
                        postScanResult(out, imageName, thumb, countLines(text));
                    })
                    .addOnFailureListener(e -> postScanError("Text recognition failed: " + e.getMessage()));
        } catch (Exception e) {
            postScanError("Text recognition failed: " + e.getMessage());
        }
    }

    private static int countLines(Text text) {
        int n = 0;
        for (Text.TextBlock b : text.getTextBlocks()) n += b.getLines().size();
        return n;
    }

    /** ML Kit blocks are not always top-to-bottom; sort the lines geometrically. */
    private static String orderedText(Text text) {
        List<Text.Line> lines = new ArrayList<>();
        for (Text.TextBlock b : text.getTextBlocks()) lines.addAll(b.getLines());
        Collections.sort(lines, new Comparator<Text.Line>() {
            @Override
            public int compare(Text.Line a, Text.Line b) {
                android.graphics.Rect ra = a.getBoundingBox(), rb = b.getBoundingBox();
                if (ra == null || rb == null) return 0;
                int rowA = ra.centerY() / Math.max(12, ra.height());
                int rowB = rb.centerY() / Math.max(12, rb.height());
                if (rowA != rowB) return Integer.compare(ra.centerY(), rb.centerY());
                return Integer.compare(ra.left, rb.left);
            }
        });
        StringBuilder sb = new StringBuilder();
        for (Text.Line l : lines) sb.append(l.getText()).append('\n');
        return sb.toString().trim();
    }

    private String thumbnail(File image) {
        try {
            Bitmap b = decodeScaled(image, 520);
            if (b == null) return "";
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 70, bos);
            return "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    private static Bitmap decodeScaled(File f, int maxEdge) {
        BitmapFactory.Options probe = new BitmapFactory.Options();
        probe.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getAbsolutePath(), probe);
        int longest = Math.max(probe.outWidth, probe.outHeight);
        int scale = 1;
        while (longest / scale > maxEdge * 2) scale *= 2;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = scale;
        Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), o);
        if (bmp == null) return null;
        int l = Math.max(bmp.getWidth(), bmp.getHeight());
        if (l > maxEdge) {
            float r = (float) maxEdge / l;
            Bitmap sc = Bitmap.createScaledBitmap(bmp,
                    Math.round(bmp.getWidth() * r), Math.round(bmp.getHeight() * r), true);
            if (sc != bmp) bmp.recycle();
            return sc;
        }
        return bmp;
    }

    private static Bitmap applyExifRotation(File f, Bitmap bmp) {
        try {
            int o = new ExifInterface(f.getAbsolutePath())
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            int deg = 0;
            if (o == ExifInterface.ORIENTATION_ROTATE_90) deg = 90;
            else if (o == ExifInterface.ORIENTATION_ROTATE_180) deg = 180;
            else if (o == ExifInterface.ORIENTATION_ROTATE_270) deg = 270;
            if (deg == 0) return bmp;
            Matrix m = new Matrix();
            m.postRotate(deg);
            Bitmap r = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (r != bmp) bmp.recycle();
            return r;
        } catch (Exception e) {
            return bmp;
        }
    }

    // ------------------------------------------------------------------ helpers

    private void postScanResult(String text, String imageName, String thumb, int lines) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("text", text);
            o.put("image", imageName);
            o.put("thumb", thumb);
            o.put("lines", lines);
        } catch (Exception ignored) {
        }
        final String js = "window.onScan(" + o + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private void postScanError(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", message);
        } catch (Exception ignored) {
        }
        final String js = "window.onScan(" + o + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private static String json(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    private static String readFile(File f) throws IOException {
        return new String(readAll(new java.io.FileInputStream(f)), StandardCharsets.UTF_8);
    }
}
