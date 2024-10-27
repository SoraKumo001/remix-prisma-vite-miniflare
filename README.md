# remix-prisma-vite-miniflare

Sample of Vite + Remix + Prisma running on Miniflare.

- vite.config.ts

```ts
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
```

- dev/server.ts

```ts
import { createRequestHandler } from "@remix-run/cloudflare";
import * as build from "virtual:remix/server-build";
import type { AppLoadContext } from "@remix-run/cloudflare";

const handler = createRequestHandler(build, "development");
const fetch = async (req: Request, context: AppLoadContext) => {
  return handler(req, { cloudflare: { env: context } } as never);
};

export default { fetch };
```

- app/routes/\_index.tsx

```tsx
import { PrismaPg } from "@prisma/adapter-pg-worker";
import { PrismaClient } from "@prisma/client/wasm";
import { Pool } from "@prisma/pg-worker";
import { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";

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
  const pool = new Pool({
    connectionString: context.cloudflare.env.DATABASE_URL,
  });
  const adapter = new PrismaPg(pool, { schema });
  const prisma = new PrismaClient({ adapter });
  await prisma.test.create({ data: {} });
  return prisma.test.findMany({ where: {} }).then((r) => r.map(({ id }) => id));
}
```
