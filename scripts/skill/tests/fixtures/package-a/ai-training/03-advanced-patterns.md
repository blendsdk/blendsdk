```markdown
# package-a Advanced Patterns

> **Package**: `@blendsdk/package-a`
> **Version**: 5.42.0

---

## Composing greetings

Wrap `greeter` in a pipeline when messages must be normalized first.

```typescript
import { greeter } from '@blendsdk/package-a';

const shout = (name: string) => greeter(name).toUpperCase();
```
```
