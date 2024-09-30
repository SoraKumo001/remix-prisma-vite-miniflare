import {
  vitePlugin as remix,
  // cloudflareDevProxyVitePlugin as remixCloudflareDevProxy,
} from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { devServer } from "./vitePlugin";

export default defineConfig({
  ssr: {
    // noExternal: ["@prisma/adapter-pg-worker", "@prisma/driver-adapter-utils"],
  },
  plugins: [
    // remixCloudflareDevProxy(),
    devServer({ autoNoExternal: true }),
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
