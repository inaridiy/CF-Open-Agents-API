import * as clack from "@clack/prompts";

import { CliError, type Plan } from "./plan.js";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Every question the CLI asks; `--yes` answers each with its initial value. */
export interface Prompter {
  text(message: string, initial: string): Promise<string>;
  select<T extends string>(message: string, choices: readonly Choice<T>[], initial: T): Promise<T>;
  multiselect<T extends string>(
    message: string,
    choices: readonly Choice<T>[],
    initial: readonly T[],
  ): Promise<T[]>;
  confirm(message: string, initial: boolean): Promise<boolean>;
  password(message: string): Promise<string>;
}

export interface Reporter {
  intro(title: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** Runs a slow step with a spinner; the label is replaced by the result. */
  spin<T>(label: string, work: () => Promise<T>, done: (result: T) => string): Promise<T>;
  note(message: string, title: string): void;
  /** The final report: what was created, updated and skipped, under a one-line verdict. */
  plan(plan: Plan, title: string): void;
  outro(message: string): void;
}

const cancelled = (): never => {
  clack.cancel("Cancelled.");
  throw new CliError("Cancelled.");
};
function unwrap<T>(value: T | typeof clack.CANCEL_SYMBOL): T {
  if (clack.isCancel(value)) return cancelled();
  return value;
}
/** clack's Option type is conditional on the value type, which a generic cannot resolve. */
const options = <T extends string>(choices: readonly Choice<T>[]) =>
  choices.map((choice) => ({ ...choice })) as unknown as clack.Option<T>[];

/** Interactive prompts on a terminal. */
export function clackPrompter(): Prompter {
  return {
    text: async (message, initial) =>
      unwrap(await clack.text({ message, placeholder: initial, defaultValue: initial })) || initial,
    select: async (message, choices, initial) =>
      unwrap(await clack.select({ message, options: options(choices), initialValue: initial })),
    multiselect: async (message, choices, initial) =>
      unwrap(
        await clack.multiselect({
          message,
          options: options(choices),
          initialValues: [...initial],
          required: false,
        }),
      ),
    confirm: async (message, initial) =>
      unwrap(await clack.confirm({ message, initialValue: initial })),
    password: async (message) => unwrap(await clack.password({ message })),
  };
}

/** `--yes`: every answer is the default. */
export function defaultPrompter(): Prompter {
  return {
    text: (_message, initial) => Promise.resolve(initial),
    select: (_message, _choices, initial) => Promise.resolve(initial),
    multiselect: (_message, _choices, initial) => Promise.resolve([...initial]),
    confirm: (_message, initial) => Promise.resolve(initial),
    password: () =>
      Promise.reject(
        new CliError("A secret value is needed; run without --yes or pass --from-env."),
      ),
  };
}

export function clackReporter(): Reporter {
  return {
    intro: (title) => clack.intro(title),
    info: (message) => clack.log.info(message),
    warn: (message) => clack.log.warn(message),
    spin: async (label, work, done) => {
      const spinner = clack.spinner();
      spinner.start(label);
      try {
        const result = await work();
        spinner.stop(done(result));
        return result;
      } catch (error) {
        spinner.error(label);
        throw error;
      }
    },
    note: (message, title) => clack.note(message, title),
    plan: (plan, title) => {
      clack.note(plan.body(), title);
      clack.outro(title);
    },
    outro: (message) => clack.outro(message),
  };
}

/** Plain lines for non-interactive runs and tests. */
export function plainReporter(
  write: (line: string) => void = (line) => console.log(line),
): Reporter {
  return {
    intro: (title) => write(title),
    info: (message) => write(`ℹ ${message}`),
    warn: (message) => write(`⚠ ${message}`),
    spin: async (label, work, done) => {
      const result = await work();
      write(done(result));
      return result;
    },
    note: (message, title) => write(`\n${title}\n${message}`),
    plan: (plan, title) => write(`\n${plan.render(title)}`),
    outro: (message) => write(`\n${message}`),
  };
}

export const interactive = (): boolean => process.stdin.isTTY && process.stdout.isTTY;
