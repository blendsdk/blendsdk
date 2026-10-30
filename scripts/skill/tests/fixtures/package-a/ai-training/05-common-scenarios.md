```markdown
# package-a Common Scenarios

> **Package**: `@blendsdk/package-a`
> **Version**: 5.42.0

---

## Greeting a list of users

Map over the input and call `greeter` for each entry.

```typescript
import { greeter } from '@blendsdk/package-a';

const names = ['ada', 'grace'];
const messages = names.map(greeter);
```
```
