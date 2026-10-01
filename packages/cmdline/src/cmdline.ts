import path from 'path';
import { isBoolean, isNumeric, isString } from '@blendsdk/stdlib';
import {
  createArgumentRegistry,
  findLegacyCommandIndex,
  parseArguments,
} from './argument-parser.js';
import {
  cloneCommandConfiguration,
  cloneParserConfiguration,
  validateCommandConfiguration,
  validateGlobalOptionsConfiguration,
} from './configuration.js';
import {
  CommandLineErrorHandlerError,
  CommandLineValidationError,
  MalformedArgumentError,
} from './errors.js';
import { renderCommandLineHelp } from './help-renderer.js';
import { createStrictTokenErrors } from './strict-diagnostics.js';
import {
  createHandlerOptions,
  validateExplicitOptionRelationships,
  validateOptionRelationships,
  validateStrictOptions,
} from './strict-validation.js';
import {
  ICommand,
  ICommandLineInvocation,
  ICommandLineParser,
  ICommandOption,
  IToken,
} from './types.js';
import {
  getDomainValidationError,
  getEmailValidationError,
  isValidDomain,
  isValidEmail,
} from './validators.js';

/**
 * @export
 * @class CommandLineParser
 */
export class CommandLineParser {
  /**
   * @protected
   * @type {ICommandLineParser}
   * @memberof CommandLineParser
   */
  protected config: ICommandLineParser;
  /**
   * @protected
   * @type {string}
   * @memberof CommandLineParser
   */
  protected interpreter: string;
  /**
   * @protected
   * @type {string}
   * @memberof CommandLineParser
   */
  protected script: string;
  /**
   * @protected
   * @type {string}
   * @memberof CommandLineParser
   */
  protected scriptName: string;
  /**
   * @protected
   * @type {ICommand[]}
   * @memberof CommandLineParser
   */
  protected commands: ICommand[];
  /** Mutable option storage used only by the compatibility parser path. */
  protected optionValues: Record<string, Record<string, any>>;

  /**
   * References the current running command
   *
   * @protected
   * @memberof CommandLineParser
   */
  protected currentCommand: ICommand | undefined;

  /**
   * Creates an instance of CommandLineParser.
   * @param {ICommandLineParser} [config]
   * @memberof CommandLineParser
   */
  public constructor(config?: ICommandLineParser) {
    this.config = cloneParserConfiguration(config);
    validateGlobalOptionsConfiguration(
      this.config.globalOptions ?? [],
      this.config.skipHelp !== true
    );
    this.commands = [];
    this.optionValues = {};
    this.interpreter = '';
    this.script = '';
    this.scriptName = '';
    this.prepare();
  }

  /**
   * Handles quoted arguments and special characters
   * @protected
   * @param {string} arg
   * @return {string}
   * @memberof CommandLineParser
   */
  protected processQuotedArgument(arg: string): string {
    // Handle quoted arguments with spaces
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.slice(1, -1);
    }

    // Handle escaped characters
    return arg.replace(/\\(.)/g, '$1');
  }

  /**
   * Validates argument format and handles malformed arguments
   * @protected
   * @param {string} arg
   * @memberof CommandLineParser
   */
  protected validateArgument(arg: string): void {
    // Check for empty arguments
    if (arg.length === 0) {
      throw new MalformedArgumentError(arg, 'Empty argument provided');
    }

    // Check for malformed options (starting with - but no content)
    if (arg === '-' || arg === '--') {
      throw new MalformedArgumentError(arg, 'Invalid option format');
    }

    // Check for options with invalid characters
    if (arg.startsWith('-') && !/^-{1,2}[a-zA-Z][a-zA-Z0-9_-]*(?:=.*)?$/.test(arg)) {
      // Allow special case for negative numbers
      if (!/^-\d+(\.\d+)?$/.test(arg)) {
        throw new MalformedArgumentError(arg, 'Invalid option name format');
      }
    }
  }

  /**
   * @protected
   * @return {IToken[]}
   * @memberof CommandLineParser
   */
  protected parseTokens(args: readonly string[] = process.argv.slice(2)): IToken[] {
    const registry = createArgumentRegistry({
      parserName: this.config.name,
      commands: this.commands,
      globalOptions: this.config.globalOptions,
    });
    const commandIndex = findLegacyCommandIndex(args, registry);

    // Validate and process arguments
    const processedArgs = args.map(arg => {
      try {
        this.validateArgument(arg);
        return this.processQuotedArgument(arg);
      } catch (error) {
        if (error instanceof MalformedArgumentError) {
          throw error;
        }
        throw new MalformedArgumentError(
          arg,
          `Failed to process argument: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Tokenize
    const optionRe = /^-(-?).*$/;
    const commandOption = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    const pass1: IToken[] = [];

    processedArgs.forEach((arg, index) => {
      const isOption = optionRe.test(arg) && !/^-\d+(\.\d+)?$/.test(arg); // Exclude negative numbers
      const isCommand = commandOption.test(arg) && index === commandIndex && !isOption;
      const isLongOption = isOption && arg.startsWith('--');
      const isShortOption = isOption && !isLongOption && arg.startsWith('-');
      const isValue = !isOption && !isCommand;

      pass1.push({
        arg,
        index,
        isCommand,
        isOption,
        isShortOption,
        isLongOption,
        isValue,
      });
    });

    const pass2: IToken[] = [];

    // Find the option values
    pass1.forEach(token => {
      if (token.isShortOption) {
        const argChars = token.arg.split('');
        if (argChars.length < 2) return;

        const optionChar = argChars[1] ?? '';
        const parts = argChars.slice(2);
        let value: string | boolean = parts.join('');

        value = (value.startsWith('=') ? value.slice(1) : value).trim();
        value = value.length === 0 ? true : value;

        try {
          value = JSON.parse(value.toString());
        } catch {
          // Keep original value if JSON parsing fails
        }

        // The option
        pass2.push({
          arg: optionChar,
          isCommand: false,
          isOption: true,
          isShortOption: true,
          isLongOption: false,
          isValue: false,
          index: pass2.length,
          value,
        });

        // The value
        pass2.push({
          arg: value.toString(),
          isCommand: false,
          isOption: false,
          isShortOption: false,
          isLongOption: false,
          isValue: true,
          index: pass2.length,
          value,
        });
      } else if (token.isLongOption) {
        const parts = token.arg.slice(2).split('=');
        const optionName = parts[0] ?? '';
        let value: string | boolean = parts.length > 1 ? parts.slice(1).join('=') : true;

        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            // Keep original value if JSON parsing fails
          }
        }

        // The option
        pass2.push({
          arg: optionName,
          isCommand: false,
          isOption: true,
          isShortOption: false,
          isLongOption: true,
          isValue: false,
          index: pass2.length,
          value,
        });

        // The value
        pass2.push({
          arg: value.toString(),
          isCommand: false,
          isOption: false,
          isShortOption: false,
          isLongOption: false,
          isValue: true,
          index: pass2.length,
          value,
        });
      } else if (token.isValue) {
        let processedArg = token.arg;
        if (processedArg.startsWith('=')) {
          const parts = processedArg.split('=');
          processedArg = parts.slice(1).join('=');
        }

        let value: any = processedArg;
        try {
          value = JSON.parse(processedArg);
        } catch {
          // Keep original value if JSON parsing fails
        }

        pass2.push({
          ...token,
          arg: processedArg,
          value,
        });
      } else {
        pass2.push(token);
      }
    });

    const pass3: IToken[] = [];
    pass2.forEach((token, index) => {
      if (token.isCommand) {
        const lowerCaseArg = token.arg.toLowerCase();
        pass3.push({
          ...token,
          arg: lowerCaseArg,
          value: lowerCaseArg,
        });
      } else if (token.isOption) {
        const nextToken = pass2[index + 1];
        const nextNextToken = pass2[index + 2];

        const peekIsValue1 = nextToken?.isValue ?? false;
        const peekIsValue2 = nextNextToken?.isValue ?? false;
        const value1 = nextToken?.value;

        if (peekIsValue1 && peekIsValue2 && value1 === true && nextNextToken) {
          pass3.push({
            ...token,
            value: nextNextToken.value,
          });
        } else if (peekIsValue1 && nextToken) {
          pass3.push({
            ...token,
            value: nextToken.value,
          });
        } else {
          pass3.push(token);
        }
      }
    });

    return pass3;
  }

  /** Captures the current process invocation metadata used by help rendering. */
  protected prepare(): void {
    this.interpreter = process.argv[0] ?? '';
    this.script = path.resolve(process.argv[1] ?? '');
    const { name } = path.parse(this.script);
    this.scriptName = this.config.name || name;
  }

  /**
   * @protected
   * @param {string} command
   * @param {ICommandOption} option
   * @param {any} value
   * @memberof CommandLineParser
   */
  protected setOptionValue(command: string, option: ICommandOption, value: any): void {
    if (!this.optionValues[command]) {
      this.optionValues[command] = {};
    }

    if (option.multiple && value !== undefined) {
      if (!Array.isArray(this.optionValues[command][option.name])) {
        this.optionValues[command][option.name] = [];
      }
      this.optionValues[command][option.name].push(value);
    } else {
      this.optionValues[command][option.name] = value;
    }
  }

  /**
   * @protected
   * @param {IToken[]} options
   * @return {object}
   * @memberof CommandLineParser
   */
  protected validate(options: IToken[]): { errors: string[]; command?: ICommand } {
    const commandToken = options.find(o => o.isCommand);
    const errors: string[] = [];
    const command =
      this.commands.find(
        candidate =>
          candidate.name.toLowerCase() === commandToken?.arg.toLowerCase() ||
          (candidate.aliases ?? []).some(
            alias => alias.toLowerCase() === commandToken?.arg.toLowerCase()
          )
      ) || (this.commands.length === 1 ? this.commands.find(c => c.default) : undefined);

    if (!command) {
      errors.push('No command provided!');
      return { errors };
    }

    const tokenOptions = options.filter(o => o.isOption);
    const commandOptions = [...(this.config.globalOptions ?? []), ...(command.options ?? [])];
    const explicitlySupplied = new Set<string>();

    for (const option of commandOptions) {
      const foundTokens = tokenOptions.filter(o => o.arg === option.name || o.arg === option.short);
      if (foundTokens.length > 0) {
        explicitlySupplied.add(option.name);
      }

      if (option.required && foundTokens.length === 0 && option.default === undefined) {
        errors.push(`Missing required option [${option.name}]`);
      }

      // Handle default values when no token is found
      if (foundTokens.length === 0 && option.default !== undefined) {
        const defaultValue = option.default;

        // Type validation for default value
        if (option.type === 'string' && !isString(defaultValue)) {
          errors.push(
            `Invalid default value for option [${option.name}], required ${option.type}, provided [${defaultValue}]`
          );
        } else if (option.type === 'number' && !isNumeric(defaultValue)) {
          errors.push(
            `Invalid default value for option [${option.name}], required ${option.type}, provided [${defaultValue}]`
          );
        } else if (option.type === 'boolean' && !isBoolean(defaultValue)) {
          errors.push(
            `Invalid default value for option [${option.name}], required ${option.type}, provided [${defaultValue}]`
          );
        } else if (option.type === 'email') {
          if (!isString(defaultValue)) {
            errors.push(
              `Invalid default value for option [${option.name}], required email string, provided [${defaultValue}]`
            );
          } else if (!isValidEmail(defaultValue as string)) {
            errors.push(
              `Invalid email default value for option [${option.name}]: ${getEmailValidationError(defaultValue as string)}`
            );
          }
        } else if (option.type === 'domain') {
          if (!isString(defaultValue)) {
            errors.push(
              `Invalid default value for option [${option.name}], required domain string, provided [${defaultValue}]`
            );
          } else if (!isValidDomain(defaultValue as string)) {
            errors.push(
              `Invalid domain default value for option [${option.name}]: ${getDomainValidationError(defaultValue as string)}`
            );
          }
        }

        // Custom validator validation for default value
        if (option.validator && defaultValue !== undefined) {
          const validationResult = option.validator(defaultValue);
          if (validationResult !== true) {
            const errorMsg =
              typeof validationResult === 'string'
                ? validationResult
                : `Invalid default value for option [${option.name}]`;
            errors.push(errorMsg);
          }
        }

        this.setOptionValue(command.name, option, defaultValue);
      }

      for (const foundToken of foundTokens) {
        const tokenValue = foundToken?.value ?? option.default;

        if (tokenValue !== undefined) {
          // Type validation
          if (option.type === 'string' && !isString(tokenValue)) {
            errors.push(
              `Invalid value provided for option [${option.name}], required ${option.type}, provided [${tokenValue}]`
            );
          } else if (option.type === 'number' && !isNumeric(tokenValue)) {
            errors.push(
              `Invalid value provided for option [${option.name}], required ${option.type}, provided [${tokenValue}]`
            );
          } else if (option.type === 'boolean' && !isBoolean(tokenValue)) {
            errors.push(
              `Invalid value provided for option [${option.name}], required ${option.type}, provided [${tokenValue}]`
            );
          } else if (option.type === 'email') {
            if (!isString(tokenValue)) {
              errors.push(
                `Invalid value provided for option [${option.name}], required email string, provided [${tokenValue}]`
              );
            } else if (!isValidEmail(tokenValue as string)) {
              errors.push(
                `Invalid email provided for option [${option.name}]: ${getEmailValidationError(tokenValue as string)}`
              );
            }
          } else if (option.type === 'domain') {
            if (!isString(tokenValue)) {
              errors.push(
                `Invalid value provided for option [${option.name}], required domain string, provided [${tokenValue}]`
              );
            } else if (!isValidDomain(tokenValue as string)) {
              errors.push(
                `Invalid domain provided for option [${option.name}]: ${getDomainValidationError(tokenValue as string)}`
              );
            }
          }

          // Choices validation
          let choicesValid = true;
          if (option.choices && option.choices.length > 0 && tokenValue !== undefined) {
            if (!option.choices.includes(tokenValue)) {
              const choicesList = option.choices.map(c => `'${c}'`).join(', ');
              errors.push(
                `Invalid value '${tokenValue}' for option [${option.name}]. Must be one of: ${choicesList}`
              );
              choicesValid = false;
            }
          }

          // Custom validator validation (only if choices validation passed)
          if (choicesValid && option.validator && tokenValue !== undefined) {
            const validationResult = option.validator(tokenValue);
            if (validationResult !== true) {
              const errorMsg =
                typeof validationResult === 'string'
                  ? validationResult
                  : `Invalid value for option [${option.name}]`;
              errors.push(errorMsg);
            }
          }
        }

        this.setOptionValue(command.name, option, tokenValue);
      }
    }

    errors.push(
      ...validateExplicitOptionRelationships(command.name, commandOptions, explicitlySupplied).map(
        issue => issue.message
      )
    );

    return { errors, command };
  }

  /**
   * @protected
   * @param {ICommand | undefined} command
   * @param {string[]} errors
   * @param {boolean} isHelp
   * @memberof CommandLineParser
   */
  protected help(
    command: ICommand | undefined,
    errors: string[],
    isHelp: boolean,
    write?: (message: string) => void
  ): void {
    renderCommandLineHelp({
      scriptName: this.scriptName,
      version: this.config.version,
      commands: this.commands,
      command,
      errors,
      helpOnly: isHelp,
      ...(write ? { write } : {}),
    });
  }

  /**
   * Executes one invocation without retaining parsed arguments or output state.
   *
   * @param context Optional caller-owned value forwarded to the selected command handler.
   * @param invocation Optional caller-owned arguments and help output boundary.
   * @returns The selected handler's result, or `undefined` when help is rendered.
   */
  public execute(context?: any): Promise<any>;
  public execute(context: unknown, invocation: ICommandLineInvocation): Promise<unknown>;
  public async execute(
    context?: unknown,
    invocation: ICommandLineInvocation = {}
  ): Promise<unknown> {
    this.resetOptionValues();
    if (this.config.strict === true) {
      return this.executeStrict(context, invocation);
    }

    try {
      const options = this.parseTokens(invocation.argv);
      const { errors, command } = this.validate(options);

      if (!command) {
        this.help(undefined, errors, false, invocation.write);
        return Promise.resolve();
      }

      const commandOptions = this.optionValues[command.name] ?? {};
      const isHelp = commandOptions['help'] !== undefined;

      if (errors.length !== 0 || isHelp) {
        this.help(command, errors, isHelp, invocation.write);
        return Promise.resolve();
      }

      this.currentCommand = command;
      commandOptions['showHelp'] = () => {
        this.help(this.currentCommand, [], true, invocation.write);
      };
      return await command.handler(createHandlerOptions(commandOptions, context));
    } catch (error) {
      // Handle parsing errors gracefully by showing help
      if (error instanceof MalformedArgumentError) {
        this.help(undefined, [error.message], false, invocation.write);
        return Promise.resolve();
      }
      // Re-throw other errors
      throw error;
    }
  }

  /** Recreates mutable legacy option storage so values never cross invocation boundaries. */
  protected resetOptionValues(): void {
    this.optionValues = {};
    for (const command of this.commands) {
      this.optionValues[command.name] = {};
      for (const option of command.options ?? []) {
        this.optionValues[command.name]![option.name] = option.multiple ? [] : undefined;
      }
    }
  }

  /**
   * Executes the exact, fail-closed path without sharing parsed state with another invocation.
   *
   * @param context Caller-owned value forwarded to the selected command handler.
   * @param invocation Caller-owned arguments and help output boundary.
   * @returns The selected handler's result, or `undefined` for a clean help request.
   * @throws {CommandLineValidationError} When token or registered-option validation fails.
   */
  protected async executeStrict(
    context?: unknown,
    invocation: ICommandLineInvocation = {}
  ): Promise<unknown> {
    const registry = createArgumentRegistry({
      parserName: this.config.name,
      commands: this.commands,
      globalOptions: this.config.globalOptions,
    });
    const result = parseArguments(invocation.argv ?? process.argv.slice(2), registry, 'strict');
    const issues = createStrictTokenErrors(result, registry);
    const helpRequested = result.command !== undefined && result.options['help'] !== undefined;
    const effectiveOptions = [
      ...(this.config.globalOptions ?? []),
      ...(result.command?.options ?? []),
    ];

    if (!result.issues.some(issue => issue.kind === 'unknown-command')) {
      issues.push(...validateStrictOptions(result, !helpRequested, effectiveOptions));
      issues.push(...validateOptionRelationships(result, effectiveOptions));
    }

    if (issues.length > 0) {
      const aggregate = new CommandLineValidationError(issues);
      if (this.config.errorHandler) {
        try {
          await this.config.errorHandler(aggregate);
        } catch (handlerError) {
          throw new CommandLineErrorHandlerError(aggregate, handlerError);
        }
      } else {
        this.help(
          result.command,
          aggregate.issues.map(issue => issue.message),
          false,
          invocation.write
        );
      }
      throw aggregate;
    }

    if (!result.command) {
      this.help(undefined, [], false, invocation.write);
      return undefined;
    }

    if (helpRequested) {
      this.help(result.command, [], true, invocation.write);
      return undefined;
    }

    this.currentCommand = result.command;
    return result.command.handler(createHandlerOptions(result.options, context));
  }

  /**
   * Add a command to the parser
   * @param {ICommand} config
   * @return {CommandLineParser}
   * @memberof CommandLineParser
   */
  public addCommand(config: ICommand): CommandLineParser {
    const commandConfig = cloneCommandConfiguration(config);

    validateCommandConfiguration(
      commandConfig,
      this.commands,
      this.config.globalOptions ?? [],
      this.config.skipHelp !== true
    );

    this.optionValues[commandConfig.name] = {};

    if (this.config.skipHelp !== true) {
      commandConfig.options.push({
        name: 'help',
        short: 'h',
        type: 'boolean',
        description: `Prints help and instructions for the ${commandConfig.name} command.`,
      });
    }

    commandConfig.options.forEach(option => {
      this.optionValues[commandConfig.name]![option.name] = option.multiple ? [] : undefined;
    });

    this.commands.push(commandConfig);
    return this;
  }
}
