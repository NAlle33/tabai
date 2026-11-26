// Imported first by every extension page and worker that bundles zod, before any schema
// is built. The extension's content security policy forbids evaluating strings. zod
// otherwise tests that with `new Function("")` when it builds its first object schema;
// the call throws, zod catches it, and Chrome still reports a policy violation for the
// context. Without compilation zod skips that test and validates the same way, interpreted.
import * as z from "zod";

z.config({ jitless: true });
