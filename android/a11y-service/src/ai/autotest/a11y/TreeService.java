package ai.autotest.a11y;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Read-only accessibility service: answers GET /ping and GET /dump?token=... on 127.0.0.1:18765 with the
 * current windows as uiautomator-format XML (core/a11y-service.ts is the client). Performs no actions.
 */
public class TreeService extends AccessibilityService {
    static final int PORT = 18765;
    static final int VERSION = 2;

    private volatile ServerSocket server;
    private volatile boolean connected;

    @Override
    protected void onServiceConnected() {
        connected = true;
        Thread t = new Thread(this::serve, "autotest-a11y-server");
        t.setDaemon(true);
        t.start();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing: the tree is read on request.
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        connected = false;
        closeServer();
        super.onDestroy();
    }

    private void closeServer() {
        try {
            if (server != null) server.close();
        } catch (Exception ignored) {
        }
    }

    private void serve() {
        try {
            server = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"));
            while (connected) {
                final Socket s = server.accept();
                Thread h = new Thread(() -> handle(s), "autotest-a11y-req");
                h.setDaemon(true);
                h.start();
            }
        } catch (Exception ignored) {
            // Closed on destroy, or the port is taken (an old instance): the host sees /ping fail.
        } finally {
            closeServer();
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(5000);
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null) return;
            // Drain headers.
            String h;
            while ((h = in.readLine()) != null && !h.isEmpty()) {
            }
            String[] parts = line.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            OutputStream out = sock.getOutputStream();
            if (path.equals("/ping")) {
                respond(out, 200, "application/json", "{\"ok\":true,\"name\":\"autotest-a11y\",\"version\":" + VERSION + ",\"connected\":" + connected + "}");
            } else if (path.startsWith("/dump")) {
                String token = query(path, "token");
                String want = TokenStore.get();
                if (want == null || token == null || !constantTimeEquals(want, token)) {
                    respond(out, 401, "text/plain", "token required");
                } else {
                    respond(out, 200, "text/xml; charset=utf-8", dump());
                }
            } else {
                respond(out, 404, "text/plain", "not found");
            }
        } catch (Exception ignored) {
        }
    }

    private String dump() {
        List<AccessibilityNodeInfo> roots = new ArrayList<>();
        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            // getWindows() is top-most first; uiautomator lists bottom-most first.
            for (int i = ws.size() - 1; i >= 0; i--) {
                AccessibilityNodeInfo r = ws.get(i).getRoot();
                if (r != null) roots.add(r);
            }
        } catch (Exception ignored) {
        }
        if (roots.isEmpty()) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) roots.add(r);
        }
        try {
            return Dumper.toXml(roots);
        } finally {
            for (AccessibilityNodeInfo r : roots) Dumper.recycle(r);
        }
    }

    private static String query(String path, String key) {
        int q = path.indexOf('?');
        if (q < 0) return null;
        for (String kv : path.substring(q + 1).split("&")) {
            int e = kv.indexOf('=');
            if (e > 0 && kv.substring(0, e).equals(key)) return kv.substring(e + 1);
        }
        return null;
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int r = 0;
        for (int i = 0; i < a.length(); i++) r |= a.charAt(i) ^ b.charAt(i);
        return r == 0;
    }

    private static void respond(OutputStream out, int code, String type, String body) throws Exception {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        String status = code == 200 ? "OK" : code == 401 ? "Unauthorized" : "Not Found";
        String head = "HTTP/1.0 " + code + " " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(b);
        out.flush();
    }
}
