/**
 * The module the vendored validator bundle is built from (website ADR 0028).
 *
 * `scripts/vendor-bids-validator.ts` bundles this file with `deno bundle`, with `@bids/validator/`
 * mapped to the release pinned in `validator-version.json`, and commits the result under
 * `public/vendor/bids-validator/<version>/`. It runs in two places:
 *
 *  - in a module Web Worker on the upload page, where the bottom of this file answers the page's
 *    messages (`src/lib/bids-validation/protocol.ts`);
 *  - in Node, under Vitest, which imports the two exports below and checks the committed bytes
 *    against real datasets.
 *
 * It is a worker rather than a script on the page because the validator evaluates the schema's
 * expressions, and compiles its JSON checks, with the `Function` constructor, which the page's
 * Content-Security-Policy refuses and a worker's own policy (see `public/_headers`) can allow.
 *
 * `getVersion` is deliberately not exported: it reads `Deno.mainModule` and throws everywhere
 * else. The bundle's version is read out of the bytes by the vendor script and the tests instead.
 */

import { fileListToTree } from "@bids/validator/files/browser";
import { validate } from "@bids/validator/validate";
import {
  type RawValidationResult,
  type WorkerRequest,
  type WorkerResponse,
  describeFailure,
  toReport,
  validatorOptions,
  withRelativePaths,
} from "../src/lib/bids-validation/protocol.ts";

export { fileListToTree, validate };

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

async function handle(scope: WorkerScope, request: WorkerRequest): Promise<void> {
  try {
    scope.postMessage({ type: "phase", phase: "tree", fileCount: request.entries.length });
    const tree = await fileListToTree(withRelativePaths(request.entries));
    scope.postMessage({ type: "phase", phase: "validate", fileCount: request.entries.length });
    const result = await validate(tree, validatorOptions());
    scope.postMessage({ type: "result", report: toReport(result as RawValidationResult) });
  } catch (error) {
    scope.postMessage({ type: "failure", ...describeFailure(error) });
  }
}

// `WorkerGlobalScope` exists only inside a worker: on the page and in Node this block is skipped,
// so importing the bundle for its exports has no side effect.
const workerGlobalScope = (globalThis as { WorkerGlobalScope?: abstract new () => object })
  .WorkerGlobalScope;
if (typeof workerGlobalScope === "function" && globalThis instanceof workerGlobalScope) {
  const scope = globalThis as unknown as WorkerScope;
  scope.onmessage = (event) => {
    if (event.data?.type === "validate") void handle(scope, event.data);
  };
}
