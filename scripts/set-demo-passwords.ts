// One-time local-dev convenience: seed.ts (src/db/seed.ts, ROLE_EMAILS)
// creates the demo company's users without a password_hash — real login
// delivery isn't wired up (CLAUDE.md §8 Q4/Q6), so there is otherwise no
// way to sign in as any seeded user. Sets the SAME known password on all
// six seeded role accounts for local exploration only; never run against
// a real deployment.
import { createExecutor } from "../src/db/bootstrapSql";
import { hashPassword } from "../src/modules/auth/password";

const DEMO_PASSWORD = "DemoPass123!";
const ROLE_EMAILS = [
  "admin@steeltrace-demo.test",
  "warehouse@steeltrace-demo.test",
  "quality@steeltrace-demo.test",
  "workshop@steeltrace-demo.test",
  "site@steeltrace-demo.test",
  "pm@steeltrace-demo.test",
];

async function main(): Promise<void> {
  const executor = await createExecutor();
  const hash = await hashPassword(DEMO_PASSWORD);

  for (const email of ROLE_EMAILS) {
    const result = await executor.run((tx) => tx.query(`UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING email`, [hash, email]));
    console.log(result.rows[0] ? `set password for ${email}` : `(skipped — no user found for ${email})`);
  }

  console.log(`\nAll seeded demo accounts now share the password: ${DEMO_PASSWORD}`);
  await executor.close();
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
