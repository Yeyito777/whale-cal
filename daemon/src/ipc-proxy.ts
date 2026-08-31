import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";

export async function runIpcProxy(
  path: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    let connected = false;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      input.unpipe(socket);
      socket.unpipe(output);
      if (error) reject(error); else resolve();
    };
    socket.once("connect", () => {
      connected = true;
      input.pipe(socket);
      socket.pipe(output, { end: false });
    });
    socket.once("error", error => finish(new Error(`cannot connect to cald: ${error.message}`)));
    socket.once("end", () => { socket.destroy(); finish(); });
    socket.once("close", () => finish(connected ? undefined : new Error("cald connection closed")));
  });
}
