import {
  CommandLineError,
  CommandLineErrorHandlerError,
  CommandLineValidationError,
  ErrorCode,
  MissingOptionDependencyError,
  UnexpectedArgumentError,
  type ICommandLineParser,
} from '@blendsdk/cmdline';

/**
 * A consumer can opt into strict parsing and perform asynchronous error presentation.
 */
const strictConfig: ICommandLineParser = {
  name: 'compile-contract-cli',
  strict: true,
  errorHandler: async error => {
    const code: string = error.code;
    void code;
  },
};

/**
 * Referencing the class values proves that every new constructor is publicly exported.
 */
const publicErrorConstructors = {
  CommandLineValidationError,
  UnexpectedArgumentError,
  MissingOptionDependencyError,
  CommandLineErrorHandlerError,
};

/**
 * A consumer can inspect every documented error field without knowing constructor signatures.
 */
function inspectPublicErrors(
  aggregate: CommandLineValidationError,
  unexpected: UnexpectedArgumentError,
  dependency: MissingOptionDependencyError,
  handlerFailure: CommandLineErrorHandlerError
): void {
  const issues: readonly CommandLineError[] = aggregate.issues;
  const argument: string = unexpected.argument;
  const commandName: string | undefined = unexpected.commandName;
  const optionName: string = dependency.optionName;
  const dependencyName: string = dependency.dependencyName;
  const dependencyCommandName: string = dependency.commandName;
  const parserError: CommandLineError = handlerFailure.parserError;
  const handlerError: unknown = handlerFailure.handlerError;

  void issues;
  void argument;
  void commandName;
  void optionName;
  void dependencyName;
  void dependencyCommandName;
  void parserError;
  void handlerError;
}

/**
 * Every new discriminator is available for exhaustive programmatic error handling.
 */
const strictErrorCodes: readonly ErrorCode[] = [
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.UNEXPECTED_ARGUMENT,
  ErrorCode.MISSING_OPTION_DEPENDENCY,
  ErrorCode.ERROR_HANDLER_FAILED,
];

void strictConfig;
void publicErrorConstructors;
void inspectPublicErrors;
void strictErrorCodes;
