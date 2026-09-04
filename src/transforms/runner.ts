import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { expandUserPath, getConfigDir } from "../config/paths";
import { isVisionEligibleModel } from "../vision/eligibility";
import type { RequestTransformContext, RequestTransformFn, RequestTransformModule } from "./types";

const transformCache = new Map<string, Promise<RequestTransformFn | null>>();

export function resolveTransformPath(specifier: string, configDir: string = getConfigDir()): string {
  const expanded = expandUserPath(specifier.trim());
  if (isAbsolute(expanded)) {
    return expanded;
  }
  const fromConfig = resolve(configDir, expanded);
  if (existsSync(fromConfig)) {
    return fromConfig;
  }
  const fromCwd = resolve(process.cwd(), expanded);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  return expanded;
}

export async function loadTransform(
  specifier: string,
  configDir: string = getConfigDir(),
): Promise<RequestTransformFn | null> {
  const resolved = resolveTransformPath(specifier, configDir);
  const existing = transformCache.get(resolved);
  if (existing) return existing;

  const flight = (async (): Promise<RequestTransformFn | null> => {
    try {
      const isFile = existsSync(resolved);
      const importTarget = isFile ? pathToFileURL(resolved).href : resolved;
      const mod = (await import(importTarget)) as RequestTransformModule;
      const fn = mod.transform ?? mod.default;
      if (typeof fn === "function") {
        return fn;
      }
      console.warn(
        `[opencodex] request transform "${specifier}" did not export a default function or "transform" function.`,
      );
      return null;
    } catch (err) {
      console.warn(`[opencodex] failed to load request transform "${specifier}":`, err);
      return null;
    }
  })();

  transformCache.set(resolved, flight);
  return flight;
}

export async function applyRequestTransforms(args: {
  parsed: OcxParsedRequest;
  providerName: string;
  modelId: string;
  providerConfig: OcxProviderConfig;
  config: OcxConfig;
}): Promise<OcxParsedRequest> {
  const { parsed, providerName, modelId, providerConfig, config } = args;

  if (parsed._requestTransformsApplied) {
    return parsed;
  }

  const specifiers: string[] = [
    ...(config.requestTransforms ?? []),
    ...(providerConfig.requestTransforms ?? []),
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  if (specifiers.length === 0) {
    parsed._requestTransformsApplied = true;
    return parsed;
  }

  let acceptsImageInput = false;
  try {
    acceptsImageInput = isVisionEligibleModel(config, {
      provider: providerName,
      id: modelId,
    });
  } catch {
    acceptsImageInput = false;
  }

  const context: RequestTransformContext = {
    providerName,
    modelId,
    providerConfig,
    config,
    acceptsImageInput,
  };

  const configDir = getConfigDir();
  let currentParsed = parsed;

  for (const specifier of specifiers) {
    const fn = await loadTransform(specifier, configDir);
    if (!fn) continue;
    try {
      const result = await fn(currentParsed, context);
      if (result && typeof result === "object") {
        currentParsed = result;
      }
    } catch (err) {
      console.warn(`[opencodex] error running request transform "${specifier}":`, err);
    }
  }

  currentParsed._requestTransformsApplied = true;
  return currentParsed;
}

export function clearTransformCacheForTests(): void {
  transformCache.clear();
}

