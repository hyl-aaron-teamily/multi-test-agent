// Intent contract (W2-1 §5.1): the semi-formal middle layer between an Issue and a TestPlan.
// Stage 1 (understanding) fills it from the Issue; stage 2 (composition) compiles it into a plan. It
// references the SKILL libraries by id (preconditions / trigger patterns / observations) or 'unmapped'.
import { z } from 'zod';

export const EstablishZ = z.enum(['executor', 'existing-data', 'construct', 'unconstructible']);

export const IssueContractZ = z.object({
  issueRef: z.string(),
  sub: z.string(),
  preconditions: z.array(
    z.object({
      /** Precondition library id; 'unmapped' when the library has none. */
      id: z.string(),
      /** The precondition as the Issue states it. */
      text: z.string(),
      establish: EstablishZ,
    }),
  ),
  trigger: z.object({
    /** Trigger semantics id (e.g. repeat-switch-and-mention, tap-quote, view-quote-preview). */
    semantics: z.string(),
    /** What is done, how often / how fast. */
    text: z.string(),
    /** Pattern id when the trigger maps to one; empty = composed by the model. */
    pattern: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  observable: z.object({
    /** Observation library id; 'unmapped' when no channel can observe it. */
    observation: z.string(),
    /** The expected normal behaviour (Expected). */
    text: z.string(),
    /** The abnormal phenomenon the Issue reports (Actual) — evidence review compares against it. */
    phenomenon: z.string(),
  }),
  /** A guess about the cause; may be empty. Shown as 推测 only — never executed, never judged. */
  suspectedMechanism: z.string().optional(),
  provenance: z.object({ by: z.enum(['rules', 'model', 'manual']), skillVersion: z.string(), model: z.string().optional() }),
});

export type IssueContract = z.infer<typeof IssueContractZ>;

export function contractJsonSchema(): unknown {
  return z.toJSONSchema(IssueContractZ, { io: 'input' });
}
