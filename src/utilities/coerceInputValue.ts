import type { Maybe } from '../jsutils/Maybe';
import type { ObjMap } from '../jsutils/ObjMap';
import type { Path } from '../jsutils/Path';
import { hasOwnProperty } from '../jsutils/hasOwnProperty';
import { inspect } from '../jsutils/inspect';
import { invariant } from '../jsutils/invariant';
import { didYouMean } from '../jsutils/didYouMean';
import { isObjectLike } from '../jsutils/isObjectLike';
import { keyMap } from '../jsutils/keyMap';
import { suggestionList } from '../jsutils/suggestionList';
import { printPathArray } from '../jsutils/printPathArray';
import { addPath, pathToArray } from '../jsutils/Path';
import { isIterableObject } from '../jsutils/isIterableObject';

import { GraphQLError } from '../error/GraphQLError';

import type { GraphQLInputType } from '../type/definition';
import {
  isLeafType,
  assertLeafType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isRequiredInputField,
} from '../type/definition';

import type { ValueNode } from '../language/ast';
import { Kind } from '../language/kinds';

type OnErrorCB = (
  path: ReadonlyArray<string | number>,
  invalidValue: unknown,
  error: GraphQLError,
) => void;

/**
 * Coerces a JavaScript value given a GraphQL Input Type.
 */
export function coerceInputValue(
  inputValue: unknown,
  type: GraphQLInputType,
  onError: OnErrorCB = defaultOnError,
): unknown {
  return coerceInputValueImpl(inputValue, type, onError, undefined);
}

function defaultOnError(
  path: ReadonlyArray<string | number>,
  invalidValue: unknown,
  error: GraphQLError,
): void {
  let errorPrefix = 'Invalid value ' + inspect(invalidValue);
  if (path.length > 0) {
    errorPrefix += ` at "value${printPathArray(path)}"`;
  }
  error.message = errorPrefix + ': ' + error.message;
  throw error;
}

function coerceInputValueImpl(
  inputValue: unknown,
  type: GraphQLInputType,
  onError: OnErrorCB,
  path: Path | undefined,
): unknown {
  if (isNonNullType(type)) {
    if (inputValue != null) {
      return coerceInputValueImpl(inputValue, type.ofType, onError, path);
    }
    onError(
      pathToArray(path),
      inputValue,
      new GraphQLError(
        `Expected non-nullable type "${inspect(type)}" not to be null.`,
      ),
    );
    return;
  }

  if (inputValue == null) {
    // Explicitly return the value null.
    return null;
  }

  if (isListType(type)) {
    const itemType = type.ofType;
    if (isIterableObject(inputValue)) {
      return Array.from(inputValue, (itemValue, index) => {
        const itemPath = addPath(path, index, undefined);
        return coerceInputValueImpl(itemValue, itemType, onError, itemPath);
      });
    }
    // Lists accept a non-list value as a list of one.
    return [coerceInputValueImpl(inputValue, itemType, onError, path)];
  }

  if (isInputObjectType(type)) {
    if (!isObjectLike(inputValue)) {
      onError(
        pathToArray(path),
        inputValue,
        new GraphQLError(`Expected type "${type.name}" to be an object.`),
      );
      return;
    }

    const coercedValue: any = {};
    const fieldDefs = type.getFields();

    for (const field of Object.values(fieldDefs)) {
      const fieldValue = inputValue[field.name];

      if (fieldValue === undefined) {
        if (field.defaultValue !== undefined) {
          coercedValue[field.name] = field.defaultValue;
        } else if (isNonNullType(field.type)) {
          const typeStr = inspect(field.type);
          onError(
            pathToArray(path),
            inputValue,
            new GraphQLError(
              `Field "${field.name}" of required type "${typeStr}" was not provided.`,
            ),
          );
        }
        continue;
      }

      coercedValue[field.name] = coerceInputValueImpl(
        fieldValue,
        field.type,
        onError,
        addPath(path, field.name, type.name),
      );
    }

    // Ensure every provided field is defined.
    for (const fieldName of Object.keys(inputValue)) {
      if (!fieldDefs[fieldName]) {
        const suggestions = suggestionList(
          fieldName,
          Object.keys(type.getFields()),
        );
        onError(
          pathToArray(path),
          inputValue,
          new GraphQLError(
            `Field "${fieldName}" is not defined by type "${type.name}".` +
              didYouMean(suggestions),
          ),
        );
      }
    }
    return coercedValue;
  }

  // istanbul ignore else (See: 'https://github.com/graphql/graphql-js/issues/2618')
  if (isLeafType(type)) {
    let parseResult;

    // Scalars and Enums determine if a input value is valid via parseValue(),
    // which can throw to indicate failure. If it throws, maintain a reference
    // to the original error.
    try {
      parseResult = type.parseValue(inputValue);
    } catch (error) {
      if (error instanceof GraphQLError) {
        onError(pathToArray(path), inputValue, error);
      } else {
        onError(
          pathToArray(path),
          inputValue,
          new GraphQLError(
            `Expected type "${type.name}". ` + error.message,
            undefined,
            undefined,
            undefined,
            undefined,
            error,
          ),
        );
      }
      return;
    }
    if (parseResult === undefined) {
      onError(
        pathToArray(path),
        inputValue,
        new GraphQLError(`Expected type "${type.name}".`),
      );
    }
    return parseResult;
  }

  // istanbul ignore next (Not reachable. All possible input types have been considered)
  invariant(false, 'Unexpected input type: ' + inspect(type));
}

/**
 * Produces a coerced "internal" JavaScript value given a GraphQL Value AST.
 *
 * Returns `undefined` when the value could not be validly coerced according to
 * the provided type.
 */
export function coerceInputLiteral(
  valueNode: ValueNode,
  type: GraphQLInputType,
  variables?: Maybe<ObjMap<unknown>>,
): unknown {
  if (valueNode.kind === Kind.VARIABLE) {
    if (!variables || isMissingVariable(valueNode, variables)) {
      return; // Invalid: intentionally return no value.
    }
    const variableValue = variables[valueNode.name.value];
    if (variableValue === null && isNonNullType(type)) {
      return; // Invalid: intentionally return no value.
    }
    // Note: This does no further checking that this variable is correct.
    // This assumes validated has checked this variable is of the correct type.
    return variableValue;
  }

  if (isNonNullType(type)) {
    if (valueNode.kind === Kind.NULL) {
      return; // Invalid: intentionally return no value.
    }
    return coerceInputLiteral(valueNode, type.ofType, variables);
  }

  if (valueNode.kind === Kind.NULL) {
    return null; // Explicitly return the value null.
  }

  if (isListType(type)) {
    if (valueNode.kind !== Kind.LIST) {
      // Lists accept a non-list value as a list of one.
      const itemValue = coerceInputLiteral(valueNode, type.ofType, variables);
      if (itemValue === undefined) {
        return; // Invalid: intentionally return no value.
      }
      return [itemValue];
    }
    const coercedValue: Array<unknown> = [];
    for (const itemNode of valueNode.values) {
      let itemValue = coerceInputLiteral(itemNode, type.ofType, variables);
      if (itemValue === undefined) {
        if (
          isMissingVariable(itemNode, variables) &&
          !isNonNullType(type.ofType)
        ) {
          // A missing variable within a list is coerced to null.
          itemValue = null;
        } else {
          return; // Invalid: intentionally return no value.
        }
      }
      coercedValue.push(itemValue);
    }
    return coercedValue;
  }

  if (isInputObjectType(type)) {
    if (valueNode.kind !== Kind.OBJECT) {
      return; // Invalid: intentionally return no value.
    }

    const coercedValue: { [field: string]: unknown } = {};
    const fieldDefs = type.getFields();
    const hasUndefinedField = valueNode.fields.some(
      (field) => !hasOwnProperty(fieldDefs, field.name.value),
    );
    if (hasUndefinedField) {
      return; // Invalid: intentionally return no value.
    }
    const fieldNodes = keyMap(valueNode.fields, (field) => field.name.value);
    for (const field of Object.values(fieldDefs)) {
      const fieldNode = fieldNodes[field.name];
      if (!fieldNode || isMissingVariable(fieldNode.value, variables)) {
        if (isRequiredInputField(field)) {
          return; // Invalid: intentionally return no value.
        }
        if (field.defaultValue !== undefined) {
          coercedValue[field.name] = field.defaultValue;
        }
      } else {
        const fieldValue = coerceInputLiteral(
          fieldNode.value,
          field.type,
          variables,
        );
        if (fieldValue === undefined) {
          return; // Invalid: intentionally return no value.
        }
        coercedValue[field.name] = fieldValue;
      }
    }
    return coercedValue;
  }

  const leafType = assertLeafType(type);

  try {
    return leafType.parseLiteral(valueNode, variables);
  } catch (_error) {
    // Invalid: ignore error and intentionally return no value.
  }
}

// Returns true if the provided valueNode is a variable which is not defined
// in the set of variables.
function isMissingVariable(
  valueNode: ValueNode,
  variables: Maybe<ObjMap<unknown>>,
): boolean {
  return (
    valueNode.kind === Kind.VARIABLE &&
    (variables == null || variables[valueNode.name.value] === undefined)
  );
}