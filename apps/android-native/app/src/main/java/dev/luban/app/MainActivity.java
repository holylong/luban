package dev.luban.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native phone console for luban.
 *
 * The WebView shell (`dev.luban.remote`) keeps rendering the relay's `/m` page;
 * this app talks to the same relay REST API directly so the chrome, lists and
 * transcript are real Android views instead of a web page in a box.
 */
public final class MainActivity extends Activity {
    private static final String PREF_SERVER = "server_url";
    private static final String PREF_COOKIE = "account_cookie";
    private static final String PREF_EMAIL = "account_email";
    private static final String DEFAULT_SERVER = "https://203.0.113.7";
    private static final String[] MODES = {"edits", "agent", "read"};
    private static final String[] MODE_LABELS = {"可改文件", "可执行", "只读"};

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    // Mutations outlive pages and Activity destruction. Never automatically retry a POST.
    private static final ExecutorService mutations = Executors.newSingleThreadExecutor();
    private static volatile boolean submitting;
    private boolean background;
    private JSONObject history = new JSONObject();
    private String historySession = "";
    private LinearLayout interactions;
    private String interactionSignature = "";
    private TextView resumeButton, liveStatus, liveProgress, liveOutput;
    private StringBuilder liveBuffer;
    private long liveSince;

    private SharedPreferences prefs;
    private Theme theme;
    private Ui ui;
    private Api api;

    private LinearLayout column;
    private LinearLayout topBar;
    private ScrollView scroll;
    private LinearLayout list;
    private LinearLayout composerBar;
    private LinearLayout navBar;

    private String screen = "login";
    private String nodeId = "";
    private String nodeName = "";
    private String project = "";
    private String sessionId = "";
    private String jobId = "";
    private String email = "";
    private String mode = "edits";
    private JSONArray nodes = new JSONArray();
    private JSONObject nodeInfo;
    private int pollToken;
    private boolean liveRunning;
    private volatile int pageGeneration;
    private final ThreadLocal<Integer> requestPage = new ThreadLocal<>();

    private void beginPage(String target) {
        pageGeneration++;
        pollToken++;
        screen = target;
        hideKeyboard();
        Ui.clear(composerBar);
    }

    private void runIo(Runnable work) {
        final int generation = pageGeneration;
        io.execute(() -> {
            if (generation != pageGeneration) return;
            requestPage.set(generation);
            try { work.run(); } finally { requestPage.remove(); }
        });
    }

    private void postResult(Runnable result) {
        final Integer generation = requestPage.get();
        main.post(() -> {
            if (!isFinishing() && !isDestroyed()
                    && generation != null && generation == pageGeneration) result.run();
        });
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getPreferences(MODE_PRIVATE);
        theme = Theme.of(prefs);
        ui = new Ui(this, theme, Theme.scaleOf(prefs));
        email = prefs.getString(PREF_EMAIL, "");
        api = new Api(prefs.getString(PREF_SERVER, DEFAULT_SERVER), prefs.getString(PREF_COOKIE, ""));
        nodeId = prefs.getString("active_node", "");
        nodeName = prefs.getString("active_name", "");
        project = prefs.getString("active_project", "");
        sessionId = prefs.getString("active_session", "");
        jobId = prefs.getString("active_job", "");
        buildShell();
        if (api.cookie().isEmpty()) showLogin(""); else confirmSession();
    }

    @Override public void onDestroy() {
        pollToken++;
        pageGeneration++;
        main.removeCallbacksAndMessages(null);
        io.shutdown();
        super.onDestroy();
    }

    @Override protected void onStop() {
        background = true;
        pollToken++;
        super.onStop();
    }

    @Override protected void onResume() {
        super.onResume();
        boolean wasBackground = background;
        background = false;
        observeSubmission();
        if (!wasBackground) return;
        if (screen.equals("job") && !jobId.isEmpty()) {
            openJob(jobId); // Reload authoritative history and replay after a background gap.
        } else if (prefs.getBoolean("submission_pending", false) || !prefs.getString("submit_notice", "").isEmpty()) {
            restoreActive();
        }
    }

    private void observeSubmission() {
        if (background || isDestroyed() || isFinishing()) return;
        boolean waiting = submitting || prefs.getBoolean("submission_pending", false);
        String active = prefs.getString("active_job", "");
        if (!screen.equals("login") && !submitting && !active.isEmpty() && !active.equals(jobId)) {
            restoreActive();
        }
        if (waiting) main.postDelayed(this::observeSubmission, 1000);
    }

    private void saveActive() {
        prefs.edit().putString("active_node", nodeId).putString("active_name", nodeName)
                .putString("active_project", project).putString("active_session", sessionId)
                .putString("active_job", jobId).apply();
    }

    private void restoreActive() {
        nodeId = prefs.getString("active_node", nodeId);
        nodeName = prefs.getString("active_name", nodeName);
        project = prefs.getString("active_project", project);
        sessionId = prefs.getString("active_session", sessionId);
        jobId = prefs.getString("active_job", "");
        if (!jobId.isEmpty()) openJob(jobId);
        else if (!sessionId.isEmpty()) openSession(sessionId, "会话", project);
        else if (!nodeId.isEmpty()) loadSessions();
        else loadDevices();
    }

    @Override public void onBackPressed() {
        pollToken++;
        if (screen.equals("job")) { showJobs(); return; }
        if (screen.equals("transcript")) {
            sessionId = "";
            loadSessions();
            return;
        }
        if (!screen.equals("devices") && !screen.equals("login")) {
            sessionId = "";
            navigate("devices");
            return;
        }
        super.onBackPressed();
    }

    /* ------------------------------------------------------------- scaffolding */

    private void buildShell() {
        Theme.applyToWindow(this, theme);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(theme.bg);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(0, top, 0, bottom);
            return insets;
        });

        column = ui.column();
        column.setBackgroundColor(theme.bg);
        root.addView(column, new FrameLayout.LayoutParams(-1, -1));

        topBar = ui.column();
        topBar.setPadding(ui.dp(18), ui.dp(14), ui.dp(16), ui.dp(10));
        column.addView(topBar, new LinearLayout.LayoutParams(-1, -2));

        FrameLayout bodyFrame = new FrameLayout(this);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, 0, 1f);
        column.addView(bodyFrame, bodyParams);
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        list = ui.scrollable();
        scroll.addView(list, new FrameLayout.LayoutParams(-1, -2));
        bodyFrame.addView(scroll, new FrameLayout.LayoutParams(-1, -1));

        composerBar = ui.column();
        column.addView(composerBar, new LinearLayout.LayoutParams(-1, -2));

        navBar = ui.row();
        navBar.setPadding(ui.dp(8), ui.dp(6), ui.dp(8), ui.dp(8));
        navBar.setBackgroundColor(theme.surface);
        column.addView(navBar, new LinearLayout.LayoutParams(-1, -2));

        setContentView(root);
    }

    private void applyTheme() {
        theme = Theme.of(prefs);
        ui = new Ui(this, theme, Theme.scaleOf(prefs));
        buildShell();
        switch (screen) {
            case "devices": showDevices(); break;
            case "sessions": showSessions(); break;
            case "jobs": showJobs(); break;
            case "job": openJob(jobId); break;
            case "transcript": openSession(sessionId, "会话", project); break;
            case "settings": showSettings(); break;
            default: showLogin("");
        }
    }

    private void header(String title, String subtitle, View right) {
        Ui.clear(topBar);
        topBar.setBackgroundColor(theme.surface);
        LinearLayout brandRow = ui.row();
        LinearLayout titles = ui.column();
        TextView heading = ui.text(title, 22, theme.text, true);
        heading.setLetterSpacing(-0.02f);
        titles.addView(heading);
        if (subtitle != null && !subtitle.isEmpty()) {
            TextView sub = ui.text(subtitle, 12.5f, theme.muted, false);
            sub.setSingleLine(true);
            sub.setEllipsize(android.text.TextUtils.TruncateAt.END);
            titles.addView(sub);
        }
        brandRow.addView(titles, new LinearLayout.LayoutParams(0, -2, 1f));
        if (right != null) brandRow.addView(right);
        topBar.addView(brandRow);
    }

    private void setBody(LinearLayout content) {
        Ui.clear(list);
        list.addView(content, new LinearLayout.LayoutParams(-1, -2));
        scroll.post(() -> scroll.scrollTo(0, 0));
    }

    private void empty(String heading, String detail) {
        LinearLayout box = ui.column();
        box.setGravity(Gravity.CENTER);
        box.setPadding(ui.dp(12), ui.dp(48), ui.dp(12), ui.dp(32));
        TextView title = ui.text(heading, 18, theme.text, true);
        title.setGravity(Gravity.CENTER);
        TextView note = ui.text(detail, 13.5f, theme.muted, false);
        note.setGravity(Gravity.CENTER);
        note.setPadding(0, ui.dp(8), 0, 0);
        box.addView(title);
        box.addView(note);
        setBody(box);
    }

    private void toast(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show();
    }

    private void navigate(String target) {
        sessionId = "";
        jobId = "";
        if (target.equals("devices")) showDevices();
        else if (target.equals("jobs")) showJobs();
        else if (target.equals("settings")) showSettings();
    }

    private void buildNav() {
        Ui.clear(navBar);
        navBar.setVisibility(View.VISIBLE);
        navBar.setBackgroundColor(theme.surface);
        String[] labels = {"设备", "任务", "设置"};
        String[] glyphs = {"◈", "≡", "⚙"};
        String[] targets = {"devices", "jobs", "settings"};
        for (int i = 0; i < labels.length; i++) {
            final String target = targets[i];
            boolean active = screen.equals(target);
            LinearLayout item = ui.column();
            item.setGravity(Gravity.CENTER);
            item.setPadding(0, ui.dp(7), 0, ui.dp(6));
            TextView icon = ui.text(glyphs[i], 17, active ? theme.accent : theme.dim, false);
            icon.setGravity(Gravity.CENTER);
            TextView text = ui.text(labels[i], 11, active ? theme.accent : theme.dim, active);
            text.setGravity(Gravity.CENTER);
            item.addView(icon);
            item.addView(text);
            item.setBackground(ui.ripple(ui.shape(active ? theme.accentSoft : 0, 0, 14)));
            item.setOnClickListener(v -> navigate(target));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1f);
            params.setMargins(ui.dp(4), 0, ui.dp(4), 0);
            navBar.addView(item, params);
        }
    }

    /* ------------------------------------------------------------------- login */

    private void showLogin(String error) {
        beginPage("login");
        boolean loggedOut = api.cookie().isEmpty();
        header(loggedOut ? "登录 luban" : "需要重新登录", api.base(), null);
        Ui.clear(navBar);
        Ui.clear(composerBar);

        LinearLayout form = ui.column();

        LinearLayout intro = ui.column();
        intro.setPadding(0, ui.dp(10), 0, ui.dp(18));
        TextView hero = ui.text("手机上派活，电脑上执行", 22, theme.text, true);
        hero.setLetterSpacing(-0.02f);
        TextView sub = ui.text("登录中继账户，查看每台电脑的会话、实时推理与文件改动。", 13.5f, theme.muted, false);
        sub.setPadding(0, ui.dp(7), 0, 0);
        intro.addView(hero);
        intro.addView(sub);
        form.addView(intro);

        EditText server = addField(form, "中继地址", api.base(), InputType.TYPE_TEXT_VARIATION_URI);
        EditText mail = addField(form, "邮箱", email, InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        EditText password = addField(form, "密码", "", InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        if (!error.isEmpty()) {
            LinearLayout fail = ui.column();
            fail.setPadding(ui.dp(13), ui.dp(11), ui.dp(13), ui.dp(11));
            fail.setBackground(ui.shape(theme.dangerSoft, theme.danger, 13));
            fail.addView(ui.text(error, 13, theme.danger, false));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
            params.bottomMargin = ui.dp(12);
            form.addView(fail, params);
        }

        TextView submit = ui.button("登录", true, v -> {
            String address = server.getText().toString().trim();
            String user = mail.getText().toString().trim();
            String secret = password.getText().toString();
            if (address.isEmpty() || user.isEmpty() || secret.isEmpty()) {
                toast("请填写中继地址、邮箱和密码");
                return;
            }
            api.base(address);
            login(user, secret);
        });
        form.addView(submit, new LinearLayout.LayoutParams(-1, -2));

        TextView hint = ui.note("账户由 relay 的 accounts.json 管理；WebView 版仍可继续使用同一账户。");
        hint.setPadding(0, ui.dp(14), 0, 0);
        form.addView(hint);
        setBody(form);
    }

    private EditText addField(LinearLayout host, String label, String value, int variation) {
        LinearLayout wrap = ui.column();
        wrap.setPadding(0, 0, 0, ui.dp(12));
        TextView caption = ui.text(label, 12, theme.dim, true);
        caption.setPadding(ui.dp(2), 0, 0, ui.dp(6));
        EditText input = new EditText(this);
        input.setText(value);
        input.setTextSize(TypedValue.COMPLEX_UNIT_PX, ui.sp(15.5f));
        input.setTextColor(theme.text);
        input.setHintTextColor(theme.dim);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | variation);
        input.setPadding(ui.dp(14), ui.dp(12), ui.dp(14), ui.dp(12));
        input.setBackground(ui.shape(theme.surfaceAlt, theme.line, 14));
        wrap.addView(caption);
        wrap.addView(input, new LinearLayout.LayoutParams(-1, -2));
        host.addView(wrap, new LinearLayout.LayoutParams(-1, -2));
        return input;
    }

    private void login(String user, String secret) {
        runIo(() -> {
            try {
                JSONObject reply = api.login(user, secret);
                email = user;
                prefs.edit()
                        .putString(PREF_SERVER, api.base())
                        .putString(PREF_COOKIE, api.cookie())
                        .putString(PREF_EMAIL, user)
                        .apply();
                JSONObject account = reply.optJSONObject("account");
                if (account != null) email = account.optString("email", user);
                postResult(this::restoreActive);
            } catch (Exception error) {
                postResult(() -> showLogin(messageOf(error)));
            }
        });
    }

    private void confirmSession() {
        runIo(() -> {
            try {
                JSONObject reply = api.me();
                JSONObject account = reply.optJSONObject("account");
                if (account != null) email = account.optString("email", email);
                postResult(this::restoreActive);
            } catch (Api.Failure failure) {
                postResult(() -> {
                    if (failure.needsLogin()) {
                        api.cookie("");
                        showLogin("登录已过期，请重新登录");
                    } else {
                        showLogin(failure.getMessage());
                    }
                });
            } catch (Exception error) {
                postResult(() -> showLogin(messageOf(error)));
            }
        });
    }

    /* ----------------------------------------------------------------- devices */

    private void loadDevices() {
        beginPage("devices");
        buildNav();
        header("luban", "正在同步设备…", null);
        empty("正在同步", "读取账户下的 luban 实例与最近任务。");
        runIo(() -> {
            try {
                JSONArray devices = api.nodes();
                postResult(() -> { nodes = devices == null ? new JSONArray() : devices; showDevices(); });
            } catch (Exception error) {
                postResult(() -> showLogin(messageOf(error)));
            }
        });
    }

    private void showDevices() {
        beginPage("devices");
        Ui.clear(composerBar);
        buildNav();
        int online = 0;
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject item = nodes.optJSONObject(i);
            if (item != null && item.optBoolean("online")) online++;
        }
        header("luban", online + " 台在线 / 共 " + nodes.length() + " 台设备", ui.iconButton("⟳", v -> loadDevices()));

        if (nodes.length() == 0) {
            empty("还没有电脑", "在网页版「设置 → 添加电脑」生成设备令牌，然后在电脑上运行 luban web --relay …");
            return;
        }
        LinearLayout content = ui.column();
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject device = nodes.optJSONObject(i);
            if (device == null) continue;
            content.addView(deviceCard(device));
        }
        setBody(content);
    }

    private View deviceCard(JSONObject device) {
        boolean online = device.optBoolean("online");
        String id = device.optString("id");
        String name = device.optString("name", "luban");
        LinearLayout card = ui.card();
        card.setBackground(ui.ripple(ui.shape(online && id.equals(nodeId) ? theme.accentSoft : theme.surface,
                online && id.equals(nodeId) ? theme.accentLine : theme.line, 18)));

        LinearLayout head = ui.row();
        head.addView(ui.dot(online ? theme.ok : theme.dim));
        TextView title = ui.text(name, 17, theme.text, true);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        head.addView(title, new LinearLayout.LayoutParams(0, -2, 1f));
        head.addView(ui.pill(online ? "在线" : "离线",
                online ? theme.ok : theme.dim, online ? theme.okSoft : theme.surfaceAlt));
        card.addView(head);

        String workspace = device.optString("workspace", "");
        if (!workspace.isEmpty()) {
            TextView path = ui.text(workspace, 12.3f, theme.dim, false);
            path.setTypeface(Typeface.MONOSPACE);
            path.setPadding(0, ui.dp(7), 0, 0);
            card.addView(path);
        }

        JSONObject status = device.optJSONObject("status");
        JSONArray jobs = status == null ? new JSONArray() : status.optJSONArray("jobs");
        String model = status == null ? "" : status.optString("model", "");
        JSONObject latest = jobs == null || jobs.length() == 0 ? null : jobs.optJSONObject(0);
        String meta = Ui.join(" · ", model, device.optString("version", "").isEmpty() ? "" : "v" + device.optString("version"));
        if (latest != null) {
            String label = statusLabel(latest.optString("status"));
            meta = Ui.join(" · ", label + " " + Ui.ellipsize(latest.optString("title", latest.optString("instruction", "")), 26), meta);
        }
        if (!meta.isEmpty()) {
            TextView detail = ui.text(meta, 12.8f, theme.muted, false);
            detail.setPadding(0, ui.dp(6), 0, 0);
            detail.setSingleLine(true);
            detail.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(detail);
        }

        LinearLayout actions = ui.row();
        TextView open = ui.button(online ? "打开并派活" : "查看历史", true, v -> openDevice(id, name));
        TextView jobsButton = ui.outlineButton("任务", v -> {
            nodeId = id;
            nodeName = name;
            project = "";
            navigate("jobs");
        });
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(0, -2, 1f);
        openParams.rightMargin = ui.dp(8);
        actions.addView(open, openParams);
        actions.addView(jobsButton, new LinearLayout.LayoutParams(ui.dp(84), -2));
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, -2);
        actionParams.topMargin = ui.dp(12);
        card.addView(actions, actionParams);
        return card;
    }

    private void openDevice(String id, String name) {
        nodeId = id;
        nodeName = name;
        project = "";
        sessionId = "";
        jobId = "";
        beginPage("sessions");
        nodeInfo = null;
        buildNav();
        header(name, "正在读取工作区…", null);
        empty("正在连接", "读取项目与会话列表。");
        runIo(() -> {
            try {
                JSONObject info = api.nodeInfo(id);
                postResult(() -> {
                    nodeInfo = info;
                    project = "";
                    loadSessions();
                });
            } catch (Exception error) {
                postResult(() -> {
                    toast(messageOf(error));
                    loadSessions();
                });
            }
        });
    }

    private String firstProject(JSONObject info) {
        if (info == null) return "";
        JSONObject projects = info.optJSONObject("projects");
        if (projects == null) return "";
        Iterator<String> keys = projects.keys();
        return keys.hasNext() ? keys.next() : "";
    }

    /* ---------------------------------------------------------------- sessions */

    private void loadSessions() {
        beginPage("sessions");
        sessionId = "";
        jobId = "";
        saveActive();
        buildSessionsChrome();
        header(nodeName.isEmpty() ? "会话" : nodeName, "正在加载会话…", ui.iconButton("⟳", v -> loadSessions()));
        Ui.clear(composerBar);
        empty("正在加载", "读取最近的会话记录。");
        runIo(() -> {
            try {
                JSONArray sessions = api.sessions(nodeId, project, 40);
                postResult(() -> showSessions(sessions));
            } catch (Exception error) {
                postResult(() -> {
                    empty("读取失败", messageOf(error));
                    buildSessionsChrome();
                });
            }
        });
    }

    private void showSessions() { loadSessions(); }

    private void showSessions(JSONArray sessions) {
        screen = "sessions";
        buildSessionsChrome();
        if (sessions == null || sessions.length() == 0) {
            LinearLayout content = ui.column();
            content.addView(projectCard());
            LinearLayout box = ui.column();
            box.setGravity(Gravity.CENTER);
            box.setPadding(0, ui.dp(38), 0, ui.dp(20));
            TextView title = ui.text("还没有会话", 17, theme.text, true);
            title.setGravity(Gravity.CENTER);
            TextView note = ui.text("在下方输入指令，任务结束后会出现在这里。", 13.5f, theme.muted, false);
            note.setGravity(Gravity.CENTER);
            note.setPadding(0, ui.dp(8), 0, 0);
            box.addView(title);
            box.addView(note);
            content.addView(box);
            setBody(content);
            return;
        }
        LinearLayout content = ui.column();
        content.addView(projectCard());
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session == null) continue;
            content.addView(sessionCard(session));
        }
        setBody(content);
    }

    private void buildSessionsChrome() {
        buildNav();
        header(nodeName.isEmpty() ? "会话" : nodeName,
                Ui.join(" · ", projectLabel(), "会话"),
                ui.iconButton("⟳", v -> loadSessions()));
        buildComposer();
    }

    private String projectLabel() {
        if (project.isEmpty()) return "当前工作区";
        if (nodeInfo == null) return project;
        JSONObject projects = nodeInfo.optJSONObject("projects");
        String path = projects == null ? "" : projects.optString(project, "");
        return path.isEmpty() ? project : project;
    }

    private View projectCard() {
        LinearLayout card = ui.card();
        card.setBackground(ui.ripple(ui.shape(theme.surface, theme.line, 18)));
        LinearLayout row = ui.row();
        TextView name = ui.text(project.isEmpty() ? "当前工作区" : project, 15, theme.text, true);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        row.addView(name, new LinearLayout.LayoutParams(0, -2, 1f));
        row.addView(ui.pill("切换", theme.accent, theme.accentSoft));
        card.addView(row);
        if (nodeInfo != null) {
            JSONObject projects = nodeInfo.optJSONObject("projects");
            String path = projects == null ? "" : projects.optString(project, "");
            if (!path.isEmpty()) {
                TextView detail = ui.text(path, 12, theme.dim, false);
                detail.setTypeface(Typeface.MONOSPACE);
                detail.setPadding(0, ui.dp(6), 0, 0);
                detail.setSingleLine(true);
                detail.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
                card.addView(detail);
            }
        }
        card.setOnClickListener(v -> chooseProject());
        return card;
    }

    private void chooseProject() {
        JSONObject projects = nodeInfo == null ? null : nodeInfo.optJSONObject("projects");
        if (projects == null || projects.length() == 0) {
            toast("这台电脑没有上报其他项目");
            return;
        }
        List<String> names = new ArrayList<>();
        names.add("当前工作区");
        Iterator<String> keys = projects.keys();
        final List<String> values = new ArrayList<>();
        values.add("");
        while (keys.hasNext()) {
            String key = keys.next();
            names.add(key + " · " + projects.optString(key, ""));
            values.add(key);
        }
        new AlertDialog.Builder(this)
                .setTitle("选择项目")
                .setItems(names.toArray(new String[0]), (dialog, which) -> {
                    project = values.get(which);
                    loadSessions();
                })
                .show();
    }

    private View sessionCard(JSONObject session) {
        String id = session.optString("id");
        LinearLayout card = ui.card();
        card.setBackground(ui.ripple(ui.shape(theme.surface, theme.line, 18)));
        TextView title = ui.text(Ui.ellipsize(session.optString("title", id), 90), 15.5f, theme.text, true);
        title.setMaxLines(2);
        card.addView(title);
        String meta = Ui.join(" · ",
                session.optInt("messages") + " 条记录",
                session.optString("model", ""),
                relative(session.optString("updatedAt")));
        TextView detail = ui.text(meta, 12.3f, theme.muted, false);
        detail.setPadding(0, ui.dp(6), 0, 0);
        card.addView(detail);
        card.setOnClickListener(v -> openSession(id, session.optString("title", id), session.optString("project", project)));
        return card;
    }

    private void openSession(String id, String title, String projectId) {
        beginPage("transcript");
        sessionId = id;
        jobId = "";
        if (!projectId.isEmpty()) project = projectId;
        saveActive();
        header(title, "正在读取交互记录…", null);
        Ui.clear(composerBar);
        empty("正在加载", "读取会话内容。");
        runIo(() -> {
            try {
                JSONObject detail = api.session(nodeId, project, id);
                postResult(() -> showTranscript(detail, title));
            } catch (Exception error) {
                postResult(() -> empty("读取失败", messageOf(error)));
            }
        });
    }

    private void showTranscript(JSONObject detail, String title) {
        screen = "transcript";
        history = detail;
        historySession = sessionId;
        header(title, Ui.join(" · ", project.isEmpty() ? "当前工作区" : project, "会话记录"),
                ui.iconButton("←", v -> loadSessions()));
        buildComposer();
        LinearLayout content = ui.column();
        JSONArray messages = detail.optJSONArray("messages");
        int shown = 0;
        if (messages != null) {
            for (int i = 0; i < messages.length(); i++) {
                JSONObject message = messages.optJSONObject(i);
                if (message == null) continue;
                String role = message.optString("role");
                if (role.equals("system")) continue;
                View view = messageView(message, role);
                if (view != null) {
                    content.addView(view);
                    shown++;
                }
            }
        }
        if (shown == 0) content.addView(ui.note("此会话没有可显示的记录，可在下方继续派活。"));
        setBody(content);
    }

    private View messageView(JSONObject message, String role) {
        if (role.equals("user")) {
            LinearLayout card = ui.card();
            card.setBackground(ui.shape(theme.accentSoft, theme.accentLine, 18));
            TextView who = ui.text("我", 11.5f, theme.accent, true);
            card.addView(who);
            TextView body = ui.body(message.optString("content"), theme.text);
            body.setPadding(0, ui.dp(5), 0, 0);
            card.addView(body);
            return card;
        }
        if (role.equals("assistant")) {
            LinearLayout block = ui.column();
            block.setPadding(ui.dp(2), 0, ui.dp(2), ui.dp(14));
            String content = message.optString("content", "");
            if (!content.trim().isEmpty()) block.addView(ui.body(content, theme.text));
            JSONArray calls = message.optJSONArray("tool_calls");
            if (calls != null) {
                for (int i = 0; i < calls.length(); i++) {
                    JSONObject call = calls.optJSONObject(i);
                    if (call == null) continue;
                    JSONObject function = call.optJSONObject("function");
                    String name = function == null ? "tool" : function.optString("name");
                    block.addView(toolChip(name, function == null ? "" : function.optString("arguments", "")));
                }
            }
            return block;
        }
        if (role.equals("tool")) {
            String content = message.optString("content", "");
            return toolResultCard(message.optString("name", "输出"), content);
        }
        return null;
    }

    private View toolChip(String name, String args) {
        LinearLayout row = ui.row();
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = ui.dp(8);
        TextView chip = ui.text("⚙ " + name, 12.5f, theme.muted, true);
        chip.setPadding(ui.dp(10), ui.dp(6), ui.dp(10), ui.dp(6));
        chip.setBackground(ui.shape(theme.surfaceAlt, theme.line, 10));
        row.addView(chip);
        if (!args.isEmpty()) {
            TextView preview = ui.text(Ui.ellipsize(args, 42), 11.5f, theme.dim, false);
            preview.setSingleLine(true);
            preview.setPadding(ui.dp(8), 0, 0, 0);
            row.addView(preview, new LinearLayout.LayoutParams(0, -2, 1f));
        }
        return row;
    }

    private View toolResultCard(String name, String content) {
        LinearLayout card = ui.card();
        card.setBackground(ui.shape(theme.codeBg, theme.lineSoft, 14));
        TextView head = ui.text("▸ " + name, 12.3f, theme.muted, true);
        card.addView(head);
        TextView body = ui.text(Ui.ellipsize(content, 320), 12.3f, theme.muted, false);
        body.setTypeface(Typeface.MONOSPACE);
        body.setPadding(0, ui.dp(7), 0, 0);
        card.addView(body);
        final boolean[] open = {false};
        card.setOnClickListener(v -> {
            open[0] = !open[0];
            body.setText(open[0] ? content : Ui.ellipsize(content, 320));
        });
        return card;
    }

    /* -------------------------------------------------------------------- jobs */

    private void showJobs() {
        beginPage("jobs");
        buildNav();
        Ui.clear(composerBar);
        if (nodeId.isEmpty()) {
            header("任务", "先选择一台设备", null);
            empty("还没有选择设备", "在「设备」里打开一台在线电脑，再查看它排队的任务。");
            return;
        }
        header("任务", nodeName + " · 最近任务", ui.iconButton("⟳", v -> loadJobs()));
        empty("正在加载", "读取任务队列。");
        runIo(() -> {
            try {
                JSONArray jobs = api.jobs(nodeId);
                postResult(() -> renderJobs(jobs));
            } catch (Exception error) {
                postResult(() -> empty("读取失败", messageOf(error)));
            }
        });
    }

    private void loadJobs() { showJobs(); }

    private void renderJobs(JSONArray jobs) {
        if (jobs == null || jobs.length() == 0) {
            empty("还没有任务", "回到设备页派活，任务会出现在这里。");
            return;
        }
        LinearLayout content = ui.column();
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;
            content.addView(jobCard(job));
        }
        setBody(content);
    }

    private View jobCard(JSONObject job) {
        LinearLayout card = ui.card();
        card.setBackground(ui.ripple(ui.shape(theme.surface, theme.line, 18)));
        LinearLayout head = ui.row();
        TextView title = ui.text(Ui.ellipsize(job.optString("title", job.optString("instruction", job.optString("id"))), 80),
                15, theme.text, true);
        title.setMaxLines(2);
        head.addView(title, new LinearLayout.LayoutParams(0, -2, 1f));
        head.addView(statusPill(job.optString("status")));
        card.addView(head);
        String meta = Ui.join(" · ", job.optString("project_id", ""), relative(job.optLong("created_at")));
        TextView detail = ui.text(meta, 12.3f, theme.muted, false);
        detail.setPadding(0, ui.dp(6), 0, 0);
        card.addView(detail);
        card.setOnClickListener(v -> openJob(job.optString("id")));
        return card;
    }

    private void openJob(String id) {
        beginPage("job");
        buildNav();
        jobId = id;
        saveActive();
        pollToken++;
        final int token = pollToken;
        header("实时执行", nodeName, ui.iconButton("←", v -> { pollToken++; showJobs(); }));
        Ui.clear(composerBar);
        LinearLayout stream = ui.column();
        if (historySession.equals(sessionId)) appendHistory(stream, history);
        interactions = ui.column();
        interactionSignature = "";
        stream.addView(interactions);
        resumeButton = ui.outlineButton("原任务继续执行", v -> resumeJob());
        resumeButton.setVisibility(View.GONE);
        stream.addView(resumeButton);
        LinearLayout card = ui.card();
        TextView status = ui.text("连接中…", 13.5f, theme.muted, true);
        TextView progress = ui.text("", 12, theme.dim, false);
        TextView output = ui.body("", theme.text);
        output.setPadding(0, ui.dp(10), 0, 0);
        card.addView(status);
        card.addView(progress);
        card.addView(output);
        stream.addView(card);
        setBody(stream);
        liveRunning = true;
        liveStatus = status;
        liveProgress = progress;
        liveOutput = output;
        liveSince = 0;
        liveBuffer = new StringBuilder();
        final String jobNode = nodeId;
        runIo(() -> {
            try {
                JSONObject job = api.job(jobNode, id);
                String sid = job.optString("session_id", "");
                String pid = job.optString("project_id", project);
                JSONObject detail = sid.isEmpty() ? new JSONObject() : api.session(jobNode, pid, sid);
                postResult(() -> {
                    if (token != pollToken || background) return;
                    sessionId = sid;
                    project = pid;
                    saveActive();
                    // Reload history after recreation/reconnection, not just in-memory navigation.
                    stream.removeAllViews();
                    String instruction = prefs.getString("instruction:" + id, job.optString("instruction", ""));
                    JSONArray messages = detail.optJSONArray("messages");
                    // Replay this job separately: keep history only through its user turn,
                    // otherwise reconnecting would show durable answers plus their stream twice.
                    JSONArray baseline = new JSONArray();
                    int boundary = -1;
                    if (messages != null) for (int i = 0; i < messages.length(); i++) {
                        JSONObject message = messages.optJSONObject(i);
                        if (message != null && "user".equals(message.optString("role"))
                                && instruction.equals(message.optString("content"))) boundary = i;
                    }
                    boolean hasReplay = job.optJSONArray("events") != null && job.optJSONArray("events").length() > 0;
                    if (messages != null) for (int i = 0; i < messages.length(); i++) {
                        if (hasReplay && boundary >= 0 && i > boundary) break;
                        baseline.put(messages.opt(i));
                    }
                    try { appendHistory(stream, new JSONObject().put("messages", baseline)); }
                    catch (JSONException ignored) {}
                    boolean present = false;
                    if (messages != null) for (int i = 0; i < messages.length(); i++) {
                        JSONObject message = messages.optJSONObject(i);
                        if (message != null && "user".equals(message.optString("role"))
                                && instruction.equals(message.optString("content"))) present = true;
                    }
                    if (!present && !instruction.isEmpty()) {
                        try { stream.addView(messageView(new JSONObject().put("content", instruction), "user")); }
                        catch (JSONException ignored) {}
                    }
                    stream.addView(interactions);
                    stream.addView(resumeButton);
                    stream.addView(card);
                });
            } catch (Exception ignored) {
                // Stream remains available even if historical session loading fails.
            }
        });
        pollJob(token, id, 0, liveBuffer, status, progress, output);
    }

    private void pollJob(int token, String id, long since, StringBuilder buffer,
                         TextView status, TextView progress, TextView output) {
        if (token != pollToken || isDestroyed() || background) return;
        final String pollingNode = nodeId;
        runIo(() -> {
            try {
                JSONObject job = api.job(pollingNode, id);
                JSONObject events = api.stream(pollingNode, id, since);
                JSONArray approvals = api.approvals(pollingNode);
                JSONArray questions = api.questions(pollingNode);
                JSONArray list = events.optJSONArray("events");
                long next = events.optLong("next", since);
                StringBuilder delta = new StringBuilder();
                if (list != null) {
                    for (int i = 0; i < list.length(); i++) {
                        JSONObject record = list.optJSONObject(i);
                        if (record == null) continue;
                        JSONObject event = record.optJSONObject("event");
                        if (event == null) continue;
                        String kind = event.optString("kind");
                        if (kind.equals("delta")) delta.append(event.optString("text"));
                        else if (kind.equals("status")) delta.append(delta.length() == 0 ? "" : "\n").append("· ").append(event.optString("text"));
                        else if (kind.equals("thinking")) delta.append(delta.length() == 0 ? "" : "\n").append("💭 ").append(event.optString("text"));
                        else if (kind.equals("tool-start")) delta.append("\n").append("⚙ ").append(event.optString("summary", event.optString("name"))).append("\n");
                        else if (kind.equals("tool-end")) delta.append(event.optBoolean("ok") ? "   ✓ " : "   ✗ ").append(Ui.ellipsize(event.optString("preview"), 160)).append("\n");
                        else if (kind.equals("error")) delta.append("\n✗ ").append(event.optString("text")).append("\n");
                    }
                }
                String statusText = statusLabel(job.optString("status"));
                int percent = (int) Math.round(job.optDouble("progress", 0));
                boolean complete = events.optBoolean("complete") || job.optString("status").matches("done|failed|cancelled|paused");
                String result = job.optString("result", "");
                String errorText = job.optString("error", "");
                String finishedSession = job.optString("session_id", "");
                postResult(() -> {
                    if (token != pollToken || background) return;
                    liveSince = next;
                    renderInteractions(id, approvals, questions);
                    resumeButton.setVisibility(job.optString("status").matches("failed|paused") ? View.VISIBLE : View.GONE);
                    status.setText(statusText);
                    progress.setText(percent + "%  ·  " + relative(job.optLong("created_at")));
                    if (delta.length() > 0) buffer.append(delta);
                    output.setText(buffer.toString());
                    if (complete) {
                        liveRunning = false;
                        if (!finishedSession.isEmpty()) sessionId = finishedSession;
                        saveActive();
                        if (!result.isEmpty() && buffer.indexOf(result) < 0) {
                            output.append("\n\n" + result);
                        }
                        if (!errorText.isEmpty()) output.append("\n✗ " + errorText);
                        buildComposer();
                    } else {
                        if (interactions.getChildCount() == 0) scroll.post(() -> {
                            if (token == pollToken && !background) scroll.fullScroll(View.FOCUS_DOWN);
                        });
                        main.postDelayed(() -> pollJob(token, id, next, buffer, status, progress, output), 1200);
                    }
                });
            } catch (Exception error) {
                postResult(() -> {
                    if (token != pollToken || background) return;
                    status.setText("连接中断，正在重连；电脑端任务不会因此取消");
                    progress.setText(messageOf(error));
                    main.postDelayed(() -> pollJob(token, id, since, buffer, status, progress, output), 2500);
                });
            }
        });
    }

    private void appendHistory(LinearLayout target, JSONObject detail) {
        JSONArray messages = detail.optJSONArray("messages");
        if (messages == null) return;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message == null) continue;
            View view = messageView(message, message.optString("role"));
            if (view != null) target.addView(view);
        }
    }

    private interface Mutation { void run() throws Exception; }

    private void mutate(Mutation operation, Runnable success) {
        final int generation = pageGeneration;
        mutations.execute(() -> {
            requestPage.set(generation);
            try {
                operation.run();
                postResult(success);
            } catch (Exception error) {
                postResult(() -> { interactionSignature = ""; toast(messageOf(error)); buildComposer(); });
            } finally { requestPage.remove(); }
        });
    }

    private void resumeJob() {
        if (submitting || prefs.getBoolean("submission_pending", false)) {
            toast("请先核对正在提交的任务"); return;
        }
        final String id = jobId, node = nodeId;
        resumeButton.setEnabled(false);
        submitting = true;
        prefs.edit().putBoolean("submission_pending", true).commit();
        observeSubmission();
        final Api client = new Api(api.base(), api.cookie());
        mutate(() -> {
            try {
                client.resume(node, id); // Resume the same job; never submit a replacement.
                prefs.edit().putBoolean("submission_pending", false).remove("submit_notice").commit();
            } catch (Exception error) {
                prefs.edit().putString("submit_notice", "继续执行结果未知，请核对原任务：" + id).commit();
                throw error;
            } finally { submitting = false; }
        }, () -> openJob(id));
    }

    private void renderInteractions(String id, JSONArray approvals, JSONArray questions) {
        String signature = approvals.toString() + questions.toString();
        if (signature.equals(interactionSignature)) return;
        interactionSignature = signature;
        Ui.clear(interactions);
        for (int i = 0; i < approvals.length(); i++) {
            JSONObject item = approvals.optJSONObject(i);
            if (item == null || !id.equals(item.optString("job_id"))) continue;
            final String prompt = item.optString("id"), node = nodeId;
            final Api client = new Api(api.base(), api.cookie());
            LinearLayout card = ui.card();
            card.addView(ui.body("等待授权 · " + item.optString("tool") + "\n" + item.optString("description")
                    + "\n" + item.optString("args"), theme.text));
            card.addView(ui.outlineButton("允许本次", v -> {
                card.setVisibility(View.GONE);
                mutate(() -> client.decide(node, prompt, "once"), () -> interactionSignature = "");
            }));
            card.addView(ui.outlineButton("拒绝", v -> {
                card.setVisibility(View.GONE);
                mutate(() -> client.decide(node, prompt, "deny"), () -> interactionSignature = "");
            }));
            interactions.addView(card);
        }
        for (int i = 0; i < questions.length(); i++) {
            JSONObject item = questions.optJSONObject(i);
            if (item == null || !id.equals(item.optString("job_id"))) continue;
            final String prompt = item.optString("id"), node = nodeId;
            final Api client = new Api(api.base(), api.cookie());
            LinearLayout card = ui.card();
            card.addView(ui.body("等待回答 · " + item.optString("question"), theme.text));
            JSONArray choices = item.optJSONArray("options");
            if (choices != null) card.addView(ui.note(choices.toString()));
            EditText answer = new EditText(this);
            answer.setTextColor(theme.text);
            String key = "answer:" + prompt;
            answer.setText(prefs.getString(key, ""));
            answer.addTextChangedListener(new TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                    prefs.edit().putString(key, s.toString()).apply();
                }
                public void afterTextChanged(Editable value) {}
            });
            card.addView(answer);
            card.addView(ui.outlineButton("提交回答", v -> {
                String text = answer.getText().toString().trim();
                if (text.isEmpty() || text.length() > 2000) { toast("回答需为 1–2000 字"); return; }
                card.setVisibility(View.GONE);
                mutate(() -> client.answer(node, prompt, text), () -> {
                    prefs.edit().remove(key).apply();
                    interactionSignature = "";
                });
            }));
            interactions.addView(card);
        }
        // Prompts stay above the stream instead of being scrolled out of view.
        if (interactions.getChildCount() > 0) scroll.smoothScrollTo(0, interactions.getTop());
    }

    private TextView statusPill(String status) {
        int color;
        int background;
        switch (status) {
            case "done": color = theme.ok; background = theme.okSoft; break;
            case "failed": case "cancelled": color = theme.danger; background = theme.dangerSoft; break;
            case "paused": color = theme.warn; background = theme.warnSoft; break;
            case "working": case "pending": case "queued": color = theme.accent; background = theme.accentSoft; break;
            default: color = theme.muted; background = theme.surfaceAlt;
        }
        return ui.pill(statusLabel(status), color, background);
    }

    private String statusLabel(String status) {
        if (status == null) return "未知";
        switch (status) {
            case "queued": return "排队中";
            case "pending": return "等待中";
            case "working": return "执行中";
            case "paused": return "已暂停";
            case "done": return "已完成";
            case "failed": return "失败";
            case "cancelled": return "已取消";
            default: return status;
        }
    }

    /* ---------------------------------------------------------------- composer */

    private EditText draft;

    private void buildComposer() {
        Ui.clear(composerBar);
        composerBar.setBackgroundColor(theme.bg);
        composerBar.setPadding(ui.dp(12), ui.dp(6), ui.dp(12), ui.dp(10));

        LinearLayout box = ui.row();
        box.setPadding(ui.dp(14), ui.dp(4), ui.dp(4), ui.dp(4));
        box.setBackground(ui.shape(theme.surface, theme.line, 20));

        EditText input = new EditText(this);
        draft = input;
        input.setHint(sessionId.isEmpty() ? "让这台电脑做什么？" : "接着这个会话补充指令…");
        input.setHintTextColor(theme.dim);
        input.setTextColor(theme.text);
        input.setTextSize(TypedValue.COMPLEX_UNIT_PX, ui.sp(15));
        input.setBackground(null);
        input.setPadding(0, ui.dp(10), 0, ui.dp(10));
        input.setMaxLines(4);
        final String draftKey = "draft:" + nodeId + ":" + project + ":" + sessionId;
        input.setText(prefs.getString(draftKey, ""));
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                prefs.edit().putString(draftKey, s.toString()).apply();
            }
            public void afterTextChanged(Editable value) {}
        });
        box.addView(input, new LinearLayout.LayoutParams(0, -2, 1f));

        TextView send = ui.text("↑", 18, theme.onAccent, true);
        send.setGravity(Gravity.CENTER);
        send.setBackground(ui.ripple(ui.shape(theme.accent, 0, 15)));
        send.setOnClickListener(v -> sendDraft());
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(ui.dp(46), ui.dp(46));
        box.addView(send, sendParams);
        composerBar.addView(box);

        LinearLayout options = ui.row();
        options.setPadding(ui.dp(2), ui.dp(8), ui.dp(2), 0);
        TextView modePill = ui.pill(MODE_LABELS[indexOf(MODES, mode)], theme.muted, theme.surfaceAlt);
        modePill.setOnClickListener(v -> cycleMode());
        options.addView(modePill);
        TextView sessionPill = ui.pill(sessionId.isEmpty() ? "新会话" : "接续会话", theme.muted, theme.surfaceAlt);
        sessionPill.setOnClickListener(v -> {
            sessionId = "";
            toast("已切换为新会话");
            loadSessions();
        });
        LinearLayout.LayoutParams pillParams = new LinearLayout.LayoutParams(-2, -2);
        pillParams.leftMargin = ui.dp(8);
        options.addView(sessionPill, pillParams);
        TextView projectPill = ui.pill(Ui.ellipsize(project.isEmpty() ? "当前工作区" : project, 16), theme.muted, theme.surfaceAlt);
        projectPill.setOnClickListener(v -> chooseProject());
        options.addView(projectPill, pillParams);
        composerBar.addView(options);
        String notice = prefs.getString("submit_notice", "");
        if (prefs.getBoolean("submission_pending", false)) {
            composerBar.addView(ui.note(submitting ? "正在提交，请勿重复发送。" : "上次提交结果未知。请先查看任务列表，勿重复派活。"));
        }
        if (!notice.isEmpty()) composerBar.addView(ui.note(notice));
        if (prefs.getBoolean("submission_pending", false) || !notice.isEmpty()) {
            composerBar.addView(ui.outlineButton("查看任务，核对后解锁发送", v -> {
                if (submitting) { toast("提交仍在进行中"); return; }
                new AlertDialog.Builder(this).setTitle("先核对原任务")
                    .setMessage("网络错误不代表服务器未收到。请在任务列表确认，避免重复执行。草稿会保留。")
                    .setPositiveButton("查看任务", (d, w) -> showJobs())
                    .setNeutralButton("已核对，解锁", (d, w) -> {
                        prefs.edit().putBoolean("submission_pending", false).remove("submit_notice").apply();
                        buildComposer();
                    }).setNegativeButton("取消", null).show();
            }));
        }
    }

    private void cycleMode() {
        int index = (indexOf(MODES, mode) + 1) % MODES.length;
        mode = MODES[index];
        String text = draft == null ? "" : draft.getText().toString();
        buildComposer();
        draft.setText(text);
        draft.setSelection(text.length());
    }

    private static int indexOf(String[] values, String value) {
        for (int i = 0; i < values.length; i++) if (values[i].equals(value)) return i;
        return 0;
    }

    private void sendDraft() {
        if (draft == null) return;
        String instruction = draft.getText().toString().trim();
        if (instruction.isEmpty()) return;
        if (nodeId.isEmpty()) {
            toast("先选择一台设备");
            return;
        }
        if (submitting || prefs.getBoolean("submission_pending", false)) {
            toast("提交结果尚未核对，请勿重复发送"); return;
        }
        if (screen.equals("job") && liveRunning) { toast("原任务仍在执行，请等待或继续原任务"); return; }
        hideKeyboard();
        final String target = sessionId, projectId = project, node = nodeId, name = nodeName;
        final String requestedMode = mode;
        final String draftKey = "draft:" + node + ":" + projectId + ":" + target;
        final Api client = new Api(api.base(), api.cookie());
        final int generation = pageGeneration;
        saveActive();
        // Persist the uncertainty marker BEFORE making a request, including process death.
        if (!prefs.edit().putBoolean("submission_pending", true).remove("submit_notice").commit()) {
            toast("无法保存提交状态，请重试"); return;
        }
        submitting = true;
        header("派活中…", nodeName, null);
        observeSubmission();
        mutations.execute(() -> {
            requestPage.set(generation);
            try {
                JSONObject reply = client.submit(node, instruction, projectId, requestedMode, target);
                String id = reply.optString("job_id");
                String sid = reply.optString("session_id", target);
                if (id.isEmpty()) throw new IllegalStateException("服务端未返回任务 ID，请核对任务列表");
                prefs.edit().putString("active_node", node).putString("active_name", name)
                        .putString("active_project", projectId).putString("active_session", sid)
                        .putString("active_job", id).putString("instruction:" + id, instruction).putBoolean("submission_pending", false)
                        .remove("submit_notice").commit();
                if (prefs.getString(draftKey, "").trim().equals(instruction)) prefs.edit().remove(draftKey).commit();
                postResult(() -> {
                    sessionId = sid;
                    // Keep the submitted instruction alongside existing history and streaming output.
                    try {
                        JSONArray messages = target.equals(historySession) ? history.optJSONArray("messages") : null;
                        if (messages == null) messages = new JSONArray();
                        messages.put(new JSONObject().put("role", "user").put("content", instruction));
                        history = new JSONObject().put("messages", messages);
                        historySession = sid;
                    } catch (JSONException ignored) {}
                    openJob(id);
                });
            } catch (Exception error) {
                prefs.edit().putString("submit_notice", "提交结果未知：" + messageOf(error) + "。请先核对任务列表。").commit();
                postResult(() -> { toast(messageOf(error)); buildComposer(); });
            } finally {
                submitting = false;
                requestPage.remove();
            }
        });
    }

    private void hideKeyboard() {
        InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (manager != null && getCurrentFocus() != null) {
            manager.hideSoftInputFromWindow(getCurrentFocus().getWindowToken(), 0);
        }
    }

    /* ---------------------------------------------------------------- settings */

    private void showSettings() {
        beginPage("settings");
        buildNav();
        Ui.clear(composerBar);
        header("设置", "外观、账户与连接", null);

        LinearLayout content = ui.column();

        LinearLayout appearance = ui.card();
        appearance.addView(ui.label("外观"));
        LinearLayout themeRow = ui.row();
        themeRow.setPadding(0, ui.dp(10), 0, 0);
        themeRow.addView(segment("深色", theme.dark, v -> setDark(true)), new LinearLayout.LayoutParams(0, -2, 1f));
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(0, -2, 1f);
        gap.leftMargin = ui.dp(8);
        themeRow.addView(segment("浅色", !theme.dark, v -> setDark(false)), gap);
        appearance.addView(themeRow);

        appearance.addView(ui.label("文字大小"));
        LinearLayout sizeRow = ui.row();
        sizeRow.setPadding(0, ui.dp(10), 0, 0);
        String[] labels = {"标准", "大", "特大"};
        float[] values = {1f, 1.15f, 1.3f};
        float current = Theme.scaleOf(prefs);
        for (int i = 0; i < labels.length; i++) {
            final float value = values[i];
            boolean active = Math.abs(current - value) < 0.02f;
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1f);
            if (i > 0) params.leftMargin = ui.dp(8);
            sizeRow.addView(segment(labels[i], active, v -> setScale(value)), params);
        }
        appearance.addView(sizeRow);
        content.addView(appearance);

        LinearLayout account = ui.card();
        account.addView(ui.label("账户"));
        account.addView(keyValue("邮箱", email.isEmpty() ? "—" : email));
        account.addView(keyValue("中继", api.base()));
        account.addView(keyValue("设备", nodes.length() + " 台"));
        TextView logout = ui.outlineButton("退出登录", v -> logout());
        LinearLayout.LayoutParams logoutParams = new LinearLayout.LayoutParams(-1, -2);
        logoutParams.topMargin = ui.dp(12);
        account.addView(logout, logoutParams);
        content.addView(account);

        LinearLayout about = ui.card();
        about.addView(ui.label("关于"));
        about.addView(keyValue("应用", "luban 原生 " + versionName()));
        about.addView(ui.note("本应用直接调用中继 REST API；WebView 版（luban 遥控）仍然保留。"));
        content.addView(about);

        setBody(content);
    }

    private TextView segment(String label, boolean active, View.OnClickListener click) {
        TextView view = ui.text(label, 14, active ? theme.text : theme.muted, active);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(ui.dp(44));
        view.setBackground(ui.ripple(active
                ? ui.shape(theme.accentSoft, theme.accentLine, 13)
                : ui.shape(theme.surfaceAlt, theme.line, 13)));
        view.setOnClickListener(click);
        return view;
    }

    private View keyValue(String key, String value) {
        LinearLayout row = ui.row();
        row.setPadding(0, ui.dp(6), 0, 0);
        TextView label = ui.text(key, 12.5f, theme.dim, false);
        label.setLayoutParams(new LinearLayout.LayoutParams(ui.dp(64), -2));
        TextView detail = ui.text(value, 13.5f, theme.text, false);
        detail.setSingleLine(true);
        detail.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        row.addView(label);
        row.addView(detail, new LinearLayout.LayoutParams(0, -2, 1f));
        return row;
    }

    private void setDark(boolean dark) {
        prefs.edit().putBoolean(Theme.PREF_DARK, dark).apply();
        applyTheme();
    }

    private void setScale(float scale) {
        prefs.edit().putString(Theme.PREF_SCALE, String.valueOf(scale)).apply();
        applyTheme();
    }

    private void logout() {
        runIo(() -> {
            try {
                api.logout();
            } catch (Exception ignored) {
                // Clearing local state is what matters; the relay session expires on its own.
            }
            api.cookie("");
            prefs.edit().remove(PREF_COOKIE).apply();
            postResult(() -> showLogin("已退出登录"));
        });
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "1.0.0";
        }
    }

    /* ----------------------------------------------------------------- helpers */

    private String messageOf(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) message = error.getClass().getSimpleName();
        if (error instanceof Api.Failure && ((Api.Failure) error).needsLogin()) {
            return "登录已过期，请重新登录";
        }
        return message;
    }

    private String relative(String iso) {
        if (iso == null || iso.isEmpty()) return "";
        try {
            long millis = parseIso(iso);
            if (millis <= 0) return "";
            return relative(millis / 1000);
        } catch (Exception ignored) {
            return "";
        }
    }

    private long parseIso(String iso) {
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            Date date = format.parse(iso.length() > 19 ? iso.substring(0, 19) : iso);
            return date == null ? 0 : date.getTime();
        } catch (Exception ignored) {
            return 0;
        }
    }

    private String relative(long epochSeconds) {
        if (epochSeconds <= 0) return "";
        long delta = System.currentTimeMillis() / 1000 - epochSeconds;
        if (delta < 60) return "刚刚";
        if (delta < 3600) return (delta / 60) + " 分钟前";
        if (delta < 86400) return (delta / 3600) + " 小时前";
        return (delta / 86400) + " 天前";
    }
}
