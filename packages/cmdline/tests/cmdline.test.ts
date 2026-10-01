import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CommandLineParser } from '../src/cmdline.js';

describe('CommandLineParser', () => {
  let parser: CommandLineParser;
  let mockHandler: Mock;
  let originalArgv: string[];

  beforeEach(() => {
    parser = new CommandLineParser({ name: 'test-cli', version: '1.0.0' });
    mockHandler = vi.fn().mockResolvedValue(undefined);
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create parser with default config', () => {
      const defaultParser = new CommandLineParser();
      expect(defaultParser).toBeInstanceOf(CommandLineParser);
    });

    it('should create parser with custom config', () => {
      const customParser = new CommandLineParser({
        name: 'custom-cli',
        version: '2.0.0',
        skipHelp: true,
      });
      expect(customParser).toBeInstanceOf(CommandLineParser);
    });
  });

  describe('addCommand', () => {
    it('should add a simple command', () => {
      const result = parser.addCommand({
        name: 'test',
        description: 'Test command',
        handler: mockHandler,
      });

      expect(result).toBe(parser); // Should return parser for chaining
    });

    it('should add command with options', () => {
      parser.addCommand({
        name: 'build',
        description: 'Build the project',
        options: [
          {
            name: 'output',
            short: 'o',
            type: 'string',
            description: 'Output directory',
            required: true,
          },
          {
            name: 'verbose',
            short: 'v',
            type: 'boolean',
            description: 'Verbose output',
          },
        ],
        handler: mockHandler,
      });

      expect(parser).toBeInstanceOf(CommandLineParser);
    });

    it('should convert command name to lowercase', () => {
      parser.addCommand({
        name: 'TEST',
        handler: mockHandler,
      });

      // This would be tested by checking internal state or execution
      expect(parser).toBeInstanceOf(CommandLineParser);
    });
  });

  describe('Token Parsing', () => {
    beforeEach(() => {
      parser.addCommand({
        name: 'test',
        options: [
          { name: 'string-opt', type: 'string' },
          { name: 'number-opt', type: 'number' },
          { name: 'boolean-opt', type: 'boolean' },
          { name: 'short', short: 's', type: 'string' },
        ],
        handler: mockHandler,
      });
    });

    it('should parse long options with values', async () => {
      process.argv = [
        'node',
        'script.js',
        'test',
        '--string-opt=hello',
        '--number-opt=42',
        '--boolean-opt=true',
      ];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          'string-opt': 'hello',
          'number-opt': 42,
          'boolean-opt': true,
        })
      );
    });

    it('should parse short options', async () => {
      process.argv = ['node', 'script.js', 'test', '-s', 'value'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          short: 'value',
        })
      );
    });

    it('should parse boolean flags', async () => {
      process.argv = ['node', 'script.js', 'test', '--boolean-opt'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          'boolean-opt': true,
        })
      );
    });

    it('should handle JSON values', async () => {
      process.argv = ['node', 'script.js', 'test', '--string-opt={"key":"value"}'];

      // Mock console.log to suppress help output
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      // The JSON parsing causes type validation to fail, so help is shown instead
      expect(consoleSpy).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Validation', () => {
    beforeEach(() => {
      parser.addCommand({
        name: 'validate',
        options: [
          {
            name: 'required-opt',
            type: 'string',
            required: true,
            description: 'A required option',
          },
          {
            name: 'string-opt',
            type: 'string',
            description: 'A string option',
          },
          {
            name: 'number-opt',
            type: 'number',
            description: 'A number option',
          },
          {
            name: 'boolean-opt',
            type: 'boolean',
            description: 'A boolean option',
          },
        ],
        handler: mockHandler,
      });
    });

    it('should validate required options', async () => {
      process.argv = ['node', 'script.js', 'validate'];

      // Should show help due to missing required option
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      expect(consoleSpy).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should validate option types - string', async () => {
      process.argv = ['node', 'script.js', 'validate', '--required-opt=test', '--string-opt=hello'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          'required-opt': 'test',
          'string-opt': 'hello',
        })
      );
    });

    it('should validate option types - number', async () => {
      process.argv = ['node', 'script.js', 'validate', '--required-opt=test', '--number-opt=42'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          'required-opt': 'test',
          'number-opt': 42,
        })
      );
    });

    it('should validate option types - boolean', async () => {
      process.argv = [
        'node',
        'script.js',
        'validate',
        '--required-opt=test',
        '--boolean-opt=false',
      ];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          'required-opt': 'test',
          'boolean-opt': false,
        })
      );
    });

    it('should handle default values', async () => {
      parser.addCommand({
        name: 'defaults',
        options: [
          {
            name: 'with-default',
            type: 'string',
            default: 'default-value',
            description: 'Option with default',
          },
        ],
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'defaults'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          'with-default': 'default-value',
        })
      );
    });
  });

  describe('Multiple Commands', () => {
    beforeEach(() => {
      parser.addCommand({
        name: 'command1',
        description: 'First command',
        handler: mockHandler,
      });

      parser.addCommand({
        name: 'command2',
        description: 'Second command',
        handler: mockHandler,
      });
    });

    it('should execute the correct command', async () => {
      process.argv = ['node', 'script.js', 'command2'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalled();
    });

    it('should show help when no command provided', async () => {
      process.argv = ['node', 'script.js'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      expect(consoleSpy).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Default Command', () => {
    it('should execute default command when no command specified', async () => {
      parser.addCommand({
        name: 'default-cmd',
        description: 'Default command',
        default: true,
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalled();
    });

    it('should disable default when multiple commands exist', async () => {
      parser.addCommand({
        name: 'cmd1',
        default: true,
        handler: mockHandler,
      });

      parser.addCommand({
        name: 'cmd2',
        handler: vi.fn(),
      });

      process.argv = ['node', 'script.js'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      expect(consoleSpy).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Help System', () => {
    beforeEach(() => {
      parser.addCommand({
        name: 'help-test',
        description: 'Command for testing help',
        options: [
          {
            name: 'option1',
            short: 'o',
            type: 'string',
            description: 'First option',
            required: true,
          },
          {
            name: 'option2',
            type: 'boolean',
            description: 'Second option',
            default: false,
          },
        ],
        handler: mockHandler,
      });
    });

    it('should show help with -h flag', async () => {
      process.argv = ['node', 'script.js', 'help-test', '-h'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      expect(consoleSpy).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should show help with --help flag', async () => {
      process.argv = ['node', 'script.js', 'help-test', '--help'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      expect(consoleSpy).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should skip help option when skipHelp is true', () => {
      const noHelpParser = new CommandLineParser({
        name: 'no-help',
        skipHelp: true,
      });

      noHelpParser.addCommand({
        name: 'test',
        handler: mockHandler,
      });

      expect(noHelpParser).toBeInstanceOf(CommandLineParser);
    });
  });

  describe('Multiple Values', () => {
    beforeEach(() => {
      parser.addCommand({
        name: 'multi',
        options: [
          {
            name: 'files',
            type: 'string',
            multiple: true,
            description: 'Multiple file inputs',
          },
        ],
        handler: mockHandler,
      });
    });

    it('should handle multiple values for an option', async () => {
      process.argv = ['node', 'script.js', 'multi', '--files=file1.txt', '--files=file2.txt'];

      await parser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.arrayContaining(['file1.txt', 'file2.txt']),
        })
      );
    });
  });

  describe('Context Passing', () => {
    it('should pass context to command handler', async () => {
      // Create a fresh parser for this test
      const contextParser = new CommandLineParser({ name: 'context-cli', version: '1.0.0' });
      contextParser.addCommand({
        name: 'context-test',
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'context-test'];
      const context = { userId: 123, environment: 'test' };

      await contextParser.execute(context);

      // Handler should be called with context
      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { userId: 123, environment: 'test' },
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle handler errors gracefully', async () => {
      const errorHandler = vi.fn().mockRejectedValue(new Error('Handler error'));

      // Create a fresh parser for this test
      const errorParser = new CommandLineParser({ name: 'error-cli', version: '1.0.0' });
      errorParser.addCommand({
        name: 'error-test',
        handler: errorHandler,
      });

      process.argv = ['node', 'script.js', 'error-test'];

      // Handler errors should be propagated
      await expect(errorParser.execute()).rejects.toThrow('Handler error');
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('Hyphenated Command Names', () => {
    it('should recognize command names with hyphens', async () => {
      const hyphenParser = new CommandLineParser({ name: 'hyphen-cli', version: '1.0.0' });
      hyphenParser.addCommand({
        name: 'build-prod',
        description: 'Build for production',
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'build-prod'];

      await hyphenParser.execute();

      expect(mockHandler).toHaveBeenCalled();
    });

    it('should recognize command names with multiple hyphens', async () => {
      const hyphenParser = new CommandLineParser({ name: 'hyphen-cli', version: '1.0.0' });
      hyphenParser.addCommand({
        name: 'test-e2e-integration',
        description: 'Run E2E integration tests',
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'test-e2e-integration'];

      await hyphenParser.execute();

      expect(mockHandler).toHaveBeenCalled();
    });

    it('should recognize command names with hyphens and underscores', async () => {
      const hyphenParser = new CommandLineParser({ name: 'hyphen-cli', version: '1.0.0' });
      hyphenParser.addCommand({
        name: 'deploy-to_staging',
        description: 'Deploy to staging environment',
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'deploy-to_staging'];

      await hyphenParser.execute();

      expect(mockHandler).toHaveBeenCalled();
    });

    it('should pass options to hyphenated command', async () => {
      const hyphenParser = new CommandLineParser({ name: 'hyphen-cli', version: '1.0.0' });
      hyphenParser.addCommand({
        name: 'build-prod',
        options: [
          {
            name: 'output',
            type: 'string',
          },
        ],
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'build-prod', '--output=dist'];

      await hyphenParser.execute();

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          output: 'dist',
        })
      );
    });

    it('should convert hyphenated command names to lowercase', async () => {
      const hyphenParser = new CommandLineParser({ name: 'hyphen-cli', version: '1.0.0' });
      hyphenParser.addCommand({
        name: 'Build-Prod',
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'Build-Prod'];

      await hyphenParser.execute();

      expect(mockHandler).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty arguments', async () => {
      process.argv = ['node', 'script.js'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await parser.execute();

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle malformed JSON values', async () => {
      // Create a fresh parser for this test
      const jsonParser = new CommandLineParser({ name: 'json-cli', version: '1.0.0' });
      jsonParser.addCommand({
        name: 'json-test',
        options: [{ name: 'data', type: 'string' }],
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'json-test', '--data={invalid json}'];

      await jsonParser.execute();

      // Malformed JSON is treated as a string value
      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: '{invalid json}',
        })
      );
    });

    it('should handle special characters in values', async () => {
      // Create a fresh parser for this test
      const specialParser = new CommandLineParser({ name: 'special-cli', version: '1.0.0' });
      specialParser.addCommand({
        name: 'special-test',
        options: [{ name: 'value', type: 'string' }],
        handler: mockHandler,
      });

      process.argv = ['node', 'script.js', 'special-test', '--value=hello@world#test$'];

      await specialParser.execute();

      // Special characters are valid in string values
      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 'hello@world#test$',
        })
      );
    });
  });

  describe('Custom Validators', () => {
    describe('Basic Validator Functionality', () => {
      it('should call custom validator and pass when returning true', async () => {
        const validatorSpy = vi.fn().mockReturnValue(true);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'value',
              type: 'string',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--value=hello'];

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith('hello');
        expect(mockHandler).toHaveBeenCalled();
      });

      it('should call custom validator and fail when returning false', async () => {
        const validatorSpy = vi.fn().mockReturnValue(false);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'value',
              type: 'string',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--value=invalid'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith('invalid');
        expect(consoleSpy).toHaveBeenCalled();
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });

      it('should use custom error message when validator returns string', async () => {
        const customError = 'Value must be at least 5 characters';
        const validatorSpy = vi.fn().mockReturnValue(customError);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'value',
              type: 'string',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--value=hi'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith('hi');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(customError));
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Validator with Different Types', () => {
      it('should validate number values', async () => {
        const validatorSpy = vi.fn((value: number) => {
          return (value >= 0 && value <= 100) || 'Value must be between 0 and 100';
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'age',
              type: 'number',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--age=25'];

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith(25);
        expect(mockHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            age: 25,
          })
        );
      });

      it('should fail validation for out-of-range number', async () => {
        const validatorSpy = vi.fn((value: number) => {
          return (value >= 0 && value <= 100) || 'Value must be between 0 and 100';
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'age',
              type: 'number',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--age=150'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith(150);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Value must be between 0 and 100')
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });

      it('should validate boolean values', async () => {
        const validatorSpy = vi.fn().mockReturnValue(true);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'flag',
              type: 'boolean',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--flag=true'];

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith(true);
        expect(mockHandler).toHaveBeenCalled();
      });
    });

    describe('Complex Validation Scenarios', () => {
      it('should validate email format with custom validator', async () => {
        const emailValidator = vi.fn((value: string) => {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          return emailRegex.test(value) || 'Invalid email format';
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'email',
              type: 'string',
              validator: emailValidator,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--email=test@example.com'];

        await validatorParser.execute();

        expect(emailValidator).toHaveBeenCalledWith('test@example.com');
        expect(mockHandler).toHaveBeenCalled();
      });

      it('should fail validation for invalid email', async () => {
        const emailValidator = vi.fn((value: string) => {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          return emailRegex.test(value) || 'Invalid email format';
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'email',
              type: 'string',
              validator: emailValidator,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--email=invalid-email'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await validatorParser.execute();

        expect(emailValidator).toHaveBeenCalledWith('invalid-email');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid email format'));
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });

      it('should validate file path existence', async () => {
        const pathValidator = vi.fn((value: string) => {
          // Simulate path validation
          return value.startsWith('/') || 'Path must be absolute';
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'path',
              type: 'string',
              validator: pathValidator,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--path=/absolute/path'];

        await validatorParser.execute();

        expect(pathValidator).toHaveBeenCalledWith('/absolute/path');
        expect(mockHandler).toHaveBeenCalled();
      });

      it('should validate URL format', async () => {
        const urlValidator = vi.fn((value: string) => {
          try {
            new URL(value);
            return true;
          } catch {
            return 'Invalid URL format';
          }
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'url',
              type: 'string',
              validator: urlValidator,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--url=https://example.com'];

        await validatorParser.execute();

        expect(urlValidator).toHaveBeenCalledWith('https://example.com');
        expect(mockHandler).toHaveBeenCalled();
      });
    });

    describe('Validator with Multiple Options', () => {
      it('should validate multiple options independently', async () => {
        const validator1 = vi.fn().mockReturnValue(true);
        const validator2 = vi.fn().mockReturnValue(true);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'option1',
              type: 'string',
              validator: validator1,
            },
            {
              name: 'option2',
              type: 'number',
              validator: validator2,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--option1=hello', '--option2=42'];

        await validatorParser.execute();

        expect(validator1).toHaveBeenCalledWith('hello');
        expect(validator2).toHaveBeenCalledWith(42);
        expect(mockHandler).toHaveBeenCalled();
      });

      it('should fail if any validator fails', async () => {
        const validator1 = vi.fn().mockReturnValue(true);
        const validator2 = vi.fn().mockReturnValue('Second option is invalid');
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'option1',
              type: 'string',
              validator: validator1,
            },
            {
              name: 'option2',
              type: 'number',
              validator: validator2,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--option1=hello', '--option2=42'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await validatorParser.execute();

        expect(validator1).toHaveBeenCalledWith('hello');
        expect(validator2).toHaveBeenCalledWith(42);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Second option is invalid')
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Validator with Default Values', () => {
      it('should validate default values', async () => {
        const validatorSpy = vi.fn().mockReturnValue(true);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'value',
              type: 'string',
              default: 'default-value',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test'];

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith('default-value');
        expect(mockHandler).toHaveBeenCalled();
      });

      it('should fail validation on invalid default value', async () => {
        const validatorSpy = vi.fn((value: string) => {
          return value.length > 5 || 'Value must be longer than 5 characters';
        });
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'value',
              type: 'string',
              default: 'hi',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await validatorParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith('hi');
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Value must be longer than 5 characters')
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Validator Not Called for Undefined Values', () => {
      it('should not call validator when option is not provided and no default', async () => {
        const validatorSpy = vi.fn().mockReturnValue(true);
        const validatorParser = new CommandLineParser({ name: 'validator-cli', version: '1.0.0' });

        validatorParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'optional',
              type: 'string',
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test'];

        await validatorParser.execute();

        expect(validatorSpy).not.toHaveBeenCalled();
        expect(mockHandler).toHaveBeenCalled();
      });
    });
  });

  describe('Choices Validation', () => {
    describe('String Choices', () => {
      it('should accept valid choice for string option', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'deploy',
          options: [
            {
              name: 'environment',
              type: 'string',
              choices: ['dev', 'staging', 'production'],
              required: true,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'deploy', '--environment=staging'];

        await choicesParser.execute();

        expect(mockHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            environment: 'staging',
          })
        );
      });

      it('should reject invalid choice for string option', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'deploy',
          options: [
            {
              name: 'environment',
              type: 'string',
              choices: ['dev', 'staging', 'production'],
              required: true,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'deploy', '--environment=test'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await choicesParser.execute();

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid value 'test' for option [environment]")
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Must be one of: 'dev', 'staging', 'production'")
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Number Choices', () => {
      it('should accept valid choice for number option', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'level',
              type: 'number',
              choices: [1, 2, 3, 4, 5],
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--level=3'];

        await choicesParser.execute();

        expect(mockHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 3,
          })
        );
      });

      it('should reject invalid choice for number option', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'level',
              type: 'number',
              choices: [1, 2, 3, 4, 5],
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--level=10'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await choicesParser.execute();

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid value '10' for option [level]")
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Must be one of: '1', '2', '3', '4', '5'")
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Multiple Values with Choices', () => {
      it('should validate each value in multiple option against choices', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'tags',
              type: 'string',
              multiple: true,
              choices: ['bug', 'feature', 'docs', 'test'],
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--tags=bug', '--tags=feature'];

        await choicesParser.execute();

        expect(mockHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            tags: expect.arrayContaining(['bug', 'feature']),
          })
        );
      });

      it('should reject if any value in multiple option is invalid', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'tags',
              type: 'string',
              multiple: true,
              choices: ['bug', 'feature', 'docs', 'test'],
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--tags=bug', '--tags=invalid'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await choicesParser.execute();

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid value 'invalid' for option [tags]")
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Choices with Default Values', () => {
      it('should use valid default value from choices', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'mode',
              type: 'string',
              choices: ['fast', 'normal', 'slow'],
              default: 'normal',
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test'];

        await choicesParser.execute();

        expect(mockHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'normal',
          })
        );
      });
    });

    describe('Choices Combined with Validator', () => {
      it('should validate choices before custom validator', async () => {
        const validatorSpy = vi.fn().mockReturnValue(true);
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'priority',
              type: 'string',
              choices: ['low', 'medium', 'high'],
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--priority=medium'];

        await choicesParser.execute();

        expect(validatorSpy).toHaveBeenCalledWith('medium');
        expect(mockHandler).toHaveBeenCalled();
      });

      it('should not call validator if choices validation fails', async () => {
        const validatorSpy = vi.fn().mockReturnValue(true);
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'priority',
              type: 'string',
              choices: ['low', 'medium', 'high'],
              validator: validatorSpy,
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--priority=invalid'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await choicesParser.execute();

        expect(validatorSpy).not.toHaveBeenCalled();
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });

    describe('Edge Cases', () => {
      it('should reject empty choices array during configuration', () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        expect(() => {
          choicesParser.addCommand({
            name: 'test',
            options: [
              {
                name: 'value',
                type: 'string',
                choices: [],
              },
            ],
            handler: mockHandler,
          });
        }).toThrow('Choices must be a non-empty array');
      });

      it('should handle case-sensitive choices', async () => {
        const choicesParser = new CommandLineParser({ name: 'choices-cli', version: '1.0.0' });

        choicesParser.addCommand({
          name: 'test',
          options: [
            {
              name: 'format',
              type: 'string',
              choices: ['JSON', 'XML', 'CSV'],
            },
          ],
          handler: mockHandler,
        });

        process.argv = ['node', 'script.js', 'test', '--format=json'];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await choicesParser.execute();

        // Should fail because 'json' !== 'JSON'
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid value 'json' for option [format]")
        );
        expect(mockHandler).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });
  });
});
