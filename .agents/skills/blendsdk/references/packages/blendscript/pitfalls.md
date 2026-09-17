> **Package**: `blendsdk/blendscript`

# blendscript Best Practices

---

## Do / Don't Pairs

### Do: Use Strict Typing
```typescript
import { compileExpression } from 'blendsdk/blendscript';

const options = {
  schema: { age: { type: 'number' } },
};

const result = compileExpression('age >= 18', options); // ✅ Correct
```
```typescript
import { compileExpression } from 'blendsdk/blendscript';

const result = compileExpression('age >= 18', { schema: {} }); // ❌ Wrong: Missing type safety in schema
```
**Why**: Not defining types can lead to errors during compilation and evaluation. Always provide a robust type definition in your schema.

---

### Do: Handle Errors Gracefully
```typescript
import { compileExpression } from 'blendsdk/blendscript';

try {
  const result = compileExpression('InvalidExpression', { schema: {} });
} catch (error) {
  console.error('Error during compilation:', error); // ✅ Correct: Handle potential errors properly
}
```
```typescript
import { compileExpression } from 'blendsdk/blendscript';

const result = compileExpression('InvalidExpression', { schema: {} }); // ❌ Wrong: No error handling implemented
```
**Why**: Failing to handle errors can cause unhandled promise rejections in async scenarios, leading to application crashes.

---

### Do: Use Built-In Functions Appropriately
```typescript
import { validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { textValue: { type: 'string' } },
};

const result = validateExpression('isEmpty(textValue)', options); // ✅ Correct: Valid use of built-in
```
```typescript
import { validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {},
};

const result = validateExpression('isEmpty()', options); // ❌ Wrong: Invalid argument count for isEmpty
```
**Why**: Each built-in function requires appropriate arguments. Always refer to the documentation to ensure you are using them correctly to prevent type mismatches.

---

## Anti-Patterns

### Using `any` Type
Avoid using the `any` type in expressions. It defeats the purpose of TypeScript's type checking and can lead to runtime errors.
```typescript
// ❌ Wrong: Use of any 
const options: { schema: any } = { schema: {} }; 
```
Instead, always use explicit types based on your schema definition.

---

### Allowing Dynamic Code Execution
Using `eval` or dynamic import statements can lead to security risks and unpredictable behavior in your SDK.
```typescript
// ❌ Wrong: Using eval
const result = eval('age >= 18'); 
```
Always use the provided APIs in BlendScript to evaluate expressions safely without running arbitrary code.

---

## Performance Tips

### Minimize Recompilation
Compile expressions once and reuse the compiled handles rather than recompiling them with each evaluation.
```typescript
const expression = compileExpression('age >= 18', options);
const result1 = evaluateExpression(expression, { age: 20 });
const result2 = evaluateExpression(expression, { age: 25 }); // ✅ Reusing compiled expression
```

### Efficient Validation 
Validate expressions before compiling them. This prevents unnecessary compilation of invalid expressions, saving resources.
```typescript
const validationResult = validateExpression('age > 18', options);
if (validationResult.ok) {
  const compilationResult = compileExpression('age > 18', options); // Validated before compilation
}
```

---

## Security Considerations

### Prevent Code Injection
Always validate input and schema definitions to protect against code injection attacks. Avoid using user-generated strings directly in expressions.
```typescript
const validationResult = validateExpression(userInput, options); // Always validate user input
```

### Handle Nullable Carefully
When dealing with nullable fields in schemas, ensure that logic properly accounts for null values to avoid unexpected behaviors.
```typescript
const options = {
  schema: { name: { type: 'string', nullable: true } },
};

// Check for nullability
const result = compileExpression('name == NULL', options);
```

By following these best practices, developers can ensure that their use of the `blendsdk/blendscript` package is correct, safe, and performs well while leveraging the power of TypeScript.

---

# blendscript Testing Patterns

---

## Test Setup

For testing BlendScript applications, ensure you have the required imports and testing configurations in your test files.

### Required Imports

```typescript
import { describe, it, expect } from 'vitest';
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';
```

### Configuration

Make sure Vitest is properly configured to run TypeScript tests. Use the following commands to set up your test environment:

```bash
npm install --save-dev vitest ts-node
```

Add a Vitest configuration in your `package.json` under the `scripts` section to run your tests:
```json
{
  "scripts": {
    "test": "vitest run --reporter=verbose"
  }
}
```

---

## Unit Testing

### How to Unit Test Code

Unit tests should focus on testing individual pieces of logic in isolation. When testing BlendScript functions, you want to validate the various outcomes based on different inputs and schemas.

### Example

Here’s an example of how to unit test the `validateExpression`, `compileExpression`, and `evaluateExpression` functions.

```typescript
import { describe, it, expect } from 'vitest';
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    Age: { type: 'number' },
    Status: { type: 'string' },
  },
};

describe('BlendScript Unit Tests', () => {
  it('should validate correct expressions', () => {
    const validation = validateExpression('Age >= 18 AND Status == "active"', options);
    expect(validation.ok).toBe(true);
    expect(validation.referencedFields).toEqual(['Age', 'Status']);
  });

  it('should compile valid expressions', () => {
    const compilation = compileExpression('Age >= 18 AND Status == "active"', options);
    expect(compilation.ok).toBe(true);
  });

  it('should evaluate expressions correctly', () => {
    const compilation = compileExpression('Age >= 18 AND Status == "active"', options);
    if (compilation.ok) {
      const result = evaluateExpression(compilation.expression, { Age: 20, Status: 'active' });
      expect(result).toEqual({ ok: true, value: true });
    }
  });

  it('should return diagnostics for invalid expressions', () => {
    const validation = validateExpression('Age && Status', options);
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toBeDefined();
  });
});
```

---

## Integration Testing

### How to Integration Test with Real Instances

Integration tests should check how different parts of your code work together, including validation, compilation, and evaluation of expressions in real-world scenarios.

### Example

Here’s how you can test the complete flow from validation to evaluation:

```typescript
import { describe, it, expect } from 'vitest';
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    age: { type: 'number' },
    country: { type: 'string' },
  },
};

describe('BlendScript Integration Tests', () => {
  it('should validate, compile, and evaluate a binding expression', () => {
    const expression = 'age >= 18 AND country == "US"';
    
    const validation = validateExpression(expression, options);
    expect(validation.ok).toBe(true);
    
    const compilation = compileExpression(expression, options);
    expect(compilation.ok).toBe(true);
    
    const result = evaluateExpression(compilation.expression, { age: 20, country: 'US' });
    expect(result).toEqual({ ok: true, value: true });
  });
});
```

---

## Mocking & Stubbing

### How to Mock This Package's Components in Consumer Tests

When testing, it can be beneficial to mock the internal functions of BlendScript to isolate tests and avoid dependencies on the actual implementation.

### Example

Utilize a mocking library to simulate the behavior of BlendScript functions.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

describe('BlendScript Mocking Tests', () => {
  it('should mock the compileExpression function', () => {
    const mockCompile = vi.spyOn(BlendScript, 'compileExpression').mockReturnValue({ ok: true, expression: {} });

    const result = compileExpression('expr', { schema: {} });
    expect(mockCompile).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, expression: {} });
    
    mockCompile.mockRestore(); // Restore original implementation
  });
});
```

---

## Test Patterns by Feature

### Testing Validation

- **Valid Inputs**:
    - Provide correct schema and expressions that should validate successfully.
  
- **Invalid Inputs**:
    - Use expressions with unknown fields or incorrect types in the schema.

### Testing Compilation

- Ensure that only valid expressions compile successfully, while invalid expressions return appropriate diagnostics.

### Testing Evaluation

- Evaluate compiled expressions against various data sets, including edge cases like `null`, `undefined`, and unexpected data types.

### Example

```typescript
describe('Feature Testing', () => {
  it('should handle validation and compilation for mixed types', () => {
    const schema = { field: { type: 'string', nullable: true } };
    const validExpression = validateExpression('field == NULL', { schema });
    expect(validExpression.ok).toBe(true);
    
    const compilation = compileExpression('field == NULL', { schema });
    expect(compilation.ok).toBe(true);
  });
});
```

With the above patterns, you can cover various scenarios and ensure your BlendScript code is thoroughly tested.

---

# blendscript Troubleshooting

---

## Common Errors

### 1. Syntax Error: Unexpected token
- **Error Message / Symptom**: `SyntaxError: Unexpected token`
- **Cause**: This error usually occurs when there's a mistake in the expression syntax, such as a missing operator or unmatched parentheses.
- **Fix**:
  Ensure the expression is valid by checking for unmatched parentheses or similar syntax issues. Here’s an example:

  ```typescript
  import { validateExpression } from 'blendsdk/blendscript';

  const options = {
    schema: { Age: { type: 'number' } },
  };

  // Incorrect expression
  const result = validateExpression('Age >= 18 AND', options); // Causes syntax error
  console.log(result); // Verify the result provides error diagnostics
  ```

### 2. Unknown Field Error
- **Error Message / Symptom**: `BS_UNKNOWN_FIELD`
- **Cause**: This indicates that an expression references a field not defined in the provided schema.
- **Fix**:
  Check your schema definitions and ensure that all field names used in the expression exist in the schema. Here’s an example:

  ```typescript
  import { validateExpression } from 'blendsdk/blendscript';

  const options = {
    schema: { Age: { type: 'number' } }, // Here Age is defined, but Country is not
  };

  const result = validateExpression('Country == "US"', options);
  console.log(result.diagnostics); // Check for BS_UNKNOWN_FIELD diagnostic
  ```

### 3. Type Mismatch Error
- **Error Message / Symptom**: `BS_TYPE_MISMATCH`
- **Cause**: This happens when the types of the operands being compared or operated on do not match the expected types defined in the schema.
- **Fix**:
  Ensure that the types of values being compared or operated on match those defined in the schema. For example:

  ```typescript
  import { validateExpression } from 'blendsdk/blendscript';

  const options = {
    schema: { Age: { type: 'number' }, Name: { type: 'string' } },
  };

  const result = validateExpression('Age == "18"', options); // Type mismatch: Age is number, "18" is string
  console.log(result.diagnostics); // Check for BS_TYPE_MISMATCH diagnostic
  ```

### 4. Invalid Argument Count
- **Error Message / Symptom**: `BS_INVALID_ARGUMENT_COUNT`
- **Cause**: This error indicates that the number of arguments passed to a built-in function doesn't match what the function expects.
- **Fix**:
  Check the built-in function's requirements and ensure that the correct number of arguments is provided. Example:

  ```typescript
  import { validateExpression } from 'blendsdk/blendscript';

  const options = {
    schema: { Description: { type: 'string' } },
  };

  const result = validateExpression('trim(Description, "extra")', options); // Incorrect: trim expects 1 argument
  console.log(result.diagnostics); // Check for BS_INVALID_ARGUMENT_COUNT diagnostic
  ```

---

## Debugging Strategies

To effectively diagnose issues with the `blendsdk/blendscript` package, follow these actionable steps:

1. **Use Diagnostic Messages**: Always check diagnostics returned from validation, compilation, and evaluation. They provide crucial information about the failure.

2. **Isolate the Expression**: Simplify the expression when debugging to understand which part is causing the failure. Start with the simplest valid expression and gradually add complexity.

   ```typescript
   const validation = validateExpression('Age >= 18', options);
   // Start with a simple expression, then incrementally build.
   ```

3. **Verify Schema Definitions**: Ensure your schema correctly reflects the types expected in your expressions. Invalid or incomplete schemas often lead to errors.

4. **Test with Known Values**: Use hardcoded, well-known values to verify functionality. This helps ensure that issues aren't originating from unexpected data.

   ```typescript
   const evaluation = evaluateExpression(compilation.expression, { Age: 20 });
   ```

5. **Review Console Output**: Pay close attention to outputs and console logs for unexpected behavior or outputs.

---

## Known Pitfalls

### 1. Forgetting to Validate Before Compile
Design your workflow to always validate your expressions before attempting to compile or evaluate them. Skipping validation can lead to runtime errors during execution.

### 2. Not Handling Nullable Fields
When using nullable fields, ensure expressions properly account for null values. Always check the nullability conditions to avoid unexpected results.

### 3. Ignoring Built-in Requirements
Every built-in function has specific parameters it expects. Be mindful of your function usage to avoid argument mismatch errors.

### 4. Lack of Return Type Handling
Ensure you handle return types appropriately across all expressions. Neglecting to account for the expected return type can lead to logical bugs.

By being aware of these common errors, debugging strategies, and pitfalls, you can build more robust applications utilizing `blendsdk/blendscript` and significantly enhance your productivity while working with expressions.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
