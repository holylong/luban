package dev.luban.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

/**
 * The grouping/routing model behind the phone console.
 *
 * These cases pin the two things a phone actually depends on: one computer is
 * one card no matter how many workspaces it registers, and a workspace stays
 * reachable while any daemon on that computer is listening.
 */
public class MachineTest {
    private static final String DEVICE = "dev-aaaaaaaaaaaaaaaa";

    private static JSONObject node(String id, boolean online, String workspace, JSONObject projects) {
        try {
            return new JSONObject()
                    .put("id", id)
                    .put("device_id", DEVICE)
                    .put("name", "luban-a-" + id.substring(id.length() - 4))
                    .put("online", online)
                    .put("workspace", workspace)
                    .put("projects", projects);
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static JSONObject projects(String... pairs) {
        JSONObject table = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) table.put(pairs[i], pairs[i + 1]);
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
        return table;
    }

    private static Machine single(JSONObject... nodes) {
        JSONArray array = new JSONArray();
        for (JSONObject node : nodes) array.put(node);
        List<RelayNode> parsed = RelayNode.parseAll(array);
        assertEquals(nodes.length, parsed.size());
        List<Machine> machines = Machine.group(parsed);
        assertEquals(1, machines.size());
        return machines.get(0);
    }

    @Test
    public void groupsEveryRegistrationOfOneComputerIntoOneCard() {
        Machine machine = single(
                node("dev-aaaaaaaaaaaaaaaa-1111111111111111", true, "/work/alpha", projects("alpha", "/work/alpha")),
                node("dev-aaaaaaaaaaaaaaaa-2222222222222222", true, "/work/beta", projects("beta", "/work/beta")));

        assertEquals(DEVICE, machine.id);
        assertEquals(2, machine.members.size());
        assertEquals(2, machine.routes.size());
        assertEquals("/work/alpha", machine.pathOf("alpha"));
        assertEquals("/work/beta", machine.pathOf("beta"));
        assertTrue(machine.online);
    }

    /**
     * The daemon sharing `~/.luban` means a live sibling can open the same
     * workspace: an offline registration must not make its workspace unusable.
     */
    @Test
    public void routesAWorkspaceToALiveSiblingWhenItsOwnerIsOffline() {
        Machine machine = single(
                node("dev-aaaaaaaaaaaaaaaa-1111111111111111", false, "/work/alpha", projects("alpha", "/work/alpha")),
                node("dev-aaaaaaaaaaaaaaaa-2222222222222222", true, "/work/beta", projects("beta", "/work/beta")));

        Machine.Route alpha = machine.routeFor("alpha");
        assertNotNull(alpha);
        assertEquals("dev-aaaaaaaaaaaaaaaa-1111111111111111", alpha.nodeId);
        assertEquals("dev-aaaaaaaaaaaaaaaa-2222222222222222", machine.servingNode("alpha"));
        assertEquals("dev-aaaaaaaaaaaaaaaa-2222222222222222", machine.servingNode("beta"));
    }

    @Test
    public void prefersTheOwnerWhileItIsLive() {
        Machine machine = single(
                node("dev-aaaaaaaaaaaaaaaa-1111111111111111", true, "/work/alpha", projects("alpha", "/work/alpha")),
                node("dev-aaaaaaaaaaaaaaaa-2222222222222222", true, "/work/beta", projects("beta", "/work/beta")));

        assertEquals("dev-aaaaaaaaaaaaaaaa-1111111111111111", machine.servingNode("alpha"));
    }

    @Test
    public void keepsAnOfflineComputerUsableForItsCachedWorkspaces() {
        Machine machine = single(
                node("dev-aaaaaaaaaaaaaaaa-1111111111111111", false, "/work/alpha", projects("alpha", "/work/alpha")));

        assertEquals(false, machine.online);
        assertEquals("dev-aaaaaaaaaaaaaaaa-1111111111111111", machine.servingNode("alpha"));
        assertEquals("离线，状态已停止更新", machine.subtitle());
    }

    @Test
    public void aRestartedInstanceTakesOverTheSameWorkspace() {
        Machine machine = single(
                node("dev-aaaaaaaaaaaaaaaa-1111111111111111", false, "/work/alpha", projects("alpha", "/work/alpha")),
                node("dev-aaaaaaaaaaaaaaaa-2222222222222222", true, "/work/alpha", projects("alpha", "/work/alpha")));

        assertEquals("/work/alpha", machine.pathOf("alpha"));
        assertEquals("dev-aaaaaaaaaaaaaaaa-2222222222222222", machine.routeFor("alpha").nodeId);
    }

    @Test
    public void theShownPathIsAlwaysThePathOfTheNodeThatServesIt() {
        Machine machine = single(
                node("dev-aaaaaaaaaaaaaaaa-1111111111111111", false, "/work/alpha", projects("alpha", "/work/alpha")),
                node("dev-aaaaaaaaaaaaaaaa-2222222222222222", true, "/work/elsewhere", projects("alpha", "/work/elsewhere")));

        // Two instances disagree about the project's directory: only the live
        // one can answer, so its mapping is the one shown and opened -- never
        // the offline path in the label with a different tree behind it.
        Machine.Route route = machine.routeFor("alpha");
        assertEquals("dev-aaaaaaaaaaaaaaaa-2222222222222222", route.nodeId);
        assertEquals("/work/elsewhere", route.path);
        assertEquals(route.path, machine.pathOf("alpha"));
    }

    @Test
    public void reportsWorkingWhenaSiblingIsWritingASession() {
        JSONObject busy = node("dev-aaaaaaaaaaaaaaaa-2222222222222222", true, "/work/beta", projects("beta", "/work/beta"));
        try {
            busy.put("status", new JSONObject().put("updated_at", 1_700_000_000L).put("model", "deepseek-chat")
                    .put("sessions", new JSONArray().put(new JSONObject()
                            .put("id", "s-1").put("project", "beta").put("title", "重构").put("updated_at", 1_700_000_100L)))
                    .put("jobs", new JSONArray().put(new JSONObject()
                            .put("id", "job-1").put("title", "重构").put("status", "working").put("updated_at", 1_700_000_100L))));
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
        Machine machine = single(busy);
        assertEquals("正在工作", machine.subtitle());
        assertEquals(1, machine.runningSessions.size());
        assertEquals(1, machine.activeJobs);
        assertEquals("deepseek-chat", machine.model);
    }

    @Test
    public void derivesTheMachineIdFromEitherField() {
        assertEquals(DEVICE, Machine.machineIdFor(DEVICE + "-3333333333333333", DEVICE));
        assertEquals(DEVICE, Machine.machineIdFor(DEVICE + "-3333333333333333", ""));
        // A relay without the machine prefix keeps ids stable rather than guessing.
        assertEquals("dev-1111111111111111", Machine.machineIdFor("dev-1111111111111111", ""));
        assertNull(Machine.find(Machine.group(RelayNode.parseAll(new JSONArray())), DEVICE));
        assertEquals("luban", Machine.machineLabel(RelayNode.parseAll(new JSONArray())));
    }
}
