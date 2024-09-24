# cloudflare-remix-env-paths

Sample of switching import between Production and Development

- vitePlugin/index.ts

```ts
import { once } from "node:events";
import { Readable } from "node:stream";
import path from "path";
import { Connect, Plugin as VitePlugin } from "vite";
import type { ServerResponse } from "node:http";
import { createMiniflare } from "./miniflare";

import {
  Response as MiniflareResponse,
  Request as MiniflareRequest,
  RequestInit,
} from "miniflare";

export function devServer(): VitePlugin {
  const plugin: VitePlugin = {
    name: "edge-dev-server",
    configureServer: async (viteDevServer) => {
      const runner = await createMiniflare(viteDevServer);
      process.on("exit", () => {
        runner.dispose();
      });
      return () => {
        if (!viteDevServer.config.server.middlewareMode) {
          viteDevServer.middlewares.use(async (req, nodeRes, next) => {
            try {
              const request = toRequest(req);
              request.headers.set(
                "x-vite-entry",
                path.resolve(__dirname, "server.ts")
              );
              const response = await runner.dispatchFetch(request);
              await toResponse(response, nodeRes);
            } catch (error) {
              next(error);
            }
          });
        }
      };
    },
    apply: "serve",
    config: () => {
      return {
        ssr: {
          target: "webworker",
        },
      };
    },
  };
  return plugin;
}

export function toRequest(nodeReq: Connect.IncomingMessage): MiniflareRequest {
  const origin =
    nodeReq.headers.origin && "null" !== nodeReq.headers.origin
      ? nodeReq.headers.origin
      : `http://${nodeReq.headers.host}`;
  const url = new URL(nodeReq.originalUrl!, origin);

  const headers = Object.entries(nodeReq.headers).reduce(
    (headers, [key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      } else if (typeof value === "string") {
        headers.append(key, value);
      }
      return headers;
    },
    new Headers()
  );

  const init: RequestInit = {
    method: nodeReq.method,
    headers,
  };

  if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
    init.body = nodeReq;
    (init as { duplex: "half" }).duplex = "half";
  }

  return new MiniflareRequest(url, init);
}

export async function toResponse(
  res: MiniflareResponse,
  nodeRes: ServerResponse
) {
  nodeRes.statusCode = res.status;
  nodeRes.statusMessage = res.statusText;
  nodeRes.writeHead(res.status, Object.entries(res.headers.entries()));
  if (res.body) {
    const readable = Readable.from(
      res.body as unknown as AsyncIterable<Uint8Array>
    );
    readable.pipe(nodeRes);
    await once(readable, "end");
  } else {
    nodeRes.end();
  }
}
```

- vitePlugin/miniflare.ts

```ts
import { fileURLToPath } from "url";
import { build } from "esbuild";
import { ViteDevServer } from "vite";
import {
  Miniflare,
  mergeWorkerOptions,
  MiniflareOptions,
  Response,
} from "miniflare";
import path from "path";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import fs from "fs";
import { unsafeModuleFallbackService } from "./unsafeModuleFallbackService";

async function getTransformedCode(modulePath: string) {
  const result = await build({
    entryPoints: [modulePath],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
  });
  return result.outputFiles[0].text;
}

export const createMiniflare = async (viteDevServer: ViteDevServer) => {
  const modulePath = path.resolve(__dirname, "miniflare_module.ts");
  const code = await getTransformedCode(modulePath);
  const config = fs.existsSync("wrangler.toml")
    ? unstable_getMiniflareWorkerOptions("wrangler.toml")
    : { workerOptions: {} };

  const miniflareOption: MiniflareOptions = {
    compatibilityDate: "2024-08-21",
    compatibilityFlags: ["nodejs_compat"],
    modulesRoot: fileURLToPath(new URL("./", import.meta.url)),
    modules: [
      {
        path: modulePath,
        type: "ESModule",
        contents: code,
      },
    ],
    unsafeUseModuleFallbackService: true,
    unsafeModuleFallbackService: (request) =>
      unsafeModuleFallbackService(viteDevServer, request),
    unsafeEvalBinding: "__viteUnsafeEval",
    serviceBindings: {
      __viteFetchModule: async (request) => {
        const args = (await request.json()) as Parameters<
          typeof viteDevServer.environments.ssr.fetchModule
        >;
        const result = await viteDevServer.environments.ssr.fetchModule(
          ...args
        );
        return new Response(JSON.stringify(result));
      },
    },
  };
  if (
    "compatibilityDate" in config.workerOptions &&
    !config.workerOptions.compatibilityDate
  ) {
    delete config.workerOptions.compatibilityDate;
  }
  const options = mergeWorkerOptions(
    miniflareOption,
    config.workerOptions as WorkerOptions
  ) as MiniflareOptions;
  const miniflare = new Miniflare(options);
  return miniflare;
};
```

- vitePlugin/miniflare_module.ts

```ts
import {
  FetchResult,
  ModuleRunner,
  ssrModuleExportsKey,
} from "vite/module-runner";

type RunnerEnv = {
  __viteUnsafeEval: {
    eval: (
      code: string,
      filename?: string
    ) => (...args: unknown[]) => Promise<void>;
  };
  __viteFetchModule: {
    fetch: (request: Request) => Promise<Response>;
  };
};

class WorkerdModuleRunner extends ModuleRunner {
  constructor(env: RunnerEnv) {
    super(
      {
        root: "/",
        sourcemapInterceptor: "prepareStackTrace",
        transport: {
          fetchModule: async (...args) => {
            const response = await env.__viteFetchModule.fetch(
              new Request("https://localhost", {
                method: "POST",
                body: JSON.stringify(args),
              })
            );
            return response.json<FetchResult>();
          },
        },
        hmr: false,
      },
      {
        runInlinedModule: async (context, transformed, id) => {
          const keys = Object.keys(context);
          const fn = env.__viteUnsafeEval.eval(
            `'use strict';async(${keys.join(",")})=>{${transformed}}`,
            id
          );
          await fn(...keys.map((key) => context[key as keyof typeof context]));
          Object.freeze(context[ssrModuleExportsKey]);
        },
        async runExternalModule(filepath) {
          const result = await import(filepath).catch((e) => {
            console.error(e);
          });
          return { ...result, ...result.default };
        },
      }
    );
  }
}

export default {
  async fetch(request: Request, env: RunnerEnv) {
    const runner = new WorkerdModuleRunner(env);
    const entry = request.headers.get("x-vite-entry")!;
    const mod = await runner.import(entry);
    const handler = mod.default as ExportedHandler;
    if (!handler.fetch) throw new Error(`Module does not have a fetch handler`);
    try {
      const result = handler.fetch(request, env, {
        waitUntil: () => {},
        passThroughOnException() {},
      });
      return result;
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  },
};
```

- vitePlugin/unsafeModuleFallbackService.ts

```ts
import { build } from "esbuild";
import { Request, Response } from "miniflare";
import { ViteDevServer } from "vite";
import { createRequire } from "node:module";
import fs from "fs";

const require = createRequire(process.cwd());

const isWindows = process.platform === "win32";

const getNormalPath = (target: string | null) => {
  if (!target) {
    throw new Error("specifier is required");
  }
  let normalPath = target;

  if (normalPath[0] === "/") {
    normalPath = normalPath.substring(1);
  }
  if (normalPath.startsWith("file:")) {
    normalPath = normalPath.substring(5);
  }
  if (isWindows) {
    if (normalPath[0] === "/") {
      normalPath = normalPath.substring(1);
    }
  }
  return normalPath;
};

export const unsafeModuleFallbackService = async (
  vite: ViteDevServer,
  request: Request
) => {
  const method = request.headers.get("X-Resolve-Method");

  const url = new URL(request.url);
  const isWindows = process.platform === "win32";
  const origin = url.searchParams.get("specifier");
  const target = getNormalPath(origin);
  const referrer = getNormalPath(url.searchParams.get("referrer"));
  const rawSpecifier = getNormalPath(url.searchParams.get("rawSpecifier"));
  // console.log("===============\n", { method, target, referrer, rawSpecifier });

  let specifier = target!;
  if (isWindows) {
    if (specifier[0] === "/") {
      specifier = specifier.substring(1);
    }
  }
  if (!specifier) {
    throw new Error("specifier is required");
  }
  if (specifier.startsWith("file:")) {
    specifier = specifier.substring(5);
  }
  if (isWindows) {
    if (specifier[0] === "/") {
      specifier = specifier.substring(1);
    }
  }

  if (!rawSpecifier.startsWith("./") && rawSpecifier[0] !== "/") {
    if (!fs.existsSync(specifier)) {
      if (method === "import") {
        specifier = import.meta.resolve(rawSpecifier, referrer);
        specifier = specifier.substring(8);
      } else {
        specifier = require.resolve(rawSpecifier, { paths: [referrer] });
        specifier = specifier.replaceAll("\\", "/");
      }

      return new Response(null, {
        status: 301,
        headers: { Location: "/" + specifier },
      });
    }
  }

  if (rawSpecifier.endsWith(".wasm")) {
    const contents = fs.readFileSync(specifier);
    return new Response(
      JSON.stringify({ name: origin?.substring(1), wasm: Array.from(contents) })
    );
  }

  const result = await build({
    entryPoints: [specifier],
    format: "esm",
    target: "esnext",
    platform: "browser",
    external: ["*.wasm"],
    bundle: true,
    packages: "external",
    mainFields: ["module", "browser", "main"],
    conditions: ["workerd", "worker", "webworker", "import"],
    minify: false,
    write: false,
    logLevel: "error",
    jsxDev: true,
  }).catch((e) => {
    console.error("esbuild error", e);
    return e;
  });
  const esModule =
    `import  { createRequire } from "node:module";
  const ___r = createRequire("/${specifier}");
  const require = (id) => {
    const result = ___r(id);
    return result.default;
  };` + result.outputFiles?.[0].text;

  return new Response(
    JSON.stringify({
      name: origin?.substring(1),
      esModule,
    })
  );
};
```

- vitePlugin/server.ts

```ts
import { createRequestHandler } from "@remix-run/cloudflare";
// eslint-disable-next-line import/no-unresolved
import * as build from "virtual:remix/server-build";
import type { AppLoadContext } from "@remix-run/cloudflare";

const fetch = async (req: Request, context: AppLoadContext) => {
  const handler = createRequestHandler(build);
  return handler(req, { cloudflare: { env: context } } as never);
};

export default { fetch };
```

- app/routes/\_index.tsx

```tsx
import { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import { PrismaPg } from "@prisma/adapter-pg-worker";
import pg from "@prisma/pg-worker";
import { PrismaClient } from "@prisma/client/wasm";

export default function Index() {
  const values = useLoaderData<string[]>();
  return (
    <div>
      {values.map((v) => (
        <div key={v}>{v}</div>
      ))}
    </div>
  );
}

export async function loader({
  context,
}: LoaderFunctionArgs): Promise<string[]> {
  const url = new URL(context.cloudflare.env.DATABASE_URL);
  const schema = url.searchParams.get("schema") ?? undefined;
  const pool = new pg.Pool({
    connectionString: context.cloudflare.env.DATABASE_URL,
  });
  const adapter = new PrismaPg(pool, { schema });
  const prisma = new PrismaClient({ adapter });
  await prisma.test.create({ data: {} });
  return prisma.test.findMany().then((r) => r.map(({ id }) => id));
}
```

- vite.config.ts

```ts
import {
  vitePlugin as remix,
  // cloudflareDevProxyVitePlugin as remixCloudflareDevProxy,
} from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { devServer } from "./vitePlugin";

export default defineConfig({
  ssr: {
    noExternal: ["@prisma/adapter-pg-worker", "@prisma/driver-adapter-utils"],
  },
  plugins: [
    // remixCloudflareDevProxy(),
    devServer(),
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
```
