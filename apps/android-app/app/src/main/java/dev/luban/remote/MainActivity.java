package dev.luban.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Android shell for the existing /m console, which stays served by the luban relay. */
public final class MainActivity extends Activity {
    private static final String PREF_URL = "relay_url";
    private static final int BG = Color.rgb(5, 7, 10);
    private static final int FG = Color.rgb(235, 240, 245);
    private static final int MUTED = Color.rgb(151, 160, 170);
    private static final int ACCENT = Color.rgb(105, 210, 245);
    private LinearLayout root;
    private ConnectionHistory history;
    private WebView web;
    private TextView status;
    private Uri origin;
    private String pendingAddress;
    private String mainFrameHttpError;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(BG);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(0, bars.top, 0, bars.bottom);
            } else {
                view.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        frame.addView(root, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        history = new ConnectionHistory(getPreferences(MODE_PRIVATE));
        java.util.List<ConnectionHistory.Record> recent = history.load();
        String saved = getPreferences(MODE_PRIVATE).getString(PREF_URL, "");
        if (!recent.isEmpty()) open(recent.get(0).launchUrl);
        else if (saved.isEmpty()) showSetup("");
        else open(saved);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private Button button(String label, View.OnClickListener click) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setOnClickListener(click);
        return view;
    }

    private void showSetup(String error) {
        root.removeAllViews();
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        root.setPadding(0, 0, 0, 0);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(28), dp(20), dp(16));
        scroll.addView(form);
        TextView heading = text("luban 遥控", 25, FG);
        heading.setTypeface(null, Typeface.BOLD);
        form.addView(heading);
        TextView help = text("输入中继打印的“手机访问链接”，或点击下方记录快速重连。", 14, MUTED);
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, -2);
        helpParams.topMargin = dp(14);
        form.addView(help, helpParams);
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setTextSize(15);
        address.setTextColor(FG);
        address.setHintTextColor(MUTED);
        address.setHint("http://192.168.1.108:5399/login?token=...");
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(getPreferences(MODE_PRIVATE).getString(PREF_URL, ""));
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(-1, -2);
        addressParams.topMargin = dp(24);
        form.addView(address, addressParams);
        Button connect = button("连接", v -> {
            String value = address.getText().toString().trim();
            Uri parsed = Uri.parse(value);
            String scheme = parsed.getScheme();
            if (!("http".equals(scheme) || "https".equals(scheme)) || parsed.getHost() == null || parsed.getHost().isEmpty()) {
                address.setError("请输入完整的 http:// 或 https:// 地址");
                return;
            }
            open(value);
        });
        form.addView(connect);
        if (!error.isEmpty()) {
            TextView note = text(error, 13, Color.rgb(255, 145, 145));
            form.addView(note);
        }
        java.util.List<ConnectionHistory.Record> recent = history.load();
        if (!recent.isEmpty()) {
            TextView recentHeading = text("最近连接", 17, FG);
            recentHeading.setTypeface(null, Typeface.BOLD);
            LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(-1, -2);
            headingParams.topMargin = dp(28);
            headingParams.bottomMargin = dp(8);
            form.addView(recentHeading, headingParams);
            for (ConnectionHistory.Record record : recent) {
                LinearLayout row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(14), dp(10), dp(8), dp(10));
                GradientDrawable background = new GradientDrawable();
                background.setColor(Color.rgb(18, 24, 32));
                background.setCornerRadius(dp(12));
                row.setBackground(background);
                LinearLayout labels = new LinearLayout(this);
                labels.setOrientation(LinearLayout.VERTICAL);
                Uri labelUri = Uri.parse(record.displayUrl);
                String node = labelUri.getQueryParameter("node");
                String host = labelUri.getHost() == null ? record.displayUrl : labelUri.getHost();
                TextView name = text(host + (node == null ? "" : " · " + node), 15, ACCENT);
                name.setSingleLine(true);
                name.setEllipsize(android.text.TextUtils.TruncateAt.END);
                labels.addView(name);
                TextView url = text(record.displayUrl, 12, MUTED);
                url.setSingleLine(true);
                url.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
                labels.addView(url);
                row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
                row.setOnClickListener(v -> open(record.launchUrl));
                Button remove = button("删除", v -> new AlertDialog.Builder(this)
                        .setMessage("删除这条连接记录？")
                        .setNegativeButton("取消", null)
                        .setPositiveButton("删除", (dialog, which) -> {
                            if (!history.forget(record.displayUrl)) {
                                Toast.makeText(this, "删除失败，请重试", Toast.LENGTH_SHORT).show();
                                return;
                            }
                            if (record.displayUrl.equals(getPreferences(MODE_PRIVATE).getString(PREF_URL, ""))) {
                                getPreferences(MODE_PRIVATE).edit().remove(PREF_URL).apply();
                            }
                            showSetup("");
                        }).show());
                row.addView(remove);
                LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
                rowParams.bottomMargin = dp(8);
                form.addView(row, rowParams);
            }
        }
        TextView hint = text("HTTPS 使用系统受信证书；自签证书须先在 Android 设置中安装 CA。", 13, MUTED);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.topMargin = dp(18);
        form.addView(hint, hintParams);
    }

    private static int port(Uri uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equals(uri.getScheme()) ? 443 : 80;
    }

    private boolean sameOrigin(Uri url) {
        return origin != null && origin.getScheme().equalsIgnoreCase(url.getScheme())
                && origin.getHost().equalsIgnoreCase(url.getHost()) && port(origin) == port(url);
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
            getPreferences(MODE_PRIVATE).edit().remove(PREF_URL).apply();
        }
        root.removeAllViews();
        root.setPadding(0, 0, 0, 0);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(8), 0, dp(6), 0);
        status = text("连接中 · " + requested.getHost(), 12, MUTED);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(0, -2, 1);
        header.addView(status, statusParams);
        header.addView(button("刷新", v -> web.reload()));
        header.addView(button("连接记录", v -> showSetup("")));
        root.addView(header, new LinearLayout.LayoutParams(-1, dp(50)));
        if (web != null) {
            web.stopLoading();
            web.destroy();
        }
        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (sameOrigin(request.getUrl())) return false;
                Toast.makeText(MainActivity.this, "已阻止跳转到其他服务器", Toast.LENGTH_SHORT).show();
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != web) return;
                // An earlier 401 belongs to its navigation, not to a later
                // successful login redirect or a manual reload.
                mainFrameHttpError = null;
                if (status != null) status.setText("连接中 · " + origin.getHost());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (view != web) return;
                Uri loaded = Uri.parse(url);
                String cookies = CookieManager.getInstance().getCookie(url);
                boolean loggedIn = cookies != null && ("luban_token=".equals(cookies) || cookies.startsWith("luban_token=") || cookies.contains("; luban_token="));
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
                    CookieManager.getInstance().flush();
                    view.clearHistory();
                }
                if (status != null && mainFrameHttpError == null) {
                    status.setText(consoleReady ? "已连接 · " + origin.getHost() : "未登录 · 点击连接记录输入令牌");
                }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (view != web) return;
                if (request.isForMainFrame()) {
                    mainFrameHttpError = "HTTP " + response.getStatusCode();
                    if (status != null) status.setText("连接失败 · " + mainFrameHttpError + " · 检查令牌或稍后重试");
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view != web) return;
                if (request.isForMainFrame()) {
                    mainFrameHttpError = "网络错误";
                    if (status != null) status.setText("连接失败 · 点击刷新重试");
                }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (view == web) {
                    mainFrameHttpError = "证书错误";
                    if (status != null) status.setText("证书不受信任 · 请安装 CA 或更换地址");
                }
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        String path = requested.getPath();
        String destination = path == null || path.isEmpty() || "/".equals(path)
                ? requested.buildUpon().path("/m/").build().toString() : address;
        if (freshLogin) {
            WebView target = web;
            CookieManager cookies = CookieManager.getInstance();
            String cookieOrigin = requested.buildUpon().path("/").clearQuery().fragment(null).build().toString();
            // Clear only this server's old login. Other saved servers keep their cookies.
            cookies.setCookie(cookieOrigin, "luban_token=; Path=/; Max-Age=0", ignored -> {
                cookies.setCookie(cookieOrigin, "luban_node=; Path=/; Max-Age=0", ignoredNode -> {
                    cookies.flush();
                    target.post(() -> { if (web == target) target.loadUrl(destination); });
                });
            });
        } else {
            web.loadUrl(destination);
        }
    }

    @Override public void onBackPressed() {
        if (web != null && web.getParent() != null && web.canGoBack()) web.goBack();
        else if (web != null && web.getParent() != null) showSetup("");
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
