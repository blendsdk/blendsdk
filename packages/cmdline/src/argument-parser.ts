import type { ICommand, ICommandOption, OptionValueType, OptionsDict } from './types.js';

/** Selects exact strict lookup or normalized legacy lookup. */
export type ArgumentLookupMode = 'strict' | 'legacy';

/** Classifies a token-level problem without coupling token consumption to public error classes. */
export type ArgumentIssueKind =
  | 'malformed-argument'
  | 'unknown-command'
  | 'unknown-option'
  | 'unexpected-argument';

/** Describes one parser-owned problem at its original argument position. */
export interface IArgumentIssue {
  /** Stable problem category used by the command-line orchestrator. */
  kind: ArgumentIssueKind;
  /** Original argument text supplied by the caller. */
  argument: string;
  /** Zero-based position within the application argument list. */
  index: number;
  /** Canonical command or parser name that provides diagnostic context. */
  commandName?: string;
  /** Parsed option name without its leading dash characters. */
  optionName?: string;
  /** Durable explanation for malformed input. */
  reason?: string;
}

/** Records an explicitly supplied option and the value derived from its source token. */
export interface IOptionOccurrence {
  /** Canonical option definition selected by exact or normalized lookup. */
  option: ICommandOption;
  /** Converted value passed to later semantic validation. */
  value: OptionValueType;
  /** Position of the option token within the application argument list. */
  index: number;
  /** Original option spelling, including dash characters and attached values. */
  spelling: string;
}

/** Holds the lookup tables required for deterministic command and option recognition. */
export interface IArgumentRegistry {
  /** Application name used when no command can provide error context. */
  parserName: string;
  /** Commands and aliases keyed by their declared, case-sensitive spelling. */
  strictCommands: ReadonlyMap<string, ICommand>;
  /** Commands and aliases keyed by their lower-cased legacy identity. */
  legacyCommands: ReadonlyMap<string, ICommand>;
  /** Effective default command, when the configuration permits one. */
  defaultCommand?: ICommand;
  /** Global options keyed by their declared long names. */
  strictGlobalLongOptions: ReadonlyMap<string, ICommandOption>;
  /** Global options keyed by their declared short names. */
  strictGlobalShortOptions: ReadonlyMap<string, ICommandOption>;
  /** Global options keyed by lower-cased long names for legacy lookup. */
  legacyGlobalLongOptions: ReadonlyMap<string, ICommandOption>;
  /** Global options keyed by lower-cased short names for legacy lookup. */
  legacyGlobalShortOptions: ReadonlyMap<string, ICommandOption>;
}

/** Contains the complete invocation-local result of token recognition and value consumption. */
export interface IArgumentParseResult {
  /** Canonical command selected by an explicit spelling or by the default rule. */
  command?: ICommand;
  /** Index of the explicit command token, absent for a default command. */
  commandIndex?: number;
  /** Canonical option values accumulated for this invocation only. */
  options: OptionsDict;
  /** Explicit occurrences retained for conflicts, dependencies, and implementation tests. */
  occurrences: readonly IOptionOccurrence[];
  /** Token problems ordered by their original argument positions. */
  issues: readonly IArgumentIssue[];
}

/** Configuration used to build immutable argument lookup tables. */
export interface IArgumentRegistryInput {
  /** Application name used for top-level diagnostics. */
  parserName: string;
  /** Registered commands in presentation order. */
  commands: readonly ICommand[];
  /** Options that are available regardless of command selection. */
  globalOptions?: readonly ICommandOption[];
}

/** Provides long and short option lookup tables for one visibility scope. */
interface IOptionLookup {
  long: ReadonlyMap<string, ICommandOption>;
  short: ReadonlyMap<string, ICommandOption>;
}

/** Separates an option token's spelling from an optional attached value. */
interface IParsedOptionToken {
  name: string;
  attachedValue?: string;
  isLong: boolean;
}

/** Captures explicit, default, or failed command selection before option parsing. */
interface ICommandSelection {
  command?: ICommand;
  commandIndex?: number;
  unknownCommand?: IArgumentIssue;
}

/**
 * Builds command and global-option lookup tables without retaining invocation state.
 *
 * @param input Registered commands, global options, and parser diagnostic name.
 * @returns Lookup tables suitable for repeated parser executions.
 */
export function createArgumentRegistry(input: IArgumentRegistryInput): IArgumentRegistry {
  const strictCommands = new Map<string, ICommand>();
  const legacyCommands = new Map<string, ICommand>();
  const strictGlobalLongOptions = new Map<string, ICommandOption>();
  const strictGlobalShortOptions = new Map<string, ICommandOption>();
  const legacyGlobalLongOptions = new Map<string, ICommandOption>();
  const legacyGlobalShortOptions = new Map<string, ICommandOption>();

  for (const command of input.commands) {
    registerCommandSpelling(strictCommands, legacyCommands, command.name, command);
    for (const alias of command.aliases ?? []) {
      registerCommandSpelling(strictCommands, legacyCommands, alias, command);
    }
  }

  for (const option of input.globalOptions ?? []) {
    registerOptionSpelling(
      strictGlobalLongOptions,
      strictGlobalShortOptions,
      legacyGlobalLongOptions,
      legacyGlobalShortOptions,
      option
    );
  }

  return {
    parserName: input.parserName,
    strictCommands,
    legacyCommands,
    defaultCommand:
      input.commands.length === 1 ? input.commands.find(command => command.default) : undefined,
    strictGlobalLongOptions,
    strictGlobalShortOptions,
    legacyGlobalLongOptions,
    legacyGlobalShortOptions,
  };
}

/**
 * Recognizes commands and options while retaining every unconsumed argument as an issue.
 *
 * The function has no process, output, or handler side effects. Every returned collection is new
 * for the invocation, so callers can safely reuse one registry across multiple executions.
 *
 * @param args Application arguments without interpreter and script entries.
 * @param registry Immutable command and option lookup tables.
 * @param mode Exact strict lookup or normalized legacy lookup.
 * @returns Invocation-local command selection, values, occurrences, and ordered issues.
 */
export function parseArguments(
  args: readonly string[],
  registry: IArgumentRegistry,
  mode: ArgumentLookupMode
): IArgumentParseResult {
  const selection = selectCommand(args, registry, mode);
  const options: OptionsDict = {};
  const occurrences: IOptionOccurrence[] = [];
  const issues: IArgumentIssue[] = selection.unknownCommand ? [selection.unknownCommand] : [];
  const commandLookup = createOptionLookup(selection.command?.options ?? [], mode);
  const globalLookup = globalOptionLookup(registry, mode);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (index === selection.commandIndex) {
      continue;
    }

    if (argument === '-' || argument === '--') {
      issues.push({
        kind: 'malformed-argument',
        argument,
        index,
        commandName: selection.command?.name,
        reason: 'Invalid option format',
      });
      continue;
    }

    if (isOptionToken(argument)) {
      const parsed = parseOptionToken(argument);
      if (!parsed) {
        issues.push({
          kind: 'malformed-argument',
          argument,
          index,
          commandName: selection.command?.name,
          reason: 'Invalid option name format',
        });
        continue;
      }

      const beforeExplicitCommand =
        selection.commandIndex !== undefined && index < selection.commandIndex;
      const option =
        findOption(parsed, globalLookup, mode) ??
        (beforeExplicitCommand ? undefined : findOption(parsed, commandLookup, mode));

      if (!option) {
        issues.push({
          kind: 'unknown-option',
          argument,
          index,
          optionName: parsed.name,
          commandName: selection.command?.name ?? registry.parserName,
        });
        continue;
      }

      const consumed = consumeOptionValue(args, index, parsed, option);
      if (!consumed.hasValue) {
        issues.push({
          kind: 'malformed-argument',
          argument,
          index,
          commandName: selection.command?.name,
          optionName: option.name,
          reason: `Option [${option.name}] requires a value`,
        });
        continue;
      }

      const value = convertOptionValue(consumed.value, option);
      storeOptionValue(options, option, value);
      occurrences.push({ option, value, index, spelling: argument });
      index += consumed.additionalTokens;
      continue;
    }

    if (selection.unknownCommand?.index === index) {
      continue;
    }

    issues.push({
      kind: 'unexpected-argument',
      argument,
      index,
      commandName: selection.command?.name,
    });
  }

  issues.sort((left, right) => left.index - right.index);
  return {
    command: selection.command,
    commandIndex: selection.commandIndex,
    options,
    occurrences,
    issues,
  };
}

/**
 * Finds a legacy command only when every earlier token is a valid global option or its value.
 *
 * Legacy mode historically recognized an explicit command at the first application position.
 * Global options extend that rule, but an unknown or malformed leading token must not allow a
 * later command to run. This focused scan avoids performing and discarding a complete parse.
 *
 * @param args Application arguments without interpreter and script entries.
 * @param registry Registered command and global-option lookup tables.
 * @returns The explicit command index, or `undefined` when no safe command can be selected.
 */
export function findLegacyCommandIndex(
  args: readonly string[],
  registry: IArgumentRegistry
): number | undefined {
  const globalLookup = globalOptionLookup(registry, 'strict');

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument === '-' || argument === '--') {
      return undefined;
    }

    if (isOptionToken(argument)) {
      const parsed = parseOptionToken(argument);
      const option = parsed ? findOption(parsed, globalLookup, 'strict') : undefined;
      if (!parsed || !option) {
        return undefined;
      }

      const consumed = consumeOptionValue(args, index, parsed, option);
      if (!consumed.hasValue) {
        return undefined;
      }
      index += consumed.additionalTokens;
      continue;
    }

    return registry.legacyCommands.has(argument.toLowerCase()) ? index : undefined;
  }

  return undefined;
}

/** Registers one declared command spelling without silently replacing an earlier owner. */
function registerCommandSpelling(
  strictCommands: Map<string, ICommand>,
  legacyCommands: Map<string, ICommand>,
  spelling: string,
  command: ICommand
): void {
  if (!strictCommands.has(spelling)) {
    strictCommands.set(spelling, command);
  }
  const normalized = spelling.toLowerCase();
  if (!legacyCommands.has(normalized)) {
    legacyCommands.set(normalized, command);
  }
}

/** Registers one global option in the exact and normalized lookup tables. */
function registerOptionSpelling(
  strictLong: Map<string, ICommandOption>,
  strictShort: Map<string, ICommandOption>,
  legacyLong: Map<string, ICommandOption>,
  legacyShort: Map<string, ICommandOption>,
  option: ICommandOption
): void {
  if (!strictLong.has(option.name)) {
    strictLong.set(option.name, option);
  }
  const normalizedLong = option.name.toLowerCase();
  if (!legacyLong.has(normalizedLong)) {
    legacyLong.set(normalizedLong, option);
  }
  if (option.short) {
    if (!strictShort.has(option.short)) {
      strictShort.set(option.short, option);
    }
    const normalizedShort = option.short.toLowerCase();
    if (!legacyShort.has(normalizedShort)) {
      legacyShort.set(normalizedShort, option);
    }
  }
}

/** Finds the first eligible command token while respecting values consumed by leading options. */
function selectCommand(
  args: readonly string[],
  registry: IArgumentRegistry,
  mode: ArgumentLookupMode
): ICommandSelection {
  const scanLookup = mergeOptionLookups(
    globalOptionLookup(registry, mode),
    createOptionLookup(registry.defaultCommand?.options ?? [], mode)
  );

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument === '-' || argument === '--') {
      continue;
    }
    if (isOptionToken(argument)) {
      const parsed = parseOptionToken(argument);
      const option = parsed ? findOption(parsed, scanLookup, mode) : undefined;
      if (parsed && option) {
        index += consumeOptionValue(args, index, parsed, option).additionalTokens;
      }
      continue;
    }

    const command = findCommand(argument, registry, mode);
    if (command) {
      return { command, commandIndex: index };
    }
    return {
      unknownCommand: {
        kind: 'unknown-command',
        argument,
        index,
        commandName: argument,
      },
    };
  }

  return { command: registry.defaultCommand };
}

/** Resolves a command using the lookup rules selected for this invocation. */
function findCommand(
  spelling: string,
  registry: IArgumentRegistry,
  mode: ArgumentLookupMode
): ICommand | undefined {
  return mode === 'strict'
    ? registry.strictCommands.get(spelling)
    : registry.legacyCommands.get(spelling.toLowerCase());
}

/** Returns the global option tables for exact or normalized lookup. */
function globalOptionLookup(registry: IArgumentRegistry, mode: ArgumentLookupMode): IOptionLookup {
  return mode === 'strict'
    ? { long: registry.strictGlobalLongOptions, short: registry.strictGlobalShortOptions }
    : { long: registry.legacyGlobalLongOptions, short: registry.legacyGlobalShortOptions };
}

/** Builds invocation-independent long and short lookup tables for an option collection. */
function createOptionLookup(
  options: readonly ICommandOption[],
  mode: ArgumentLookupMode
): IOptionLookup {
  const long = new Map<string, ICommandOption>();
  const short = new Map<string, ICommandOption>();
  for (const option of options) {
    const longName = mode === 'strict' ? option.name : option.name.toLowerCase();
    if (!long.has(longName)) {
      long.set(longName, option);
    }
    if (option.short) {
      const shortName = mode === 'strict' ? option.short : option.short.toLowerCase();
      if (!short.has(shortName)) {
        short.set(shortName, option);
      }
    }
  }
  return { long, short };
}

/** Merges lookup scopes while giving the first scope deterministic precedence. */
function mergeOptionLookups(first: IOptionLookup, second: IOptionLookup): IOptionLookup {
  return {
    long: new Map([...second.long, ...first.long]),
    short: new Map([...second.short, ...first.short]),
  };
}

/** Resolves a parsed option spelling through its matching long or short table. */
function findOption(
  parsed: IParsedOptionToken,
  lookup: IOptionLookup,
  mode: ArgumentLookupMode
): ICommandOption | undefined {
  const name = mode === 'strict' ? parsed.name : parsed.name.toLowerCase();
  return parsed.isLong ? lookup.long.get(name) : lookup.short.get(name);
}

/** Distinguishes option-shaped input from negative numeric values. */
function isOptionToken(argument: string): boolean {
  return argument.startsWith('-') && !isNegativeNumber(argument);
}

/** Recognizes the negative decimal forms that numeric options may consume as values. */
function isNegativeNumber(argument: string): boolean {
  return /^-\d+(?:\.\d+)?$/.test(argument);
}

/** Parses supported long and compact short spellings without consuming a neighboring token. */
function parseOptionToken(argument: string): IParsedOptionToken | undefined {
  if (argument.startsWith('--')) {
    const content = argument.slice(2);
    const separator = content.indexOf('=');
    const name = separator >= 0 ? content.slice(0, separator) : content;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      return undefined;
    }
    return {
      name,
      attachedValue: separator >= 0 ? content.slice(separator + 1) : undefined,
      isLong: true,
    };
  }

  const content = argument.slice(1);
  const name = content.slice(0, 1);
  if (!/^[a-zA-Z]$/.test(name)) {
    return undefined;
  }
  const remainder = content.slice(1);
  return {
    name,
    attachedValue:
      remainder.length > 0
        ? remainder.startsWith('=')
          ? remainder.slice(1)
          : remainder
        : undefined,
    isLong: false,
  };
}

/** Determines an option's raw value and how many following tokens it consumes. */
function consumeOptionValue(
  args: readonly string[],
  index: number,
  parsed: IParsedOptionToken,
  option: ICommandOption
): { hasValue: boolean; value: string | boolean; additionalTokens: number } {
  if (parsed.attachedValue !== undefined) {
    return { hasValue: true, value: parsed.attachedValue, additionalTokens: 0 };
  }

  const next = args[index + 1];
  if ((option.type ?? 'string') === 'boolean') {
    if (next === 'true' || next === 'false') {
      return { hasValue: true, value: next, additionalTokens: 1 };
    }
    return { hasValue: true, value: true, additionalTokens: 0 };
  }

  if (next !== undefined && (!isOptionToken(next) || isNumericOptionValue(next, option))) {
    return { hasValue: true, value: next, additionalTokens: 1 };
  }
  return { hasValue: false, value: '', additionalTokens: 0 };
}

/** Allows only registered numeric options to consume option-shaped negative values. */
function isNumericOptionValue(value: string, option: ICommandOption): boolean {
  return option.type === 'number' && isNegativeNumber(value);
}

/** Converts unambiguous boolean and numeric text while retaining invalid text for validation. */
function convertOptionValue(value: string | boolean, option: ICommandOption): OptionValueType {
  if (typeof value === 'boolean') {
    return value;
  }
  if (option.type === 'boolean') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  }
  if (option.type === 'number') {
    const trimmed = value.trim();
    const converted = Number(trimmed);
    return trimmed.length > 0 && Number.isFinite(converted) ? converted : value;
  }
  return value;
}

/** Stores a canonical value using either last-value or explicit accumulation semantics. */
function storeOptionValue(
  options: OptionsDict,
  option: ICommandOption,
  value: OptionValueType
): void {
  if (option.multiple) {
    const previous = options[option.name];
    if (Array.isArray(previous)) {
      previous.push(value);
    } else {
      options[option.name] = [value];
    }
    return;
  }
  options[option.name] = value;
}
