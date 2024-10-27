import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import { devServer } from "vite-plugin-miniflare";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    devServer({
      // entry: "./functions/[[path]].ts",
      // bundle: true,
      entry: "./dev/server.ts",
      autoNoExternal: true,
      injectClientScript: false,
    }),
    remix({
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
      },
    }),
    tsconfigPaths(),
  ],
});
