package app.saveitup.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    // Text shared into the app (Android "Share" sheet) that the web layer hasn't picked up yet.
    private static String pendingShare = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        captureShare(getIntent());
        // The web app calls SaveItUpNative.takeShared() on start-up to fetch a share that launched it.
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String takeShared() {
                String s = pendingShare;
                pendingShare = null;
                return s == null ? "" : s;
            }

            // Opens a link in Chrome (normal or, if Chrome honours the hint, incognito).
            // Returns "chrome", "chrome-incognito", "default" (Chrome missing, default browser used) or "error".
            @JavascriptInterface
            public String openInChrome(String url, boolean incognito) {
                try {
                    Uri uri = Uri.parse(url);
                    String scheme = uri.getScheme();
                    if (scheme == null || !(scheme.equals("http") || scheme.equals("https"))) return "error";
                    if (incognito) {
                        // Chrome ignores an "open incognito" hint from other apps, but supports ephemeral Custom Tabs:
                        // a private tab that keeps no history, cookies or cache after it closes.
                        try {
                            CustomTabsIntent tab = new CustomTabsIntent.Builder().setEphemeralBrowsingEnabled(true).build();
                            tab.intent.setPackage("com.android.chrome");
                            tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            tab.launchUrl(MainActivity.this, uri);
                            return "chrome-ephemeral";
                        } catch (Exception ignored) {
                            // fall through to the plain intent below
                        }
                    }
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    intent.setPackage("com.android.chrome");
                    if (incognito) intent.putExtra("com.google.android.apps.chrome.EXTRA_OPEN_NEW_INCOGNITO_TAB", true);
                    try {
                        startActivity(intent);
                        return incognito ? "chrome-incognito" : "chrome";
                    } catch (ActivityNotFoundException e) {
                        intent.setPackage(null);
                        startActivity(intent);
                        return "default";
                    }
                } catch (Exception e) {
                    return "error";
                }
            }
        }, "SaveItUpNative");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (captureShare(intent) && pendingShare != null) {
            // App is already running: hand the shared text to the page right away.
            final String js = "window.dispatchEvent(new CustomEvent('saveitup-share',{detail:" + JSONObject.quote(pendingShare) + "}));";
            pendingShare = null;
            getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(js, null));
        }
    }

    private boolean captureShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.isEmpty()) return false;
        pendingShare = text;
        return true;
    }
}
