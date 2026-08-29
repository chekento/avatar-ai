package ai.avatar.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

public final class MainActivity extends Activity implements TextToSpeech.OnInitListener {
    private static final String APP_ORIGIN = "https://app.avatar.local/";
    private static final int RECORD_AUDIO_REQUEST = 41;
    private static final String KEY_ALIAS = "avatar-ai-session-secrets";
    private static final String PREFS = "avatar-ai-encrypted";

    private WebView webView;
    private SpeechRecognizer recognizer;
    private TextToSpeech textToSpeech;
    private boolean ttsReady = false;
    private String pendingSpeech;
    private String pendingSpeechLanguage = "de-DE";
    private String pendingRecognitionLanguage;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 16, 29));
        getWindow().setNavigationBarColor(Color.rgb(7, 16, 29));
        textToSpeech = new TextToSpeech(this, this);
        configureWebView();
        handleOAuthIntent(getIntent());
    }

    private void configureWebView() {
        webView = new WebView(this);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setBackgroundColor(Color.rgb(7, 16, 29));
        webView.addJavascriptInterface(new AvatarBridge(), "AvatarAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"app.avatar.local".equals(uri.getHost())) return null;
                String path = uri.getPath() == null ? "AvatarAI.html" : uri.getPath().replaceFirst("^/", "");
                if (path.isEmpty()) path = "AvatarAI.html";
                try {
                    InputStream stream = getAssets().open(path);
                    String extension = MimeTypeMap.getFileExtensionFromUrl(path);
                    String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                    if (mime == null) mime = path.endsWith(".html") ? "text/html" : "application/octet-stream";
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'self' https: data:; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src https:; frame-src https://accounts.google.com https://huggingface.co https://openrouter.ai");
                    headers.put("X-Content-Type-Options", "nosniff");
                    return new WebResourceResponse(mime, StandardCharsets.UTF_8.name(), 200, "OK", headers, stream);
                } catch (Exception ignored) {
                    return null;
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("app.avatar.local".equals(uri.getHost())) return false;
                openExternal(uri.toString());
                return true;
            }
        });
        webView.loadUrl(APP_ORIGIN + "AvatarAI.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOAuthIntent(intent);
    }

    private void handleOAuthIntent(Intent intent) {
        if (intent == null || intent.getData() == null || !"avatarai".equals(intent.getData().getScheme())) return;
        String callback = intent.getData().toString();
        webView.post(() -> webView.evaluateJavascript("window.avatarNative&&window.avatarNative.oauthCallback(" + JSONObject.quote(callback) + ")", null));
    }

    private void openExternal(String url) {
        runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
            } catch (ActivityNotFoundException exception) {
                Toast.makeText(this, "Kein Browser verfügbar", Toast.LENGTH_LONG).show();
            }
        });
    }

    private void startRecognition(String language) {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            callback("onSpeechError", "Auf diesem Gerät ist keine Spracherkennung verfügbar.");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingRecognitionLanguage = language;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, RECORD_AUDIO_REQUEST);
            return;
        }
        stopRecognition();
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}
            @Override public void onError(int error) { callback("onSpeechError", speechError(error)); stopRecognition(); }
            @Override public void onResults(Bundle results) {
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) callback("onSpeechResult", matches.get(0));
                else callback("onSpeechError", "Ich habe nichts verstanden.");
                stopRecognition();
            }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        recognizer.startListening(intent);
    }

    private String speechError(int code) {
        if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) return "Ich habe nichts verstanden.";
        if (code == SpeechRecognizer.ERROR_NETWORK || code == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) return "Die Spracherkennung hat kein Netzwerk.";
        if (code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) return "Die Mikrofonberechtigung fehlt.";
        return "Spracherkennung fehlgeschlagen (" + code + ").";
    }

    private void stopRecognition() {
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }

    private void speakNative(String text, String language) {
        if (!ttsReady) {
            pendingSpeech = text;
            pendingSpeechLanguage = language;
            return;
        }
        Locale locale = Locale.forLanguageTag(language);
        textToSpeech.setLanguage(locale);
        textToSpeech.setSpeechRate(1.01f);
        textToSpeech.setPitch(1.03f);
        textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "avatar-ai-answer");
    }

    @Override
    public void onInit(int status) {
        ttsReady = status == TextToSpeech.SUCCESS;
        if (ttsReady) {
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onError(String utteranceId) { callbackNoArg("onSpeechDone"); }
                @Override public void onDone(String utteranceId) { callbackNoArg("onSpeechDone"); }
            });
            if (pendingSpeech != null) {
                String value = pendingSpeech;
                pendingSpeech = null;
                speakNative(value, pendingSpeechLanguage);
            }
        } else callback("onSpeechError", "Die Sprachausgabe konnte nicht gestartet werden.");
    }

    private void callback(String method, String value) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript("window.avatarNative&&window.avatarNative." + method + "(" + JSONObject.quote(value) + ")", null));
    }

    private void callbackNoArg(String method) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript("window.avatarNative&&window.avatarNative." + method + "()", null));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != RECORD_AUDIO_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            String language = pendingRecognitionLanguage == null ? "de-DE" : pendingRecognitionLanguage;
            pendingRecognitionLanguage = null;
            startRecognition(language);
        } else callback("onSpeechError", "Mikrofonzugriff wurde nicht erlaubt. Du kannst weiter tippen.");
    }

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    private void putSecret(String key, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key, packed).apply();
    }

    private String readSecret(String key) throws Exception {
        String packed = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, null);
        if (packed == null) return null;
        String[] parts = packed.split(":", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    public final class AvatarBridge {
        @JavascriptInterface public void openExternal(String url) {
            if (url != null && (url.startsWith("https://") || url.startsWith("http://localhost"))) MainActivity.this.openExternal(url);
        }
        @JavascriptInterface public void startListening(String language) { runOnUiThread(() -> startRecognition(language)); }
        @JavascriptInterface public void stopListening() { runOnUiThread(MainActivity.this::stopRecognition); }
        @JavascriptInterface public void speak(String text, String language) { runOnUiThread(() -> speakNative(text, language)); }
        @JavascriptInterface public void stopSpeaking() { runOnUiThread(() -> { if (textToSpeech != null) textToSpeech.stop(); callbackNoArg("onSpeechDone"); }); }
        @JavascriptInterface public void secureSet(String key, String value) { try { putSecret(key, value); } catch (Exception ignored) {} }
        @JavascriptInterface public String secureGet(String key) { try { return readSecret(key); } catch (Exception ignored) { return null; } }
        @JavascriptInterface public void secureDelete(String key) { getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(key).apply(); }
    }

    @Override
    protected void onDestroy() {
        stopRecognition();
        if (textToSpeech != null) { textToSpeech.stop(); textToSpeech.shutdown(); }
        if (webView != null) { webView.removeJavascriptInterface("AvatarAndroid"); webView.destroy(); }
        super.onDestroy();
    }
}
