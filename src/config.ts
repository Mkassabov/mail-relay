export function parseDomain(domain: string) {
  const parts = domain.split(".");
  const rootZone = parts.slice(-2).join(".");
  const subdomain = parts.slice(0, -2).join(".");
  return { rootZone, subdomain };
}

export function resolveForwardAddress(template: string, alias: string): string {
  return template.replace("${alias}", alias);
}
