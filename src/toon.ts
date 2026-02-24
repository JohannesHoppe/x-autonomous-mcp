/**
 * Minimal TOON encoder, vendored from @toon-format/toon v2.1.0
 * Original: https://github.com/toon-format/toon (MIT, Johann Schopplich)
 * Only the encoder is included. Decoder, key folding, replacer stripped.
 */

// --- Types ---

type JsonPrimitive = string | number | boolean | null;
// Interfaces allow recursive references (type aliases don't)
interface JsonArray extends Array<JsonValue> {}
interface JsonObject { [key: string]: JsonValue; }
type JsonValue = JsonPrimitive | JsonArray | JsonObject;

// --- Constants ---

const COMMA = ",";
const LIST_ITEM_PREFIX = "- ";
const LIST_ITEM_MARKER = "-";
const NULL_LITERAL = "null";
const TRUE_LITERAL = "true";
const FALSE_LITERAL = "false";
const INDENT = 2;

// --- String utilities ---

function escapeString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function isBooleanOrNullLiteral(token: string): boolean {
  return token === TRUE_LITERAL || token === FALSE_LITERAL || token === NULL_LITERAL;
}

function isValidUnquotedKey(key: string): boolean {
  return /^[A-Z_][\w.]*$/i.test(key);
}

function isSafeUnquoted(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  if (isBooleanOrNullLiteral(value)) return false;
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) || /^0\d+$/.test(value)) return false;
  if (value.includes(":") || value.includes('"') || value.includes("\\")) return false;
  if (/[[\]{}]/.test(value) || /[\n\r\t]/.test(value)) return false;
  if (value.includes(COMMA)) return false;
  if (value.startsWith(LIST_ITEM_MARKER)) return false;
  return true;
}

// --- Type guards ---

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}

function isArrayOfPrimitives(value: JsonArray): value is JsonPrimitive[] {
  return value.every((item) => isJsonPrimitive(item));
}

function isArrayOfArrays(value: JsonArray): value is JsonArray[] {
  return value.every((item) => isJsonArray(item));
}

function isArrayOfObjects(value: JsonArray): value is JsonObject[] {
  return value.every((item) => isJsonObject(item));
}

// --- Normalization (unknown → JsonValue) ---

function normalizeValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return 0;
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = normalizeValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return null;
}

// --- Primitive encoding ---

function encodePrimitive(value: JsonPrimitive): string {
  if (value === null) return NULL_LITERAL;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return isSafeUnquoted(value) ? value : `"${escapeString(value)}"`;
}

function encodeKey(key: string): string {
  return isValidUnquotedKey(key) ? key : `"${escapeString(key)}"`;
}

function joinPrimitives(values: readonly JsonPrimitive[]): string {
  return values.map((v) => encodePrimitive(v)).join(COMMA);
}

function formatHeader(length: number, opts?: { key?: string; fields?: readonly string[] }): string {
  let h = "";
  if (opts?.key != null) h += encodeKey(opts.key);
  h += `[${length}]`;
  if (opts?.fields) h += `{${opts.fields.map((f) => encodeKey(f)).join(COMMA)}}`;
  h += ":";
  return h;
}

function inlineArray(values: JsonPrimitive[], key?: string): string {
  const header = formatHeader(values.length, key != null ? { key } : undefined);
  return values.length === 0 ? header : `${header} ${joinPrimitives(values)}`;
}

// --- Indentation ---

function ind(depth: number, content: string): string {
  return " ".repeat(INDENT * depth) + content;
}

function indList(depth: number, content: string): string {
  return ind(depth, LIST_ITEM_PREFIX + content);
}

// --- Tabular detection ---

function extractTabularHeader(rows: readonly JsonObject[]): string[] | undefined {
  if (rows.length === 0) return undefined;
  const firstKeys = Object.keys(rows[0]);
  if (firstKeys.length === 0) return undefined;
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== firstKeys.length) return undefined;
    for (const key of firstKeys) {
      if (!(key in row) || !isJsonPrimitive(row[key])) return undefined;
    }
  }
  return firstKeys;
}

// --- Generators ---

function* encodeJsonValue(value: JsonValue, depth: number): Generator<string> {
  if (isJsonPrimitive(value)) {
    const encoded = encodePrimitive(value);
    if (encoded !== "") yield encoded;
    return;
  }
  if (isJsonArray(value)) {
    yield* encodeArrayLines(undefined, value, depth);
  } else if (isJsonObject(value)) {
    yield* encodeObjectLines(value, depth);
  }
}

function* encodeObjectLines(value: JsonObject, depth: number): Generator<string> {
  for (const [key, val] of Object.entries(value)) {
    const ek = encodeKey(key);
    if (isJsonPrimitive(val)) {
      yield ind(depth, `${ek}: ${encodePrimitive(val)}`);
    } else if (isJsonArray(val)) {
      yield* encodeArrayLines(key, val, depth);
    } else if (isJsonObject(val)) {
      yield ind(depth, `${ek}:`);
      if (!isEmptyObject(val)) yield* encodeObjectLines(val, depth + 1);
    }
  }
}

function* encodeArrayLines(key: string | undefined, value: JsonArray, depth: number): Generator<string> {
  if (value.length === 0) {
    yield ind(depth, formatHeader(0, key != null ? { key } : undefined));
    return;
  }

  // Primitive array — inline
  if (isArrayOfPrimitives(value)) {
    yield ind(depth, inlineArray(value, key));
    return;
  }

  // Array of primitive arrays — list items
  if (isArrayOfArrays(value) && value.every((arr) => isArrayOfPrimitives(arr as JsonArray))) {
    yield ind(depth, formatHeader(value.length, key != null ? { key } : undefined));
    for (const arr of value) {
      yield indList(depth + 1, inlineArray(arr as JsonPrimitive[]));
    }
    return;
  }

  // Array of objects — tabular or list
  if (isArrayOfObjects(value)) {
    const header = extractTabularHeader(value);
    if (header) {
      yield ind(depth, formatHeader(value.length, { key, fields: header }));
      for (const row of value) {
        yield ind(depth + 1, joinPrimitives(header.map((k) => row[k]) as JsonPrimitive[]));
      }
      return;
    }
    // Non-tabular — expanded list
    yield ind(depth, formatHeader(value.length, key != null ? { key } : undefined));
    for (const item of value) {
      yield* encodeObjectAsListItem(item, depth + 1);
    }
    return;
  }

  // Mixed array fallback
  yield ind(depth, formatHeader(value.length, key != null ? { key } : undefined));
  for (const item of value) {
    yield* encodeListItemValue(item, depth + 1);
  }
}

function* encodeObjectAsListItem(obj: JsonObject, depth: number): Generator<string> {
  if (isEmptyObject(obj)) {
    yield ind(depth, LIST_ITEM_MARKER);
    return;
  }
  const entries = Object.entries(obj);
  const [firstKey, firstValue] = entries[0];
  const ek = encodeKey(firstKey);

  if (isJsonPrimitive(firstValue)) {
    yield indList(depth, `${ek}: ${encodePrimitive(firstValue)}`);
  } else if (isJsonArray(firstValue)) {
    if (firstValue.length === 0) {
      yield indList(depth, `${ek}${formatHeader(0)}`);
    } else if (isArrayOfPrimitives(firstValue)) {
      yield indList(depth, `${ek}${inlineArray(firstValue)}`);
    } else {
      yield indList(depth, `${ek}${formatHeader(firstValue.length)}`);
      for (const item of firstValue) {
        yield* encodeListItemValue(item, depth + 2);
      }
    }
  } else if (isJsonObject(firstValue)) {
    yield indList(depth, `${ek}:`);
    if (!isEmptyObject(firstValue)) yield* encodeObjectLines(firstValue, depth + 2);
  }

  if (entries.length > 1) {
    const restObj = Object.fromEntries(entries.slice(1)) as JsonObject;
    yield* encodeObjectLines(restObj, depth + 1);
  }
}

function* encodeListItemValue(value: JsonValue, depth: number): Generator<string> {
  if (isJsonPrimitive(value)) {
    yield indList(depth, encodePrimitive(value));
  } else if (isJsonArray(value)) {
    if (isArrayOfPrimitives(value)) {
      yield indList(depth, inlineArray(value));
    } else {
      yield indList(depth, formatHeader(value.length));
      for (const item of value) {
        yield* encodeListItemValue(item, depth + 1);
      }
    }
  } else if (isJsonObject(value)) {
    yield* encodeObjectAsListItem(value, depth);
  }
}

// --- Public API ---

export function encode(value: unknown): string {
  const normalized = normalizeValue(value);
  const lines: string[] = [];
  for (const line of encodeJsonValue(normalized, 0)) {
    lines.push(line);
  }
  return lines.join("\n");
}
