package dev.luban.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.TreeSet;

/**
 * One physical computer on the phone: every per-workspace relay registration
 * that shares its machine id.
 *
 * The relay identifies a registration by `dev-<machine>-<workspace digest>`,
 * so "my laptop" is one card with several workspaces rather than several
 * laptops. Each workspace keeps the node id that actually serves it, because
 * that is what a phone has to route a task to.
 */
final class Machine {
    static final class Route {
        final String project;
        final String path;
        final String nodeId;

        Route(String project, String path, String nodeId) {
            this.project = project;
            this.path = path;
            this.nodeId = nodeId;
        }
    }

    final String id;
    final String name;
    final List<RelayNode> members;
    final boolean online;
    /** Newest job across the live instances, or across the snapshot if offline. */
    final RelayNode.Job latestJob;
    /** Terminal sessions the computer is writing to right now. */
    final List<RelayNode.LiveSession> runningSessions;
    final String model;
    final int activeJobs;
    final List<Route> routes;

    private Machine(String id, String name, List<RelayNode> members, boolean online,
                    RelayNode.Job latestJob, List<RelayNode.LiveSession> runningSessions,
                    String model, int activeJobs, List<Route> routes) {
        this.id = id;
        this.name = name;
        this.members = members;
        this.online = online;
        this.latestJob = latestJob;
        this.runningSessions = runningSessions;
        this.model = model;
        this.activeJobs = activeJobs;
        this.routes = routes;
    }

    /** What the card leads with, mirroring the web client's device card. */
    String subtitle() {
        if (runningSessions.size() > 0) return "正在工作";
        RelayNode.Job job = latestJob;
        if (job == null) return online ? "空闲，等待派活" : "离线，状态已停止更新";
        String head = job.title.isEmpty() ? job.instruction : job.title;
        return head == null ? "" : head;
    }

    Route routeFor(String project) {
        for (Route route : routes) if (route.project.equals(project)) return route;
        return null;
    }

    /**
     * The registration that should serve a workspace right now.
     *
     * Instances of one computer share `~/.luban`, so the project table is the
     * same and any live instance can open any of this machine's workspaces.
     * That is what makes a workspace reachable while the daemon is listening,
     * whichever registration the relay happens to list first: prefer the owner,
     * then fall back to a live sibling, and only then to an offline owner.
     */
    String servingNode(String project) {
        Route route = routeFor(project);
        String owner = route == null ? "" : route.nodeId;
        for (RelayNode member : members) if (member.online && member.id.equals(owner)) return owner;
        for (RelayNode member : members) if (member.online) return member.id;
        return owner.isEmpty() ? representative().id : owner;
    }

    String pathOf(String project) {
        Route route = routeFor(project);
        return route == null ? "" : route.path;
    }

    /** The registration a whole-machine request goes to: any live one first. */
    RelayNode representative() {
        for (RelayNode member : members) if (member.online) return member;
        return members.get(0);
    }

    /** Stable physical id: `dev-<machine>-<16 hex>` is still one computer. */
    static String machineIdFor(String id, String deviceId) {
        String identity = deviceId == null || deviceId.isEmpty() ? id : deviceId;
        return identity == null ? "" : identity.replaceFirst("(?i)^(dev-[a-f0-9]{16,64})-[a-f0-9]{16}$", "$1");
    }

    static String hostLabel(String name) {
        int separator = name.lastIndexOf(" · ");
        return separator < 0 ? name : name.substring(0, separator);
    }

    /**
     * One label for a computer whose registrations carry per-instance names
     * (`my-mac`, `my-mac75764`): the shared prefix, or the first label when the
     * names have nothing in common.
     */
    static String machineLabel(List<RelayNode> members) {
        Set<String> labels = new LinkedHashSet<>();
        for (RelayNode member : members) {
            String label = hostLabel(member.name);
            if (!label.isEmpty()) labels.add(label);
        }
        if (labels.isEmpty()) return "luban";
        if (labels.size() == 1) return labels.iterator().next();
        List<String> ordered = new ArrayList<>(labels);
        String prefix = ordered.get(0);
        for (String label : ordered.subList(1, ordered.size())) {
            int length = 0;
            while (length < prefix.length() && length < label.length() && prefix.charAt(length) == label.charAt(length)) length++;
            prefix = prefix.substring(0, length);
        }
        prefix = prefix.replaceAll("[\\s._-]+$", "");
        return prefix.length() >= 4 ? prefix : ordered.get(0);
    }

    private static String normalizedPath(String path) {
        if (path == null) return "";
        String value = path.replace('\\', '/');
        while (value.endsWith("/") && value.length() > 1) value = value.substring(0, value.length() - 1);
        return value.matches("^[A-Za-z]:.*") ? value.toLowerCase() : value;
    }

    private static String folderName(String path) {
        String value = path == null ? "" : path.replace('\\', '/');
        while (value.endsWith("/") && value.length() > 1) value = value.substring(0, value.length() - 1);
        int slash = value.lastIndexOf('/');
        String name = slash < 0 ? value : value.substring(slash + 1);
        return name.isEmpty() ? value : name;
    }

    /**
     * Union the workspace tables of every instance.
     *
     * Two instances can advertise the same project (a restarted daemon still
     * remembers the old one). Prefer the instance whose own workspace *is* that
     * path, otherwise a live instance over an offline one, so a task lands on
     * the process that can actually open the directory.
     */
    static List<Route> routesFor(List<RelayNode> members) {
        Map<String, String> byProject = new LinkedHashMap<>();
        Map<String, String> ownerOf = new LinkedHashMap<>();
        for (RelayNode member : members) {
            for (Map.Entry<String, String> entry : member.projects.entrySet()) {
                String project = entry.getKey();
                String path = entry.getValue();
                if (project == null || project.isEmpty() || path.isEmpty()) continue;
                if (!byProject.containsKey(project)) {
                    byProject.put(project, path);
                    ownerOf.put(project, member.id);
                    continue;
                }
                String current = ownerOf.get(project);
                RelayNode owner = null;
                for (RelayNode candidate : members) if (candidate.id.equals(current)) owner = candidate;
                boolean ownsPath = normalizedPath(path).equals(normalizedPath(member.workspace));
                boolean ownerOwnsPath = owner != null && normalizedPath(byProject.get(project)).equals(normalizedPath(owner.workspace));
                if ((ownsPath && !ownerOwnsPath) || (member.online && (owner == null || !owner.online))) {
                    byProject.put(project, path);
                    ownerOf.put(project, member.id);
                }
            }
        }
        // Older relays omit the table even though the registration has a root.
        for (RelayNode member : members) {
            if (member.workspace.isEmpty()) continue;
            boolean covered = false;
            for (String path : byProject.values()) {
                if (normalizedPath(path).equals(normalizedPath(member.workspace))) { covered = true; break; }
            }
            if (covered) continue;
            String project = folderName(member.workspace);
            if (!byProject.containsKey(project)) {
                byProject.put(project, member.workspace);
                ownerOf.put(project, member.id);
            }
        }
        List<Route> routes = new ArrayList<>();
        for (Map.Entry<String, String> entry : byProject.entrySet()) {
            routes.add(new Route(entry.getKey(), entry.getValue(), ownerOf.get(entry.getKey())));
        }
        Collections.sort(routes, Comparator.comparing(route -> route.project));
        return routes;
    }

    static List<Machine> group(List<RelayNode> nodes) {
        Map<String, List<RelayNode>> groups = new LinkedHashMap<>();
        for (RelayNode node : nodes) {
            String key = machineIdFor(node.id, node.deviceId);
            List<RelayNode> members = groups.get(key);
            if (members == null) {
                members = new ArrayList<>();
                groups.put(key, members);
            }
            members.add(node);
        }
        List<Machine> machines = new ArrayList<>();
        for (Map.Entry<String, List<RelayNode>> entry : groups.entrySet()) {
            List<RelayNode> members = new ArrayList<>(entry.getValue());
            // Heartbeats must not reorder instance labels or change the route.
            Collections.sort(members, Comparator.comparing(member -> member.id));
            boolean online = false;
            for (RelayNode member : members) if (member.online) online = true;
            List<RelayNode> statusOwners = new ArrayList<>();
            for (RelayNode member : members) if (member.online) statusOwners.add(member);
            if (statusOwners.isEmpty()) statusOwners = members;
            RelayNode.Job latest = null;
            int active = 0;
            List<RelayNode.LiveSession> running = new ArrayList<>();
            Set<String> models = new TreeSet<>();
            Map<String, RelayNode.LiveSession> sessions = new LinkedHashMap<>();
            for (RelayNode member : statusOwners) {
                if (!member.status.model.isEmpty()) models.add(member.status.model);
                for (RelayNode.Job job : member.status.jobs) {
                    if (latest == null || job.updatedAt >= latest.updatedAt) latest = job;
                    if (job.status.matches("queued|pending|working")) active++;
                }
                if (member.online) for (RelayNode.LiveSession session : member.status.sessions) {
                    sessions.put(session.project + "\u0000" + session.id, session);
                }
            }
            running.addAll(sessions.values());
            Collections.sort(running, (left, right) -> Long.compare(right.updatedAt, left.updatedAt));
            machines.add(new Machine(entry.getKey(), machineLabel(members), members, online, latest, running,
                    models.size() == 1 ? models.iterator().next() : "", active, routesFor(members)));
        }
        Collections.sort(machines, Comparator.comparing(machine -> machine.id));
        return machines;
    }

    static Machine find(List<Machine> machines, String id) {
        for (Machine machine : machines) if (machine.id.equals(id)) return machine;
        return null;
    }
}
