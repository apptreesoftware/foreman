import type { Instance } from "../instance.ts";

/** Opens a phase epic issue on the instance's board. Implemented in Task 7. */
export async function runEpicNew(
  _instance: Instance,
  _o: { title: string; phase: number; spec: string; agentReady: boolean },
  _out: (line: string) => void,
): Promise<number> {
  throw new Error("not implemented until Task 7");
}
