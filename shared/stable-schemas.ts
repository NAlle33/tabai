import * as z from "zod";

// Schemas whose accepted values and listed JSON Schema stay what stored data, callers and
// module programs already rely on, where the schema library's own forms would change them.

/**
 * An identifier in the 8-4-4-4-12 form of hexadecimal digits, in either case. zod's own
 * uuid() also demands the RFC 9562 version and variant digits; stored records, tool
 * arguments and module programs' own identifiers were accepted without them, so this
 * form keeps every one of them readable. Tools still describe it as a `uuid` string.
 */
export const uuidSchema = z.stringFormat("uuid", value => z.regexes.guid.test(value));

const withSeconds = z.regexes.datetime({});
const minutesOnly = z.regexes.datetime({ precision: -1 });
/**
 * A date and time in UTC ending in `Z`, with optional seconds and fraction:
 * `2026-11-26T09:53Z` and `2026-11-26T09:53:46.173Z`. zod's own datetime() requires
 * the seconds, while stored records hold minute-precision times that models and
 * module programs wrote, so both forms stay accepted. Offsets and dates that do not
 * exist stay refused. Tools still describe it as a `date-time` string.
 */
export const dateTimeSchema = z.stringFormat("date-time", value => withSeconds.test(value) || minutesOnly.test(value));

/**
 * A text of at most `max` UTF-16 units, as zod 3 counted, and listed with `maxLength: max` as
 * before. zod's own max() counts characters (code points), up to twice as many units. Where
 * host code saves, cuts or budgets the same text by that number in UTF-16 units, a text the
 * schema let through would be cut there, or stored ending in half a character; refused
 * instead, the model can shorten it.
 */
export function maxUtf16Units<T extends z.ZodString>(schema: T, max: number): T {
  return schema.refine(value => value.length <= max, `Too big: expected string to have <=${max} characters`).meta({ maxLength: max });
}

/**
 * Takes back what zod's converter adds that a tool listing never carried: the safe-integer
 * range on an integer without its own bound, `propertyNames` on a record, zod's own pattern
 * beside the e-mail format, `oneOf` for a discriminated union, a union of literals spelled as branches
 * instead of one `enum`, and an open object where the arguments drop unknown keys.
 * Validation is unchanged; it is the schema itself, not this listing.
 */
function asListedBefore({ jsonSchema }: { jsonSchema: unknown }): void {
  const json = jsonSchema as Record<string, unknown>;
  if (json.type === "integer") {
    if (json.minimum === -Number.MAX_SAFE_INTEGER) delete json.minimum;
    if (json.maximum === Number.MAX_SAFE_INTEGER) delete json.maximum;
  }
  delete json.propertyNames;
  // Only zod's own e-mail pattern: a pattern an author set, or one of .startsWith() and its
  // kind, which zod also lists beside a format of its own, stays listed.
  if (json.format === "email" && json.pattern === z.regexes.email.source) delete json.pattern;
  if (json.oneOf) { json.anyOf = json.oneOf; delete json.oneOf; }
  const options = json.anyOf as Record<string, unknown>[] | undefined;
  if (options?.length && options.every(option => Object.keys(option).length === 2 && typeof option.type === "string" && "const" in option)) {
    const types = [...new Set(options.map(option => option.type))];
    delete json.anyOf;
    Object.assign(json, { type: types.length === 1 ? types[0] : types, enum: options.map(option => option.const) });
  }
  if (json.type === "object" && json.properties && !("additionalProperties" in json)) json.additionalProperties = false;
}

/**
 * A tool's argument object. Unknown keys are dropped, never refused, and the tool listing
 * stays what callers and the local model's grammar always read: the local model's protocol
 * was verified with exactly that listing, so zod's own additions are taken back (see
 * asListedBefore). The MCP SDK converts the schema with zod's converter, which offers no
 * per-call option to it, so the object carries its own listing: zod's converter consults a
 * schema's `toJSONSchema` method before anything else. An empty argument list keeps the
 * plain listing it always had.
 */
export function toolInputObject<S extends z.ZodRawShape>(shape: S): z.ZodObject<S> {
  const schema = z.object(shape);
  if (!Object.keys(shape).length) return schema;
  let listing: Record<string, unknown> | undefined;
  schema._zod.toJSONSchema = () => {
    // The SDK's own conversion (draft-07, input side), run on a twin without this method.
    listing ??= (({ $schema: _dialect, ...rest }) => rest)(z.toJSONSchema(z.object(shape), { target: "draft-07", io: "input", override: asListedBefore }));
    return structuredClone(listing);
  };
  return schema;
}
