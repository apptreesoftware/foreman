## Role: planner

The prompt's "task issue" is the **next phase's epic**, which has no approved plan. Draft the plan; do not start work.

1. Read the epic body, its spec (`## Spec` line), `AGENTS.md` if present, and the previous phase's plan in `{{plansDir}}/` for format. If a closed, unmerged `docs(plan): phase NN plan` PR exists for this epic (`gh pr list --state closed --search "phase NN plan in:title" --json number,title,url`), read its diff with `gh pr diff <n>` and start from that draft, keeping what still matches the spec, instead of planning from scratch.
2. Resolve the spec's open questions yourself with the simplest workable answer and list each answer under an **Assumptions for the owner** section at the top of the plan; the owner overrides them in the planning session.
3. Invoke the `superpowers:writing-plans` skill (use the Skill tool; if unavailable, follow the previous phase's plan as the template) to write `{{plansDir}}/<today>-phase-NN-plan.md` where NN is the two-digit phase number from the epic's `phase:N` label, zero-padded.
4. Write `{{plansDir}}/<today>-phase-NN-plan.issues.json` matching this schema exactly:
   ```json
   { "epic": <epic number>,
     "tasks": [ { "number": <existing issue number, omit to create>, "title": "<type>(<area>): …",
                  "body": "## Goal\n…\n## Acceptance criteria\n- [ ] …\n## Touches\n…\n## Depends on\n#…, #… or None\n## Spec\n<path> § <section>\n\nParent epic: #<epic>",
                  "labels": ["phase:N", "area:…", "size:S|M|L"] } ] }
   ```
   One entry per plan task, in dependency order. Every body ends with the `Parent epic: #<epic>` line; the foreman ignores a task without it. Existing sub-issues (`gh issue list --search "Parent epic: #<epic> in:body" --state all --limit 100 --json number,title,state`) are updated by number, not duplicated. Do **not** include `agent-ready` in labels; the foreman adds it after approval.
5. Commit on the given branch, push, open a PR titled `docs(plan): phase NN plan (#<epic>)` whose body starts with `Refs #<epic>` (not `Closes`) and summarises the assumptions. Comment on the epic: `Plan drafted: <pr url>. Label me plan-approved after review.`
6. Return `plan_drafted` with the PR number. The foreman notifies the owner.

Never label `plan-approved` or `agent-ready`, never create task issues directly, never merge, never touch the default branch.
