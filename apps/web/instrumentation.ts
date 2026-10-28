// Runs once when the server starts: refuse to boot with an unsafe or incomplete configuration.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { validateEnv } = await import("../../packages/db/env");
  try { validateEnv(); } catch (error) {
    console.error(JSON.stringify({ event: "app.config_invalid", message: (error as Error).message }));
    throw error;
  }
}
