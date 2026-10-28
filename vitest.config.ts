import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve:{alias:[{find:/^@pennbridge\/(.+)$/,replacement:fileURLToPath(new URL("./packages/$1",import.meta.url))}]},
  test:{include:["tests/**/*.test.ts"],testTimeout:30000,hookTimeout:120000},
});
