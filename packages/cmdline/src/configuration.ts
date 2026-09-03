import { InvalidConfigurationError } from './errors.js';
import type { ICommand, ICommandLineParser, ICommandOption } from './types.js';

/**
 * Copies an option definition and every mutable collection it owns.
 *
 * Registration is a trust boundary: callers may reuse or mutate the objects they passed in, but
 * those later changes must not alter parser behavior after validation has succeeded.
 */
function cloneOptionConfiguration(option: ICommandOption): ICommandOption {
  return {
    ...option,
    choices: option.choices ? [...option.choices] : undefined,
    conflicts: option.conflicts ? [...option.conflicts] : undefined,
    depends: option.depends ? [...option.depends] : undefined,
  };
}

/**
 * Creates parser-owned configuration without retaining caller-owned mutable objects.
 *
 * @param config Optional caller configuration.
 * @returns A detached parser configuration with compatibility defaults applied.
 */
export function cloneParserConfiguration(config?: ICommandLineParser): ICommandLineParser {
  const source = config ?? { name: 'default' };
  return {
    ...source,
    version: source.version ?? '1.0',
    helpOption: source.helpOption ? { ...source.helpOption } : undefined,
    globalOptions: source.globalOptions?.map(cloneOptionConfiguration),
  };
}

/**
 * Creates a parser-owned command definition without retaining caller-owned mutable objects.
 *
 * Nested commands are copied recursively even though current execution uses only the top-level
 * registry. This keeps the ownership boundary complete if subcommand support is activated later.
 *
 * @param command Caller-supplied command definition.
 * @returns A detached command definition suitable for validation and storage.
 */
export function cloneCommandConfiguration(
  command: ICommand
): ICommand & { options: ICommandOption[] } {
  return {
    ...command,
    aliases: command.aliases ? [...command.aliases] : undefined,
    examples: command.examples ? [...command.examples] : undefined,
    options: (command.options ?? []).map(cloneOptionConfiguration),
    subcommands: command.subcommands?.map(cloneCommandConfiguration),
  };
}

/**
 * Validates one command and its options against package configuration rules.
 *
 * @param command Candidate command definition.
 * @param existingCommands Commands already owned by the parser.
 * @throws {InvalidConfigurationError} When a name, option, or relationship is invalid.
 */
export function validateCommandConfiguration(
  command: ICommand,
  existingCommands: readonly ICommand[],
  globalOptions: readonly ICommandOption[] = [],
  automaticHelp = true
): void {
  if (!command.name || typeof command.name !== 'string') {
    throw new InvalidConfigurationError(
      'command.name',
      'Command name is required and must be a string'
    );
  }

  if (['help', 'version'].includes(command.name.toLowerCase())) {
    throw new InvalidConfigurationError(
      'command.name',
      `Command name '${command.name}' is reserved`
    );
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(command.name)) {
    throw new InvalidConfigurationError(
      'command.name',
      'Command name must start with a letter and contain only letters, numbers, hyphens, and underscores'
    );
  }

  const registeredSpellings = commandSpellings(existingCommands);
  if (registeredSpellings.has(command.name.toLowerCase())) {
    throw new InvalidConfigurationError('command.name', `Command '${command.name}' already exists`);
  }

  const aliases = new Set<string>();
  for (const alias of command.aliases ?? []) {
    validateCommandSpelling(alias, `command.aliases.${alias}`);
    const normalized = alias.toLowerCase();
    if (normalized === command.name.toLowerCase() || aliases.has(normalized)) {
      throw new InvalidConfigurationError(
        `command.aliases.${alias}`,
        `Duplicate alias '${alias}' for command '${command.name}'`
      );
    }
    if (registeredSpellings.has(normalized)) {
      throw new InvalidConfigurationError(
        `command.aliases.${alias}`,
        `Alias '${alias}' already belongs to another command`
      );
    }
    aliases.add(normalized);
  }

  validateOptionsConfiguration(command.options ?? [], command.name);
  validateAutomaticHelpCollision(command.options ?? [], command.name, automaticHelp);
  validateOptionScopeCollisions(command.options ?? [], globalOptions, command.name);
}

/**
 * Validates parser-level options before any command can consume them.
 *
 * @param options Global options visible to every command.
 * @throws {InvalidConfigurationError} When a global name, short name, or relationship is invalid.
 */
export function validateGlobalOptionsConfiguration(
  options: readonly ICommandOption[],
  automaticHelp = true
): void {
  validateOptionsConfiguration(options, 'global');
  validateAutomaticHelpCollision(options, 'global', automaticHelp);
}

/** Rejects option spellings that would shadow the parser-owned help option. */
function validateAutomaticHelpCollision(
  options: readonly ICommandOption[],
  owner: string,
  automaticHelp: boolean
): void {
  if (!automaticHelp) {
    return;
  }
  const collision = options.find(option => option.short === 'h');
  if (collision) {
    throw new InvalidConfigurationError(
      `${owner}.options.${collision.name}.short`,
      `Short option '${collision.short}' conflicts with automatic help`
    );
  }
}

/** Applies command spelling syntax and reserved-name rules to canonical names and aliases. */
function validateCommandSpelling(spelling: string, item: string): void {
  if (!spelling || typeof spelling !== 'string') {
    throw new InvalidConfigurationError(item, 'Command spelling must be a non-empty string');
  }
  if (['help', 'version'].includes(spelling.toLowerCase())) {
    throw new InvalidConfigurationError(item, `Command spelling '${spelling}' is reserved`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(spelling)) {
    throw new InvalidConfigurationError(
      item,
      'Command spelling must start with a letter and contain only letters, numbers, hyphens, and underscores'
    );
  }
}

/** Returns every normalized canonical and alias spelling already owned by the parser. */
function commandSpellings(commands: readonly ICommand[]): Set<string> {
  const spellings = new Set<string>();
  for (const command of commands) {
    spellings.add(command.name.toLowerCase());
    for (const alias of command.aliases ?? []) {
      spellings.add(alias.toLowerCase());
    }
  }
  return spellings;
}

/** Rejects long and short collisions between global and command option scopes. */
function validateOptionScopeCollisions(
  commandOptions: readonly ICommandOption[],
  globalOptions: readonly ICommandOption[],
  commandName: string
): void {
  const globalLong = new Set(globalOptions.map(option => option.name));
  const globalShort = new Set(
    globalOptions.flatMap(option => (option.short ? [option.short] : []))
  );

  for (const option of commandOptions) {
    if (globalLong.has(option.name)) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}`,
        `Option '${option.name}' conflicts with a global option`
      );
    }
    if (option.short && globalShort.has(option.short)) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}.short`,
        `Short option '${option.short}' conflicts with a global option`
      );
    }
  }
}

/** Validates option names, relationships, choices, and defaults for one command. */
function validateOptionsConfiguration(
  options: readonly ICommandOption[],
  commandName: string
): void {
  const optionNames = new Set<string>();
  const shortNames = new Set<string>();

  for (const option of options) {
    if (!option.name || typeof option.name !== 'string') {
      throw new InvalidConfigurationError(
        `${commandName}.options`,
        'Option name is required and must be a string'
      );
    }

    if (['help', 'version'].includes(option.name.toLowerCase())) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}`,
        `Option name '${option.name}' is reserved`
      );
    }

    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(option.name)) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}`,
        'Option name must start with a letter and contain only letters, numbers, hyphens, and underscores'
      );
    }

    if (optionNames.has(option.name)) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}`,
        `Duplicate option name '${option.name}'`
      );
    }
    optionNames.add(option.name);

    if (option.short) {
      validateShortOption(option, commandName, shortNames);
    }

    if (option.conflicts && option.depends) {
      const dependencies = new Set(option.depends);
      const intersection = option.conflicts.filter(name => dependencies.has(name));
      if (intersection.length > 0) {
        throw new InvalidConfigurationError(
          `${commandName}.options.${option.name}`,
          `Option cannot both conflict with and depend on: ${intersection.join(', ')}`
        );
      }
    }

    if (option.choices && (!Array.isArray(option.choices) || option.choices.length === 0)) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}.choices`,
        'Choices must be a non-empty array'
      );
    }

    if (
      option.choices &&
      option.default !== undefined &&
      !option.choices.includes(option.default)
    ) {
      throw new InvalidConfigurationError(
        `${commandName}.options.${option.name}.default`,
        `Default value '${option.default}' is not in choices`
      );
    }
  }
}

/** Validates and records one short option spelling. */
function validateShortOption(
  option: ICommandOption,
  commandName: string,
  shortNames: Set<string>
): void {
  if (typeof option.short !== 'string' || option.short.length !== 1) {
    throw new InvalidConfigurationError(
      `${commandName}.options.${option.name}.short`,
      'Short option must be a single character'
    );
  }
  if (!/^[a-zA-Z]$/.test(option.short)) {
    throw new InvalidConfigurationError(
      `${commandName}.options.${option.name}.short`,
      'Short option must be a letter'
    );
  }
  if (shortNames.has(option.short)) {
    throw new InvalidConfigurationError(
      `${commandName}.options.${option.name}.short`,
      `Duplicate short option '${option.short}'`
    );
  }
  shortNames.add(option.short);
}
