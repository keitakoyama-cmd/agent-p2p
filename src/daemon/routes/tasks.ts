import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";
import type { TrackedTask } from "../../lib/task/manager";
import type { Plan } from "../../lib/task/planner";
import type { AgentId, TaskStatus } from "../../types/protocol";

export async function handleTasks(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, taskManager, planner } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "POST" && path === "/task/request") {
    const body = JSON.parse(await readBody(req));
    const targetId = body.target_agent_id as AgentId;
    const perm = taskManager.checkPermission(targetId, "task", "request");
    if (!perm.allowed) { json(res, 403, { error: "Not permitted to request tasks from this peer" }); return true; }

    const task = taskManager.createTask(targetId, {
      type: body.type || "generic",
      description: body.description || "",
      input: body.input || {},
      timeout_ms: body.timeout_ms,
      priority: body.priority,
    });

    const sent = agent.getSwarm().sendTaskMessage(targetId, "task_request", task.request);
    if (!sent) { json(res, 422, { error: "Peer not connected", task }); return true; }

    json(res, 200, { task, needs_approval: perm.needsApproval });
    return true;
  }

  if (req.method === "GET" && path === "/task/list") {
    const status = url.searchParams.get("status") as TaskStatus | null;
    json(res, 200, { tasks: taskManager.listTasks(status ?? undefined) });
    return true;
  }

  if (req.method === "GET" && path.startsWith("/task/") && path.split("/").length === 3) {
    const taskId = path.split("/")[2];
    const task = taskManager.getTask(taskId);
    json(res, task ? 200 : 404, task || { error: "Task not found" });
    return true;
  }

  if (req.method === "POST" && path === "/task/respond") {
    const body = JSON.parse(await readBody(req));
    const { task_id, action } = body; // action: accept | reject | complete | fail | cancel
    const task = taskManager.getTask(task_id);
    if (!task) { json(res, 404, { error: "Task not found" }); return true; }

    if (action === "accept") {
      taskManager.updateTaskStatus(task_id, "accepted");
      agent.getSwarm().sendTaskMessage(task.from, "task_accept", { task_id });
    } else if (action === "reject") {
      taskManager.updateTaskStatus(task_id, "cancelled");
      agent.getSwarm().sendTaskMessage(task.from, "task_reject", { task_id, reason: body.reason || "" });
    } else if (action === "complete") {
      const result = { task_id, status: "completed" as const, output: body.output || {}, duration_ms: Date.now() - task.created_at };
      taskManager.updateTaskStatus(task_id, "completed", result);
      agent.getSwarm().sendTaskMessage(task.from, "task_result", result);
    } else if (action === "fail") {
      taskManager.updateTaskStatus(task_id, "failed");
      agent.getSwarm().sendTaskMessage(task.from, "task_error", { task_id, error_code: "TASK_FAILED", message: body.error || "Failed", retryable: body.retryable ?? false });
    } else if (action === "cancel") {
      taskManager.updateTaskStatus(task_id, "cancelled");
      agent.getSwarm().sendTaskMessage(task.to === agent.getAgentInfo().agent_id ? task.from : task.to, "task_cancel", { task_id, reason: body.reason });
    }
    json(res, 200, taskManager.getTask(task_id));
    return true;
  }

  // --- Task Queue routes ---

  if (req.method === "POST" && path === "/queue/enqueue") {
    const body = JSON.parse(await readBody(req));
    const task = taskManager.enqueue({
      type: body.type || "generic",
      description: body.description || "",
      input: body.input || {},
      timeout_ms: body.timeout_ms,
      priority: body.priority,
    }, body.assign_to);
    json(res, 200, task);
    return true;
  }

  if (req.method === "GET" && path === "/queue") {
    json(res, 200, { length: taskManager.queueLength(), tasks: taskManager.listTasks("pending") });
    return true;
  }

  if (req.method === "POST" && path === "/queue/dequeue") {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const task = taskManager.dequeue(agent.getAgentInfo().agent_id, parsed.capabilities);
    json(res, task ? 200 : 204, task || { message: "No tasks available" });
    return true;
  }

  if (req.method === "POST" && path === "/worker/start") {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const intervalMs = parsed.interval_ms || 30000;
    const targetPeers = taskManager.listPeers().map(p => p.agent_id);

    taskManager.startWorker(
      intervalMs,
      async () => {
        // Poll all connected peers for tasks
        for (const peerId of targetPeers) {
          agent.getSwarm().sendTaskMessage(peerId, "task_poll", {
            capabilities: taskManager.buildHeartbeat().capabilities,
          });
        }
        // Wait a bit for response
        return new Promise<TrackedTask | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000);
          taskManager.once("worker:task_received", ({ task }: { task: TrackedTask }) => {
            clearTimeout(timer);
            resolve(task);
          });
        });
      },
      async (task) => {
        // Emit event for external handler (MCP server / Claude Code)
        taskManager.emit("worker:execute", task);
        // Default: return success with empty output
        // Real execution would be handled by the task handler
        return { output: { message: "Task received, awaiting external execution" } };
      }
    );
    json(res, 200, { status: "worker started", interval_ms: intervalMs, polling_peers: targetPeers });
    return true;
  }

  if (req.method === "POST" && path === "/worker/stop") {
    taskManager.stopWorker();
    json(res, 200, { status: "worker stopped" });
    return true;
  }

  // --- Plan routes ---

  if (req.method === "POST" && path === "/plan/load") {
    const body = JSON.parse(await readBody(req)) as Plan;
    const state = planner.loadPlan(body);
    json(res, 200, state);
    return true;
  }

  if (req.method === "POST" && path.match(/^\/plan\/([^/]+)\/start$/)) {
    const planId = path.split("/")[2];
    try {
      planner.start(planId);
      json(res, 200, planner.getPlan(planId));
    } catch (e) {
      json(res, 404, { error: (e as Error).message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/plan/list") {
    json(res, 200, { plans: planner.listPlans() });
    return true;
  }

  if (req.method === "GET" && path.match(/^\/plan\/([^/]+)$/)) {
    const planId = path.split("/")[2];
    const state = planner.getPlan(planId);
    json(res, state ? 200 : 404, state || { error: "Plan not found" });
    return true;
  }

  return false;
}
