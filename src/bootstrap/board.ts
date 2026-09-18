import type { BootstrapApi } from "../github.ts";

export const STATUS_OPTIONS = ["Backlog", "Ready", "In Progress", "In Review", "Done"] as const;

type Api = Pick<
  BootstrapApi,
  "createProject" | "linkProject" | "projectFields" | "setStatusOptions"
>;

/**
 * Creates the board when the instance has none, and otherwise only reports how an existing one
 * differs from what the foreman needs: `init` never edits a board someone is already using.
 */
export async function ensureProject(
  gh: Api,
  o: {
    owner: string;
    repo: string;
    project: number | null;
    title: string;
    /** Called with the new number the moment it exists, before the link and the options. */
    onCreated: (number: number) => void;
  },
): Promise<{ number: number; created: boolean; drift: string[] }> {
  if (o.project === null) {
    const number = await gh.createProject(o.owner, o.title);
    // Recorded first: a throw from the link or the options then leaves a board the next `init`
    // finds and verifies, rather than an orphan and a second project.
    o.onCreated(number);
    await gh.linkProject(number, o.owner);
    const fields = await gh.projectFields(number, o.owner);
    if (!fields.status) throw new Error(`project ${number} has no Status field`);
    await gh.setStatusOptions(fields.status.id, [...STATUS_OPTIONS]);
    return { number, created: true, drift: [] };
  }
  const fields = await gh.projectFields(o.project, o.owner);
  const drift: string[] = [];
  if (!fields.status) drift.push("project has no Status single-select field");
  else {
    const names = fields.status.options.map((x) => x.name);
    if (names.join("|") !== STATUS_OPTIONS.join("|"))
      drift.push(`Status options are ${names.join(", ")}; expected ${STATUS_OPTIONS.join(", ")}`);
  }
  return { number: o.project, created: false, drift };
}
