```markdown
# package-a Best Practices

> **Package**: `@blendsdk/package-a`
> **Version**: 5.42.0

---

## Keep calls pure

Prefer passing values into `greeter` instead of reading shared state, so the
call stays easy to test.

## Validate input

Reject empty names at the edge of the application, not inside the helper.
```
