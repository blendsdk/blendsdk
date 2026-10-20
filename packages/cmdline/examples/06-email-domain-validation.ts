import { CommandLineParser } from '../src';

/**
 * Example demonstrating email and domain validation types
 * This example shows how to use the new 'email' and 'domain' option types
 * for validating email addresses and domain names in command line arguments.
 */

// Create a parser for a hypothetical email configuration tool
const parser = new CommandLineParser({
  name: 'email-config',
  version: '1.0.0',
});

// Add a command that uses email and domain validation
parser.addCommand({
  name: 'setup',
  description: 'Setup email configuration with validation',
  options: [
    {
      name: 'sender-email',
      short: 's',
      type: 'email',
      description: 'Sender email address',
      required: true,
    },
    {
      name: 'reply-to',
      short: 'r',
      type: 'email',
      description: 'Reply-to email address',
      default: 'noreply@example.com',
    },
    {
      name: 'smtp-server',
      short: 'h',
      type: 'domain',
      description: 'SMTP server domain',
      required: true,
    },
    {
      name: 'allowed-domains',
      short: 'd',
      type: 'domain',
      description: 'Allowed domains for recipients',
      multiple: true,
    },
    {
      name: 'port',
      short: 'p',
      type: 'number',
      description: 'SMTP server port',
      default: 587,
    },
    {
      name: 'use-tls',
      short: 't',
      type: 'boolean',
      description: 'Use TLS encryption',
      default: true,
    },
  ],
  handler: async options => {
    console.log('Email Configuration Setup:');
    console.log('==========================');
    console.log(`Sender Email: ${options['sender-email']}`);
    console.log(`Reply-To: ${options['reply-to']}`);
    console.log(`SMTP Server: ${options['smtp-server']}`);
    console.log(`Port: ${options.port}`);
    console.log(`Use TLS: ${options['use-tls']}`);

    if (options['allowed-domains']) {
      console.log('Allowed Domains:');
      const domains = Array.isArray(options['allowed-domains'])
        ? options['allowed-domains']
        : [options['allowed-domains']];
      domains.forEach((domain: string) => {
        console.log(`  - ${domain}`);
      });
    }

    console.log('\nConfiguration saved successfully!');
    return { success: true };
  },
});

// Add another command for testing validation
parser.addCommand({
  name: 'validate',
  description: 'Validate email addresses and domains',
  options: [
    {
      name: 'email',
      short: 'e',
      type: 'email',
      description: 'Email address to validate',
      required: true,
    },
    {
      name: 'domain',
      short: 'd',
      type: 'domain',
      description: 'Domain to validate',
      required: true,
    },
  ],
  handler: async options => {
    console.log('Validation Results:');
    console.log('==================');
    console.log(`Email: ${options.email} ✓ Valid`);
    console.log(`Domain: ${options.domain} ✓ Valid`);
    return { email: options.email, domain: options.domain };
  },
});

// Example usage and error handling
async function runExample() {
  try {
    console.log('Email and Domain Validation Example');
    console.log('===================================\n');

    console.log('Try running these commands:');
    console.log('');
    console.log('Valid examples:');
    console.log(
      '  node email-config setup -s admin@company.com -h smtp.gmail.com -d company.com -d partner.org'
    );
    console.log('  node email-config validate -e user@example.com -d example.com');
    console.log('');
    console.log('Invalid examples (will show validation errors):');
    console.log('  node email-config setup -s invalid-email -h smtp.gmail.com');
    console.log('  node email-config validate -e user@invalid -d .invalid.domain');
    console.log('');

    // Execute the parser with current command line arguments
    await parser.execute();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run the example if this file is executed directly
if (require.main === module) {
  runExample();
}

export { parser, runExample };
