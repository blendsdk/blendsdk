```markdown
# package-a Testing Patterns

> **Package**: `@blendsdk/package-a`
> **Version**: 5.42.0

---

## Unit test the helper

Assert on the returned string rather than on internal calls.

```typescript
import { greeter } from '@blendsdk/package-a';

test('greets by name', () => {
  expect(greeter('world')).toBe('Hello, world!');
});
```
```
