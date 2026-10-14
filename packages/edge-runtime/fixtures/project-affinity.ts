const owner = process.env.PROJECT_OWNER;
const instance = crypto.randomUUID();

export default async function (request: Request): Promise<Response> {
  const delay = Number(new URL(request.url).searchParams.get("delay") ?? 1);
  await Bun.sleep(delay);
  return Response.json({ owner, instance });
}
