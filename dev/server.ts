import { createRequestHandler } from "@remix-run/cloudflare";
import * as build from "virtual:remix/server-build";
import type { AppLoadContext } from "@remix-run/cloudflare";

const handler = createRequestHandler(build, "development");
const fetch = async (req: Request, context: AppLoadContext) => {
  return handler(req, { cloudflare: { env: context } } as never);
};

export default { fetch };
