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

class ImportError extends Error {
  path: string;
  constructor(path: string) {
    super(path);
    this.name = "ImportError";
    this.path = path;
  }
  getPath() {
    return this.path;
  }
}

class WorkerdModuleRunner extends ModuleRunner {
  constructor(env: RunnerEnv) {
    const modules: Record<string, unknown> = {};
    const fetchCache: Record<string, FetchResult> = {};
    super(
      {
        root: "/",
        sourcemapInterceptor: "prepareStackTrace",
        transport: {
          async fetchModule(...args) {
            const cache = args[2]?.cached ? fetchCache[args[0]] : undefined;
            const response =
              cache ??
              ((await env.__viteFetchModule
                .fetch(
                  new Request("http://localhost", {
                    method: "POST",
                    body: JSON.stringify(args),
                  })
                )
                .then((v) => v.json())) as FetchResult);
            if (args[2]?.cached) {
              fetchCache[args[0]] = response;
            }

            return response;
          },
        },
      },
      {
        async runInlinedModule(context, transformed, { id }) {
          const keys = Object.keys(context);
          const fn = env.__viteUnsafeEval.eval(
            `'use strict';async(${keys.join(",")})=>{${transformed}}`,
            id
          );
          await fn(
            ...keys.map((key) => context[key as keyof typeof context])
          ).catch((e) => {
            if (e instanceof ImportError) throw e;
            if (e instanceof Error && "stack" in e) {
              throw String(e.stack);
            }
            throw e;
          });
          Object.freeze(context[ssrModuleExportsKey]);
        },
        async runExternalModule(filepath) {
          const result =
            modules[filepath] ??
            (await import(filepath).catch((_e) => {
              throw new ImportError(filepath);
            }));
          modules[filepath] = result;
          if (result.default) return { ...result, ...result.default };
          return result;
        },
      }
    );
  }
}

export default {
  async fetch(request: Request, env: RunnerEnv) {
    const runner = new WorkerdModuleRunner(env);
    const entry = request.headers.get("x-vite-entry")!;
    try {
      const mod = await runner.import(entry);
      const handler = mod.default as ExportedHandler;
      if (!handler.fetch)
        throw new Error(`Module does not have a fetch handler`);

      const result = handler.fetch(request, env, {
        waitUntil: () => {},
        passThroughOnException() {},
      });
      return result;
    } catch (e) {
      if (e instanceof ImportError) {
        return new Response(String(e), {
          status: 500,
          headers: {
            "x-request-bundle": e.getPath(),
          },
        });
      }
      return new Response(String(e), {
        status: 500,
      });
    }
  },
};
