import type { Issue } from "@lamsa/core";

export const ExitCode = {
  ok: 0,
  invalid: 1,
  usage: 2,
  notFound: 3,
  renderFailed: 4,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = ExitCode.usage,
    readonly fix?: string,
    readonly nodeId?: string,
  ) {
    super(message);
  }
}

export interface Output {
  json: boolean;
  result(data: unknown, human: () => string): void;
}

export function createOutput(json: boolean): Output {
  return {
    json,
    result(data, human) {
      if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      else {
        const text = human();
        if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
      }
    },
  };
}

export function formatIssue(issue: Issue): string {
  const where = [issue.file, issue.nodeId].filter(Boolean).join(" ");
  const fix = issue.fix ? `\n    fix: ${issue.fix}` : "";
  return `${issue.severity === "error" ? "error" : "warn "} ${where ? `${where}: ` : ""}${issue.message} [${issue.code}]${fix}`;
}

export function reportError(error: unknown, json: boolean): number {
  const cli =
    error instanceof CliError
      ? error
      : error && typeof error === "object" && "fix" in error
        ? new CliError(
            (error as unknown as Error).message,
            (error as { notFound?: boolean }).notFound ? ExitCode.notFound : ExitCode.usage,
            (error as { fix?: string }).fix,
            (error as { nodeId?: string }).nodeId,
          )
        : new CliError((error as Error)?.message ?? String(error), ExitCode.usage);
  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: { message: cli.message, fix: cli.fix, nodeId: cli.nodeId } }, null, 2) + "\n",
    );
  } else {
    process.stderr.write(`lamsa: ${cli.message}\n${cli.fix ? `  fix: ${cli.fix}\n` : ""}`);
  }
  return cli.exitCode;
}
