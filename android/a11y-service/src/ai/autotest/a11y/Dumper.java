package ai.autotest.a11y;

import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/** Accessibility nodes → uiautomator-format XML (same attributes and invisible-child skipping as `uiautomator dump`). */
final class Dumper {
    private Dumper() {
    }

    static String toXml(List<AccessibilityNodeInfo> roots) {
        StringBuilder sb = new StringBuilder(64 * 1024);
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        int i = 0;
        for (AccessibilityNodeInfo r : roots) node(sb, r, i++, 0);
        sb.append("</hierarchy>");
        return sb.toString();
    }

    private static void node(StringBuilder sb, AccessibilityNodeInfo n, int index, int depth) {
        if (n == null || depth > 80) return;
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        sb.append("<node index=\"").append(index).append('"');
        attr(sb, "text", n.getText());
        attr(sb, "resource-id", n.getViewIdResourceName());
        attr(sb, "class", n.getClassName());
        attr(sb, "package", n.getPackageName());
        attr(sb, "content-desc", n.getContentDescription());
        bool(sb, "checkable", n.isCheckable());
        bool(sb, "checked", n.isChecked());
        bool(sb, "clickable", n.isClickable());
        bool(sb, "enabled", n.isEnabled());
        bool(sb, "focusable", n.isFocusable());
        bool(sb, "focused", n.isFocused());
        bool(sb, "scrollable", n.isScrollable());
        bool(sb, "long-clickable", n.isLongClickable());
        bool(sb, "password", n.isPassword());
        bool(sb, "selected", n.isSelected());
        bool(sb, "visible-to-user", n.isVisibleToUser());
        sb.append(" bounds=\"[").append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\"");
        if (Build.VERSION.SDK_INT >= 26) attr(sb, "hint", n.getHintText());
        int c = n.getChildCount();
        if (c == 0) {
            sb.append(" />");
            return;
        }
        sb.append('>');
        for (int k = 0; k < c; k++) {
            AccessibilityNodeInfo ch = n.getChild(k);
            if (ch == null) continue;
            // uiautomator skips children not visible to the user.
            if (ch.isVisibleToUser()) node(sb, ch, k, depth + 1);
        }
        sb.append("</node>");
    }

    private static void bool(StringBuilder sb, String k, boolean v) {
        sb.append(' ').append(k).append("=\"").append(v).append('"');
    }

    private static void attr(StringBuilder sb, String k, CharSequence v) {
        sb.append(' ').append(k).append("=\"");
        if (v != null) escape(sb, v.toString());
        sb.append('"');
    }

    private static void escape(StringBuilder sb, String s) {
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                case '\n': sb.append("&#10;"); break;
                case '\r': sb.append("&#13;"); break;
                default:
                    // Control characters are not valid XML 1.0.
                    if (ch < 0x20 && ch != '\t') continue;
                    sb.append(ch);
            }
        }
    }
}
