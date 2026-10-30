import { describe, expect, it } from 'vitest';

import {
  CircularDependencyError,
  CommandLineError,
  ConflictingOptionsError,
  ErrorCategory,
  ErrorCode,
  InvalidConfigurationError,
  InvalidOptionValueError,
  isCommandLineError,
  MalformedArgumentError,
  MissingRequiredOptionError,
  NoCommandProvidedError,
  UnknownCommandError,
  UnknownOptionError,
} from '../src/errors.js';

describe('CommandLineError Classes', () => {
  describe('MissingRequiredOptionError', () => {
    it('should create error with option name and command', () => {
      const error = new MissingRequiredOptionError('output', 'build');

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('Missing required option [output] for command [build]');
      expect(error.code).toBe('MISSING_REQUIRED_OPTION');
      expect(error.category).toBe('VALIDATION');
      expect(error.optionName).toBe('output');
      expect(error.commandName).toBe('build');
    });

    it('should create error with option name and command', () => {
      const error = new MissingRequiredOptionError('output', 'build');

      expect(error.message).toBe('Missing required option [output] for command [build]');
      expect(error.optionName).toBe('output');
    });
  });

  describe('InvalidOptionValueError', () => {
    it('should create error with type validation info', () => {
      const error = new InvalidOptionValueError('port', 'number', 'abc');

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe(
        'Invalid value provided for option [port], required number, provided [abc]'
      );
      expect(error.code).toBe('INVALID_OPTION_VALUE');
      expect(error.category).toBe('VALIDATION');
      expect(error.optionName).toBe('port');
      expect(error.expectedType).toBe('number');
      expect(error.providedValue).toBe('abc');
    });
  });

  describe('NoCommandProvidedError', () => {
    it('should create error for missing command', () => {
      const error = new NoCommandProvidedError();

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('No command provided and no default command available');
      expect(error.code).toBe('NO_COMMAND_PROVIDED');
      expect(error.category).toBe('PARSING');
    });
  });

  describe('UnknownCommandError', () => {
    it('should create error with command suggestions', () => {
      const error = new UnknownCommandError('buidl', ['build', 'test', 'deploy']);

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe(
        'Unknown command [buidl]. Available commands: build, test, deploy'
      );
      expect(error.code).toBe('UNKNOWN_COMMAND');
      expect(error.category).toBe('PARSING');
      expect(error.commandName).toBe('buidl');
      expect(error.availableCommands).toEqual(['build', 'test', 'deploy']);
    });

    it('should create error without suggestions when no commands available', () => {
      const error = new UnknownCommandError('test', []);

      expect(error.message).toBe('Unknown command [test].');
      expect(error.availableCommands).toEqual([]);
    });
  });

  describe('UnknownOptionError', () => {
    it('should create error for unknown option', () => {
      const error = new UnknownOptionError('verbose', 'build');

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('Unknown option [verbose] for command [build]');
      expect(error.code).toBe('UNKNOWN_OPTION');
      expect(error.category).toBe('PARSING');
      expect(error.optionName).toBe('verbose');
      expect(error.commandName).toBe('build');
    });
  });

  describe('ConflictingOptionsError', () => {
    it('should create error for conflicting options', () => {
      const error = new ConflictingOptionsError(['quiet', 'verbose']);

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('Conflicting options provided: quiet, verbose');
      expect(error.code).toBe('CONFLICTING_OPTIONS');
      expect(error.category).toBe('VALIDATION');
      expect(error.conflictingOptions).toEqual(['quiet', 'verbose']);
    });
  });

  describe('MalformedArgumentError', () => {
    it('should create error for malformed argument', () => {
      const error = new MalformedArgumentError('--option=', 'missing value');

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('Malformed argument [--option=]: missing value');
      expect(error.code).toBe('MALFORMED_ARGUMENT');
      expect(error.category).toBe('PARSING');
      expect(error.argument).toBe('--option=');
    });
  });

  describe('CircularDependencyError', () => {
    it('should create error for circular dependencies', () => {
      const error = new CircularDependencyError(['cmd1', 'cmd2', 'cmd1']);

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('Circular dependency detected: cmd1 -> cmd2 -> cmd1');
      expect(error.code).toBe('CIRCULAR_DEPENDENCY');
      expect(error.category).toBe('CONFIGURATION');
      expect(error.dependencyChain).toEqual(['cmd1', 'cmd2', 'cmd1']);
    });
  });

  describe('InvalidConfigurationError', () => {
    it('should create error for invalid configuration', () => {
      const error = new InvalidConfigurationError('option.name', 'cannot be empty');

      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.message).toBe('Invalid configuration for [option.name]: cannot be empty');
      expect(error.code).toBe('INVALID_CONFIGURATION');
      expect(error.category).toBe('CONFIGURATION');
      expect(error.configurationItem).toBe('option.name');
    });
  });

  describe('isCommandLineError type guard', () => {
    it('should return true for CommandLineError instances', () => {
      const error = new MissingRequiredOptionError('test', 'build');
      expect(isCommandLineError(error)).toBe(true);
    });

    it('should return false for regular Error instances', () => {
      const error = new Error('Regular error');
      expect(isCommandLineError(error)).toBe(false);
    });

    it('should return false for non-error values', () => {
      expect(isCommandLineError('string')).toBe(false);
      expect(isCommandLineError(null)).toBe(false);
      expect(isCommandLineError(undefined)).toBe(false);
      expect(isCommandLineError({})).toBe(false);
    });
  });

  describe('Error inheritance', () => {
    it('should properly inherit from Error', () => {
      const error = new MissingRequiredOptionError('test', 'build');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CommandLineError);
      expect(error.name).toBe('MissingRequiredOptionError');
      expect(error.stack).toBeDefined();
    });

    it('should have proper error properties', () => {
      const error = new InvalidOptionValueError('port', 'number', 'abc');

      expect(error.message).toBeTruthy();
      expect(error.code).toBeTruthy();
      expect(error.category).toBeTruthy();
      expect(error.name).toBe('InvalidOptionValueError');
    });
  });

  describe('ErrorCategory enum', () => {
    it('should have correct values', () => {
      expect(ErrorCategory.PARSING).toBe('PARSING');
      expect(ErrorCategory.VALIDATION).toBe('VALIDATION');
      expect(ErrorCategory.CONFIGURATION).toBe('CONFIGURATION');
    });
  });

  describe('ErrorCode enum', () => {
    it('should have all expected error codes', () => {
      expect(ErrorCode.MISSING_REQUIRED_OPTION).toBe('MISSING_REQUIRED_OPTION');
      expect(ErrorCode.INVALID_OPTION_VALUE).toBe('INVALID_OPTION_VALUE');
      expect(ErrorCode.NO_COMMAND_PROVIDED).toBe('NO_COMMAND_PROVIDED');
      expect(ErrorCode.UNKNOWN_COMMAND).toBe('UNKNOWN_COMMAND');
      expect(ErrorCode.UNKNOWN_OPTION).toBe('UNKNOWN_OPTION');
      expect(ErrorCode.CONFLICTING_OPTIONS).toBe('CONFLICTING_OPTIONS');
      expect(ErrorCode.MALFORMED_ARGUMENT).toBe('MALFORMED_ARGUMENT');
      expect(ErrorCode.CIRCULAR_DEPENDENCY).toBe('CIRCULAR_DEPENDENCY');
      expect(ErrorCode.INVALID_CONFIGURATION).toBe('INVALID_CONFIGURATION');
    });
  });
});
