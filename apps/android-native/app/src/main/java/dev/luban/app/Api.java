package dev.luban.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Thin REST client for the luban relay.
 *
 * The relay authenticates a phone with the `luban_account` cookie and then
 * forwards every `/api/*` call to one enrolled node; `?node=` picks the node.
 * That is exactly what the web console does, so the native app speaks the same
 * language instead of needing a second protocol on the server.
 */
final class Api {
    static final class Failure extends IOException {
        final int status;
        Failure(int status, String message) {
            super(message);
            this.status = status;
        }

        boolean needsLogin() { return status == 401; }
    }

    private String base;
    private String cookie;

    Api(String base, String cookie) {
        this.base = normalize(base);
        this.cookie = cookie == null ? "" : cookie;
    }

    static String normalize(String value) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) return "";
        if (!text.startsWith("http://") && !text.startsWith("https://")) text = "https://" + text;
        while (text.endsWith("/")) text = text.substring(0, text.length() - 1);
        return text;
    }

    String base() { return base; }
    void base(String value) { base = normalize(value); }
    String cookie() { return cookie; }
    void cookie(String value) { cookie = value == null ? "" : value; }

    static String enc(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            return value;
        }
    }

    private static String scoped(String path, String node) {
        if (node == null || node.isEmpty()) return path;
        return path + (path.contains("?") ? "&" : "?") + "node=" + enc(node);
    }

    JSONObject get(String path) throws IOException, JSONException {
        return call("GET", path, null);
    }

    JSONObject get(String path, String node) throws IOException, JSONException {
        return call("GET", scoped(path, node), null);
    }

    /**
     * `/api/jobs`, `/api/sessions` and `/api/approvals` answer with a bare
     * JSON array instead of the `{ok: true, ...}` envelope.
     */
    JSONArray getArray(String path, String node) throws IOException, JSONException {
        return array("GET", scoped(path, node), null);
    }

    JSONObject post(String path, JSONObject body) throws IOException, JSONException {
        return call("POST", path, body);
    }

    JSONObject post(String path, String node, JSONObject body) throws IOException, JSONException {
        return call("POST", scoped(path, node), body);
    }

    private JSONObject call(String method, String path, JSONObject body) throws IOException, JSONException {
        Object parsed = request(method, path, body);
        if (parsed instanceof JSONArray) return new JSONObject().put("ok", true).put("data", parsed);
        JSONObject json = (JSONObject) parsed;
        if (json.has("ok") && !json.optBoolean("ok")) {
            throw new Failure(json.optInt("status", 400), json.optString("error", "请求失败"));
        }
        return json;
    }

    private JSONArray array(String method, String path, JSONObject body) throws IOException, JSONException {
        Object parsed = request(method, path, body);
        if (parsed instanceof JSONArray) return (JSONArray) parsed;
        JSONObject json = (JSONObject) parsed;
        if (json.has("ok") && !json.optBoolean("ok")) {
            throw new Failure(json.optInt("status", 400), json.optString("error", "请求失败"));
        }
        return new JSONArray();
    }

    private Object request(String method, String path, JSONObject body) throws IOException, JSONException {
        if (base.isEmpty()) throw new Failure(0, "请先填写中继地址");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(12000);
            // A long session transcript can be hundreds of kilobytes and the
            // relay adds a round trip; 20s used to time out on real accounts.
            connection.setReadTimeout(45000);
            connection.setRequestProperty("accept", "application/json");
            if (!cookie.isEmpty()) connection.setRequestProperty("cookie", cookie);
            if (body != null) {
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("content-type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(payload);
                }
            }
            int status = connection.getResponseCode();
            captureCookie(connection.getHeaderFields());
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : read(stream);
            Object parsed;
            try {
                parsed = text.isEmpty() ? new JSONObject() : new JSONTokener(text).nextValue();
            } catch (JSONException malformed) {
                parsed = new JSONObject().put("ok", false).put("status", status)
                        .put("error", text.length() > 300 ? text.substring(0, 300) : text);
            }
            String failure = parsed instanceof JSONObject ? ((JSONObject) parsed).optString("error", "") : "";
            if (status >= 400) {
                throw new Failure(status, failure.isEmpty() ? "HTTP " + status : failure);
            }
            return parsed;
        } finally {
            connection.disconnect();
        }
    }

    private void captureCookie(Map<String, List<String>> headers) {
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() == null || !entry.getKey().equalsIgnoreCase("set-cookie")) continue;
            for (String raw : entry.getValue()) {
                int at = raw.indexOf("luban_account=");
                if (at < 0) continue;
                int end = raw.indexOf(';', at);
                cookie = end < 0 ? raw.substring(at) : raw.substring(at, end);
            }
        }
    }

    private static String read(InputStream stream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int size;
        while ((size = stream.read(chunk)) > 0) buffer.write(chunk, 0, size);
        return buffer.toString("UTF-8");
    }

    // ------------------------------------------------------------------ api

    JSONObject login(String email, String password) throws IOException, JSONException {
        JSONObject body = new JSONObject().put("email", email).put("password", password);
        return post("/api/auth/login", body);
    }

    JSONObject me() throws IOException, JSONException { return get("/api/auth/me"); }

    JSONObject logout() throws IOException, JSONException { return post("/api/auth/logout", new JSONObject()); }

    JSONArray nodes() throws IOException, JSONException {
        return get("/relay/nodes").optJSONArray("nodes");
    }

    JSONObject nodeInfo(String node) throws IOException, JSONException {
        return get("/api/node", node);
    }

    JSONObject addProject(String node, String value, boolean existing) throws IOException, JSONException {
        JSONObject body = new JSONObject();
        if (existing) body.put("path", value); else body.put("name", value);
        return post("/api/projects", node, body);
    }

    JSONArray sessions(String node, String project, int limit) throws IOException, JSONException {
        String path = "/api/sessions?limit=" + limit + "&project=" + enc(project == null ? "" : project);
        return getArray(path, node);
    }

    JSONObject session(String node, String project, String id) throws IOException, JSONException {
        return get("/api/sessions/" + enc(id) + "?project=" + enc(project == null ? "" : project), node);
    }

    JSONArray jobs(String node) throws IOException, JSONException {
        return getArray("/api/jobs", node);
    }

    JSONObject job(String node, String id) throws IOException, JSONException {
        return get("/api/jobs/" + enc(id), node);
    }

    JSONObject stream(String node, String id, long since) throws IOException, JSONException {
        return get("/api/jobs/" + enc(id) + "/stream?since=" + since, node);
    }

    JSONObject submit(String node, String instruction, String project, String mode, String sessionId)
            throws IOException, JSONException {
        JSONObject body = new JSONObject()
                .put("instruction", instruction)
                .put("project_id", project == null ? "" : project)
                .put("mode", mode)
                .put("interaction", "on");
        if (sessionId != null && !sessionId.isEmpty()) body.put("session_id", sessionId);
        return post("/api/jobs", node, body);
    }

    JSONObject cancel(String node, String id) throws IOException, JSONException {
        return post("/api/jobs/" + enc(id) + "/cancel", node, new JSONObject());
    }

    JSONObject resume(String node, String id) throws IOException, JSONException {
        return post("/api/jobs/" + enc(id) + "/resume", node, new JSONObject());
    }

    JSONArray approvals(String node) throws IOException, JSONException {
        return getArray("/api/approvals", node);
    }

    JSONObject decide(String node, String id, String decision) throws IOException, JSONException {
        return post("/api/approvals", node, new JSONObject().put("id", id).put("decision", decision));
    }

    JSONArray questions(String node) throws IOException, JSONException {
        return getArray("/api/questions", node);
    }

    /**
     * Remove one computer from the account.
     *
     * The relay drops every registration it owns; device tokens are revoked by
     * the same call, so a phone that removes a stale laptop is not just
     * hiding it.
     */
    JSONObject deleteDevice(String deviceId) throws IOException, JSONException {
        return call("DELETE", "/api/account/devices/" + enc(deviceId), null);
    }

    /** Delete a saved session; the relay answers 409 while a job still owns it. */
    JSONObject deleteSession(String node, String project, String id) throws IOException, JSONException {
        return post("/api/sessions/" + enc(id) + "/delete?project=" + enc(project), node, new JSONObject());
    }

    /** Switch the model (and reasoning effort) used for the next task. */
    JSONObject setModel(String node, String id, String effort) throws IOException, JSONException {
        JSONObject body = new JSONObject().put("model", id);
        // An explicit null is "this model's default"; omitting it would keep the old effort.
        body.put("reasoning_effort", effort == null ? JSONObject.NULL : effort);
        return post("/api/model", node, body);
    }

    JSONObject answer(String node, String id, String answer) throws IOException, JSONException {
        return post("/api/questions", node, new JSONObject().put("id", id).put("answer", answer));
    }
}
