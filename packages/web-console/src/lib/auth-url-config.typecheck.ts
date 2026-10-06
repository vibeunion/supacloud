import { createAuthUrlConfigClient, type AuthUrlConfigInput } from "./auth-url-config";

const client = createAuthUrlConfigClient("tenant-a");
const valid = { site_url: "https://app.test", uri_allow_list: "" } satisfies AuthUrlConfigInput;
void client.update(valid);
// @ts-expect-error A record id is not a writable configuration field.
void client.update({ ...valid, id: "auth-url-config" });
// @ts-expect-error Allow lists use the backend string format, not an array.
void client.update({ site_url: "https://app.test", uri_allow_list: [] });
// @ts-expect-error A form must supply both canonical configuration fields.
void client.update({ site_url: "https://app.test" });
void client.read().then(result => {
  const url: string = result.siteUrl;
  const redirects: string[] = result.redirectUrls;
  // @ts-expect-error Configuration never exposes a credential.
  const secret: string = result.client_secret;
  return [url, redirects, secret];
});
