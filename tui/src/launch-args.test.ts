import { describe, expect, test } from "bun:test";
import { parseLaunchArgs } from "./launch-args";

describe("launch arguments", () => {
  test("defaults to the local daemon", () => {
    expect(parseLaunchArgs([])).toEqual({ sshAlias: null, showHelp: false });
  });

  test("accepts --ssh as a separate or joined value", () => {
    expect(parseLaunchArgs(["--ssh", "whale"]).sshAlias).toBe("whale");
    expect(parseLaunchArgs(["--ssh=home-server"]).sshAlias).toBe("home-server");
  });

  test("rejects missing, repeated, unsafe, and unknown arguments", () => {
    expect(() => parseLaunchArgs(["--ssh"])).toThrow("requires an SSH alias");
    expect(() => parseLaunchArgs(["--ssh", "--help"])).toThrow("requires an SSH alias");
    expect(() => parseLaunchArgs(["--ssh", "a", "--ssh", "b"])).toThrow("only be specified once");
    expect(() => parseLaunchArgs(["--ssh=host;touch /tmp/nope"])).toThrow("Invalid --ssh alias");
    expect(() => parseLaunchArgs(["--remote"])).toThrow("Unknown option: --remote");
  });

  test("recognizes help", () => {
    expect(parseLaunchArgs(["-h"]).showHelp).toBe(true);
    expect(parseLaunchArgs(["--help"]).showHelp).toBe(true);
  });
});
