package com.clubrent.tracker;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String BKASH_PACKAGE = "com.bKash.customerapp";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Exposes window.CRTNative.openBkash() to the web app.
        getBridge().getWebView().addJavascriptInterface(new NativeBridge(), "CRTNative");
    }

    public class NativeBridge {
        // Opens the bKash app if installed, otherwise its Play Store page.
        @JavascriptInterface
        public void openBkash() {
            runOnUiThread(() -> {
                Intent launch = getPackageManager().getLaunchIntentForPackage(BKASH_PACKAGE);
                if (launch != null) {
                    startActivity(launch);
                } else {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                            Uri.parse("https://play.google.com/store/apps/details?id=" + BKASH_PACKAGE)));
                }
            });
        }
    }
}
