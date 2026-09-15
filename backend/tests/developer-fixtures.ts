import { createUser, type TestHarness } from "./helpers.js";

/** Explicit privileged fixture; ordinary test users remain unprivileged. */
export async function createDeveloper(h: TestHarness): Promise<string> {
  const userId = await createUser(h);
  await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')",
    [userId, "nericollin@gmail.com", h.clock.now().toISOString()]);
  return userId;
}
