export function parseDomain(domain: string) {
  const parts = domain.split(".");
  const rootZone = parts.slice(-2).join(".");
  const subdomain = parts.slice(0, -2).join(".");
  return { rootZone, subdomain };
}

export function resolveForwardAddress(template: string, alias: string): string {
  return template.replace("${alias}", alias);
}

/**
 * The base mailbox behind a forward template.
 *
 * Templates are plus-addressed (`user+${alias}@host`), so the exact
 * recipient differs per alias. Cloudflare matches a plus-address against
 * the verified base address, so the base is what has to be registered.
 */
export function baseForwardAddress(template: string): string {
  const expanded = resolveForwardAddress(template, "");
  return expanded.replace(/\+[^@]*@/, "@");
}
