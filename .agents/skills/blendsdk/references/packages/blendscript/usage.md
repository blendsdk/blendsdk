> **Package**: `blendsdk/blendscript`

# blendscript Core Concepts

---

## What Is BlendScript

BlendScript is a small, safe expression language designed for defining business rules. It provides a way to validate and evaluate expressions dynamically based on user-defined schemas. Its syntax is simple and intuitive, making it accessible for developers and non-developers alike.

---

## How It Works

BlendScript operates by using a multi-step pipeline for processing expressions:

1. **Lexical Analysis**: The source code is tokenized into meaningful symbols.
2. **Parsing**: Tokens are transformed into an abstract syntax tree (AST).
3. **Analysis**: The AST is validated against a provided schema to check for errors and type compatibility.
4. **Compilation**: Valid expressions are compiled into a reusable opaque handle.
5. **Evaluation**: Compiled expressions are executed against a runtime data record, returning evaluation results, including success or potential errors.

This structured approach ensures that BlendScript maintains high levels of safety and correctness, preventing common runtime errors associated with dynamic expression evaluation.

---

## Complete Example

Here’s a complete example demonstrating key features of BlendScript, including schema definition, expression compilation, and evaluation.

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

// Define a schema
const options = {
  schema: {
    Age: { type: 'number' },
    Status: { type: 'string' },
  },
  expectedResult: 'boolean',
};

// Validate an expression
const validation = validateExpression('Age >= 18 AND Status == "active"', options);
if (validation.ok) {
  // Compile the expression if validation is successful
  const compilation = compileExpression('Age >= 18 AND Status == "active"', options);
  if (compilation.ok) {
    // Evaluate the compiled expression with data
    const evaluation = evaluateExpression(compilation.expression, { Age: 20, Status: "active" });
    console.log(evaluation); // Output: { ok: true, value: true }
  } else {
    console.error('Compilation failed:', compilation.diagnostics);
  }
} else {
  console.error('Validation failed:', validation.diagnostics);
}
```

---

## Key Methods/Properties Table

| Name                   | Type/Signature                                       | Description                                                       |
|------------------------|-----------------------------------------------------|-------------------------------------------------------------------|
| `compileExpression`    | `(source: string, options: ExpressionOptions) => CompilationResult` | Compiles source expression into an opaque handle after validation.|
| `evaluateExpression`   | `(expression: CompiledExpression, data: Record<string, ExpressionValue>) => EvaluationResult` | Evaluates a compiled expression against provided data.           |
| `validateExpression`   | `(source: string, options: ExpressionOptions) => ValidationResult` | Validates source expression against a defined schema.            |
| `BlendScriptApiError`  | `class`                                            | Error class for reporting API misuse.                            |
| `ExpressionOptions`    | `interface`                                        | Options for validation and compilation, including schema and expected result type. |
| `CompilationResult`    | `type`                                            | Result type returned from `compileExpression`, indicating success or failure with diagnostics. |
| `EvaluationResult`     | `type`                                            | Result type returned from `evaluateExpression`, indicating success or failure with the value or diagnostic. |

--- 

## Related Concepts

- *Built-ins*: Explore the built-in functions available for use in BlendScript.
- *Error Handling*: Guidelines on handling errors and diagnostics when working with BlendScript.
- *Expressions*: A closer look at how expressions are constructed and evaluated.

---

---

# blendscript Basic Usage

---

## Installation

To install the `blendsdk/blendscript` package, run the following command:

```bash
npm install blendsdk/blendscript
```

or if you prefer yarn:

```bash
yarn add blendsdk/blendscript
```

---

## Quick Start

Here is a minimal setup to get started with BlendScript:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { active: { type: 'boolean' } },
};

const compiled = compileExpression('active == true', options);
if (compiled.ok) {
  const result = evaluateExpression(compiled.expression, { active: true });
  console.log(result); // Output: { ok: true, value: true }
}
```

---

## Fundamentals

### Expression Compilation

You can compile expressions using the `compileExpression` function. This function checks the syntax and prepares it for evaluation.

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const options = {
  schema: { age: { type: 'number' } },
};

const compilationResult = compileExpression('age >= 18', options);
if (compilationResult.ok) {
  console.log('Compilation successful:', compilationResult);
} else {
  console.error('Compilation failed:', compilationResult.diagnostics);
}
```

### Expression Evaluation

Once an expression is compiled, you can evaluate it against runtime data using the `evaluateExpression` function.

```typescript
import { evaluateExpression } from 'blendsdk/blendscript';

const data = { age: 20 };
const evaluation = evaluateExpression(compilationResult.expression, data);
if (evaluation.ok) {
  console.log('Evaluation result:', evaluation.value); // Output: true or false based on the evaluation
}
```

### Expression Validation

Before compiling, you can validate an expression using the `validateExpression` function. This ensures that your expression adheres to the defined schema.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const validationOptions = {
  schema: { status: { type: 'string' } },
};

const validationResult = validateExpression('status == "active"', validationOptions);
if (validationResult.ok) {
  console.log('Expression is valid.');
} else {
  console.error('Validation failed:', validationResult.diagnostics);
}
```

---

## Configuration

### Common Configuration Options

| Name              | Type                       | Default   | Description                                                 |
|-------------------|----------------------------|-----------|-------------------------------------------------------------|
| `schema`          | `ExpressionSchema`         | Required  | The complete set of fields available to the expression.    |
| `expectedResult`  | `ExpressionValueType`      | Optional  | An optional exact result type required from the expression. |

---

## Error Handling

Handle errors gracefully using `BlendScriptApiError` in your code. It provides meaningful error codes to help identify issues.

```typescript
import { BlendScriptApiError } from 'blendsdk/blendscript';

try {
  const result = validateExpression('status == "active"', myOptions);
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error('BlendScript API error:', error.code, error.message);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

Use the diagnostics returned from `validateExpression`, `compileExpression`, and `evaluateExpression` to troubleshoot specific issues related to schema violations, compilation failures, or evaluation errors.

---

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
