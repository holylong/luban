package dev.luban.remote;

import android.app.Activity;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Android shell for the existing /m console, which stays served by the luban relay.
 *
 * The shell draws native chrome around the WebView (a slim status strip, the
 * setup screen and the appearance screen) instead of leaving a stock button bar
 * above a web page that already has its own header.
 */
public final class MainActivity extends Activity {
    private static final String PREF_URL = "relay_url";
    private static final int SCREEN_SETUP = 0;
    private static final int SCREEN_CONSOLE = 1;

    private SharedPreferences prefs;
    private Theme theme;
    private ConnectionHistory history;
    private FrameLayout frame;
    private LinearLayout column;
    private FrameLayout overlay;

    private WebView web;
    private TextView status;
    private TextView statusDot;
    // Live task line reported by the console; empty means "only connected".
    private String taskText = "";
    private String connectionText = "";
    private int connectionDot;
    private Uri origin;
    private String pendingAddress;
    private String consoleUrl;
    private String mainFrameHttpError;
    private int screen = SCREEN_SETUP;
    private String setupError = "";
    private boolean appearanceDirty;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getPreferences(MODE_PRIVATE);
        theme = Theme.of(prefs, getResources().getConfiguration());
        Theme.apply(this, theme);
        frame = new FrameLayout(this);
        frame.setBackgroundColor(theme.bg);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(0, bars.top, 0, bars.bottom);
            } else {
                view.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(theme.bg);
        frame.addView(column, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        history = new ConnectionHistory(prefs);
        java.util.List<ConnectionHistory.Record> recent = history.load();
        String saved = prefs.getString(PREF_URL, "");
        if (!recent.isEmpty()) open(recent.get(0).launchUrl);
        else if (saved.isEmpty()) showSetup("");
        else open(saved);
    }

    /* ---------------------------------------------------------------- theme */

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView label(String value, float size, int color, boolean strong) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (strong) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return view;
    }

    private Drawable surface(int fill, int stroke, int radiusDp) {
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.RECTANGLE);
        shape.setColor(fill);
        shape.setCornerRadius(dp(radiusDp));
        if (stroke != 0) shape.setStroke(dp(1), stroke);
        return shape;
    }

    private Drawable pressable(Drawable content) {
        return new RippleDrawable(ColorStateList.valueOf(theme.dark ? 0x33FFFFFF : 0x22000000), content, null);
    }

    private Drawable touch() {
        return new RippleDrawable(ColorStateList.valueOf(theme.dark ? 0x26FFFFFF : 0x1F000000), null, null);
    }

    private TextView action(String text, boolean primary, View.OnClickListener click) {
        TextView view = label(text, primary ? 16f : 14.5f, primary ? theme.onAccent : theme.fg, true);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(48));
        view.setPadding(dp(18), dp(12), dp(18), dp(12));
        view.setBackground(pressable(primary
                ? surface(theme.accent, 0, 14)
                : surface(theme.panelAlt, theme.line, 14)));
        view.setOnClickListener(click);
        return view;
    }

    private TextView choice(String text, boolean active, View.OnClickListener click) {
        TextView view = label(text, 14.5f, active ? theme.fg : theme.muted, active);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(46));
        view.setPadding(dp(4), 0, dp(4), 0);
        view.setBackground(pressable(active
                ? surface(theme.accentSoft, theme.accent, 13)
                : surface(theme.panelAlt, theme.line, 13)));
        view.setOnClickListener(click);
        return view;
    }

    private TextView dangerAction(String text, View.OnClickListener click) {
        TextView view = label(text, 15.5f, theme.danger, true);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(48));
        view.setPadding(dp(18), dp(12), dp(18), dp(12));
        view.setBackground(pressable(surface(theme.panel, theme.danger, 14)));
        view.setOnClickListener(click);
        return view;
    }

    private TextView iconAction(String glyph, View.OnClickListener click) {
        TextView view = label(glyph, 19f, theme.fg, false);
        view.setGravity(Gravity.CENTER);
        view.setMinWidth(dp(40));
        view.setMinHeight(dp(40));
        view.setBackground(pressable(surface(theme.panelAlt, theme.line, 20)));
        view.setOnClickListener(click);
        return view;
    }

    private LinearLayout card() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(dp(16), dp(15), dp(16), dp(15));
        view.setBackground(surface(theme.panel, theme.line, 16));
        return view;
    }

    private TextView section(String text) {
        TextView view = label(text, 12.5f, theme.dim, true);
        view.setLetterSpacing(0.06f);
        return view;
    }

    private TextView note(String text) { return note(text, theme.dim); }

    private TextView note(String text, int color) {
        TextView view = label(text, 12.5f, color, false);
        view.setLineSpacing(dp(2), 1f);
        return view;
    }

    private View divider() {
        View view = new View(this);
        view.setBackgroundColor(theme.line);
        return view;
    }

    private LinearLayout.LayoutParams above(int margin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(margin);
        return params;
    }

    private LinearLayout.LayoutParams below(int margin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(margin);
        return params;
    }

    private void setStatus(String text, int dot) {
        connectionText = text;
        connectionDot = dot;
        renderStatus();
    }

    /** Work in progress outranks the connection line: the strip is the only
     *  always-visible surface, so it is what tells the reader the computer is
     *  still busy after the transcript has scrolled away. */
    private void renderStatus() {
        if (status == null) return;
        boolean busy = !taskText.isEmpty();
        status.setText(busy ? taskText : connectionText);
        status.setTextColor(busy ? theme.accent : theme.muted);
        if (statusDot != null) statusDot.setTextColor(busy ? theme.accent : connectionDot);
    }

    /** The console reports {working,label,detail,seconds,stalled}; anything it
     *  cannot parse simply means the strip keeps its connection text. */
    private void applyTaskStatus(String payload) {
        String line = "";
        try {
            JSONObject json = new JSONObject(payload);
            if (json.optBoolean("working", false)) {
                String label = json.optString("label", "");
                String detail = json.optString("detail", "");
                int seconds = json.optInt("seconds", 0);
                StringBuilder text = new StringBuilder(label.isEmpty() ? "工作中" : label);
                if (!detail.isEmpty()) {
                    text.append(" · ").append(detail.length() > 34
                            ? detail.substring(0, 33) + "…" : detail);
                }
                if (seconds > 0) text.append(" · ").append(seconds).append("s");
                if (json.optBoolean("stalled", false)) text.append(" · 等待输出");
                line = text.toString();
            }
        } catch (JSONException ignored) {
            line = "";
        }
        taskText = line;
        renderStatus();
    }

    /** The page pushes progress through this; a WebView has no other channel
     *  that the shell can read without polling the DOM. */
    private final class TaskBridge {
        @JavascriptInterface
        public void setTaskStatus(String payload) {
            final TextView target = status;
            if (target == null) return;
            target.post(() -> {
                if (status == target) applyTaskStatus(payload);
            });
        }
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception missing) {
            return "?";
        }
    }

    /* ------------------------------------------------------------ overlays */

    private FrameLayout openOverlay() {
        closeOverlay();
        FrameLayout scrim = new FrameLayout(this);
        scrim.setBackgroundColor(theme.scrim);
        scrim.setClickable(true);
        scrim.setOnClickListener(view -> closeOverlay());
        overlay = scrim;
        frame.addView(scrim, new FrameLayout.LayoutParams(-1, -1));
        return scrim;
    }

    private void closeOverlay() {
        if (overlay != null && overlay.getParent() == frame) frame.removeView(overlay);
        overlay = null;
    }

    private void showMenu() {
        FrameLayout scrim = openOverlay();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(6), dp(6), dp(6), dp(6));
        sheet.setBackground(surface(theme.panel, theme.line, 16));
        sheet.addView(menuRow("外观设置", view -> { appearanceDirty = false; showAppearance(); }));
        sheet.addView(menuRow("刷新页面", view -> { closeOverlay(); if (web != null) web.reload(); }));
        sheet.addView(menuRow("连接记录", view -> { closeOverlay(); showSetup(""); }));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(190), -2, Gravity.TOP | Gravity.END);
        params.topMargin = dp(48);
        params.rightMargin = dp(12);
        scrim.addView(sheet, params);
    }

    private TextView menuRow(String text, View.OnClickListener click) {
        TextView view = label(text, 15.5f, theme.fg, false);
        view.setPadding(dp(14), dp(14), dp(14), dp(14));
        view.setBackground(touch());
        view.setOnClickListener(click);
        return view;
    }

    /* ----------------------------------------------------------- appearance */

    private void showAppearance() {
        FrameLayout scrim = openOverlay();
        scrim.setOnClickListener(null);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(theme.bg);
        page.setClickable(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(8), dp(14), dp(8));
        bar.setBackgroundColor(theme.panel);
        bar.addView(iconAction("‹", view -> {
            closeOverlay();
            if (appearanceDirty) {
                appearanceDirty = false;
                reloadBase();
            }
        }));
        TextView title = label("外观设置", 18f, theme.fg, true);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, -2, 1);
        titleParams.leftMargin = dp(10);
        bar.addView(title, titleParams);
        page.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        page.addView(divider(), new LinearLayout.LayoutParams(-1, dp(1)));

        ScrollView scroll = new ScrollView(this);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(16), dp(18), dp(16), dp(28));
        scroll.addView(form);
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout themeCard = card();
        themeCard.addView(section("主题"));
        LinearLayout themeRow = new LinearLayout(this);
        themeRow.setOrientation(LinearLayout.HORIZONTAL);
        for (int index = 0; index < Theme.MODES.length; index++) {
            String mode = Theme.MODES[index];
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
            if (index > 0) params.leftMargin = dp(8);
            themeRow.addView(choice(Theme.MODE_LABELS[index], theme.mode.equals(mode), view -> pickTheme(mode)), params);
        }
        themeCard.addView(themeRow, above(12));
        themeCard.addView(note("「跟随系统」会随手机的深色模式自动切换，页面和窗口栏一起变。"), above(12));
        form.addView(themeCard, below(14));

        LinearLayout zoomCard = card();
        zoomCard.addView(section("文字大小"));
        LinearLayout zoomRow = new LinearLayout(this);
        zoomRow.setOrientation(LinearLayout.HORIZONTAL);
        for (int index = 0; index < Theme.TEXT_ZOOMS.length; index++) {
            int zoom = Theme.TEXT_ZOOMS[index];
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
            if (index > 0) params.leftMargin = dp(8);
            zoomRow.addView(choice(Theme.TEXT_ZOOM_LABELS[index], theme.textZoom == zoom, view -> pickTextZoom(zoom)), params);
        }
        zoomCard.addView(zoomRow, above(12));
        zoomCard.addView(note("文字大小会同时放大手机控制台的正文，长回答更好读。"), above(12));
        form.addView(zoomCard, below(14));

        LinearLayout about = card();
        about.addView(section("关于"));
        about.addView(kvLine("版本", "v" + appVersion()), above(10));
        about.addView(kvLine("控制台", "luban 手机页面 · /m/"), above(8));
        form.addView(about);

        scrim.addView(page, new FrameLayout.LayoutParams(-1, -1));
    }

    private LinearLayout kvLine(String key, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(label(key, 13.5f, theme.dim, false), new LinearLayout.LayoutParams(dp(64), -2));
        TextView text = label(value, 14f, theme.fg, false);
        text.setSingleLine(true);
        text.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));
        return row;
    }

    private void pickTheme(String mode) {
        prefs.edit().putString(Theme.PREF_MODE, mode).apply();
        theme = Theme.of(prefs, getResources().getConfiguration());
        Theme.apply(this, theme);
        frame.setBackgroundColor(theme.bg);
        appearanceDirty = true;
        showAppearance();
    }

    private void pickTextZoom(int zoom) {
        prefs.edit().putInt(Theme.PREF_TEXT_ZOOM, zoom).apply();
        theme = Theme.of(prefs, getResources().getConfiguration());
        if (web != null) web.getSettings().setTextZoom(theme.textZoom);
        appearanceDirty = true;
        showAppearance();
    }

    /** Rebuild whatever is under the overlay with the palette now in force. */
    private void reloadBase() {
        theme = Theme.of(prefs, getResources().getConfiguration());
        Theme.apply(this, theme);
        frame.setBackgroundColor(theme.bg);
        if (screen == SCREEN_CONSOLE && consoleUrl != null) open(consoleUrl);
        else showSetup(setupError);
    }

    /* ---------------------------------------------------------------- setup */

    private void showSetup(String error) {
        setupError = error == null ? "" : error;
        screen = SCREEN_SETUP;
        destroyWeb();
        status = null;
        statusDot = null;
        column.removeAllViews();

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        column.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(24), dp(20), dp(28));
        scroll.addView(form);

        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView badge = new ImageView(this);
        badge.setImageResource(R.drawable.ic_luban);
        LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(dp(46), dp(46));
        badgeParams.rightMargin = dp(12);
        head.addView(badge, badgeParams);
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.addView(label("luban 遥控", 27f, theme.fg, true));
        titles.addView(label("手机上派活，电脑上干活", 14f, theme.muted, false), above(2));
        head.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
        head.addView(iconAction("⚙", view -> { appearanceDirty = false; showAppearance(); }));
        form.addView(head, below(18));

        LinearLayout connect = card();
        connect.addView(section("中继访问地址"));
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setTextSize(15.5f);
        address.setTextColor(theme.fg);
        address.setHintTextColor(theme.dim);
        address.setHint("https://中继地址/m/?token=…");
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(prefs.getString(PREF_URL, ""));
        address.setBackground(surface(theme.panelAlt, theme.line, 12));
        address.setPadding(dp(14), dp(13), dp(14), dp(13));
        connect.addView(address, above(10));
        connect.addView(action("连接", true, view -> {
            String value = address.getText().toString().trim();
            Uri parsed = Uri.parse(value);
            String scheme = parsed.getScheme();
            if (!("http".equals(scheme) || "https".equals(scheme)) || parsed.getHost() == null || parsed.getHost().isEmpty()) {
                address.setError("请输入完整的 http:// 或 https:// 地址");
                return;
            }
            open(value);
        }), above(14));
        if (!setupError.isEmpty()) connect.addView(note(setupError, theme.danger), above(12));
        form.addView(connect, below(18));

        java.util.List<ConnectionHistory.Record> recent = history.load();
        if (!recent.isEmpty()) {
            TextView heading = section("最近连接");
            LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(-1, -2);
            headingParams.topMargin = dp(4);
            headingParams.bottomMargin = dp(10);
            form.addView(heading, headingParams);
            for (ConnectionHistory.Record record : recent) form.addView(historyRow(record), below(10));
        }

        form.addView(note("HTTPS 使用系统受信证书；自签证书须先在 Android 设置中安装 CA。"), above(10));
    }

    private View historyRow(ConnectionHistory.Record record) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(13), dp(8), dp(13));
        row.setBackground(pressable(surface(theme.panel, theme.line, 16)));

        LinearLayout labels = new LinearLayout(this);
        labels.setOrientation(LinearLayout.VERTICAL);
        Uri parsed = Uri.parse(record.displayUrl);
        String node = parsed.getQueryParameter("node");
        String host = parsed.getHost() == null ? record.displayUrl : parsed.getHost();
        TextView name = label(host + (node == null ? "" : " · " + node), 16f, theme.accent, true);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        labels.addView(name);
        TextView url = label(record.displayUrl, 12.5f, theme.dim, false);
        url.setSingleLine(true);
        url.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        labels.addView(url, above(2));
        row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        row.setOnClickListener(view -> open(record.launchUrl));

        TextView remove = label("✕", 18f, theme.dim, false);
        remove.setGravity(Gravity.CENTER);
        remove.setBackground(pressable(surface(0, 0, 20)));
        remove.setOnClickListener(view -> confirmForget(record));
        row.addView(remove, new LinearLayout.LayoutParams(dp(44), dp(44)));
        return row;
    }

    private void confirmForget(ConnectionHistory.Record record) {
        FrameLayout scrim = openOverlay();
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(18), dp(18), dp(18), dp(14));
        panel.setBackground(surface(theme.panel, theme.line, 18));
        panel.addView(label("删除连接记录？", 17f, theme.fg, true));
        TextView url = note(record.displayUrl);
        url.setSingleLine(true);
        url.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        panel.addView(url, above(8));
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.END);
        TextView cancel = action("取消", false, view -> closeOverlay());
        TextView confirm = dangerAction("删除", view -> { forget(record); closeOverlay(); });
        actions.addView(cancel);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(-2, -2);
        gap.leftMargin = dp(10);
        actions.addView(confirm, gap);
        panel.addView(actions, above(16));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
        params.leftMargin = dp(24);
        params.rightMargin = dp(24);
        scrim.addView(panel, params);
    }

    private void forget(ConnectionHistory.Record record) {
        if (!history.forget(record.displayUrl)) {
            Toast.makeText(this, "删除失败，请重试", Toast.LENGTH_SHORT).show();
            return;
        }
        if (record.displayUrl.equals(prefs.getString(PREF_URL, ""))) prefs.edit().remove(PREF_URL).apply();
        if (screen == SCREEN_SETUP) showSetup("");
    }

    /* -------------------------------------------------------------- console */

    private static int port(Uri uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equals(uri.getScheme()) ? 443 : 80;
    }

    private static boolean hasCookie(String header, String name) {
        if (header == null) return false;
        String prefix = name + "=";
        for (String part : header.split(";")) {
            if (part.trim().startsWith(prefix)) return true;
        }
        return false;
    }

    private boolean sameOrigin(Uri url) {
        return origin != null && origin.getScheme().equalsIgnoreCase(url.getScheme())
                && origin.getHost().equalsIgnoreCase(url.getHost()) && port(origin) == port(url);
    }

    /** Pin the shell palette so the page never renders the other theme. */
    private String pinTheme(String url) {
        Uri parsed = Uri.parse(url);
        String path = parsed.getPath();
        if (path == null || !path.startsWith("/m/")) return url;
        String wanted = theme.pageTheme();
        // Comparing the value, not the URL string, is what keeps
        // shouldOverrideUrlLoading from reloading the same navigation forever.
        if (wanted.equals(parsed.getQueryParameter("theme"))) return url;
        // Uri.Builder has no "remove one parameter"; rebuild the query without it.
        StringBuilder query = new StringBuilder();
        for (String name : parsed.getQueryParameterNames()) {
            if ("theme".equals(name)) continue;
            for (String value : parsed.getQueryParameters(name)) {
                if (query.length() > 0) query.append('&');
                query.append(Uri.encode(name)).append('=').append(Uri.encode(value));
            }
        }
        if (query.length() > 0) query.append('&');
        query.append("theme=").append(wanted);
        return parsed.buildUpon().clearQuery().encodedQuery(query.toString()).build().toString();
    }

    private void paintPageTheme(WebView view, Theme palette) {
        String js = "(function(){var e=document.documentElement;e.setAttribute('data-luban-theme','"
                + palette.pageTheme() + "');var m=document.querySelector('meta[name=\"theme-color\"]');"
                + "if(m)m.setAttribute('content','" + palette.hex(palette.bg) + "');})()";
        view.evaluateJavascript(js, null);
    }

    private void destroyWeb() {
        if (web == null) return;
        web.stopLoading();
        web.destroy();
        web = null;
    }

    private void open(String address) {
        Uri requested = Uri.parse(address);
        origin = requested;
        pendingAddress = address;
        mainFrameHttpError = null;
        boolean freshLogin = requested.getQueryParameter("token") != null;
        if (freshLogin) {
            // A prior same-origin cookie can make a failed token link look like
            // a successful connection to the old node. Start a new login cleanly.
            prefs.edit().remove(PREF_URL).apply();
        }
        screen = SCREEN_CONSOLE;
        appearanceDirty = false;
        taskText = "";
        destroyWeb();
        status = null;
        statusDot = null;
        column.removeAllViews();

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(14), dp(8), dp(8), dp(8));
        bar.setBackgroundColor(theme.panel);
        statusDot = label("●", 11f, theme.dim, false);
        bar.addView(statusDot);
        status = label("连接中 · " + requested.getHost(), 13.5f, theme.muted, true);
        status.setSingleLine(true);
        status.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(0, -2, 1);
        statusParams.leftMargin = dp(8);
        bar.addView(status, statusParams);
        bar.addView(iconAction("⋮", view -> showMenu()), new LinearLayout.LayoutParams(dp(38), dp(38)));
        column.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        column.addView(divider(), new LinearLayout.LayoutParams(-1, dp(1)));

        web = new WebView(this);
        // Same object name as reportNativeStatus() in the mobile client.
        web.addJavascriptInterface(new TaskBridge(), "lubanShell");
        web.setBackgroundColor(theme.bg);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setTextZoom(theme.textZoom);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!sameOrigin(url)) {
                    Toast.makeText(MainActivity.this, "已阻止跳转到其他服务器", Toast.LENGTH_SHORT).show();
                    return true;
                }
                // Server redirects keep the old theme parameter; re-pin it on any
                // main-frame navigation so /m/ always renders the shell palette.
                if (request.isForMainFrame()) {
                    String pinned = pinTheme(url.toString());
                    if (!pinned.equals(url.toString())) {
                        view.loadUrl(pinned);
                        return true;
                    }
                }
                return false;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != web) return;
                // An earlier 401 belongs to its navigation, not to a later
                // successful login redirect or a manual reload.
                mainFrameHttpError = null;
                // A navigation reloads the console: its old progress is stale.
                taskText = "";
                setStatus("连接中 · " + origin.getHost(), theme.dim);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (view != web) return;
                // A login redirect lands on /m/ without the theme parameter, so
                // pin the palette from here as well.
                paintPageTheme(view, theme);
                Uri loaded = Uri.parse(url);
                String cookies = CookieManager.getInstance().getCookie(url);
                // Account login stores luban_account; one-tap/token login stores
                // luban_token. Accept either so the native status bar does not
                // report "未登录" after a successful account sign-in.
                boolean loggedIn = hasCookie(cookies, "luban_token") || hasCookie(cookies, "luban_account");
                boolean consoleReady = mainFrameHttpError == null && sameOrigin(loaded)
                        && "/m/".equals(loaded.getPath()) && loggedIn;
                if (consoleReady) {
                    // /login exchanges the one-time token for an HttpOnly cookie.
                    // Show a token-free address. The reconnect link itself stays encrypted.
                    Uri.Builder clean = loaded.buildUpon().clearQuery().fragment(null);
                    String node = loaded.getQueryParameter("node");
                    if (node != null && !node.isEmpty()) clean.appendQueryParameter("node", node);
                    String displayUrl = clean.build().toString();
                    String reconnectUrl = pendingAddress != null ? pendingAddress : displayUrl;
                    if (!history.remember(reconnectUrl, displayUrl)) {
                        Toast.makeText(MainActivity.this, "连接成功，但保存记录失败", Toast.LENGTH_SHORT).show();
                    }
                    getPreferences(MODE_PRIVATE).edit().putString(PREF_URL, displayUrl).apply();
                    consoleUrl = displayUrl;
                    CookieManager.getInstance().flush();
                    view.clearHistory();
                }
                if (mainFrameHttpError == null) {
                    setStatus(consoleReady ? "已连接 · " + origin.getHost() : "未登录 · 点右上角重新连接",
                            consoleReady ? theme.success : theme.dim);
                }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (view != web) return;
                if (request.isForMainFrame()) {
                    mainFrameHttpError = "HTTP " + response.getStatusCode();
                    setStatus("连接失败 · " + mainFrameHttpError + " · 检查令牌", theme.danger);
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view != web) return;
                if (request.isForMainFrame()) {
                    mainFrameHttpError = "网络错误";
                    setStatus("连接失败 · 右上角可刷新重试", theme.danger);
                }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (view == web) {
                    mainFrameHttpError = "证书错误";
                    setStatus("证书不受信任 · 安装 CA 或更换地址", theme.danger);
                }
            }
        });
        column.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));

        String path = requested.getPath();
        String destination = path == null || path.isEmpty() || "/".equals(path)
                ? requested.buildUpon().path("/m/").build().toString() : address;
        consoleUrl = destination;
        final String target = pinTheme(destination);
        if (freshLogin) {
            WebView loading = web;
            CookieManager cookies = CookieManager.getInstance();
            String cookieOrigin = requested.buildUpon().path("/").clearQuery().fragment(null).build().toString();
            // Clear only this server's old login. Other saved servers keep their cookies.
            cookies.setCookie(cookieOrigin, "luban_token=; Path=/; Max-Age=0", ignored -> {
                cookies.setCookie(cookieOrigin, "luban_account=; Path=/; Max-Age=0", ignoredAccount -> {
                    cookies.setCookie(cookieOrigin, "luban_node=; Path=/; Max-Age=0", ignoredNode -> {
                        cookies.flush();
                        loading.post(() -> { if (web == loading) loading.loadUrl(target); });
                    });
                });
            });
        } else {
            web.loadUrl(target);
        }
    }

    @Override public void onBackPressed() {
        if (overlay != null) {
            closeOverlay();
            if (appearanceDirty) {
                appearanceDirty = false;
                reloadBase();
            }
            return;
        }
        if (screen == SCREEN_CONSOLE && web != null && web.canGoBack()) web.goBack();
        else if (screen == SCREEN_CONSOLE) showSetup(setupError);
        else super.onBackPressed();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        Theme next = Theme.of(prefs, configuration);
        if (next.dark == theme.dark) return;
        theme = next;
        Theme.apply(this, theme);
        frame.setBackgroundColor(theme.bg);
        if (overlay != null) closeOverlay();
        reloadBase();
    }

    @Override protected void onDestroy() {
        destroyWeb();
        super.onDestroy();
    }
}
