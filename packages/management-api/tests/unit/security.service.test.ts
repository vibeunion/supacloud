import { describe, test, expect, spyOn } from "bun:test";
import { addFirewallRule, requestSsl } from "../../src/services/security.service";
import { shellService } from "../../src/services/shell.service";

describe("SecurityService", () => {
    test("addFirewallRule should call security_manager.sh", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await addFirewallRule(5432, "1.2.3.4");
        expect(result.message).toContain("opened");
        expect(spy).toHaveBeenCalledWith("security_manager.sh", ["add_firewall_rule", "5432", "1.2.3.4"]);

        spy.mockRestore();
    });

    test("requestSsl should trigger async cert generation", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await requestSsl("example.com");
        expect(result.message).toContain("SSL");
        expect(spy).toHaveBeenCalled();

        spy.mockRestore();
    });
});
