import { describe, expect, test } from "bun:test";
import { sshProxyArgs, validateSshAlias } from "./ssh-transport";

describe("SSH transport", () => {
  test("uses a compressed noninteractive stdio proxy that never joins a foreign master", () => {
    expect(sshProxyArgs("home")).toEqual([
      "-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "ControlPath=none",
      "home", "cald", "proxy",
    ]);
  });

  test("shares one connection through a private control socket when reusing", () => {
    const reuse = sshProxyArgs("home", { controlPath: "/run/x/ssh/home%.sock", persist: "10m" });
    expect(reuse).not.toContain("ControlPath=none");
    expect(reuse).toContain("ControlMaster=auto");
    expect(reuse).toContain("ControlPath=/run/x/ssh/home%%.sock");
    expect(reuse).toContain("ControlPersist=10m");
    expect(reuse.slice(-3)).toEqual(["home", "cald", "proxy"]);
  });

  test("rejects option and shell injection", () => {
    expect(validateSshAlias("home-server")).toBeNull();
    expect(validateSshAlias("-oProxyCommand=bad")).not.toBeNull();
    expect(validateSshAlias("host;touch /tmp/nope")).not.toBeNull();
  });
});
