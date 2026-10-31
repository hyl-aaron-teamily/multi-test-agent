package ai.autotest.a11y;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives the session token from the host (adb shell `am broadcast`; guarded by WRITE_SECURE_SETTINGS in the manifest). */
public class TokenReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String t = intent.getStringExtra("token");
        if (t != null && t.length() >= 16) TokenStore.set(t);
    }
}
