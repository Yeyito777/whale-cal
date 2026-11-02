import { validateSshAlias } from "./ssh-transport";

export interface LaunchOptions {
  sshAlias: string | null;
  showHelp: boolean;
}

export const LAUNCH_USAGE = [
  "Usage: whale-cal [options]",
  "",
  "Options:",
  "  --ssh <alias>  Connect to cald through this SSH alias on launch",
  "  -h, --help     Show this help",
].join("\n");

export function parseLaunchArgs(args: readonly string[]): LaunchOptions {
  const options: LaunchOptions = { sshAlias: null, showHelp: false };

  const setSshAlias = (alias: string | undefined): void => {
    if (!alias || alias.startsWith("-")) throw new Error("--ssh requires an SSH alias.");
    if (options.sshAlias !== null) throw new Error("--ssh may only be specified once.");
    const error = validateSshAlias(alias);
    if (error) throw new Error(`Invalid --ssh alias: ${error}`);
    options.sshAlias = alias;
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--ssh") setSshAlias(args[++index]);
    else if (arg.startsWith("--ssh=")) setSshAlias(arg.slice("--ssh=".length));
    else if (arg === "--help" || arg === "-h") options.showHelp = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}
