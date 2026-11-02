// Durable Object plumbing, built the way STRDM routes through Rork's single DO binding:
// one `env.DO` fetcher, and each request names its object with X-Rork-DO-Class / X-Rork-DO-Id.
// Under plain `wrangler dev` there is no Rork router, so doFetcher() routes those headers to the
// namespaces bound in wrangler.local.toml instead.

export const INTERNAL_HEADER = 'X-Karta-Internal';
export const INTERNAL_MARKER = 'karta-do';

export type DOFetcher = { fetch(req: Request): Promise<Response> };

export interface DOEnv {
  DO?: Fetcher;
  KARTA_DB?: DurableObjectNamespace;
  MEDIA?: DurableObjectNamespace;
}

export const isInternal = (req: Request): boolean => req.headers.get(INTERNAL_HEADER) === INTERNAL_MARKER;

export function doRequest(cls: 'KartaDB' | 'MediaStore', id: string, url: string, init: RequestInit = {}): Request {
  const r = new Request(url, init);
  r.headers.set('X-Rork-DO-Class', cls);
  r.headers.set('X-Rork-DO-Id', id);
  r.headers.set(INTERNAL_HEADER, INTERNAL_MARKER);
  return r;
}

export function doFetcher(env: DOEnv): DOFetcher {
  if (env.DO) return env.DO;
  return {
    fetch(req: Request) {
      const cls = req.headers.get('X-Rork-DO-Class');
      const ns = cls === 'KartaDB' ? env.KARTA_DB : cls === 'MediaStore' ? env.MEDIA : undefined;
      if (!ns) return Promise.resolve(new Response(`No binding for ${cls}`, { status: 500 }));
      return ns.get(ns.idFromName(req.headers.get('X-Rork-DO-Id') ?? 'global')).fetch(req);
    },
  };
}
