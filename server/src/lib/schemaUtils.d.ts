import { ZodTypeAny } from 'zod';

export function jsonSchemaToZod(schema: any): ZodTypeAny;
export function resolveJsonPointer(root: any, pointer: string): any;
export function loadExternalSchema(filePath: string, cache: Record<string, any>): Promise<any>;
export function dereferenceSchema(
  schema: any,
  manifestRoot: any,
  manifestDir: string,
  externalCache: Record<string, any>,
  seen?: WeakSet<any>,
  localRoot?: any
): Promise<any>;
