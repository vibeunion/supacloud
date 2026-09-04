import { describe, expect, it } from "bun:test";
import { TransferState, TRANSFER_STATE, makeStateKey } from "./transfer_state";
import { createEnvironmentInjector } from "./inject";

describe("Angular Universal TransferState for SSR/Hydration", () => {
  interface UserSession {
    id: string;
    role: string;
  }

  const USER_KEY = makeStateKey<UserSession>("current_user");
  const THEME_KEY = makeStateKey<string>("app_theme");

  it("stores and retrieves state with type safety", () => {
    const state = new TransferState();
    expect(state.isEmpty()).toBe(true);
    expect(state.hasKey(USER_KEY)).toBe(false);

    state.set(USER_KEY, { id: "usr_101", role: "admin" });
    expect(state.isEmpty()).toBe(false);
    expect(state.hasKey(USER_KEY)).toBe(true);

    const session = state.get(USER_KEY, { id: "guest", role: "anonymous" });
    expect(session).toEqual({ id: "usr_101", role: "admin" });

    const theme = state.get(THEME_KEY, "dark");
    expect(theme).toBe("dark");
  });

  it("supports remove() and key deletion", () => {
    const state = new TransferState();
    state.set(THEME_KEY, "light");
    expect(state.hasKey(THEME_KEY)).toBe(true);

    state.remove(THEME_KEY);
    expect(state.hasKey(THEME_KEY)).toBe(false);
    expect(state.isEmpty()).toBe(true);
  });

  it("serializes to and deserializes from JSON", () => {
    const serverState = new TransferState();
    serverState.set(USER_KEY, { id: "usr_202", role: "viewer" });
    serverState.set(THEME_KEY, "nord");

    const json = serverState.toJson();
    expect(typeof json).toBe("string");
    expect(json).toContain("usr_202");

    // Client hydration from serialized string
    const clientState = TransferState.fromJson(json);
    expect(clientState.hasKey(USER_KEY)).toBe(true);
    expect(clientState.get(USER_KEY, { id: "", role: "" })).toEqual({ id: "usr_202", role: "viewer" });
    expect(clientState.get(THEME_KEY, "default")).toBe("nord");
  });

  it("can be injected via TRANSFER_STATE token in an EnvironmentInjector", () => {
    const env = createEnvironmentInjector([]);
    const ts = env.get(TRANSFER_STATE);
    expect(ts).toBeInstanceOf(TransferState);

    ts.set(THEME_KEY, "solarized");
    expect(ts.get(THEME_KEY, "light")).toBe("solarized");
  });
});
