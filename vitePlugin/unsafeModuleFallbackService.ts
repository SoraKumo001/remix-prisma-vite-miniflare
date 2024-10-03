import fs from "fs";
import { createRequire } from "node:module";
import { initSync, parse } from "cjs-module-lexer";
import { build } from "esbuild";
import { Request, Response } from "miniflare";
import { ViteDevServer } from "vite";
import { getPackageValue } from "./utils";

initSync();

const require = createRequire(process.cwd());

const isWindows = process.platform === "win32";

const getNormalPath = (target: string | null) => {
  if (!target) {
    throw new Error("specifier is required");
  }
  let normalPath = target;

  if (normalPath.startsWith("/file:")) {
    normalPath = normalPath.substring(6);
  }
  if (normalPath.startsWith("file://")) {
    normalPath = normalPath.substring(7);
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
  // console.log("===============\n", {
  //   method,
  //   origin,
  //   target,
  //   referrer,
  //   rawSpecifier,
  // });

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
        // specifier = import.meta.resolve(rawSpecifier, referrer);
        // specifier = specifier.substring(8);
        const resolve = await vite.environments.ssr.pluginContainer.resolveId(
          rawSpecifier,
          referrer
        );
        specifier = resolve?.id.replace(/\?v=.+$/, "") ?? "";
      } else {
        specifier = require.resolve(rawSpecifier, {
          paths: [referrer],
        });
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

  const type = getPackageValue(specifier, "type", false);

  const js = `import { createRequire } from "node:module";
      const ___r = createRequire("file:${specifier}");
      const require = (id) => {
        const result = ___r(id);
        return result.default;
      };`;

  if (type !== "module") {
    const result = await build({
      entryPoints: [specifier],
      format: "cjs",
      platform: "browser",
      external: ["*.wasm"],
      bundle: true,
      packages: "external",
      minify: true,
      write: false,
      logLevel: "error",
      jsxDev: true,
    }).catch((e) => {
      console.error("esbuild error", e);
      return e;
    });
    const commonJsModule = result.outputFiles?.[0].text;

    const { exports } = parse(commonJsModule, specifier);
    if (exports.length) {
      const exportModules = exports
        .filter((v) => !["default", "__esModule"].includes(v))
        .map(
          (name) =>
            `export const ${name} = exports.${name} ?? module.exports.${name};\n`
        )
        .join("");
      const esModule =
        js +
        "\nvar exports = {};var module = {exports:{}}\n" +
        commonJsModule +
        exportModules +
        "export default exports;\n";
      return new Response(
        JSON.stringify({
          name: origin?.substring(1),
          esModule,
        })
      );
    }
  }

  const result = await build({
    entryPoints: [specifier],
    format: "esm",
    platform: "browser",
    external: ["*.wasm"],
    bundle: true,
    packages: "external",
    minify: false,
    write: false,
    logLevel: "error",
    jsxDev: true,
    banner: {
      js,
    },
  }).catch((e) => {
    console.error("esbuild error", e);
    return e;
  });
  const esModule = result.outputFiles?.[0].text;
  return new Response(
    JSON.stringify({
      name: origin?.substring(1),
      esModule,
    })
  );
};
