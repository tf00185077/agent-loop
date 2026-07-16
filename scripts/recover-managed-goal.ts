import { recoverManagedGoal } from "../src/runtime/agent-session/managed-goal-recovery.js";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const databasePath = value("--database");
const workspacePath = value("--workspace");
const goalId = value("--goal");

if (!databasePath || !workspacePath || !goalId) {
  process.stderr.write(
    "Usage: npm run recover:managed-goal -- --database <sqlite> --workspace <goal-workspace> --goal <id> " +
    "[--apply --plan-digest <sha256> --backup <sqlite-copy> --stopped-evidence <json>]\n",
  );
  process.exitCode = 2;
} else {
  const apply = args.includes("--apply");
  const result = recoverManagedGoal({
    databasePath,
    workspacePath,
    goalId,
    apply,
    planDigest: value("--plan-digest"),
    backupPath: value("--backup"),
    stoppedEvidencePath: value("--stopped-evidence"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (apply && !result.applied) process.exitCode = 3;
}
