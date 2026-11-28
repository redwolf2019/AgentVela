import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["agentvela", "agentvela-dev", "agentvela-preview"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "agentvela://attacker/welcome",
    "agentvela://app/welcome/../evil",
    "https://attacker.example/welcome",
    "https://app.t3.codes/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());

  it("allows explicitly allowlisted hosted origins", () => {
    expect(
      providerAuthReturnUrl("https://hosted.example.com/welcome?code=secret#agents:machine-id", [
        "https://hosted.example.com",
      ]),
    ).toBe("https://hosted.example.com/welcome#agents:machine-id");
  });
});
