/**
 * Error categories for grouping related errors
 */
export enum ErrorCategory {
  PARSING = 'PARSING',
  VALIDATION = 'VALIDATION',
  CONFIGURATION = 'CONFIGURATION',
}

/**
 * Error codes for programmatic error handling
 */
export enum ErrorCode {
  /** One strict invocation produced one or more specific parser issues. */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** A plain argument remained after supported tokens were consumed. */
  UNEXPECTED_ARGUMENT = 'UNEXPECTED_ARGUMENT',
  /** An explicitly supplied option lacked a declared dependency. */
  MISSING_OPTION_DEPENDENCY = 'MISSING_OPTION_DEPENDENCY',
  /** A custom error-presentation hook threw or rejected. */
  ERROR_HANDLER_FAILED = 'ERROR_HANDLER_FAILED',
  MISSING_REQUIRED_OPTION = 'MISSING_REQUIRED_OPTION',
  INVALID_OPTION_VALUE = 'INVALID_OPTION_VALUE',
  NO_COMMAND_PROVIDED = 'NO_COMMAND_PROVIDED',
  UNKNOWN_COMMAND = 'UNKNOWN_COMMAND',
  UNKNOWN_OPTION = 'UNKNOWN_OPTION',
  CONFLICTING_OPTIONS = 'CONFLICTING_OPTIONS',
  MALFORMED_ARGUMENT = 'MALFORMED_ARGUMENT',
  CIRCULAR_DEPENDENCY = 'CIRCULAR_DEPENDENCY',
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
}

/**
 * Base class for all command line parsing errors
 */
export abstract class CommandLineError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    category: ErrorCategory,
    code: string,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Aggregates every parser-owned issue discovered during one strict invocation.
 *
 * The collection is copied and frozen so later rendering or error hooks cannot change the
 * rejection observed by the consuming application.
 *
 * @example
 * ```ts
 * try {
 *   await parser.execute();
 * } catch (error) {
 *   if (error instanceof CommandLineValidationError) {
 *     console.error(error.issues);
 *   }
 * }
 * ```
 */
export class CommandLineValidationError extends CommandLineError {
  /** Specific parser issues in deterministic input and validation order. */
  public readonly issues: readonly CommandLineError[];

  /**
   * Creates a strict validation aggregate.
   *
   * @param issues Non-empty ordered parser issues from one invocation.
   * @throws {TypeError} When called without a specific issue.
   */
  public constructor(issues: readonly CommandLineError[]) {
    if (issues.length === 0) {
      throw new TypeError('Command-line validation requires at least one issue');
    }
    const issueList = issues.map(issue => issue.message).join('\n- ');
    super(
      `Command-line validation failed:\n- ${issueList}`,
      ErrorCategory.VALIDATION,
      ErrorCode.VALIDATION_FAILED,
      { issueCount: issues.length }
    );
    this.issues = Object.freeze([...issues]);
  }
}

/** Reports a plain argument that remains after all supported tokens have been consumed. */
export class UnexpectedArgumentError extends CommandLineError {
  /** Original unconsumed argument text. */
  public readonly argument: string;
  /** Canonical command whose input contained the argument, when available. */
  public readonly commandName?: string;

  /**
   * Creates an unexpected-argument issue.
   *
   * @param argument Original unconsumed argument text.
   * @param commandName Canonical command that supplied diagnostic context.
   */
  public constructor(argument: string, commandName?: string) {
    const context = commandName ? ` for command [${commandName}]` : '';
    super(
      `Unexpected argument [${argument}]${context}`,
      ErrorCategory.PARSING,
      ErrorCode.UNEXPECTED_ARGUMENT,
      { argument, commandName }
    );
    this.argument = argument;
    this.commandName = commandName;
  }
}

/** Reports an explicitly supplied option whose required companion was not supplied. */
export class MissingOptionDependencyError extends CommandLineError {
  /** Option whose dependency was not satisfied. */
  public readonly optionName: string;
  /** Required companion option that was absent. */
  public readonly dependencyName: string;
  /** Canonical command containing both option definitions. */
  public readonly commandName: string;

  /**
   * Creates a missing-option-dependency issue.
   *
   * @param optionName Explicit option that declares the dependency.
   * @param dependencyName Required companion option that was absent.
   * @param commandName Canonical command that owns the options.
   */
  public constructor(optionName: string, dependencyName: string, commandName: string) {
    super(
      `Option [${optionName}] requires option [${dependencyName}] for command [${commandName}]`,
      ErrorCategory.VALIDATION,
      ErrorCode.MISSING_OPTION_DEPENDENCY,
      { optionName, dependencyName, commandName }
    );
    this.optionName = optionName;
    this.dependencyName = dependencyName;
    this.commandName = commandName;
  }
}

/** Preserves both a parser failure and a failed custom error-presentation hook. */
export class CommandLineErrorHandlerError extends CommandLineError {
  /** Original parser-owned failure that blocked command execution. */
  public readonly parserError: CommandLineError;
  /** Value thrown or rejected by the custom error handler. */
  public readonly handlerError: unknown;

  /**
   * Creates a combined parser and presentation failure.
   *
   * @param parserError Original typed parser failure.
   * @param handlerError Failure produced while presenting the parser error.
   */
  public constructor(parserError: CommandLineError, handlerError: unknown) {
    super(
      'Command-line error handler failed while presenting a parser error',
      ErrorCategory.VALIDATION,
      ErrorCode.ERROR_HANDLER_FAILED,
      { parserErrorCode: parserError.code }
    );
    this.parserError = parserError;
    this.handlerError = handlerError;
  }
}

/**
 * Error thrown when a required option is missing
 */
export class MissingRequiredOptionError extends CommandLineError {
  public readonly optionName: string;
  public readonly commandName: string;

  constructor(optionName: string, commandName: string) {
    super(
      `Missing required option [${optionName}] for command [${commandName}]`,
      ErrorCategory.VALIDATION,
      ErrorCode.MISSING_REQUIRED_OPTION,
      { optionName, commandName }
    );
    this.optionName = optionName;
    this.commandName = commandName;
  }
}

/**
 * Error thrown when an invalid option value is provided
 */
export class InvalidOptionValueError extends CommandLineError {
  public readonly optionName: string;
  public readonly expectedType: string;
  public readonly providedValue: unknown;

  constructor(optionName: string, expectedType: string, providedValue: unknown) {
    const message = `Invalid value provided for option [${optionName}], required ${expectedType}, provided [${providedValue}]`;
    super(message, ErrorCategory.VALIDATION, ErrorCode.INVALID_OPTION_VALUE, {
      optionName,
      expectedType,
      providedValue,
    });
    this.optionName = optionName;
    this.expectedType = expectedType;
    this.providedValue = providedValue;
  }
}

/**
 * Error thrown when no command is provided and no default command exists
 */
export class NoCommandProvidedError extends CommandLineError {
  constructor() {
    super(
      'No command provided and no default command available',
      ErrorCategory.PARSING,
      ErrorCode.NO_COMMAND_PROVIDED
    );
  }
}

/**
 * Error thrown when an unknown command is provided
 */
export class UnknownCommandError extends CommandLineError {
  public readonly commandName: string;
  public readonly availableCommands: string[];

  constructor(commandName: string, availableCommands: string[] = [], suggestedCommand?: string) {
    const suggestion =
      availableCommands.length > 0 ? ` Available commands: ${availableCommands.join(', ')}` : '';
    const didYouMean = suggestedCommand ? ` Did you mean [${suggestedCommand}]?` : '';
    super(
      `Unknown command [${commandName}].${suggestion}${didYouMean}`,
      ErrorCategory.PARSING,
      ErrorCode.UNKNOWN_COMMAND,
      { commandName, availableCommands, suggestedCommand }
    );
    this.commandName = commandName;
    this.availableCommands = availableCommands;
  }
}

/**
 * Error thrown when an unknown option is provided
 */
export class UnknownOptionError extends CommandLineError {
  public readonly optionName: string;
  public readonly commandName: string;

  constructor(optionName: string, commandName: string, suggestedOption?: string) {
    const didYouMean = suggestedOption ? `. Did you mean [--${suggestedOption}]?` : '';
    super(
      `Unknown option [${optionName}] for command [${commandName}]${didYouMean}`,
      ErrorCategory.PARSING,
      ErrorCode.UNKNOWN_OPTION,
      { optionName, commandName, suggestedOption }
    );
    this.optionName = optionName;
    this.commandName = commandName;
  }
}

/**
 * Error thrown when there are conflicting options
 */
export class ConflictingOptionsError extends CommandLineError {
  public readonly conflictingOptions: string[];

  constructor(conflictingOptions: string[]) {
    super(
      `Conflicting options provided: ${conflictingOptions.join(', ')}`,
      ErrorCategory.VALIDATION,
      ErrorCode.CONFLICTING_OPTIONS,
      { conflictingOptions }
    );
    this.conflictingOptions = conflictingOptions;
  }
}

/**
 * Error thrown when command line arguments are malformed
 */
export class MalformedArgumentError extends CommandLineError {
  public readonly argument: string;
  public readonly reason: string;

  constructor(argument: string, reason: string) {
    super(
      `Malformed argument [${argument}]: ${reason}`,
      ErrorCategory.PARSING,
      ErrorCode.MALFORMED_ARGUMENT,
      { argument, reason }
    );
    this.argument = argument;
    this.reason = reason;
  }
}

/**
 * Error thrown when there are circular command dependencies
 */
export class CircularDependencyError extends CommandLineError {
  public readonly dependencyChain: string[];

  constructor(dependencyChain: string[]) {
    super(
      `Circular dependency detected: ${dependencyChain.join(' -> ')}`,
      ErrorCategory.CONFIGURATION,
      ErrorCode.CIRCULAR_DEPENDENCY,
      { dependencyChain }
    );
    this.dependencyChain = dependencyChain;
  }
}

/**
 * Error thrown when command or option configuration is invalid
 */
export class InvalidConfigurationError extends CommandLineError {
  public readonly configurationItem: string;
  public readonly reason: string;

  constructor(configurationItem: string, reason: string) {
    super(
      `Invalid configuration for [${configurationItem}]: ${reason}`,
      ErrorCategory.CONFIGURATION,
      ErrorCode.INVALID_CONFIGURATION,
      { configurationItem, reason }
    );
    this.configurationItem = configurationItem;
    this.reason = reason;
  }
}

/**
 * Type guard to check if an error is a CommandLineError
 */
export function isCommandLineError(error: unknown): error is CommandLineError {
  return error instanceof CommandLineError;
}
