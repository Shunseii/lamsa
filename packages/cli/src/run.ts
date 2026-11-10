import { reportError } from "./output.js";

export async function checkCommandResult(task: () => Promise<number>, json: boolean): Promise<void> {
  try {
    process.exitCode = await task();
  } catch (error) {
    process.exitCode = reportError(error, json);
  }
}
