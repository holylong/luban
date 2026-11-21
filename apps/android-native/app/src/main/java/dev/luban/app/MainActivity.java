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
import java.util.Collections;
import java.util.Date;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
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
    private static final String PREF_MACHINE = "active_machine";
    /** Last `/relay/nodes` snapshot, so a phone with no network still shows
     *  the workspaces it was working in a minute ago. */
    private static final String PREF_NODES_CACHE = "cache_nodes";
    private static final String PREF_NODES_CACHE_AT = "cache_nodes_at";
    private static final String DEFAULT_SERVER = "https://thickness-oxygen-life-resistant.trycloudflare.com";
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
    private TextView resumeButton, cancelButton, liveStatus, liveProgress, liveOutput, headerSubtitle;
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
    /** Relay registration that owns the current workspace. */
    private String nodeId = "";
    /** Physical computer the user picked: several registrations share it. */
    private String machineId = "";
    private String nodeName = "";
    private String project = "";
    private String sessionId = "";
    private String jobId = "";
    private String email = "";
    private String mode = "edits";
    private List<RelayNode> nodes = new ArrayList<>();
    private List<Machine> machines = new ArrayList<>();
    /** True while the screen is showing the cached snapshot, not a live relay answer. */
    private boolean cached;
    private long cacheAt;
    /** A /relay/nodes read succeeded (live or from the offline cache) in this session. */
    private boolean devicesLoaded;
    private JSONObject nodeInfo;
    /** Per-workspace session lists of the machine currently open. */
    private final Map<String, JSONArray> workspaceSessions = new LinkedHashMap<>();
    /** Which registration answered for a job, so opening it polls the right node. */
    private final Map<String, String> jobOwner = new LinkedHashMap<>();
    private final Map<String, String> workspaceErrors = new LinkedHashMap<>();
    /** Workspaces whose session list the user expanded. */
    private final Set<String> openWorkspaces = new LinkedHashSet<>();
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
        machineId = prefs.getString(PREF_MACHINE, "");
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
        prefs.edit().putString("active_node", nodeId).putString(PREF_MACHINE, machineId)
                .putString("active_name", nodeName)
                .putString("active_project", project).putString("active_session", sessionId)
                .putString("active_job", jobId).apply();
    }

    private void restoreActive() {
        nodeId = prefs.getString("active_node", nodeId);
        machineId = prefs.getString(PREF_MACHINE, machineId);
        nodeName = prefs.getString("active_name", nodeName);
        project = prefs.getString("active_project", project);
        sessionId = prefs.getString("active_session", sessionId);
        jobId = prefs.getString("active_job", "");
        if (!jobId.isEmpty()) openJob(jobId);
        else if (!sessionId.isEmpty()) openSession(sessionId, "会话", project);
        else if (!machineId.isEmpty()) openMachine(machineId);
        else if (!nodeId.isEmpty()) loadSessions();
        else loadDevices();
    }

    @Override public void onBackPressed() {
        pollToken++;
        if (screen.equals("job")) { showJobs(); return; }
        if (screen.equals("transcript")) {
            sessionId = "";
            if (!machineId.isEmpty()) openMachine(machineId); else loadSessions();
            return;
        }
        if (screen.equals("sessions")) {
            sessionId = "";
            if (!machineId.isEmpty()) { openMachine(machineId); return; }
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
            case "machine": openMachine(machineId); break;
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
        headerSubtitle = null;
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
            headerSubtitle = sub;
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

    /** True when the transcript is parked at the newest line (or too short to
     *  scroll), so streaming can follow without yanking the reader upwards. */
    private boolean nearBottom() {
        View child = scroll.getChildAt(0);
        if (child == null) return true;
        int distance = child.getHeight() - (scroll.getScrollY() + scroll.getHeight());
        return distance < ui.dp(120);
    }

    private void followTail() {
        scroll.post(() -> {
            if (!background && screen.equals("job")) scroll.fullScroll(View.FOCUS_DOWN);
        });
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

    /* --------------------------------------------------------------- machines */

    /**
     * One card per physical computer.
     *
     * Since `luban daemon` every workspace can hold its own relay connection,
     * so a laptop shows up as several registrations with a shared machine id.
     * Grouping them here is what makes "打开电脑 → 挑工作区" possible instead of
     * scrolling a list of near-identical devices.
     */
    private void loadDevices() {
        beginPage("devices");
        buildNav();
        Ui.clear(composerBar);
        header("luban", "正在同步设备…", null);
        empty("正在同步", "读取账户下的电脑、工作区与最近任务。");
        runIo(() -> {
            try {
                final List<RelayNode> fresh = RelayNode.parseAll(api.nodes());
                postResult(() -> {
                    nodes = fresh;
                    cached = false;
                    devicesLoaded = true;
                    machines = Machine.group(nodes);
                    saveNodesCache();
                    showDevices();
                });
            } catch (Api.Failure failure) {
                postResult(() -> {
                    if (failure.needsLogin()) {
                        api.cookie("");
                        showLogin("登录已过期，请重新登录");
                    } else {
                        showCachedDevices(failure.getMessage());
                    }
                });
            } catch (Exception error) {
                postResult(() -> showCachedDevices(messageOf(error)));
            }
        });
    }

    /** No network, but the last snapshot still says where work can continue. */
    private void showCachedDevices(String reason) {
        List<RelayNode> snapshot = loadNodesCache();
        if (snapshot.isEmpty()) {
            empty("读取失败", reason);
            return;
        }
        nodes = snapshot;
        cached = true;
        devicesLoaded = true;
        machines = Machine.group(nodes);
        showDevices();
        toast("离线：显示上次同步的设备");
    }

    private void saveNodesCache() {
        // An empty reply must not erase the last known fleet: it is the only thing
        // left to show when the relay is unreachable on the next launch.
        if (nodes.isEmpty()) return;
        JSONArray array = new JSONArray();
        for (RelayNode node : nodes) array.put(node.toCache());
        cacheAt = System.currentTimeMillis() / 1000;
        prefs.edit().putString(PREF_NODES_CACHE, array.toString())
                .putLong(PREF_NODES_CACHE_AT, cacheAt).apply();
    }

    private List<RelayNode> loadNodesCache() {
        cacheAt = prefs.getLong(PREF_NODES_CACHE_AT, 0);
        try {
            return RelayNode.parseAll(new JSONArray(prefs.getString(PREF_NODES_CACHE, "[]")));
        } catch (JSONException ignored) {
            return new ArrayList<>();
        }
    }

    /** Re-read the relay list after a workspace was created or removed. */
    private void refreshMachines(Runnable then) {
        runIo(() -> {
            try {
                final List<RelayNode> fresh = RelayNode.parseAll(api.nodes());
                postResult(() -> {
                    nodes = fresh;
                    cached = false;
                    devicesLoaded = true;
                    machines = Machine.group(nodes);
                    saveNodesCache();
                    then.run();
                });
            } catch (Exception error) {
                postResult(() -> { toast(messageOf(error)); then.run(); });
            }
        });
    }

    private void showDevices() {
        // Cold start (fresh install, restored page, back navigation) has nothing to
        // paint yet. Fetching here beats showing "0 台在线 / 共 0 台电脑", which reads
        // as "my computers are gone" and needs a manual refresh to recover.
        if (!devicesLoaded) {
            loadDevices();
            return;
        }
        beginPage("devices");
        Ui.clear(composerBar);
        buildNav();
        int online = 0;
        for (Machine machine : machines) if (machine.online) online++;
        String subtitle = online + " 台在线 / 共 " + machines.size() + " 台电脑";
        if (cached && cacheAt > 0) subtitle = subtitle + " · 离线缓存 " + relative(cacheAt);
        header("luban", subtitle, ui.iconButton("⟳", v -> loadDevices()));

        if (machines.isEmpty()) {
            empty("还没有电脑", "在网页版「设置 → 添加电脑」生成设备令牌，然后在电脑上运行 luban daemon 接入中继。");
            return;
        }
        LinearLayout content = ui.column();
        for (Machine machine : machines) content.addView(machineCard(machine));
        setBody(content);
    }

    private View machineCard(Machine machine) {
        boolean current = machine.id.equals(machineId);
        LinearLayout card = ui.card();
        card.setBackground(ui.ripple(ui.shape(current ? theme.accentSoft : theme.surface,
                current ? theme.accentLine : theme.line, 18)));
        // The whole card opens the computer: tapping the name is the obvious gesture,
        // and before this only the bottom button worked.
        card.setOnClickListener(v -> openMachine(machine.id));

        LinearLayout head = ui.row();
        head.addView(ui.dot(machine.online ? theme.ok : theme.dim));
        TextView title = ui.text(machine.name, 17, theme.text, true);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        head.addView(title, new LinearLayout.LayoutParams(0, -2, 1f));
        if (machine.members.size() > 1) {
            LinearLayout.LayoutParams badge = new LinearLayout.LayoutParams(-2, -2);
            badge.rightMargin = ui.dp(6);
            head.addView(ui.pill(machine.members.size() + " 个工作区", theme.muted, theme.surfaceAlt), badge);
        }
        head.addView(ui.pill(machine.online ? "在线" : "离线",
                machine.online ? theme.ok : theme.dim, machine.online ? theme.okSoft : theme.surfaceAlt));
        card.addView(head);

        String names = workspaceNames(machine);
        if (!names.isEmpty()) {
            TextView list = ui.text(names, 13, theme.muted, false);
            list.setPadding(0, ui.dp(7), 0, 0);
            list.setMaxLines(2);
            list.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(list);
        }

        String version = machine.members.get(0).version;
        String meta = Ui.join(" · ", machine.model, version.isEmpty() ? "" : "v" + version,
                machine.activeJobs > 0 ? machine.activeJobs + " 个进行中" : "");
        if (!meta.isEmpty()) {
            TextView detail = ui.text(meta, 12.8f, theme.muted, false);
            detail.setPadding(0, ui.dp(6), 0, 0);
            detail.setSingleLine(true);
            detail.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(detail);
        }

        String status = machine.subtitle();
        if (!status.isEmpty()) {
            TextView line = ui.text(status, 12.8f, theme.dim, false);
            line.setPadding(0, ui.dp(5), 0, 0);
            line.setSingleLine(true);
            line.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(line);
        }

        LinearLayout actions = ui.row();
        TextView open = ui.button(machine.online ? "打开并派活" : "查看缓存", true, v -> openMachine(machine.id));
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(0, -2, 1f);
        openParams.rightMargin = ui.dp(8);
        actions.addView(open, openParams);
        actions.addView(ui.outlineButton("任务", v -> {
            machineId = machine.id;
            nodeName = machine.name;
            nodeId = machine.representative().id;
            project = "";
            saveActive();
            navigate("jobs");
        }), new LinearLayout.LayoutParams(ui.dp(72), -2));
        if (!machine.online) {
            LinearLayout.LayoutParams removeParams = new LinearLayout.LayoutParams(ui.dp(72), -2);
            removeParams.leftMargin = ui.dp(8);
            actions.addView(ui.outlineButton("移除", v -> confirmRemoveMachine(machine)), removeParams);
        }
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, -2);
        actionParams.topMargin = ui.dp(12);
        card.addView(actions, actionParams);
        return card;
    }

    private String workspaceNames(Machine machine) {
        StringBuilder names = new StringBuilder();
        int shown = 0;
        for (Machine.Route route : machine.routes) {
            if (shown == 3) { names.append(" …"); break; }
            if (names.length() > 0) names.append(" · ");
            names.append(route.project);
            shown++;
        }
        return names.toString();
    }

    /** A laptop that went away for good: drop every registration it owns. */
    private void confirmRemoveMachine(Machine machine) {
        new AlertDialog.Builder(this)
                .setTitle("移除这台电脑？")
                .setMessage("将移除 " + machine.name + " 名下的 " + machine.members.size()
                        + " 个工作区实例，不会删除电脑上的文件。电脑重新接入中继后可以再加回来。")
                .setPositiveButton("移除", (dialog, which) -> {
                    toast("正在移除…");
                    runIo(() -> {
                        try {
                            for (RelayNode member : machine.members) {
                                api.deleteDevice(member.deviceId.isEmpty() ? member.id : member.deviceId);
                            }
                            postResult(() -> refreshMachines(() -> { if (machines.isEmpty()) loadDevices(); else showDevices(); }));
                        } catch (Exception error) {
                            postResult(() -> toast(messageOf(error)));
                        }
                    });
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** Open one computer: its workspaces come from every registration it owns. */
    private void openMachine(String id) {
        machineId = id;
        Machine machine = Machine.find(machines, id);
        if (machine == null) {
            // Cold start or a stale active machine: fetch the list, then retry.
            beginPage("devices");
            buildNav();
            Ui.clear(composerBar);
            header("luban", "正在连接…", null);
            empty("正在连接", "读取这台电脑的工作区。");
            runIo(() -> {
                try {
                    final List<RelayNode> fresh = RelayNode.parseAll(api.nodes());
                    postResult(() -> {
                        nodes = fresh;
                        cached = false;
                        devicesLoaded = true;
                        machines = Machine.group(nodes);
                        saveNodesCache();
                        if (Machine.find(machines, id) == null) {
                            showDevices();
                            toast("这台电脑已不在账户下");
                            return;
                        }
                        openMachine(id);
                    });
                } catch (Exception error) {
                    postResult(() -> showCachedDevices(messageOf(error)));
                }
            });
            return;
        }
        nodeName = machine.name;
        nodeId = machine.representative().id;
        project = "";
        sessionId = "";
        jobId = "";
        beginPage("machine");
        buildNav();
        Ui.clear(composerBar);
        saveActive();
        showMachine(machine);
        loadMachineSessions(machine);
    }

    private void showMachine(Machine machine) {
        screen = "machine";
        buildNav();
        Ui.clear(composerBar);
        String subtitle = Ui.join(" · ", machine.online ? "在线" : "离线",
                machine.routes.size() + " 个工作区", machine.model);
        header(machine.name, subtitle, ui.iconButton("⟳", v -> refreshMachines(() -> openMachine(machine.id))));

        LinearLayout content = ui.column();
        if (!machine.online) {
            LinearLayout note = ui.column();
            note.setPadding(ui.dp(13), ui.dp(11), ui.dp(13), ui.dp(11));
            note.setBackground(ui.shape(theme.surfaceAlt, theme.line, 13));
            note.addView(ui.text("电脑离线，显示上次同步的工作区与会话", 13, theme.muted, true));
            note.addView(ui.note("电脑上的 luban daemon 重新连上中继后，这里的会话就能继续。"));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
            params.bottomMargin = ui.dp(11);
            content.addView(note, params);
        }
        if (machine.routes.isEmpty()) {
            content.addView(ui.note("这台电脑还没有工作区，可以在下方新建，或添加电脑上已有的目录。"));
        }
        for (Machine.Route route : machine.routes) content.addView(workspaceCard(machine, route));

        LinearLayout actions = ui.row();
        TextView add = ui.outlineButton("＋ 新建工作区", v -> promptWorkspace(false));
        TextView existing = ui.outlineButton("＋ 添加已有目录", v -> promptWorkspace(true));
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, -2, 1f);
        LinearLayout.LayoutParams halfRight = new LinearLayout.LayoutParams(0, -2, 1f);
        halfRight.leftMargin = ui.dp(8);
        actions.addView(add, half);
        actions.addView(existing, halfRight);
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, -2);
        actionParams.topMargin = ui.dp(2);
        content.addView(actions, actionParams);
        if (!machine.online) {
            add.setEnabled(false);
            existing.setEnabled(false);
            add.setAlpha(0.45f);
            existing.setAlpha(0.45f);
        }
        setBody(content);
    }

    private View workspaceCard(Machine machine, Machine.Route route) {
        LinearLayout card = ui.card();
        card.setBackground(ui.ripple(ui.shape(theme.surface, theme.line, 18)));
        LinearLayout head = ui.row();
        TextView name = ui.text(route.project, 16, theme.text, true);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        head.addView(name, new LinearLayout.LayoutParams(0, -2, 1f));
        JSONArray sessions = workspaceSessions.get(route.project);
        String failure = workspaceErrors.get(route.project);
        String count = failure != null ? "读取失败" : sessions == null ? "读取中" : sessions.length() + " 个会话";
        head.addView(ui.pill(count, failure != null ? theme.danger : theme.muted,
                failure != null ? theme.dangerSoft : theme.surfaceAlt));
        card.addView(head);

        if (!route.path.isEmpty()) {
            TextView path = ui.text(route.path, 12, theme.dim, false);
            path.setTypeface(Typeface.MONOSPACE);
            path.setSingleLine(true);
            path.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
            path.setPadding(0, ui.dp(6), 0, 0);
            card.addView(path);
        }

        LinearLayout actions = ui.row();
        LinearLayout.LayoutParams firstAction = new LinearLayout.LayoutParams(0, -2, 1f);
        firstAction.topMargin = ui.dp(10);
        TextView fresh = ui.outlineButton("＋ 新会话", v -> openWorkspace(machine, route, null));
        LinearLayout.LayoutParams secondAction = new LinearLayout.LayoutParams(0, -2, 1f);
        secondAction.topMargin = ui.dp(10);
        secondAction.leftMargin = ui.dp(8);
        boolean open = openWorkspaces.contains(route.project);
        TextView toggle = ui.outlineButton(open ? "收起会话" : "会话列表", v -> {
            if (!openWorkspaces.remove(route.project)) openWorkspaces.add(route.project);
            showMachine(machine);
        });
        actions.addView(fresh, firstAction);
        actions.addView(toggle, secondAction);
        card.addView(actions);
        if (!machine.online) {
            fresh.setAlpha(0.45f);
            fresh.setEnabled(false);
        }

        if (open) {
            LinearLayout box = ui.column();
            box.setPadding(0, ui.dp(6), 0, 0);
            if (failure != null) {
                box.addView(ui.note("会话读取失败：" + failure));
            } else if (sessions == null) {
                box.addView(ui.note("正在读取会话…"));
            } else if (sessions.length() == 0) {
                box.addView(ui.note("还没有会话，点「新会话」开始。"));
            } else {
                for (int i = 0; i < sessions.length(); i++) {
                    JSONObject session = sessions.optJSONObject(i);
                    if (session != null) box.addView(workspaceSessionRow(machine, route, session));
                }
            }
            card.addView(box);
        }
        return card;
    }

    private View workspaceSessionRow(Machine machine, Machine.Route route, JSONObject session) {
        LinearLayout row = ui.row();
        row.setPadding(0, ui.dp(9), 0, ui.dp(3));
        LinearLayout texts = ui.column();
        String id = session.optString("id");
        String title = session.optString("title", id);
        TextView name = ui.text(Ui.ellipsize(title.isEmpty() ? "未命名会话" : title, 90), 14.5f, theme.text, true);
        name.setMaxLines(2);
        texts.addView(name);
        boolean running = session.optBoolean("running", false);
        String meta = Ui.join(" · ", session.optInt("messages", 0) + " 条记录",
                session.optString("model", ""), sessionWhen(session), running ? "运行中" : "");
        TextView detail = ui.text(meta, 12, theme.muted, false);
        detail.setPadding(0, ui.dp(4), 0, 0);
        texts.addView(detail);
        row.addView(texts, new LinearLayout.LayoutParams(0, -2, 1f));

        TextView remove = ui.text("删除", 12.5f, theme.danger, false);
        remove.setPadding(ui.dp(10), ui.dp(8), ui.dp(4), ui.dp(8));
        remove.setOnClickListener(v -> confirmDeleteSession(machine, route, session));
        row.addView(remove);

        row.setOnClickListener(v -> openWorkspace(machine, route, session));
        return row;
    }

    private void confirmDeleteSession(Machine machine, Machine.Route route, JSONObject session) {
        if (session.optBoolean("running", false)) {
            toast("会话正在运行，结束后再删除");
            return;
        }
        String title = session.optString("title", session.optString("id"));
        new AlertDialog.Builder(this)
                .setTitle("删除会话？")
                .setMessage("将删除「" + Ui.ellipsize(title, 40) + "」及其历史记录，无法恢复；不会删除工作区文件。")
                .setPositiveButton("删除", (dialog, which) -> {
                    final String id = session.optString("id");
                    final Api client = new Api(api.base(), api.cookie());
                    toast("正在删除…");
                    mutate(() -> client.deleteSession(machine.servingNode(route.project), route.project, id), () -> {
                        JSONArray list = workspaceSessions.get(route.project);
                        if (list != null) {
                            JSONArray kept = new JSONArray();
                            for (int i = 0; i < list.length(); i++) {
                                JSONObject item = list.optJSONObject(i);
                                if (item != null && id.equals(item.optString("id"))) continue;
                                kept.put(item);
                            }
                            workspaceSessions.put(route.project, kept);
                        }
                        toast("已删除会话");
                        showMachine(machine);
                    });
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** Route the whole screen to one workspace, then continue in it. */
    private void openWorkspace(Machine machine, Machine.Route route, JSONObject session) {
        machineId = machine.id;
        nodeName = machine.name;
        nodeId = machine.servingNode(route.project);
        project = route.project;
        sessionId = "";
        jobId = "";
        saveActive();
        if (session == null) {
            loadSessions();
        } else {
            openSession(session.optString("id"), session.optString("title", "会话"), route.project);
        }
    }

    private void loadMachineSessions(Machine machine) {
        workspaceSessions.clear();
        workspaceErrors.clear();
        if (!machine.online) {
            for (Machine.Route route : machine.routes) workspaceSessions.put(route.project, cachedSessions(machine, route));
            showMachine(machine);
            return;
        }
        runIo(() -> {
            Map<String, JSONArray> loaded = new LinkedHashMap<>();
            Map<String, String> failures = new LinkedHashMap<>();
            for (Machine.Route route : machine.routes) {
                final String serving = machine.servingNode(route.project);
                try {
                    loaded.put(route.project, startedSessions(api.sessions(serving, route.project, 200)));
                } catch (Exception error) {
                    loaded.put(route.project, cachedSessions(machine, route));
                    failures.put(route.project, messageOf(error));
                }
            }
            postResult(() -> {
                workspaceSessions.putAll(loaded);
                workspaceErrors.putAll(failures);
                persistSessions(machine, loaded);
                Machine live = Machine.find(machines, machine.id);
                showMachine(live == null ? machine : live);
            });
        });
    }

    /** Drafts with no message are not something anyone picks from a phone. */
    private JSONArray startedSessions(JSONArray sessions) {
        JSONArray started = new JSONArray();
        if (sessions == null) return started;
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session == null) continue;
            if (session.optBoolean("running", false) || session.optInt("messages", 0) > 0) started.put(session);
        }
        return started;
    }

    private String sessionCacheKey(String node, String project) {
        return "cache_sessions:" + node + "\u0000" + project;
    }

    private void persistSessions(Machine machine, Map<String, JSONArray> loaded) {
        android.content.SharedPreferences.Editor editor = prefs.edit();
        for (Map.Entry<String, JSONArray> entry : loaded.entrySet()) {
            Machine.Route route = machine.routeFor(entry.getKey());
            if (route == null) continue;
            JSONArray list = entry.getValue();
            JSONArray slim = new JSONArray();
            for (int i = 0; i < Math.min(list.length(), 60); i++) slim.put(list.opt(i));
            editor.putString(sessionCacheKey(route.nodeId, route.project), slim.toString());
        }
        editor.apply();
    }

    /** Offline list: what this phone fetched last, else what the relay remembered. */
    private JSONArray cachedSessions(Machine machine, Machine.Route route) {
        try {
            JSONArray stored = new JSONArray(prefs.getString(sessionCacheKey(route.nodeId, route.project), "[]"));
            if (stored.length() > 0) return stored;
        } catch (JSONException ignored) {
            // Fall through to the relay snapshot.
        }
        JSONArray list = new JSONArray();
        for (RelayNode member : machine.members) {
            for (RelayNode.LiveSession session : member.status.sessions) {
                if (!route.project.equals(session.project)) continue;
                try {
                    list.put(new JSONObject().put("id", session.id).put("title", session.title)
                            .put("project", session.project).put("messages", 0)
                            .put("updated", session.updatedAt));
                } catch (JSONException ignored) {
                    // A row that cannot be built is simply skipped.
                }
            }
        }
        return list;
    }

    private String sessionWhen(JSONObject session) {
        long epoch = session.optLong("updated", 0);
        if (epoch > 0) return relative(epoch);
        return relative(session.optString("updatedAt"));
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

    private Machine currentMachine() {
        return Machine.find(machines, machineId);
    }

    private String projectLabel() {
        return project.isEmpty() ? "当前工作区" : project;
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
        Machine machine = currentMachine();
        String path = machine == null ? "" : machine.pathOf(project);
        if (!path.isEmpty()) {
            TextView detail = ui.text(path, 12, theme.dim, false);
            detail.setTypeface(Typeface.MONOSPACE);
            detail.setPadding(0, ui.dp(6), 0, 0);
            detail.setSingleLine(true);
            detail.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
            card.addView(detail);
        }
        card.setOnClickListener(v -> chooseProject());
        return card;
    }

    private void chooseProject() {
        final List<String> names = new ArrayList<>();
        final List<String> values = new ArrayList<>();
        names.add("＋ 新建工作区…");
        values.add("__new__");
        names.add("＋ 添加电脑上已有目录…");
        values.add("__existing__");
        Machine machine = currentMachine();
        if (machine != null) {
            for (Machine.Route route : machine.routes) {
                names.add(route.project + " · " + route.path);
                values.add(route.project);
            }
        }
        new AlertDialog.Builder(this)
                .setTitle(machine == null ? "工作区" : machine.name + " 的工作区")
                .setItems(names.toArray(new String[0]), (dialog, which) -> {
                    String value = values.get(which);
                    if (value.equals("__new__")) { promptWorkspace(false); return; }
                    if (value.equals("__existing__")) { promptWorkspace(true); return; }
                    if (machine == null) return;
                    Machine.Route route = machine.routeFor(value);
                    if (route == null) { loadSessions(); return; }
                    openWorkspace(machine, route, null);
                })
                .show();
    }

    private void promptWorkspace(boolean existing) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(existing ? "例如 /home/me/project 或 D:\\work\\project" : "例如 my-new-project");
        input.setInputType(InputType.TYPE_CLASS_TEXT
                | (existing ? InputType.TYPE_TEXT_VARIATION_URI : InputType.TYPE_TEXT_VARIATION_NORMAL));
        input.setPadding(ui.dp(18), ui.dp(8), ui.dp(18), ui.dp(8));
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(existing ? "添加电脑上的目录" : "新建工作区")
                .setMessage(existing
                        ? "输入电脑上已存在的绝对路径。仅注册目录，不复制文件。"
                        : "输入名称，将在电脑默认工作区目录下创建。")
                .setView(input)
                .setPositiveButton("确定", null)
                .setNegativeButton("取消", null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String value = input.getText().toString().trim();
                    if (value.isEmpty()) {
                        toast(existing ? "请填写目录绝对路径" : "请填写工作区名称");
                        return;
                    }
                    dialog.dismiss();
                    createWorkspace(value, existing);
                }));
        dialog.show();
    }

    private void createWorkspace(String value, boolean existing) {
        Machine machine = currentMachine();
        final String targetNode = machine == null ? nodeId : machine.representative().id;
        if (targetNode.isEmpty()) {
            toast("请先选择一台电脑");
            return;
        }
        toast(existing ? "正在添加目录…" : "正在创建工作区…");
        runIo(() -> {
            try {
                JSONObject reply = api.addProject(targetNode, value, existing);
                final String created = reply.optString("project", "");
                postResult(() -> {
                    toast("工作区已" + (reply.optBoolean("created") ? "创建" : "添加") + "：" + created);
                    refreshMachines(() -> {
                        Machine refreshed = currentMachine();
                        Machine.Route route = refreshed == null ? null : refreshed.routeFor(created);
                        openWorkspaces.add(created);
                        if (refreshed != null && route != null) openWorkspace(refreshed, route, null);
                        else openMachine(machineId);
                    });
                });
            } catch (Exception error) {
                postResult(() -> toast(messageOf(error)));
            }
        });
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
                sessionWhen(session),
                session.optBoolean("running", false) ? "运行中" : "");
        TextView detail = ui.text(meta, 12.3f, theme.muted, false);
        detail.setPadding(0, ui.dp(6), 0, 0);
        card.addView(detail);
        card.setOnClickListener(v -> {
            String label = session.optString("title", id);
            String work = session.optString("project", project);
            // A running session is a live stream, not a frozen transcript.
            if (session.optBoolean("running", false)) openLiveSession(id, label, work);
            else openSession(id, label, work);
        });
        return card;
    }

    /** Find the job that is writing a running session, then watch it live. */
    private void openLiveSession(String id, String title, String projectId) {
        Machine machine = currentMachine();
        List<String> nodeIds = new ArrayList<>();
        if (machine != null) {
            for (RelayNode member : machine.members) if (member.online) nodeIds.add(member.id);
        }
        if (nodeIds.isEmpty() && !nodeId.isEmpty()) nodeIds.add(nodeId);
        beginPage("transcript");
        header(title, "接入实时输出…", null);
        Ui.clear(composerBar);
        empty("正在连接", "这个会话正在执行任务，正在接入实时输出。");
        runIo(() -> {
            String found = "";
            JSONArray jobs = fetchJobs(nodeIds);
            for (int i = 0; i < jobs.length() && found.isEmpty(); i++) {
                JSONObject item = jobs.optJSONObject(i);
                if (item == null || !id.equals(item.optString("session_id"))) continue;
                if (!item.optString("status").matches("queued|pending|working")) continue;
                found = item.optString("id");
            }
            final String job = found;
            postResult(() -> {
                if (!job.isEmpty()) openJob(job); else openSession(id, title, projectId);
            });
        });
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
                postResult(() -> {
                    // Only an offline computer gets the "it will open later"
                    // wording; a deleted session must not look like a pause.
                    if (machineReachable()) offlineTranscript(title, id, "读取失败", messageOf(error));
                    else offlineTranscript(title, id, "这台电脑现在没有连上中继", messageOf(error));
                });
            }
        });
    }

    /**
     * A cached session row stays tappable while the computer is away.
     *
     * The relay cannot serve a transcript from a disconnected node, so the
     * honest answer is "this is what I remember; it will open again" plus a
     * retry that becomes the live transcript the moment the daemon is back.
     */
    private boolean machineReachable() {
        Machine machine = currentMachine();
        return machine == null || machine.online;
    }

    private void offlineTranscript(String title, String id, String headline, String reason) {
        screen = "transcript";
        header(title, "电脑离线", ui.iconButton("←", v -> {
            if (!machineId.isEmpty()) openMachine(machineId); else loadSessions();
        }));
        Ui.clear(composerBar);
        LinearLayout content = ui.column();
        LinearLayout card = ui.card();
        card.setBackground(ui.shape(theme.surfaceAlt, theme.line, 18));
        card.addView(ui.text(headline, 15.5f, theme.text, true));
        if (machineReachable()) card.addView(ui.note("会话仍保存在电脑上，可以重试。"));
        else card.addView(ui.note("会话内容在电脑上，电脑恢复连接后会自动打开。"));
        if (!reason.isEmpty()) card.addView(ui.note(reason));
        content.addView(card);
        content.addView(ui.button("重试", true, v -> openSession(id, title, project)));
        content.addView(ui.outlineButton("回到工作区", v -> {
            if (!machineId.isEmpty()) openMachine(machineId); else loadSessions();
        }));
        setBody(content);
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

    /**
     * One queue per computer, not per registration.
     *
     * A machine with two open workspaces registers twice, so asking a single
     * node hid the jobs started from the other workspace. Offline instances
     * simply contribute nothing instead of failing the whole screen.
     */
    private void showJobs() {
        beginPage("jobs");
        buildNav();
        Ui.clear(composerBar);
        Machine machine = currentMachine();
        List<String> nodeIds = new ArrayList<>();
        String title = machine == null ? nodeName : machine.name;
        if (machine != null) {
            for (RelayNode member : machine.members) if (member.online) nodeIds.add(member.id);
        } else if (!nodeId.isEmpty()) {
            nodeIds.add(nodeId);
        }
        if (machine == null && nodeIds.isEmpty()) {
            header("任务", "先选择一台设备", null);
            empty("还没有选择设备", "在「设备」里打开一台电脑，再查看它排队的任务。");
            return;
        }
        header("任务", title + " · 最近任务", ui.iconButton("⟳", v -> loadJobs()));
        if (nodeIds.isEmpty()) {
            empty("电脑离线", "这台电脑恢复连接后，排队的任务会重新出现在这里。");
            return;
        }
        empty("正在加载", "读取任务队列。");
        runIo(() -> {
            JSONArray jobs = fetchJobs(nodeIds);
            postResult(() -> renderJobs(jobs));
        });
    }

    private JSONArray fetchJobs(List<String> nodeIds) {
        Map<String, JSONObject> byId = new LinkedHashMap<>();
        for (String node : nodeIds) {
            try {
                JSONArray jobs = api.jobs(node);
                for (int i = 0; i < jobs.length(); i++) {
                    JSONObject job = jobs.optJSONObject(i);
                    if (job == null) continue;
                    String id = job.optString("id");
                    if (id.isEmpty()) continue;
                    byId.put(id, job);
                    jobOwner.put(id, node);
                }
            } catch (Exception ignored) {
                // One quiet instance must not hide another instance's queue.
            }
        }
        List<JSONObject> list = new ArrayList<>(byId.values());
        Collections.sort(list, (left, right) -> Long.compare(right.optLong("created_at"), left.optLong("created_at")));
        return new JSONArray(list);
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
        // A job lives on the registration that accepted it, which may not be
        // the workspace currently open.
        String owner = jobOwner.get(id);
        if (owner != null && !owner.isEmpty()) nodeId = owner;
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
        cancelButton = ui.outlineButton("取消任务", v -> cancelJob());
        cancelButton.setVisibility(View.GONE);
        stream.addView(cancelButton);
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
                    stream.addView(cancelButton);
                    stream.addView(card);
                    // A job screen opens on the newest line, not on the history.
                    followTail();
                });
            } catch (Exception ignored) {
                // Stream remains available even if historical session loading fails.
            }
        });
        pollJob(token, id, 0, liveBuffer, status, progress, output);
    }

    private void pollJob(int token, String id, long since, StringBuilder buffer,
                         TextView status, TextView progress, TextView output) {
        if (token != pollToken || isDestroyed() || background || !liveRunning) return;
        final String pollingNode = nodeId;
        runIo(() -> {
            try {
                JSONObject job = api.job(pollingNode, id);
                JSONObject events = api.stream(pollingNode, id, since);
                JSONArray approvals = api.approvals(pollingNode);
                JSONArray questions = api.questions(pollingNode);
                JSONArray list = events.optJSONArray("events");
                String statusText = statusLabel(job.optString("status"));
                int percent = (int) Math.round(job.optDouble("progress", 0));
                // `events.complete` only reports that the replay buffer still covered
                // `since`; it is true on every first poll. Treating it as "the job
                // finished" froze the screen on 执行中 0% while the computer worked on.
                boolean complete = job.optString("status").matches("done|failed|cancelled|paused");
                String result = job.optString("result", "");
                String errorText = job.optString("error", "");
                String finishedSession = job.optString("session_id", "");
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
                postResult(() -> {
                    if (token != pollToken || background) return;
                    boolean following = nearBottom();
                    liveSince = events.optLong("next", since);
                    renderInteractions(id, approvals, questions);
                    String jobStatus = job.optString("status");
                    resumeButton.setVisibility(jobStatus.matches("failed|paused") ? View.VISIBLE : View.GONE);
                    if (cancelButton != null) {
                        cancelButton.setVisibility(jobStatus.matches("queued|pending|working") ? View.VISIBLE : View.GONE);
                    }
                    status.setText(statusText);
                    progress.setText(percent + "%  ·  " + relative(job.optLong("created_at")));
                    // The header is visible even when the transcript is long.
                    if (headerSubtitle != null) {
                        headerSubtitle.setText(Ui.join(" · ", nodeName, statusText, percent + "%"));
                    }
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
                    } else if (following) {
                        scroll.post(() -> {
                            if (token == pollToken && !background) scroll.fullScroll(View.FOCUS_DOWN);
                        });
                    }
                });
            } catch (Exception error) {
                postResult(() -> {
                    if (token != pollToken || background) return;
                    status.setText("连接中断，正在重连；电脑端任务不会因此取消");
                    progress.setText(messageOf(error));
                });
            } finally {
                // Re-arm in `finally` so a slow, failed or dropped answer cannot end
                // the loop; the guard above stops it once the job has finished.
                main.postDelayed(() -> pollJob(token, id, liveSince, buffer, status, progress, output), 1200);
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

    /** Stop a running task; the computer keeps the transcript either way. */
    private void cancelJob() {
        final String id = jobId, node = nodeId;
        if (id.isEmpty()) return;
        new AlertDialog.Builder(this)
                .setTitle("取消这个任务？")
                .setMessage("电脑端会立即停止执行，已经写下的内容会保留在会话里。")
                .setPositiveButton("取消任务", (dialog, which) -> {
                    if (cancelButton != null) cancelButton.setEnabled(false);
                    final Api client = new Api(api.base(), api.cookie());
                    mutate(() -> client.cancel(node, id), () -> {
                        if (cancelButton != null) cancelButton.setEnabled(true);
                        interactionSignature = "";
                        toast("已请求取消");
                    });
                })
                .setNegativeButton("继续执行", null)
                .show();
    }

    /**
     * Pending prompts, with the same choices the web client offers.
     *
     * Everything here is a one-tap decision: an approval that only says
     * "allow this once" forces the phone user to sit through every call, and a
     * question whose options are printed as JSON is not answerable at all.
     */
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
            boolean onceOnly = item.optBoolean("once_only", false);
            String risk = item.optString("risk", "");
            String description = item.optString("description", "");
            String args = item.optString("args", "");
            LinearLayout card = ui.card();
            card.addView(ui.body("等待授权 · " + item.optString("tool"), theme.text));
            if (!risk.isEmpty()) card.addView(ui.note("风险：" + risk));
            if (!description.isEmpty() && !description.equals(item.optString("tool"))) {
                card.addView(ui.note(description));
            }
            if (!args.isEmpty()) card.addView(ui.note(Ui.ellipsize(args, 320)));
            LinearLayout allow = ui.row();
            allow.setPadding(0, ui.dp(10), 0, 0);
            allow.addView(ui.outlineButton("允许本次", v -> {
                card.setVisibility(View.GONE);
                mutate(() -> client.decide(node, prompt, "once"), () -> interactionSignature = "");
            }), new LinearLayout.LayoutParams(0, -2, 1f));
            LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(0, -2, 1f);
            gap.leftMargin = ui.dp(8);
            allow.addView(ui.outlineButton("拒绝", v -> {
                card.setVisibility(View.GONE);
                mutate(() -> client.decide(node, prompt, "deny"), () -> interactionSignature = "");
            }), gap);
            card.addView(allow);
            if (!onceOnly) {
                // "本会话" and "这个工具" are the two answers that stop the
                // card from coming back on the very next call.
                LinearLayout remember = ui.row();
                remember.setPadding(0, ui.dp(8), 0, 0);
                remember.addView(ui.pill("本会话都允许", theme.accent, theme.accentSoft), new LinearLayout.LayoutParams(-2, -2));
                remember.setOnClickListener(v -> {
                    card.setVisibility(View.GONE);
                    mutate(() -> client.decide(node, prompt, "always"), () -> interactionSignature = "");
                });
                LinearLayout.LayoutParams toolGap = new LinearLayout.LayoutParams(-2, -2);
                toolGap.leftMargin = ui.dp(8);
                TextView toolPill = ui.pill("这个工具都允许", theme.accent, theme.accentSoft);
                toolPill.setOnClickListener(v -> {
                    card.setVisibility(View.GONE);
                    mutate(() -> client.decide(node, prompt, "tool"), () -> interactionSignature = "");
                });
                remember.addView(toolPill, toolGap);
                card.addView(remember);
            }
            interactions.addView(card);
        }
        for (int i = 0; i < questions.length(); i++) {
            JSONObject item = questions.optJSONObject(i);
            if (item == null || !id.equals(item.optString("job_id"))) continue;
            final String prompt = item.optString("id"), node = nodeId;
            final Api client = new Api(api.base(), api.cookie());
            final String key = "answer:" + prompt;
            LinearLayout card = ui.card();
            card.addView(ui.body("等待回答 · " + item.optString("question"), theme.text));
            JSONArray choices = item.optJSONArray("options");
            if (choices != null) for (int c = 0; c < choices.length(); c++) {
                JSONObject choice = choices.optJSONObject(c);
                if (choice == null) continue;
                String label = choice.optString("label", "");
                if (label.isEmpty()) continue;
                String description = choice.optString("description", "");
                TextView option = ui.outlineButton(description.isEmpty() ? label : label + " · " + Ui.ellipsize(description, 60),
                        v -> {
                            card.setVisibility(View.GONE);
                            mutate(() -> client.answer(node, prompt, label), () -> {
                                prefs.edit().remove(key).apply();
                                interactionSignature = "";
                            });
                        });
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
                params.topMargin = ui.dp(6);
                card.addView(option, params);
            }
            EditText answer = new EditText(this);
            answer.setHint("或者直接输入回答");
            answer.setHintTextColor(theme.dim);
            answer.setTextColor(theme.text);
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
        Machine machine = currentMachine();
        if (machine != null && !machine.online) {
            toast("电脑离线，恢复连接后可以继续派活");
            return;
        }
        // A workspace is served by its own registration; route there, not to
        // whichever instance happened to answer the device list.
        if (machine != null && !project.isEmpty()) nodeId = machine.servingNode(project);
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

        content.addView(modelCard());

        LinearLayout account = ui.card();
        account.addView(ui.label("账户"));
        account.addView(keyValue("邮箱", email.isEmpty() ? "—" : email));
        account.addView(keyValue("中继", api.base()));
        account.addView(keyValue("设备", machines.size() + " 台电脑"));
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

    /**
     * The model card mirrors the desktop/web selector: which model the computer
     * is on, and — for models that support it — the reasoning effort. Jobs
     * snapshot the model when they start, so switching here only affects the
     * next task.
     */
    private LinearLayout modelCard() {
        LinearLayout card = ui.card();
        card.addView(ui.label("模型"));
        LinearLayout body = ui.column();
        card.addView(body);
        Machine machine = currentMachine();
        if (machine == null) {
            body.addView(ui.note("还没有选择电脑。"));
            return card;
        }
        RelayNode owner = null;
        for (RelayNode member : machine.members) if (member.online) { owner = member; break; }
        if (owner == null) {
            body.addView(ui.note(machine.name + " 离线，恢复连接后才能切换模型。"));
            return card;
        }
        final String node = owner.id;
        body.addView(ui.note("读取中…"));
        runIo(() -> {
            try {
                JSONObject info = api.nodeInfo(node);
                postResult(() -> renderModel(body, node, info));
            } catch (Exception error) {
                postResult(() -> {
                    Ui.clear(body);
                    body.addView(ui.note("读取失败：" + messageOf(error)));
                });
            }
        });
        return card;
    }

    private void renderModel(LinearLayout body, String node, JSONObject info) {
        Ui.clear(body);
        String name = info.optString("model", info.optString("model_id", ""));
        String effort = info.isNull("reasoning_effort") ? "" : info.optString("reasoning_effort", "");
        String provider = info.optString("provider", "");
        body.addView(keyValue("当前", name + (effort.isEmpty() ? "" : " · " + effort)));
        if (!provider.isEmpty()) body.addView(keyValue("提供方", provider));
        final JSONArray models = info.optJSONArray("models");
        if (models == null || models.length() == 0) {
            body.addView(ui.note("这台电脑没有可切换的模型。"));
            return;
        }
        TextView change = ui.outlineButton("切换模型", v ->
                chooseModel(node, models, info.optString("model_id", ""), this::showSettings));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = ui.dp(10);
        body.addView(change, params);
    }

    private void chooseModel(String node, JSONArray models, String currentId, Runnable done) {
        final String[] labels = new String[models.length()];
        for (int i = 0; i < models.length(); i++) {
            JSONObject item = models.optJSONObject(i);
            if (item == null) { labels[i] = "—"; continue; }
            String label = item.optString("name", item.optString("id", "—"));
            if (item.optString("id").equals(currentId)) label = label + "（当前）";
            labels[i] = label;
        }
        new AlertDialog.Builder(this).setTitle("选择模型").setItems(labels, (dialog, which) -> {
            JSONObject item = models.optJSONObject(which);
            if (item == null) return;
            final String id = item.optString("id");
            JSONArray efforts = item.optJSONArray("reasoning_efforts");
            if (efforts == null || efforts.length() == 0) { switchModel(node, id, null, done); return; }
            String[] effortLabels = new String[efforts.length() + 1];
            effortLabels[0] = "默认";
            for (int i = 0; i < efforts.length(); i++) effortLabels[i + 1] = efforts.optString(i);
            new AlertDialog.Builder(this).setTitle("推理强度")
                    .setItems(effortLabels, (inner, choice) ->
                            switchModel(node, id, choice == 0 ? null : effortLabels[choice], done))
                    .setNegativeButton("取消", null).show();
        }).setNegativeButton("取消", null).show();
    }

    private void switchModel(String node, String id, String effort, Runnable done) {
        final Api client = new Api(api.base(), api.cookie());
        mutate(() -> client.setModel(node, id, effort), () -> {
            toast("已切换模型，下一个任务生效");
            if (done != null) done.run();
        });
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
