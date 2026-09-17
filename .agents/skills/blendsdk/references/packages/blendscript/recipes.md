> **Package**: `blendsdk/blendscript`

# blendscript Advanced Patterns

---

## Composite Expressions

### When to Use

This pattern is ideal when you have multiple conditions to evaluate that can be combined into a single logical expression. It enhances readability and simplifies managing complex business rules.

### Complete Code Example

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    Age: { type: 'number' },
    Country: { type: 'string' },
    Status: { type: 'string' },
  },
};

// Combine multiple conditions into a single expression
const expressionSource = 'Age >= 18 AND Country == "US" AND Status == "active"';
const compilation = compileExpression(expressionSource, options);

if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { Age: 20, Country: "US", Status: "active" });
  console.log(result); // Output: { ok: true, value: true }
}
```

### Explanation

This pattern allows you to create complex logical expressions by combining multiple conditions using logical operators. It enhances the ability to define multifaceted business rules by leveraging concise syntax.

### Caveats

- Ensure that each referenced property in the expression exists in the provided schema.
- Evaluating very complex expressions with numerous conditions may lead to performance considerations, particularly with deep logical nesting or extensive lists of conditions.

---

## Handling Nullable Values

### When to Use

This pattern is necessary when your schema allows nullable fields, and you want to perform evaluations that specifically handle `null` cases correctly.

### Complete Code Example

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    FirstName: { type: 'string', nullable: true },
    Age: { type: 'number' },
  },
};

// Evaluating nullable fields
const expressionSource = 'FirstName == NULL OR Age >= 18';
const compilation = compileExpression(expressionSource, options);

if (compilation.ok) {
  const result1 = evaluateExpression(compilation.expression, { FirstName: null, Age: 20 });
  const result2 = evaluateExpression(compilation.expression, { FirstName: "John", Age: 16 });
  console.log(result1); // Output: { ok: true, value: true }
  console.log(result2); // Output: { ok: true, value: false }
}
```

### Explanation

Handling nullable values allows you to craft expressions that can differentiate between present and absent values. This is particularly useful when dealing with optional data fields.

### Caveats

- Ensure to check for nullability correctly in expressions to prevent unwanted evaluations.
- Evaluations against nullable fields should be planned to avoid unexpected runtime errors.

---

## Built-in Functions with Composite Logic

### When to Use

Use this pattern when you need to apply built-in functions to process the input values before making final comparisons or evaluations, particularly when they involve dynamic or computed conditions.

### Complete Code Example

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    Description: { type: 'string' },
    IsActive: { type: 'boolean' },
  },
};

// Using built-in functions within conditions
const expressionSource = 'isEmpty(Description) AND IsActive == true';
const compilation = compileExpression(expressionSource, options);

if (compilation.ok) {
  const result1 = evaluateExpression(compilation.expression, { Description: '', IsActive: true });
  const result2 = evaluateExpression(compilation.expression, { Description: 'Active', IsActive: true });
  console.log(result1); // Output: { ok: true, value: true }
  console.log(result2); // Output: { ok: true, value: false }
}
```

### Explanation

This pattern showcases how to effectively combine built-in functions with logical conditions for robust evaluations. It provides a powerful capability to enforce business rules that depend on value transformations and checks.

### Caveats

- Be aware of built-ins that can handle null values appropriately.
- Ensure the appropriate types are being passed to built-in functions to avoid type mismatches during evaluations.

---

## Expression Composition with Reusable Handles

### When to Use

This pattern is valuable when an expression will be evaluated multiple times with different datasets, allowing for increased performance and cleaner code.

### Complete Code Example

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { 
    Value: { type: 'number' }, 
    Threshold: { type: 'number' },
  },
};

// Compile once and reuse
const expressionSource = 'Value > Threshold';
const compilation = compileExpression(expressionSource, options);

if (compilation.ok) {
  const evaluations = [
    evaluateExpression(compilation.expression, { Value: 10, Threshold: 5 }),
    evaluateExpression(compilation.expression, { Value: 3, Threshold: 5 }),
    evaluateExpression(compilation.expression, { Value: 7, Threshold: 7 }),
  ];

  evaluations.forEach((result, index) => {
    console.log(`Evaluation ${index + 1}:`, result);
  });
}
```

### Explanation

This pattern emphasizes performance by compiling an expression into a reusable handle, which can be evaluated multiple times with different input data without needing to recompile the expression each time.

### Caveats

- The compiled expression can only be reused in the context where it was created.
- Changes to the schema after compilation may invalidate the handle and lead to runtime errors.

---

## Advanced Error Handling with Diagnostics

### When to Use

Utilize this pattern when configuring complex expressions or when handling user-generated input that can often lead to a variety of diagnostic errors.

### Complete Code Example

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    Age: { type: 'number' },
    Country: { type: 'string' },
  },
};

// Validate and compile the expression while handling diagnostics
const expressionSource = 'Age >= 18 AND Country == "active"';
const validation = validateExpression(expressionSource, options);
if (!validation.ok) {
  console.error('Validation errors:', validation.diagnostics);
} else {
  const compilation = compileExpression(expressionSource, options);
  if (compilation.ok) {
    const result = evaluateExpression(compilation.expression, { Age: 20, Country: 'US' });
    console.log(result); // Output: { ok: true, value: true }
  } else {
    console.error('Compilation errors:', compilation.diagnostics);
  }
}
```

### Explanation

By utilizing advanced error handling techniques and capturing diagnostics during validation and compilation, developers can significantly improve debugging and error management. This is crucial for maintaining a robust application.

### Caveats

- Always check the error codes and messages returned for meaningful debugging.
- Avoid assuming validation passes—always perform validation before compilation and evaluation.

---

---

# blendscript Common Scenarios

---

## How do I validate an expression with a schema?

To validate an expression against a defined schema, you can use the `validateExpression` function. This checks the syntax and types without compiling the expression.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Country: { type: 'string' } },
};

const validation = validateExpression('Country == "NL"', options);
console.log(validation); // Output: { ok: true, resultType: 'boolean', referencedFields: ['Country'] }
```

---

## How do I compile an expression after validation?

After validating an expression, you can compile it using the `compileExpression` function. This prepares the expression for evaluation.

```typescript
import { validateExpression, compileExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Enabled: { type: 'boolean' } },
};

const expression = 'Enabled == true';
const validation = validateExpression(expression, options);
if (validation.ok) {
  const compilation = compileExpression(expression, options);
  console.log(compilation); // Output: { ok: true, expression: {...}, resultType: 'boolean', referencedFields: ['Enabled'] }
}
```

---

## How do I evaluate a compiled expression?

To evaluate a compiled expression against runtime data, use the `evaluateExpression` function. This will return the result of the evaluation.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Enabled: { type: 'boolean' } },
};

const compilation = compileExpression('Enabled == true', options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { Enabled: true });
  console.log(result); // Output: { ok: true, value: true }
}
```

---

## How do I handle errors during validation or evaluation?

You can handle errors by checking the result of validation or evaluation. If the `ok` property is `false`, the corresponding diagnostics will provide details about the error.

```typescript
import { validateExpression, compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = { schema: { Age: { type: 'number' } } };
const expression = 'Age >= 18';

const validation = validateExpression(expression, options);
if (!validation.ok) {
  console.error('Validation failed:', validation.diagnostics);
} else {
  const compilation = compileExpression(expression, options);
  if (!compilation.ok) {
    console.error('Compilation failed:', compilation.diagnostics);
  } else {
    const result = evaluateExpression(compilation.expression, { Age: 20 });
    console.log(result); // Output: { ok: true, value: true }
  }
}
```

---

## How do I use built-in functions in expressions?

Built-in functions such as `isEmpty` and `trim` can be utilized in your expressions. Ensure that you provide the appropriate types in the schema for the fields being utilized.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Description: { type: 'string' }, IsActive: { type: 'boolean' } },
};

const expression = 'isEmpty(Description) AND IsActive == true';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { Description: '', IsActive: true });
  console.log(result); // Output: { ok: true, value: true }
}
```

---

## How do I use nullable fields in expressions?

To use nullable fields, specify `nullable: true` in your schema for the corresponding field. Handle the null cases explicitly in your expressions.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Name: { type: 'string', nullable: true }, Status: { type: 'boolean' } },
};

const expression = 'Name == NULL OR Status == true';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const data = { Name: null, Status: true };
  const result = evaluateExpression(compilation.expression, data);
  console.log(result); // Output: { ok: true, value: true }
}
```

---

## How do I ensure safe execution and avoid code injection?

When using `blendsdk/blendscript`, avoid any dynamic execution functions such as `eval` and ensure all expressions and schemas are validated before execution. Built-in functions that handle null values can maintain safety during evaluation.

```typescript
import { validateExpression, compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Age: { type: 'number' }, Country: { type: 'string' } },
};

// Validate expression before evaluation
const expression = 'Age >= 18 AND Country == "US"';
const validation = validateExpression(expression, options);
if (validation.ok) {
  const compilation = compileExpression(expression, options);
  if (compilation.ok) {
    const result = evaluateExpression(compilation.expression, { Age: 20, Country: 'US' });
    console.log(result); // Output: { ok: true, value: true }
  }
}
```

---

## How do I manage complex expressions?

You can manage complex expressions by breaking them into smaller, reusable components. This reduces redundancy and enhances readability. Compile expressions once and reuse the handles.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

// Define your schema and a complex expression
const options = { schema: { Age: { type: 'number' }, Status: { type: 'string' } } };
const baseExpression = 'Age >= 18';
const complexExpression = `${baseExpression} AND Status == "active"`;

const compilation = compileExpression(complexExpression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { Age: 20, Status: 'active' });
  console.log(result); // Output: { ok: true, value: true }
}
```

---

## How do I use BlendScript in asynchronous environments?

You can use `blendsdk/blendscript` in asynchronous environments; just ensure that you properly handle any Promise-based logic. Use async functions when necessary with proper error handling.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const processData = async (options, data) => {
  const expression = 'Age >= 18';
  const compilation = compileExpression(expression, options);
  
  if (compilation.ok) {
    return evaluateExpression(compilation.expression, data);
  } else {
    throw new Error(`Compilation failed: ${compilation.diagnostics}`);
  }
};

const options = { schema: { Age: { type: 'number' } } };
processData(options, { Age: 20 })
  .then(result => console.log(result)) // Output: { ok: true, value: true }
  .catch(error => console.error(error));
```

---

With these common scenarios, you can effectively utilize the features and capabilities of the `blendsdk/blendscript` package to manage dynamic expressions in your applications.

---

# blendscript Examples Library

## Basic Expressions

### Validate a Simple Expression
This example shows how to validate a simple expression using a schema that includes a single boolean field.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { isActive: { type: 'boolean' } },
};

const validation = validateExpression('isActive == true', options);
console.log(validation); // Expected output: { ok: true, resultType: 'boolean', referencedFields: ['isActive'] }
```

### Compile a Simple Expression
In this example, we compile a basic expression that checks the value of a boolean field.

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const options = {
  schema: { isEnabled: { type: 'boolean' } },
};

const compilation = compileExpression('isEnabled', options);
console.log(compilation); // Expected output: { ok: true, expression: {...}, resultType: 'boolean', referencedFields: ['isEnabled'] }
```

### Evaluate a Compiled Expression
This example demonstrates how to evaluate a compiled expression against specific data.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { isActive: { type: 'boolean' } },
};

const compilation = compileExpression('isActive', options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { isActive: true });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

---

## Conditional Logic

### Using AND and OR in Conditions
This example shows combining multiple conditions using logical AND and OR in an expression.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    age: { type: 'number' },
    status: { type: 'string' },
  },
};

const expression = 'age >= 18 AND status == "active"';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { age: 20, status: 'active' });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

### Combining Conditions with Nullity Checks
This example demonstrates how to check for null values in conditional expressions.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    name: { type: 'string', nullable: true },
    isRegistered: { type: 'boolean' },
  },
};

const expression = 'name == NULL OR isRegistered == true';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { name: null, isRegistered: true });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

---

## Built-in Functions

### Using Built-in String Functions
This example shows how to use built-in functions like `trim` to manipulate string values in expressions.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { description: { type: 'string' } },
};

const expression = 'trim(description) == ""';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { description: '   ' });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

### Evaluating List Membership with IN
This example demonstrates how to check membership in a list using the IN operator.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { country: { type: 'string' } },
};

const expression = 'country IN ("US", "GB", "CA")';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { country: 'US' });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

---

## Error Handling

### Handling Compilation and Validation Errors
This example demonstrates how to catch errors during validation and compilation of an expression.

```typescript
import { validateExpression, compileExpression } from 'blendsdk/blendscript';

const options = {
  schema: { age: { type: 'number' } },
};

try {
  const validation = validateExpression('age >= 18', options);
  if (!validation.ok) {
    throw new Error(`Validation failed: ${validation.diagnostics}`);
  }
  const compilation = compileExpression('age >= 18', options);
  if (!compilation.ok) {
    throw new Error(`Compilation failed: ${compilation.diagnostics}`);
  }
} catch (error) {
  console.error(error.message);
}
```

---

## Advanced Usage

### Compiling Expressions for Reuse
Here’s how you can compile an expression once and reuse it for multiple evaluations.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { balance: { type: 'number' }, isActive: { type: 'boolean' } },
};

const expression = 'balance > 1000 AND isActive';
const compilation = compileExpression(expression, options);
if (compilation.ok) {
  const result1 = evaluateExpression(compilation.expression, { balance: 1500, isActive: true });
  const result2 = evaluateExpression(compilation.expression, { balance: 500, isActive: false });
  
  console.log(result1); // Expected output: { ok: true, value: true }
  console.log(result2); // Expected output: { ok: true, value: false }
}
```

---

## Combining Expressions
This example shows how to combine multiple expressions into a single line.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    age: { type: 'number' },
    country: { type: 'string' },
    isActive: { type: 'boolean' },
  },
};

const combinedExpression = 'age >= 18 AND (country == "US" OR country == "CA") AND isActive';
const compilation = compileExpression(combinedExpression, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { age: 30, country: 'US', isActive: true });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

---

## Nullable Fields
### Handling Null Values in Conditions
Here’s how you can effectively deal with null values in expressions.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { name: { type: 'string', nullable: true }, isActive: { type: 'boolean' } },
};

const expressionWithNull = 'name == NULL OR isActive == true';
const compilation = compileExpression(expressionWithNull, options);
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { name: null, isActive: false });
  console.log(result); // Expected output: { ok: true, value: true }
}
```

This example demonstrates the behavior expected when explicitly checking for null values alongside other conditions.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
