import { z } from "zod";
import { ValidationError } from "../core/errors.js";
import { CorrectionPlanSchema, type CorrectionPlan } from "../contracts/schemas.js";
import type { JobHandler, PreparedJob, WorkerJob } from "../jobs/worker.js";
import type { CorrectionService } from "./correctionService.js";

const CorrectionPayloadSchema = z.object({ plan: CorrectionPlanSchema });

/**
 * Slice 5 job handler. All validation happens in prepare(); every durable
 * lifecycle write happens in commit(tx) inside the existing job fence.
 */
export class CorrectionJobHandler<TX extends object> implements JobHandler<TX> {
  readonly kind = "correct";

  constructor(private readonly corrections: CorrectionService<TX>) {}

  async prepare(job: WorkerJob): Promise<PreparedJob<TX>> {
    let payload: unknown;
    try {
      payload = JSON.parse(job.payloadJson);
    } catch {
      throw new ValidationError("correction job payload is not valid JSON");
    }
    const parsed = CorrectionPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new ValidationError("correction job payload is invalid", parsed.error.issues);
    const plan = parsed.data.plan as CorrectionPlan;

    return {
      summary: `${plan.kind} correction prepared`,
      commit: async (tx) => {
        await this.corrections.correct(tx, plan, {
          jobId: job.id,
          claimGeneration: job.claimGeneration,
        });
      },
    };
  }
}
