import { createGraphqlClient } from "../generated/graphql";

function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error("Missing element: " + selector);
  return node;
}
const tenant = element<HTMLSelectElement>("#tenant");
const order = element<HTMLSelectElement>("#order");
const detail = element("#detail");
const message = element("#message");
const error = element("#error");
const refresh = element<HTMLButtonElement>("#refresh");
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
let pending: AbortController | undefined;

function row(parent: HTMLElement, cells: string[], numericFrom = Number.POSITIVE_INFINITY): void {
  const tr = document.createElement("tr");
  cells.forEach((text, index) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (index >= numericFrom) td.className = "num";
    tr.append(td);
  });
  parent.append(tr);
}
async function load(): Promise<void> {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  detail.hidden = true;
  error.hidden = true;
  message.hidden = false;
  message.textContent = "Loading order...";
  refresh.disabled = true;
  try {
    const sessionResponse = await fetch("/session?tenant=" + tenant.value, { signal: controller.signal });
    if (!sessionResponse.ok) throw new Error("Session unavailable");
    const session: unknown = await sessionResponse.json();
    if (!session || typeof session !== "object" || !("accessToken" in session) || typeof session.accessToken !== "string") {
      throw new Error("Invalid session");
    }
    const accessToken = session.accessToken;
    const queries = createGraphqlClient({ url: location.origin, getAccessToken: () => accessToken });
    const started = performance.now();
    const result = await queries.OrderDetail({ id: Number(order.value) }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const record = result.ordersCollection?.edges[0]?.node;
    if (!record) {
      message.textContent = "No accessible order.";
      return;
    }
    element("#number").textContent = record.number;
    element("#status").textContent = record.status.replaceAll("_", " ");
    element("#customer").textContent = record.customer?.name ?? "Not available";
    element("#email").textContent = record.customer?.email ?? "";
    element("#total").textContent = money(record.totalCents);
    const items = record.items?.edges ?? [];
    element("#count").textContent = String(items.length);
    const itemsBody = element("#items");
    itemsBody.replaceChildren();
    for (const { node: item } of items) {
      row(itemsBody, [item.sku, item.description, String(item.quantity), money(item.unitPriceCents), money(item.quantity * item.unitPriceCents)], 2);
    }
    const deliveries = element("#deliveries");
    deliveries.replaceChildren();
    for (const { node: delivery } of record.deliveries?.edges ?? []) {
      row(deliveries, [delivery.carrier, delivery.tracking, delivery.status.replaceAll("_", " ")]);
    }
    element("#timing").textContent = "Retrieved in " + Math.round(performance.now() - started) + " ms";
    message.hidden = true;
    detail.hidden = false;
  } catch (cause) {
    if (controller.signal.aborted) return;
    message.hidden = true;
    error.hidden = false;
    error.textContent = cause instanceof Error ? cause.message : "Order request failed.";
  } finally {
    if (!controller.signal.aborted) refresh.disabled = false;
  }
}
element<HTMLFormElement>("#filters").addEventListener("submit", (event) => { event.preventDefault(); void load(); });
tenant.addEventListener("change", () => { void load(); });
order.addEventListener("change", () => { void load(); });
void load();
