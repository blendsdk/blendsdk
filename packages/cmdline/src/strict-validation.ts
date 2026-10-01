import { isBoolean, isNumeric, isString } from '@blendsdk/stdlib';

import {
  CommandLineError,
  ConflictingOptionsError,
  InvalidOptionValueError,
  MissingOptionDependencyError,
  MissingRequiredOptionError,
} from './errors.js';
import type { IArgumentParseResult } from './argument-parser.js';
import type { ICommandOption, OptionsDict, OptionValueType } from './types.js';
import {
  getDomainValidationError,
  getEmailValidationError,
  isValidDomain,
  isValidEmail,
} from './validators.js';

/**
 * Validates selected-command values in declaration order.
 *
 * @param result Invocation-local recognition result whose defaults may be populated.
 * @param validateAbsentOptions Whether defaults and required-option checks apply.
 * @param options Effective global and command options in registration order.
 * @returns Typed semantic issues in deterministic option order.
 */
export function validateStrictOptions(
  result: IArgumentParseResult,
  validateAbsentOptions = true,
  options: readonly ICommandOption[] = result.command?.options ?? []
): CommandLineError[] {
  if (!result.command) {
    return [];
  }

  const issues: CommandLineError[] = [];
  for (const option of options) {
    let value = result.options[option.name];
    if (validateAbsentOptions && value === undefined && option.default !== undefined) {
      value = option.default;
      result.options[option.name] = option.default;
    }

    if (value === undefined) {
      if (validateAbsentOptions && option.required) {
        issues.push(new MissingRequiredOptionError(option.name, result.command.name));
      }
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    for (const suppliedValue of values) {
      const issue = validateStrictValue(option, suppliedValue);
      if (issue) {
        issues.push(issue);
      }
    }
  }
  return issues;
}

/**
 * Validates conflicts and dependencies from explicit occurrences without treating defaults as
 * owner activation.
 *
 * @param result Invocation-local values and explicit option occurrences.
 * @param options Effective global and command options in registration order.
 * @returns Deduplicated relationship issues in owner registration and declaration order.
 */
export function validateOptionRelationships(
  result: IArgumentParseResult,
  options: readonly ICommandOption[] = result.command?.options ?? []
): CommandLineError[] {
  if (!result.command) {
    return [];
  }

  const explicitlySupplied = new Set(result.occurrences.map(occurrence => occurrence.option.name));
  return validateExplicitOptionRelationships(result.command.name, options, explicitlySupplied);
}

/**
 * Validates relationship presence from canonical explicitly supplied option names.
 *
 * This lower-level entry point lets the legacy parser activate the declared APIs while retaining
 * its established help-and-resolve failure presentation.
 *
 * @param commandName Canonical selected command name.
 * @param options Effective global and command options in registration order.
 * @param explicitlySupplied Canonical names present in source arguments, including false values.
 * @returns Deduplicated typed relationship issues.
 */
export function validateExplicitOptionRelationships(
  commandName: string,
  options: readonly ICommandOption[],
  explicitlySupplied: ReadonlySet<string>
): CommandLineError[] {
  const optionsByName = new Map(options.map(option => [option.name, option]));
  const conflictPairs = new Set<string>();
  const dependencyPairs = new Set<string>();
  const issues: CommandLineError[] = [];

  for (const option of options) {
    if (!explicitlySupplied.has(option.name)) {
      continue;
    }

    for (const targetName of option.conflicts ?? []) {
      if (!explicitlySupplied.has(targetName)) {
        continue;
      }
      const pairKey = [option.name, targetName].sort().join('\u0000');
      if (!conflictPairs.has(pairKey)) {
        conflictPairs.add(pairKey);
        issues.push(new ConflictingOptionsError([option.name, targetName]));
      }
    }

    for (const dependencyName of option.depends ?? []) {
      const dependency = optionsByName.get(dependencyName);
      const isPresent = explicitlySupplied.has(dependencyName) || dependency?.default !== undefined;
      const pairKey = `${option.name}\u0000${dependencyName}`;
      if (!isPresent && !dependencyPairs.has(pairKey)) {
        dependencyPairs.add(pairKey);
        issues.push(new MissingOptionDependencyError(option.name, dependencyName, commandName));
      }
    }
  }

  return issues;
}

/**
 * Combines invocation values and opaque caller context without weakening option value types.
 *
 * @param options Canonical validated values for one invocation.
 * @param context Opaque caller-owned handler context.
 * @returns A fresh handler argument object.
 */
export function createHandlerOptions<TOptions extends OptionsDict>(
  options: TOptions,
  context: unknown
): TOptions & { context?: unknown } {
  return Object.assign({}, options, { context });
}

/** Validates one supplied or default value without mutating invocation state. */
function validateStrictValue(
  option: ICommandOption,
  value: OptionValueType
): InvalidOptionValueError | undefined {
  const invalidType = invalidValueExpectation(option, value);
  if (invalidType) {
    return new InvalidOptionValueError(option.name, invalidType, value);
  }

  if (option.choices && !option.choices.includes(value)) {
    return new InvalidOptionValueError(
      option.name,
      `one of ${option.choices.map(choice => `[${choice}]`).join(', ')}`,
      value
    );
  }

  if (option.validator) {
    const result = option.validator(value);
    if (result !== true) {
      return new InvalidOptionValueError(
        option.name,
        typeof result === 'string' ? result : 'a value accepted by its validator',
        value
      );
    }
  }
  return undefined;
}

/** Returns a durable expected-value description when a supplied value is invalid. */
function invalidValueExpectation(
  option: ICommandOption,
  value: OptionValueType
): string | undefined {
  const type = option.type ?? 'string';
  if (type === 'string' && !isString(value)) {
    return 'string';
  }
  if (type === 'number' && !isNumeric(value)) {
    return 'number';
  }
  if (type === 'boolean' && !isBoolean(value)) {
    return 'boolean';
  }
  if (type === 'email' && (!isString(value) || !isValidEmail(value))) {
    return isString(value) ? getEmailValidationError(value) : 'email string';
  }
  if (type === 'domain' && (!isString(value) || !isValidDomain(value))) {
    return isString(value) ? getDomainValidationError(value) : 'domain string';
  }
  return undefined;
}
