export interface PublicPath {
  path: string;
  suffix: string;
}

interface PublicAddress {
  oldHref: string;
  href: string;
  slug?: string;
}

/** Parse relative paths and absolute links to the site's apex or www host. */
export function sitePathReader(origin: string | undefined, prefix: string) {
  const host = origin ? new URL(origin).hostname : null;
  const hosts = host ? new Set([host, host.startsWith("www.") ? host.slice(4) : `www.${host}`]) : new Set<string>();
  return (value: unknown): PublicPath | null => {
    if (typeof value !== "string" || !value.includes(prefix) || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
    try {
      const relative = value.startsWith("/") && !value.startsWith("//");
      const url = new URL(value, "https://relative.invalid");
      if (!relative && (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.port || !hosts.has(url.hostname))) return null;
      return { path: decodeURIComponent(url.pathname), suffix: url.search + url.hash };
    } catch { return null; }
  };
}

/** Replace addresses after the underlying repository has qualified the projected content. */
export function publicPathProjector(
  parse: (value: unknown) => PublicPath | null,
  read: (paths: string[]) => Promise<PublicAddress[]>,
  required: (kind: string) => boolean,
  unavailable: () => never,
) {
  return async function project<T>(pending: T | Promise<T>): Promise<T> {
    const value = await pending;
    const paths = new Set<string>();
    const keys = ["href", "url", "externalUrl"] as const;
    function collect(node: unknown) {
      if (!node || typeof node !== "object") return;
      const object = node as Record<string, unknown>;
      for (const key of keys) {
        const match = parse(object[key]);
        if (match) paths.add(match.path);
      }
      Object.values(object).forEach(collect);
    }
    collect(value);
    if (!paths.size) return value;

    const addresses = new Map((await read([...paths])).map(address => [address.oldHref, address]));
    function visit(node: unknown): unknown {
      if (Array.isArray(node)) return node.map(visit).filter(item => item !== null);
      if (!node || typeof node !== "object") return node;
      const object = node as Record<string, unknown>;
      const result = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]));
      for (const key of keys) {
        const match = parse(object[key]);
        if (!match) continue;
        const address = addresses.get(match.path);
        if (address) {
          const href = address.href + match.suffix;
          if (key === "url" && object.kind === "external") return { kind: "internal", href };
          result[key] = href;
          if (key === "href" && address.slug !== undefined && typeof object.slug === "string") result.slug = address.slug;
        } else {
          if (object.kind === "internal" || object.kind === "external") return { kind: "unavailable" };
          if (key === "href" && typeof object.kind === "string" && required(object.kind)) unavailable();
          if (key !== "externalUrl") return null;
          result[key] = null;
        }
      }
      if (object.type === "child-page" && result.target === null) result.title = "Unavailable page";
      if (object.pageMention && (result.link as { kind?: string } | undefined)?.kind === "unavailable") {
        result.text = "Unavailable page";
      }
      return result;
    }

    return visit(value) as T;
  };
}
