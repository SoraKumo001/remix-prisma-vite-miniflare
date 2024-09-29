import fs from "fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import path from "path";
import {
  Response as MiniflareResponse,
  Request as MiniflareRequest,
  RequestInit,
} from "miniflare";
import { Connect, Plugin as VitePlugin } from "vite";
import { createMiniflare } from "./miniflare";
import type { ServerResponse } from "node:http";

const isWindows = process.platform === "win32";

const getPackageName = (specifier: string): string | null => {
  const now = process.cwd();
  let dir = path.dirname(specifier);
  while (true) {
    const packageJson = path.join(dir, "package.json");
    if (fs.existsSync(packageJson)) {
      const json = JSON.parse(fs.readFileSync(packageJson, "utf-8"));
      return json.name;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === now) {
      return null;
    }
    dir = parentDir;
  }
};

export function devServer(): VitePlugin {
  const plugin: VitePlugin = {
    name: "edge-dev-server",
    configureServer: async (viteDevServer) => {
      const runner = await createMiniflare(viteDevServer);
      process.on("exit", () => {
        runner.dispose();
      });
      viteDevServer.watcher.on("change", (file) => {
        if (file === path.resolve(__dirname, "miniflare_module.ts"))
          viteDevServer.restart();
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
              const requestBundle = response.headers.get("x-request-bundle");
              if (requestBundle) {
                let normalPath = requestBundle;
                if (normalPath.startsWith("file://")) {
                  normalPath = normalPath.substring(7);
                }
                if (isWindows && normalPath[0] === "/") {
                  normalPath = normalPath.substring(1);
                }
                const packageName = getPackageName(normalPath);
                if (!packageName) {
                  throw new Error("No package name found");
                }
                nodeRes.writeHead(500);
                nodeRes.end(`Add '${packageName}' to noExternal`);
              } else toResponse(response, nodeRes);
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
