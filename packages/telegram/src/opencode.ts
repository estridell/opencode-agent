import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { registrationFile, requireRuntime, runtimeEnv, upstreamBinary } from "./runtime"

export type Client = OpenCodeClient

export async function connect(): Promise<Client> {
  await requireRuntime()
  // env -i is intentional: Service.ensure's env option otherwise merges the host environment.
  const endpoint = await Service.ensure({
    file: registrationFile(),
    version: version => /^2\./.test(version),
    command: ["env", "-i", ...Object.entries(runtimeEnv()).map(([key, value]) => `${key}=${value}`), upstreamBinary(), "serve", "--service"],
  })
  return makeClient(endpoint)
}

/** Plugins use the already running owned service for APIs outside their in-process context. */
export async function connectExisting(): Promise<Client> {
  const endpoint = await Service.discover({ file: registrationFile() })
  if (!endpoint) throw new Error("The managed OpenCode service is unavailable.")
  return makeClient(endpoint)
}

function makeClient(endpoint: Awaited<ReturnType<typeof Service.ensure>>): Client {
  const boundedFetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return fetch(input, url.includes("/api/event") ? init : {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
  }, { preconnect: fetch.preconnect })
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    fetch: boundedFetch,
  })
}

export function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "_tag" in error && String(error._tag).endsWith("NotFoundError")
}
