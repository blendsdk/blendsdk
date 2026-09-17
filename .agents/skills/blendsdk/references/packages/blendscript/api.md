> **Package**: `blendsdk/blendscript`

# blendscript API Reference

---

## Classes

### BlendScriptApiError

The `BlendScriptApiError` class represents errors that occur due to invalid API calls.

| Method      | Signature                                               | Returns  | Description                            |
|-------------|--------------------------------------------------------|----------|----------------------------------------|
| constructor | `new BlendScriptApiError(code: BlendScriptApiErrorCode, message: string)` | `BlendScriptApiError` | Creates a new instance with a specific error code and message. |

---

## Functions

### compileExpression

Compiles an expression into a reusable handle.

#### Signature

```typescript
compileExpression(source: string, options: ExpressionOptions): CompilationResult
```

#### Parameters

| Parameter | Type                | Required | Default | Description                                             |
|-----------|---------------------|----------|---------|---------------------------------------------------------|
| source    | `string`            | Yes      |         | The expression source to compile.                      |
| options   | `ExpressionOptions` | Yes      |         | The schema and expected result type for the expression. |

#### Returns

`CompilationResult` — The result of the compilation process.

#### Example

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Enabled: { type: 'boolean' } },
};

const result = compileExpression('Enabled', options);
if (result.ok) {
  console.log('Compiled successfully:', result.expression);
} else {
  console.error('Compilation failed:', result.diagnostics);
}
```

---

### evaluateExpression

Evaluates a compiled expression against provided data.

#### Signature

```typescript
evaluateExpression(expression: CompiledExpression, data: Readonly<Record<string, ExpressionValue>>): EvaluationResult
```

#### Parameters

| Parameter  | Type                            | Required | Default | Description                                              |
|------------|---------------------------------|----------|---------|----------------------------------------------------------|
| expression | `CompiledExpression`            | Yes      |         | The compiled expression to evaluate.                    |
| data       | `Readonly<Record<string, ExpressionValue>>` | Yes      |         | The data to evaluate against the compiled expression.   |

#### Returns

`EvaluationResult` — The result of the evaluation process.

#### Example

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const expressionSource = 'Enabled == true';
const options = { schema: { Enabled: { type: 'boolean' } } };
const compilation = compileExpression(expressionSource, options);

if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { Enabled: true });
  console.log(result); // Output: { ok: true, value: true }
}
```

---

### validateExpression

Validates the syntax of an expression against a defined schema.

#### Signature

```typescript
validateExpression(source: string, options: ExpressionOptions): ValidationResult
```

#### Parameters

| Parameter | Type                | Required | Default | Description                                              |
|-----------|---------------------|----------|---------|----------------------------------------------------------|
| source    | `string`            | Yes      |         | The expression source to validate.                      |
| options   | `ExpressionOptions` | Yes      |         | The schema against which to validate the expression.    |

#### Returns

`ValidationResult` — The result of the validation process.

#### Example

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Country: { type: 'string' } },
};

const validationResult = validateExpression('Country == "NL"', options);
if (validationResult.ok) {
  console.log('Validation successful.');
} else {
  console.error('Validation failed:', validationResult.diagnostics);
}
```

---

## Types & Interfaces

### ExpressionOptions

Defines the options for validation and compilation, including schema and expected result type.

| Property            | Type                       | Description                                                      |
|---------------------|----------------------------|------------------------------------------------------------------|
| schema              | `ExpressionSchema`        | The complete set of fields available to the expression.         |
| expectedResult      | `ExpressionValueType`     | An optional exact result type required from the expression.     |

### CompilationResult

The result of attempting to compile an expression.

| Property         | Type                                   | Description                                |
|-------------------|----------------------------------------|--------------------------------------------|
| ok                | `boolean`                              | Indicates whether the compilation was successful. |
| diagnostics       | `readonly ExpressionDiagnostic[]`     | A list of diagnostics if the compilation failed.   |
| expression        | `CompiledExpression`                   | The compiled expression if successful.             |

### EvaluationResult

The result of evaluating a compiled expression.

| Property         | Type                                    | Description                                |
|-------------------|-----------------------------------------|--------------------------------------------|
| ok                | `boolean`                               | Indicates whether the evaluation was successful. |
| diagnostic        | `ExpressionDiagnostic`                  | Diagnostics if the evaluation failed.          |
| value             | `ExpressionValue`                       | The evaluated result if successful.           |

### ExpressionValue

The values that can be processed within BlendScript, including scalar types.

| Type               | Description                                       |
|--------------------|---------------------------------------------------|
| `string`           | A string value.                                   |
| `number`           | A numeric value.                                  |
| `boolean`          | A boolean value.                                  |
| `null`             | Represents a null value.                          |

---

## Enums / Constants

### BlendScriptApiErrorCode

Error codes used to identify issues raised by the BlendScript API.

| Value                             | Description                                     |
|-----------------------------------|-------------------------------------------------|
| `BS_INVALID_ARGUMENT`             | Indicates an invalid argument was passed.       |
| `BS_INVALID_SCHEMA`               | Indicates the schema provided is invalid.      |
| `BS_INVALID_OPTIONS`              | Indicates options provided are invalid.         |
| `BS_INVALID_COMPILED_EXPRESSION`  | Indicates an invalid compiled expression was used.|
| `BS_SCHEMA_FIELD_LIMIT_EXCEEDED`  | Indicates the defined schema has too many fields.|

---

## Error Handling

### BlendScriptApiError

Use this class to manage errors occurring due to misconfigured API calls.

```typescript
import { BlendScriptApiError } from 'blendsdk/blendscript';

try {
  const result = compileExpression('Invalid Expression', { schema: {} });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error('API Error:', error.code, error.message);
  }
}

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
