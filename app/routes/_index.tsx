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
