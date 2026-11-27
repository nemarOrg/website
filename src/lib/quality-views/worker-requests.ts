/**
 * What the sensor-field worker accepts (website ADR 0035 decision 1; the protocol is
 * `worker-protocol.ts`). Imported only by the worker (`worker.ts`, and with it the client's
 * in-thread fallback), so the page's own chunk does not carry it (the owner's ruling on #599).
 */

import { isIndexList, isRecord } from "./worker-protocol";

const isCount = (value: unknown, least: number): boolean =>
  Number.isInteger(value) && (value as number) >= least;

/**
 * Why `value` is not a request the worker can run, or null when it is one. A
 * message crosses from another script, so the type says what it should be and this says what it
 * is.
 */
export function requestProblem(value: unknown): string | null {
  if (!isRecord(value)) return "the message is not an object";
  if (!Number.isInteger(value.id)) return "the message has no integer id";
  if (value.type === "cancel") return null;
  if (value.type === "check") return "view" in value ? null : "the check has no view";
  if (value.type === "check-content") {
    return typeof value.schema === "string" && "content" in value
      ? null
      : "the content check has no schema or no content";
  }
  if (value.type === "activity") {
    return ((value.step === "prepare" || value.step === "plan") && isRecord(value.input)) ||
      (value.step === "compute" && isRecord(value.plan) && "digital" in value)
      ? null
      : "the activity step has no input";
  }
  if (value.type !== "draw" && value.type !== "prepare") {
    return `the message type ${JSON.stringify(value.type)} is unknown`;
  }
  const { layoutKey, thetaDeg, radius, values, mapCount, first, contours } = value;
  if (typeof layoutKey !== "string" || layoutKey === "") return "layoutKey is not a string";
  if (!(thetaDeg instanceof Float64Array) || !(radius instanceof Float64Array)) {
    return "thetaDeg and radius are not Float64Arrays";
  }
  if (thetaDeg.length !== radius.length) return "thetaDeg and radius differ in length";
  if (value.type === "prepare") return null;
  if (!isCount(mapCount, 0)) return "mapCount is not a count";
  const maps = mapCount as number;
  if (!(values instanceof Float64Array) || values.length !== thetaDeg.length * maps) {
    return "values does not hold one value per sensor per map";
  }
  if (!isIndexList(first) || first.some((index) => index >= maps)) {
    return "first is not a list of map indices";
  }
  if (!isCount(value.batchSize, 1) || !isCount(value.laterBatchSize, 1)) {
    return "batchSize and laterBatchSize are not positive";
  }
  if (!isIndexList(contours) || contours.some((index) => index >= maps)) {
    return "contours is not a list of map indices";
  }
  return null;
}
