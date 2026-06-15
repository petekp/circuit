import { z } from 'zod';
import { CompiledFlowId } from './ids.js';

export const CustomFlowPackageDescriptor = z
  .object({
    schema_version: z.literal(1),
    id: CompiledFlowId,
    format: z.literal('compiled-flow-package'),
    compiled_flow: z.literal('circuit.json'),
    purpose: z.string().min(1),
  })
  .strict();
export type CustomFlowPackageDescriptor = z.infer<typeof CustomFlowPackageDescriptor>;
