import type { IArgumentIssue, IArgumentParseResult, IArgumentRegistry } from './argument-parser.js';
import {
  CommandLineError,
  MalformedArgumentError,
  UnexpectedArgumentError,
  UnknownCommandError,
  UnknownOptionError,
} from './errors.js';
import { createSuggestionSession, type ISuggestionMatcher } from './suggestions.js';

/**
 * Converts ordered token issues into public typed diagnostics with optional similarity hints.
 *
 * @param result Invocation-local recognition result and issue positions.
 * @param registry Exact registered spellings visible to the invocation.
 * @returns Typed issues in the same order as the input failures.
 */
export function createStrictTokenErrors(
  result: IArgumentParseResult,
  registry: IArgumentRegistry
): CommandLineError[] {
  if (result.issues.length === 0) {
    return [];
  }

  const session = createSuggestionSession();
  const commandMatcher = result.issues.some(issue => issue.kind === 'unknown-command')
    ? session.createMatcher([...registry.strictCommands.keys()])
    : undefined;
  const hasUnknownLongOption = result.issues.some(
    issue => issue.kind === 'unknown-option' && issue.argument.startsWith('--')
  );
  const visibleGlobalOptions = [...registry.strictGlobalLongOptions.values()]
    .filter(option => option.hidden !== true)
    .map(option => option.name);
  const globalOptionMatcher = hasUnknownLongOption
    ? session.createMatcher(visibleGlobalOptions)
    : undefined;
  const commandOptionMatcher =
    hasUnknownLongOption && result.command
      ? session.createMatcher([
          ...visibleGlobalOptions,
          ...(result.command.options ?? [])
            .filter(option => option.hidden !== true)
            .map(option => option.name),
        ])
      : globalOptionMatcher;

  return result.issues.map(issue =>
    createTokenError(
      issue,
      registry,
      result.commandIndex,
      commandMatcher,
      globalOptionMatcher,
      commandOptionMatcher
    )
  );
}

/** Converts one pure token issue without changing its rejection semantics. */
function createTokenError(
  issue: IArgumentIssue,
  registry: IArgumentRegistry,
  commandIndex: number | undefined,
  commandMatcher: ISuggestionMatcher | undefined,
  globalOptionMatcher: ISuggestionMatcher | undefined,
  commandOptionMatcher: ISuggestionMatcher | undefined
): CommandLineError {
  switch (issue.kind) {
    case 'malformed-argument':
      return new MalformedArgumentError(issue.argument, issue.reason ?? 'Invalid argument');
    case 'unknown-command':
      return new UnknownCommandError(
        issue.argument,
        [...registry.strictCommands.keys()],
        commandMatcher?.find(issue.argument)
      );
    case 'unknown-option': {
      const isBeforeExplicitCommand = commandIndex !== undefined && issue.index < commandIndex;
      const matcher = isBeforeExplicitCommand ? globalOptionMatcher : commandOptionMatcher;
      const suggestion = issue.argument.startsWith('--')
        ? matcher?.find(issue.optionName ?? issue.argument)
        : undefined;
      return new UnknownOptionError(
        issue.optionName ?? issue.argument,
        issue.commandName ?? registry.parserName,
        suggestion
      );
    }
    case 'unexpected-argument':
      return new UnexpectedArgumentError(issue.argument, issue.commandName);
  }
}
