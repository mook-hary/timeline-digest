import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

export function validateReferencesSelectionConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("References selection config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(`Unsupported references selection config schemaVersion: ${data.schemaVersion}`);
  }
  if (typeof data.policyId !== "string" || !data.policyId.trim()) {
    throw new ValidationError("References selection policyId must be a non-empty string");
  }
  if (!Number.isInteger(data.primaryMinValue) || data.primaryMinValue < 1 || data.primaryMinValue > 5) {
    throw new ValidationError("References selection primaryMinValue must be an integer from 1 to 5");
  }
  return { schemaVersion: 1, policyId: data.policyId, primaryMinValue: data.primaryMinValue };
}

export async function loadReferencesSelectionConfig(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(`Failed to read references selection config: ${error.message}`, { cause: error });
  }
  let data;
  try { data = JSON.parse(text); } catch (error) {
    throw new ValidationError("References selection config is not valid JSON", { cause: error });
  }
  return validateReferencesSelectionConfig(data);
}
