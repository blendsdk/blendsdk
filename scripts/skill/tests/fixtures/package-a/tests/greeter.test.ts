import { greeter } from '../src/greeter.js';

test('greets by name', () => {
  expect(greeter('world')).toBe('Hello, world!');
});
