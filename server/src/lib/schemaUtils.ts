import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export function jsonSchemaToZod(schema: any): z.ZodTypeAny {
    if (!schema) return z.any().optional();
    try {
        let isNullable = false;
        if (Array.isArray(schema.type) && schema.type.includes('null')) {
            isNullable = true;
        }
        if (schema.nullable === true) {
            isNullable = true;
        }

        if (schema.oneOf && Array.isArray(schema.oneOf)) {
            const parts = schema.oneOf.map((s: any) => jsonSchemaToZod(s));
            const union = z.union(parts as any);
            return isNullable ? union.nullable() : union;
        }
        if (schema.anyOf && Array.isArray(schema.anyOf)) {
            const parts = schema.anyOf.map((s: any) => jsonSchemaToZod(s));
            const union = z.union(parts as any);
            return isNullable ? union.nullable() : union;
        }

        if (schema.type === 'object' || (schema.properties && typeof schema.properties === 'object')) {
            const props: Record<string, z.ZodTypeAny> = {};
            const required = Array.isArray(schema.required) ? schema.required : [];
            const properties = schema.properties || {};
            for (const [k, v] of Object.entries(properties)) {
                let child = jsonSchemaToZod(v as any);
                if (!required.includes(k)) {
                    child = child.optional();
                }
                props[k] = child;
            }
            let obj: any = z.object(props);
            if (schema.additionalProperties === false) {
                obj = obj.strict();
            }
            return isNullable ? obj.nullable() : obj;
        }

        if (schema.type === 'array' || schema.items) {
            if (Array.isArray(schema.items)) {
                const items = schema.items.map((it: any) => jsonSchemaToZod(it));
                let tup: any = z.tuple(items as any);
                return isNullable ? tup.nullable() : tup;
            }
            const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
            let arr: any = z.array(itemSchema as any);
            if (typeof schema.minItems === 'number') arr = arr.min(schema.minItems);
            if (typeof schema.maxItems === 'number') arr = arr.max(schema.maxItems);
            if (schema.uniqueItems) arr = arr.refine((a: any[]) => new Set(a).size === a.length, { message: 'items must be unique' });
            return isNullable ? arr.nullable() : arr;
        }

        if (schema.enum && Array.isArray(schema.enum)) {
            const allStrings = schema.enum.every((v: any) => typeof v === 'string');
            if (allStrings) {
                const zenum: z.ZodTypeAny = z.enum(schema.enum as [string, ...string[]]);
                return isNullable ? zenum.nullable() : zenum;
            }
            const lits = schema.enum.map((v: any) => z.literal(v));
            const union: z.ZodTypeAny = z.union(lits as any);
            return isNullable ? union.nullable() : union;
        }

        if (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'))) {
            let s: any = z.string();
            if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
            if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
            if (schema.pattern) {
                try {
                    const re = new RegExp(schema.pattern);
                    s = s.regex(re);
                } catch { }
            }
            if (schema.format) {
                if (schema.format === 'uri' || schema.format === 'url') {
                    s = s.url();
                } else if (schema.format === 'email') {
                    s = s.email();
                }
            }
            return isNullable ? s.nullable() : s;
        }

        if (schema.type === 'integer' || schema.type === 'number' || (Array.isArray(schema.type) && (schema.type.includes('number') || schema.type.includes('integer')))) {
            let n: any = z.number();
            if (schema.type === 'integer' || (Array.isArray(schema.type) && schema.type.includes('integer'))) {
                n = (n as any).int();
            }
            if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
            if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
            if (typeof schema.exclusiveMinimum === 'number') n = n.refine((v: number) => v > schema.exclusiveMinimum, { message: `must be > ${schema.exclusiveMinimum}` });
            if (typeof schema.exclusiveMaximum === 'number') n = n.refine((v: number) => v < schema.exclusiveMaximum, { message: `must be < ${schema.exclusiveMaximum}` });
            if (typeof schema.multipleOf === 'number') n = n.refine((v: number) => Math.abs(v / schema.multipleOf - Math.round(v / schema.multipleOf)) < 1e-8, { message: `must be multipleOf ${schema.multipleOf}` });
            return isNullable ? n.nullable() : n;
        }

        if (schema.type === 'boolean') {
            const b = z.boolean();
            return isNullable ? b.nullable() : b;
        }

        return isNullable ? z.any().nullable() : z.any();
    } catch (err) {
        return z.any().optional();
    }
}

export function resolveJsonPointer(root: any, pointer: string): any {
    if (!pointer || pointer === '#') return root;
    const p = pointer.replace(/^#\//, '');
    const parts = p.split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur: any = root;
    for (const part of parts) {
        if (cur === undefined || cur === null) return undefined;
        cur = cur[part];
    }
    return cur;
}

export async function loadExternalSchema(filePath: string, cache: Record<string, any>) {
    const abs = path.resolve(filePath);
    if (cache[abs]) return cache[abs];
    try {
        const raw = await fs.readFile(abs, 'utf8');
        const parsed = JSON.parse(raw);
        cache[abs] = parsed;
        return parsed;
    } catch (err) {
        throw new Error(`Failed to read external schema ${filePath}: ${String(err)}`);
    }
}

export async function dereferenceSchema(
    schema: any,
    manifestRoot: any,
    manifestDir: string,
    externalCache: Record<string, any>,
    seen = new WeakSet(),
    localRoot?: any
) {
    if (schema === null || typeof schema !== 'object') return schema;
    if (!localRoot) localRoot = schema;
    if (seen.has(schema)) return schema; // avoid cycles
    seen.add(schema);

    if (schema.$ref && typeof schema.$ref === 'string') {
        const ref = schema.$ref;
        if (ref.startsWith('#')) {
            let resolved = resolveJsonPointer(manifestRoot, ref);
            if (resolved === undefined && localRoot) {
                resolved = resolveJsonPointer(localRoot, ref);
            }
            if (resolved === undefined) throw new Error(`Unresolved internal $ref ${ref}`);
            return dereferenceSchema(resolved, manifestRoot, manifestDir, externalCache, seen, localRoot);
        } else {
            const [filePart, pointerPart] = ref.split('#');
            const targetPath = path.resolve(manifestDir, filePart);
            const external = await loadExternalSchema(targetPath, externalCache);
            if (pointerPart) {
                const resolved = resolveJsonPointer(external, `#/${pointerPart.replace(/^\//, '')}`);
                if (resolved === undefined) throw new Error(`Unresolved external $ref ${ref}`);
                return dereferenceSchema(resolved, external, path.dirname(targetPath), externalCache, seen, undefined);
            }
            return dereferenceSchema(external, external, path.dirname(targetPath), externalCache, seen, undefined);
        }
    }

    if (Array.isArray(schema)) {
        const out: any[] = [];
        for (const it of schema) {
            out.push(await dereferenceSchema(it, manifestRoot, manifestDir, externalCache, seen, localRoot));
        }
        return out;
    }

    const out: any = {};
    for (const [k, v] of Object.entries(schema)) {
        out[k] = await dereferenceSchema(v, manifestRoot, manifestDir, externalCache, seen, localRoot);
    }
    return out;
}
