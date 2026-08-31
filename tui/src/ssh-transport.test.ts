import { describe, expect, test } from "bun:test";
import { sshProxyArgs, validateSshAlias } from "./ssh-transport";

describe("SSH transport", () => {
  test("uses a compressed noninteractive stdio proxy", () => {
    expect(sshProxyArgs("home")).toEqual([
      "-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "home", "cald", "proxy",
    ]);
  });

  test("rejects option and shell injection", () => {
    expect(validateSshAlias("home-server")).toBeNull();
    expect(validateSshAlias("-oProxyCommand=bad")).not.toBeNull();
    expect(validateSshAlias("host;touch /tmp/nope")).not.toBeNull();
  });
});
