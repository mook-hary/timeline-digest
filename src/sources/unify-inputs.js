import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

const INPUT_ID = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function validateUnifyInputsConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Unify inputs config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported unify inputs schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!Array.isArray(data.inputs)) {
    throw new ValidationError("Unify inputs config inputs must be an array");
  }
  if (data.inputs.length === 0) {
    throw new ValidationError("Unify inputs config inputs must not be empty");
  }

  const seen = new Map();
  const inputs = data.inputs.map((input, index) => {
    if (!isPlainObject(input)) {
      throw new ValidationError(`inputs[${index}] must be an object`);
    }

    const id = requireString(input.id, `inputs[${index}].id`);
    if (!INPUT_ID.test(id)) {
      throw new ValidationError(`inputs[${index}].id must match ${INPUT_ID}`);
    }
    if (seen.has(id)) {
      throw new ValidationError(
        `Duplicate unify input id "${id}" at inputs[${seen.get(id)}] and inputs[${index}]`
      );
    }
    seen.set(id, index);

    const inputPath = requireString(input.path, `inputs[${index}].path`);
    if (typeof input.required !== "boolean") {
      throw new ValidationError(`inputs[${index}].required must be a boolean`);
    }

    return {
      id,
      path: inputPath,
      required: input.required,
    };
  });

  return {
    schemaVersion: 1,
    inputs,
  };
}

export async function loadUnifyInputs(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(
      `Failed to read unify inputs config: ${error.message}`,
      { cause: error }
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Unify inputs config is not valid JSON", {
      cause: error,
    });
  }

  return validateUnifyInputsConfig(data);
}
