import { defineConfig, type Plugin } from "vite";

// One id per build. Baked into the JS and written to version.json, so a running
// copy of the app can tell whether a newer deploy exists (see src/update.ts).
const BUILD_ID = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);

function versionFile(): Plugin {
  return {
    name: "version-file",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
    }
  };
}

export default defineConfig({
  base: "/djraf7/",
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [versionFile()],
  build: { target: "es2020" }
});
