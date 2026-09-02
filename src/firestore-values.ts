// Firestore's REST shape is typed values (`{stringValue: "x"}`); tools speak
// plain JSON. These two functions are the only place that translation lives.

type FsValue = Record<string, unknown>;

export function toJson(value: FsValue | undefined): unknown {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('arrayValue' in value) {
    const values = (value.arrayValue as { values?: FsValue[] }).values ?? [];
    return values.map(toJson);
  }
  if ('mapValue' in value) {
    return fieldsToJson((value.mapValue as { fields?: Record<string, FsValue> }).fields ?? {});
  }
  return null;
}

export function fieldsToJson(fields: Record<string, FsValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toJson(v)]));
}

export function toValue(value: unknown): FsValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFields(value as object) } };
  return { nullValue: null };
}

export function toFields(value: object): Record<string, FsValue> {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toValue(v)]));
}

// A document name is a full resource path; tools only want the last segment.
export function documentId(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}
