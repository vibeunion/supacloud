async page => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const state = (id, value) => page.waitForFunction(
    ([id, value]) => document.getElementById(id)?.textContent === value, [id, value],
  );
  const download = (subject, path) => page.evaluate(async ({ subject, path }) => {
    const response = await fetch("/fixture/session?subject=" + subject, { headers: { "x-starter-fixture": "browser" } });
    const session = await response.json();
    const object = await fetch("/storage/v1/object/authenticated/review-attachments/" + path, {
      headers: { authorization: "Bearer " + session.token, apikey: session.anonKey },
    });
    return { status: object.status, body: object.ok ? await object.text() : null };
  }, { subject, path });
  const evidence = async () => {
    await page.getByRole("button", { name: "Read evidence", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("result")?.textContent?.includes("approvalRequests"));
    return JSON.parse(await page.locator("#result").textContent());
  };
  await state("list-status", "ready");
  check(await page.locator("#rows li").count() === 1, "Owner must see one review");
  await page.getByRole("checkbox", { name: "Fail list request" }).check();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await state("list-status", "error");
  check(await page.locator("#rows li").count() === 0, "Read error must clear stale rows");
  await page.getByRole("checkbox", { name: "Fail list request" }).uncheck();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await state("list-status", "ready");

  await page.getByLabel("Attachment", { exact: true }).setInputFiles({
    name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("private browser approval evidence"),
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await state("mutation-status", "confirmed");
  await state("list-status", "ready");
  const uploaded = await evidence();
  check(uploaded.attachments.length === 1 && uploaded.objects.length === 1, "Upload must persist one private object and binding");
  check(uploaded.attachments[0].object_path === uploaded.objects[0].name, "Binding must reference the stored object");
  check(uploaded.receipts.length === 1 && uploaded.audit.length === 1, "Upload must have one receipt and audit");
  const ownedObject = await download("owner", uploaded.objects[0].name);
  check(ownedObject.status === 200 && ownedObject.body === "private browser approval evidence",
    "Owner must download the original durable bytes");

  await page.getByRole("button", { name: "Advance database version", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("result")?.textContent === '{"advanced":true}');
  await page.getByRole("button", { name: "Approve", exact: true }).evaluate(button => {
    button.click();
    button.click();
  });
  await state("mutation-status", "conflict");
  await state("list-status", "ready");
  check((await page.locator("#rows").textContent()).includes("draft v2"), "Conflict must refresh current version");
  await page.getByRole("checkbox", { name: "Lose approval response" }).check();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await state("mutation-status", "unknown");
  const operation = await page.locator("#operation").textContent();
  check(operation.length > 0, "Unknown outcome must retain operation identity");
  check(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled(), "Unknown must block writes");
  const committed = await evidence();
  check(committed.reviews[0].state === "approved" && committed.reviews[0].version === 3, "Lost response must follow real commit");
  check(committed.droppedResponses === 1 && committed.approvalRequests === 2, "Conflict and lost approval must each send once");
  check(committed.receipts.length === 2 && committed.audit.length === 2, "Exactly one approval and upload must commit");
  await page.screenshot({ path: "output/playwright/starter-unknown.png", fullPage: true });

  await page.reload();
  await state("list-status", "ready");
  await state("mutation-status", "unknown");
  check(await page.locator("#operation").textContent() === operation, "Reload must preserve operation identity");
  check(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled(), "Reload must not unlock writes");
  const pending = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("supacloud.review.pending.v1:")).map(([, value]) => JSON.parse(value)));
  check(pending.length === 1 && Object.keys(pending[0]).sort().join(",") === "expectedVersion,kind,operationId,reviewId",
    "Pending storage must contain only operation identity");
  await page.getByRole("button", { name: "Check receipt", exact: true }).click();
  await state("mutation-status", "confirmed");
  await state("list-status", "ready");
  const recovered = await evidence();
  check(recovered.approvalRequests === committed.approvalRequests, "Recovery must not replay approval");
  check(JSON.stringify(recovered.receipts) === JSON.stringify(committed.receipts)
    && JSON.stringify(recovered.audit) === JSON.stringify(committed.audit), "Readback must not mutate receipts or audit");
  check(await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith("supacloud.review.pending.v1:")).length) === 0, "Confirmed recovery must clear pending record");
  await page.screenshot({ path: "output/playwright/starter-recovered.png", fullPage: true });

  await page.getByRole("combobox", { name: "Identity" }).selectOption("other");
  await state("list-status", "empty");
  await state("mutation-status", "idle");
  check(await page.locator("#rows li").count() === 0, "Identity change must not expose owner rows");
  await page.getByRole("button", { name: "Probe foreign approval", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("result")?.textContent === '{"status":"denied"}');
  const objectAccess = await download("other", uploaded.objects[0].name);
  check(objectAccess.status === 403 || objectAccess.status === 404, "Foreign subject must not download the private attachment");
  const denied = await evidence();
  check(denied.receipts.length === 2 && denied.audit.length === 2 && denied.approvalRequests === 3,
    "Denied foreign write must not leave receipts or audit");
  await page.screenshot({ path: "output/playwright/starter-denied.png", fullPage: true });
  return { status: "passed", identity: "local-signed-not-live-SupAuth",
    checks: ["list", "read-failure-recovery", "private-upload", "conflict-refresh", "committed-response-loss",
      "reload-identity", "read-only-recovery", "foreign-list-write-object-denial"],
    evidence: denied };
}
