import type { ICommand } from './types.js';

/** Inputs required to render top-level or command-scoped help. */
export interface IHelpRenderInput {
  /** Application name displayed in the welcome heading. */
  scriptName: string;
  /** Optional application version displayed beside the name. */
  version?: string;
  /** Registered commands in presentation order. */
  commands: readonly ICommand[];
  /** Selected command for command-scoped help. */
  command?: ICommand;
  /** Already rendered validation messages. */
  errors: readonly string[];
  /** Suppresses error presentation for a clean help request. */
  helpOnly: boolean;
  /** Receives rendered lines; defaults to the process console. */
  write?: (message: string) => void;
}

/**
 * Renders the package's established text help without making parser decisions.
 *
 * @param input Application metadata, command context, and prepared messages.
 */
export function renderCommandLineHelp(input: IHelpRenderInput): void {
  const write = input.write ?? console.log;
  write(`Welcome to ${input.scriptName} ${input.version}`);

  if (!input.helpOnly) {
    const errorTable: string[][] = [];
    if (input.errors.length !== 0) {
      write(input.command ? `\nErrors: (${input.command.name} command)\n` : '\nError:\n');
      input.errors.forEach(error => errorTable.push(['\t', `- ${error}`]));
    }
    printTable(errorTable, write);
  }

  if (!input.command) {
    write(input.commands.length !== 0 ? '\nCommands:\n' : '');
    const commandTable = input.commands.map(command => [
      '\t',
      command.name || '(default)',
      '\t\t',
      command.description || '',
      command.default ? `[default command]` : '',
    ]);
    printTable(commandTable, write);
    return;
  }

  write('\nCommand:\n');
  printTable(
    [
      [
        '\t',
        input.command.name,
        '\t\t',
        input.command.description || '',
        '\t',
        input.command.default ? `[default command]` : '',
      ],
    ],
    write
  );

  write('\nOptions:\n');
  const optionTable = (input.command.options ?? []).map(option => [
    '\t',
    `--${option.name}`,
    option.short ? ` | -${option.short}` : '',
    '\t\t',
    option.description || 'No description!',
    '\t',
    option.required ? '[required]' : '',
    option.multiple ? '[multiple]' : '',
    option.default !== undefined ? `[default:${option.default}]` : '',
    `[${option.type || 'string'}]`,
  ]);
  printTable(optionTable, write);
}

/** Aligns columns while preserving the existing plain-text output contract. */
function printTable(table: readonly (readonly string[])[], write: (message: string) => void): void {
  const columnSizes: number[] = [];
  for (const row of table) {
    row.forEach((column, index) => {
      columnSizes[index] = Math.max(columnSizes[index] ?? 0, column.length);
    });
  }

  const rendered = table
    .map(row =>
      row
        .map((column, index) => column.padEnd(columnSizes[index] ?? 0, ' '))
        .join('')
        .trimEnd()
    )
    .join('\n')
    .trimEnd();
  write(rendered);
}
