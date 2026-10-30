import type { CommandLineError } from './errors.js';

/**
 * Supported option value types
 */
export type OptionValueType = string | number | boolean;

/**
 * Union type for option values that can be single values or arrays
 */
export type OptionValue<T extends OptionValueType = OptionValueType> = T | T[];

/**
 * Generic dictionary type with better type safety
 */
export type Dictionary<T = unknown> = Record<string, T>;

/**
 * Options dictionary with proper typing
 */
export type OptionsDict = Dictionary<OptionValue>;

/**
 * Configuration for the command line parser
 * @interface ICommandLineParser
 */
export interface ICommandLineParser {
  /** Name of the application/script */
  name: string;
  /** Version of the application */
  version?: string;
  /**
   * Enables exact, case-sensitive, fail-closed recognition.
   *
   * Strict mode rejects parser-owned failures with `CommandLineValidationError` and never invokes
   * a command handler after invalid input. The default is `false` for v5 compatibility.
   *
   * @default false
   */
  strict?: boolean;
  /** Skip automatic help option addition */
  skipHelp?: boolean;
  /** Custom help option configuration */
  helpOption?: {
    name?: string;
    short?: string;
    description?: string;
  };
  /**
   * Options accepted before or after every explicit command.
   *
   * Values reach handlers under canonical long names. Global long and short spellings must not
   * collide with command-local options.
   */
  globalOptions?: ICommandOption[];
  /**
   * Replaces built-in invalid-input rendering in strict mode.
   *
   * The parser awaits this hook and then rejects with the same typed parser error. If the hook
   * fails, execution rejects with `CommandLineErrorHandlerError`, preserving both failures.
   */
  errorHandler?: (error: CommandLineError) => void | Promise<void>;
}

/** Invocation-local command input and output overrides. */
export interface ICommandLineInvocation {
  /** Application arguments without interpreter and script entries. */
  readonly argv?: readonly string[];
  /** Receives each rendered help line instead of writing to the process console. */
  readonly write?: (message: string) => void;
}

/**
 * Token interface for parsed command line arguments
 * @interface IToken
 */
export interface IToken {
  /** Position index in the argument list */
  index: number;
  /** Raw argument string */
  arg: string;
  /** Whether this token represents a command */
  isCommand: boolean;
  /** Whether this is a short option (e.g., -v) */
  isShortOption?: boolean;
  /** Whether this is a long option (e.g., --verbose) */
  isLongOption?: boolean;
  /** Whether this token is any type of option */
  isOption: boolean;
  /** Whether this token is a value */
  isValue: boolean;
  /** Parsed value of the token */
  value?: OptionValueType;
}

/**
 * Result of token validation
 * @interface IValidationResult
 */
export interface IValidationResult {
  /** List of validation errors */
  errors: string[];
  /** The matched command, if any */
  command?: ICommand;
  /** Parsed options for the command */
  options: OptionsDict;
}

/**
 * Configuration for a command option
 * @interface ICommandOption
 */
export interface ICommandOption<T extends OptionValueType = OptionValueType> {
  /**
   * Name of the option (used with --)
   * @example "verbose", "output-file"
   */
  name: string;

  /**
   * Single character short name (used with -)
   * @example "v" for verbose, "o" for output
   */
  short?: string;

  /**
   * Help description for the option
   */
  description?: string;

  /**
   * Data type of the option value
   * @default "string"
   */
  type?: OptionTypeString;

  /**
   * Default value for the option
   */
  default?: T;

  /**
   * Whether this option is required
   * @default false
   */
  required?: boolean;

  /**
   * Whether this option can accept multiple values
   * @default false
   */
  multiple?: boolean;

  /**
   * List of valid choices for this option
   */
  choices?: T[];

  /**
   * Custom validation function
   */
  validator?: (value: T) => boolean | string;

  /**
   * Canonical option names that cannot be explicitly supplied with this option.
   * Explicit `false` counts as supplied; defaults alone do not activate a conflict.
   */
  conflicts?: string[];

  /**
   * Canonical option names required when this option is explicitly supplied.
   * A dependency is satisfied by an explicit value or a configured default, including `false`.
   */
  depends?: string[];

  /**
   * Whether this option is hidden from help
   * @default false
   */
  hidden?: boolean;
}

/**
 * Command handler function type
 */
export type CommandHandler<TOptions extends OptionsDict = OptionsDict> = (
  options: TOptions & { context?: unknown }
) => Promise<unknown> | unknown;

/**
 * Configuration for a command
 * @interface ICommand
 */
export interface ICommand<TOptions extends OptionsDict = OptionsDict> {
  /**
   * Name of the command
   * @example "build", "test", "deploy"
   */
  name: string;

  /**
   * Help description for the command
   */
  description?: string;

  /**
   * Whether this is the default command when no command is specified
   * @default false
   */
  default?: boolean;

  /**
   * Options configuration for this command
   */
  options?: ICommandOption[];

  /**
   * Handler function for this command
   */
  handler: CommandHandler<TOptions>;

  /**
   * Examples of how to use this command
   */
  examples?: string[];

  /**
   * Additional validated spellings that select this command's canonical handler state.
   * Aliases are exact in strict mode and case-normalized in legacy mode.
   */
  aliases?: string[];

  /**
   * Category/group for organizing commands in help
   */
  category?: string;

  /**
   * Whether this command is hidden from help
   * @default false
   */
  hidden?: boolean;

  /**
   * Subcommands of this command
   */
  subcommands?: ICommand[];
}

/**
 * Parsing context for internal use
 * @interface IParsingContext
 */
export interface IParsingContext {
  /** Raw command line arguments */
  args: string[];
  /** Current parsing position */
  position: number;
  /** Parsed tokens */
  tokens: IToken[];
  /** Current command being processed */
  currentCommand?: ICommand;
  /** Accumulated options */
  options: OptionsDict;
}

/**
 * Help formatting options
 * @interface IHelpOptions
 */
export interface IHelpOptions {
  /** Maximum width for help output */
  maxWidth?: number;
  /** Whether to use colors in help output */
  colors?: boolean;
  /** Custom help template */
  template?: string;
  /** Show examples in help */
  showExamples?: boolean;
  /** Show aliases in help */
  showAliases?: boolean;
}

/**
 * Type for option type strings
 */
export type OptionTypeString = 'string' | 'number' | 'boolean' | 'email' | 'domain';

/**
 * Mapped type for converting option type strings to actual types
 */
export type OptionTypeMap = {
  string: string;
  number: number;
  boolean: boolean;
  email: string;
  domain: string;
};

/**
 * Utility type to extract the TypeScript type from an option type string
 */
export type TypeFromOptionType<T extends OptionTypeString> = OptionTypeMap[T];

/**
 * Utility type to create a strongly typed options object from command options
 */
export type InferOptionsType<T extends readonly ICommandOption[]> = {
  [K in T[number] as K['name']]: K['multiple'] extends true
    ? Array<TypeFromOptionType<K['type'] extends OptionTypeString ? K['type'] : 'string'>>
    : TypeFromOptionType<K['type'] extends OptionTypeString ? K['type'] : 'string'>;
};

/**
 * Reserved option names that cannot be used
 */
export const RESERVED_OPTION_NAMES = ['help', 'version'] as const;

/**
 * Reserved command names that cannot be used
 */
export const RESERVED_COMMAND_NAMES = ['help', 'version'] as const;

/**
 * Type for reserved option names
 */
export type ReservedOptionName = (typeof RESERVED_OPTION_NAMES)[number];

/**
 * Type for reserved command names
 */
export type ReservedCommandName = (typeof RESERVED_COMMAND_NAMES)[number];
