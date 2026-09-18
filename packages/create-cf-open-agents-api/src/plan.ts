export type StepStatus = "created" | "updated" | "skipped";

/** One idempotent change; `note` explains a skip or a decision the user should know about. */
export interface StepResult {
  status: StepStatus;
  file: string;
  note?: string;
}

/** An expected failure: printed as one line, exit code 1, no stack trace. */
export class CliError extends Error {
  override readonly name = "CliError";
}

export class Plan {
  readonly created: string[] = [];
  readonly updated: string[] = [];
  readonly skipped: string[] = [];
  readonly notes: string[] = [];

  /** A file touched twice is listed once, under its first status. */
  add(result: StepResult): StepResult {
    const listed = [...this.created, ...this.updated, ...this.skipped].includes(result.file);
    if (!listed) this[result.status].push(result.file);
    if (result.note) this.notes.push(result.note);
    return result;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** The Created/Updated/Skipped/Notes report, one bullet per file. */
  render(title: string): string {
    return `${title}\n${this.body()}`;
  }

  body(): string {
    const block = (heading: string, items: readonly string[]) =>
      items.length === 0 ? [] : [heading, ...items.map((item) => `  - ${item}`)];
    return [
      ...block("Created", this.created),
      ...block("Updated", this.updated),
      ...block("Skipped", this.skipped),
      ...block("Notes", this.notes),
    ].join("\n");
  }
}
