// Placement is a computer constraint, never a snapshot of whichever brain happened to be first at creation.
import { formatBrainRef, onMachine, parseBrainRef, sameBrain, workKind, type AgentDef, type Task } from "@piomio/shared";
import { skillOfGoal } from "./model-router.ts";

export function taskPlacement(task: Pick<Task, "machineId" | "brainRef">): string | undefined {
  // Older hubs saved the first configured brain as the placement. Its computer remains binding, its brain does not.
  return task.machineId ?? (task.brainRef ? parseBrainRef(task.brainRef).machineId : undefined);
}

export function taskBrains(refs: readonly string[], agent: AgentDef, task: Task, here: string, canonical: (id: string) => string = (id) => id): string[] {
  const machine = (id: string) => canonical(id === "local" ? here : id);
  const placed = taskPlacement(task);
  const at = placed === undefined ? undefined : machine(placed) === machine("local") ? "local" : canonical(placed);
  // A brain supplied to task_delegate means "must use this brain"; the agent's thinking.brain is a preference.
  const required = task.thinking?.brain;
  // Feed/schedule instructions can mention scripts without asking for native code work.
  const native = (task.thinking?.skill ?? (workKind(task) === "task" ? skillOfGoal(task.goal) : undefined)) === "code";
  const out: string[] = [];
  for (const ref of refs) {
    const r = parseBrainRef(ref);
    // Compare physical computers, but keep a same-host node's executor: its CLI/sign-in can differ from the hub's.
    const machineId = at !== undefined && machine(r.machineId) !== machine(at)
      ? at
      : r.machineId === here ? "local" : r.machineId;
    if (!onMachine(machineId, agent.machines, here, canonical)) continue;
    if (native && r.brainId === "api") continue;
    const candidate = formatBrainRef({ ...r, machineId });
    if (required) {
      const want = parseBrainRef(required);
      if (want.brainId !== r.brainId || (want.variant && want.variant !== r.variant)) continue;
      if (required.includes("@") && machine(want.machineId) !== machine(machineId)) continue;
    }
    if (!out.some((b) => sameBrain(b, candidate))) out.push(candidate);
  }
  return out;
}
