package dev.luban.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * One relay registration: a luban process serving one workspace.
 *
 * The relay hands the phone a flat list (`/relay/nodes`), and since `luban
 * daemon` each workspace can hold its own connection, so a single computer
 * shows up as several registrations that share a machine id. {@link Machine}
 * groups them; this class is only the parsed snapshot of one registration,
 * including the status the relay remembered while the computer was offline.
 */
final class RelayNode {
    static final class Job {
        String id = "";
        String title = "";
        String instruction = "";
        String status = "";
        String sessionId = "";
        double progress;
        long updatedAt;
    }

    /** A terminal session the node is writing to right now. */
    static final class LiveSession {
        String id = "";
        String project = "";
        String title = "";
        long updatedAt;
    }

    static final class Status {
        long updatedAt;
        String model = "";
        final List<Job> jobs = new ArrayList<>();
        final List<LiveSession> sessions = new ArrayList<>();

        boolean isEmpty() {
            return updatedAt == 0 && jobs.isEmpty() && sessions.isEmpty() && model.isEmpty();
        }
    }

    String id = "";
    String deviceId = "";
    String name = "luban";
    String version = "";
    String workspace = "";
    boolean online;
    long lastSeen;
    final LinkedHashMap<String, String> projects = new LinkedHashMap<>();
    final Status status = new Status();

    static List<RelayNode> parseAll(JSONArray array) {
        List<RelayNode> nodes = new ArrayList<>();
        if (array == null) return nodes;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) nodes.add(parse(item));
        }
        return nodes;
    }

    static RelayNode parse(JSONObject json) {
        RelayNode node = new RelayNode();
        node.id = json.optString("id", "");
        node.deviceId = json.optString("device_id", "");
        node.name = json.optString("name", "luban");
        node.version = json.optString("version", "");
        node.workspace = json.optString("workspace", "");
        node.online = json.optBoolean("online", false);
        node.lastSeen = json.optLong("last_seen", 0);
        JSONObject projects = json.optJSONObject("projects");
        if (projects != null) {
            Iterator<String> keys = projects.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String path = projects.optString(key, "");
                if (!path.isEmpty()) node.projects.put(key, path);
            }
        }
        JSONObject status = json.optJSONObject("status");
        if (status != null) {
            node.status.updatedAt = status.optLong("updated_at", 0);
            node.status.model = status.optString("model", "");
            JSONArray jobs = status.optJSONArray("jobs");
            if (jobs != null) for (int i = 0; i < jobs.length(); i++) {
                JSONObject item = jobs.optJSONObject(i);
                if (item == null) continue;
                Job job = new Job();
                job.id = item.optString("id", "");
                job.title = item.optString("title", "");
                job.instruction = item.optString("instruction", "");
                job.status = item.optString("status", "");
                job.sessionId = item.optString("session_id", "");
                job.progress = item.optDouble("progress", 0);
                job.updatedAt = item.optLong("updated_at", 0);
                node.status.jobs.add(job);
            }
            JSONArray sessions = status.optJSONArray("sessions");
            if (sessions != null) for (int i = 0; i < sessions.length(); i++) {
                JSONObject item = sessions.optJSONObject(i);
                if (item == null) continue;
                LiveSession session = new LiveSession();
                session.id = item.optString("id", "");
                session.project = item.optString("project", "");
                session.title = item.optString("title", "");
                session.updatedAt = item.optLong("updated_at", 0);
                node.status.sessions.add(session);
            }
        }
        return node;
    }

    /**
     * A compact copy for the offline cache.
     *
     * Personal `SharedPreferences` are not a database: keep the identity, the
     * workspace table and the newest few status rows so a phone that starts
     * with no network still shows where it can continue later.
     */
    JSONObject toCache() {
        JSONObject json = new JSONObject();
        try {
            json.put("id", id);
            json.put("device_id", deviceId);
            json.put("name", name);
            json.put("version", version);
            json.put("workspace", workspace);
            json.put("online", false);
            json.put("last_seen", lastSeen);
            JSONObject table = new JSONObject();
            for (LinkedHashMap.Entry<String, String> entry : projects.entrySet()) {
                table.put(entry.getKey(), entry.getValue());
            }
            json.put("projects", table);
            JSONObject summary = new JSONObject();
            summary.put("updated_at", status.updatedAt);
            summary.put("model", status.model);
            JSONArray jobs = new JSONArray();
            for (int i = 0; i < Math.min(status.jobs.size(), 6); i++) {
                Job job = status.jobs.get(i);
                jobs.put(new JSONObject().put("id", job.id).put("title", job.title)
                        .put("instruction", job.instruction).put("status", job.status)
                        .put("progress", job.progress).put("updated_at", job.updatedAt)
                        .put("session_id", job.sessionId));
            }
            JSONArray sessions = new JSONArray();
            for (int i = 0; i < Math.min(status.sessions.size(), 40); i++) {
                LiveSession session = status.sessions.get(i);
                sessions.put(new JSONObject().put("id", session.id).put("project", session.project)
                        .put("title", session.title).put("updated_at", session.updatedAt));
            }
            summary.put("jobs", jobs);
            summary.put("sessions", sessions);
            json.put("status", summary);
        } catch (Exception ignored) {
            // A cache entry that cannot be written is simply not cached.
        }
        return json;
    }
}
