```markdown
# package-a Overview for LLMs

> **Package**: `@blendsdk/package-a`
> **Version**: 5.42.0
> **Language**: TypeScript (strict mode)
> **Import**: `import { ... } from '@blendsdk/package-a'`

---

## What It Is

`@blendsdk/package-a` is a tiny fixture package. It integrates with
`@blendsdk/webafx` at runtime and ships a single greeting helper.

---

## Minimum Example

```typescript
import { greeter } from '@blendsdk/package-a';

console.log(greeter('world'));
```
```
