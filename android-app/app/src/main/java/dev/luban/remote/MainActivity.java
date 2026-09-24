package dev.luban.remote;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
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
import android.widget.TextView;
import android.widget.Toast;

/** Android shell for the existing /m console, which stays served by the luban relay. */
public final class MainActivity extends Activity {
    private static final String PREF_URL = "relay_url";
    private static final int BG = Color.rgb(5, 7, 10);
    private static final int FG = Color.rgb(235, 240, 245);
    private static final int MUTED = Color.rgb(151, 160, 170);
    private LinearLayout root;
    private WebView web;
    private TextView status;
    private Uri origin;
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
        String saved = getPreferences(MODE_PRIVATE).getString(PREF_URL, "");
        if (saved.isEmpty()) showSetup("");
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
        root.setPadding(dp(20), dp(28), dp(20), dp(16));
        TextView heading = text("luban 遥控", 25, FG);
        heading.setTypeface(null, Typeface.BOLD);
        root.addView(heading);
        TextView help = text("输入中继打印的“手机访问链接”，或本机 Web 地址。令牌链接只需输入一次。", 14, MUTED);
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, -2);
        helpParams.topMargin = dp(14);
        root.addView(help, helpParams);
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
        root.addView(address, addressParams);
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
        root.addView(connect);
        if (!error.isEmpty()) {
            TextView note = text(error, 13, Color.rgb(255, 145, 145));
            root.addView(note);
        }
        TextView hint = text("HTTPS 使用系统受信证书；自签证书须先在 Android 设置中安装 CA。", 13, MUTED);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.topMargin = dp(18);
        root.addView(hint, hintParams);
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
        mainFrameHttpError = null;
        boolean freshLogin = "/login".equals(requested.getPath()) && requested.getQueryParameter("token") != null;
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
        header.addView(button("地址", v -> showSetup("")));
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
            @Override public void onPageFinished(WebView view, String url) {
                Uri loaded = Uri.parse(url);
                String cookies = CookieManager.getInstance().getCookie(url);
                boolean loggedIn = cookies != null && ("luban_token=".equals(cookies) || cookies.startsWith("luban_token=") || cookies.contains("; luban_token="));
                if (sameOrigin(loaded) && "/m/".equals(loaded.getPath()) && loggedIn) {
                    // /login exchanges the one-time token for an HttpOnly cookie.
                    // Keep only the clean console address in app preferences.
                    getPreferences(MODE_PRIVATE).edit().putString(PREF_URL, loaded.buildUpon().clearQuery().build().toString()).apply();
                    CookieManager.getInstance().flush();
                    view.clearHistory();
                }
                if (status != null && mainFrameHttpError == null) status.setText(loggedIn ? "已连接 · " + origin.getHost() : "未登录 · 点击地址输入令牌");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (request.isForMainFrame()) {
                    mainFrameHttpError = "HTTP " + response.getStatusCode();
                    if (status != null) status.setText("连接失败 · " + mainFrameHttpError + " · 检查令牌或稍后重试");
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && status != null) status.setText("连接失败 · 点击刷新重试");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (status != null) status.setText("证书不受信任 · 请安装 CA 或更换地址");
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        String path = requested.getPath();
        String destination = path == null || path.isEmpty() || "/".equals(path)
                ? requested.buildUpon().path("/m/").build().toString() : address;
        if (freshLogin) {
            WebView target = web;
            CookieManager.getInstance().removeAllCookies(removed -> {
                CookieManager.getInstance().flush();
                target.post(() -> { if (web == target) target.loadUrl(destination); });
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
