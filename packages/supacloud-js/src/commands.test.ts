import { describe, expect, mock, test } from "bun:test";
import { createSupaCloudClient } from "./index";

function commandClient() {
  const rpc = mock(async (functionName: string, params: { request: object }) => ({
    data: { functionName, params }, error: null,
  }));
  const supabase = { rpc, auth: { getSession: async () => ({ data: { session: null }, error: null }) } };
  return {
    commands: createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "http://management-not-used",
      projectRef: "project-ref",
    }).commands,
    rpc,
  };
}

describe("SupaCloud command receipts client", () => {
  test("maps submit and get to service-role RPCs", async () => {
    const { commands, rpc } = commandClient();
    const request = {
      commandId: "11111111-1111-4111-8111-111111111111",
      commandType: "report.issue",
      targetType: "report",
      targetId: "report-1",
      actorId: "22222222-2222-4222-8222-222222222222",
      payload: { reportId: "report-1" },
      maxAttempts: 4,
    };
    await commands.submit(request);
    await commands.get(request.commandId);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[0]).toBe("supacloud_command_submit");
    expect(rpc.mock.calls[1]?.[0]).toBe("supacloud_command_get");
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ request });
  });
});
