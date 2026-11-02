// functions/media-store.ts | Audio, artwork and video files. One Durable Object per file ("m:<id>").
//
// Same storage approach as STRDM's SocialMedia / ExchangeAudio: uploads arrive in 4 MB chunks,
// sit in 1 MB rows, and stream back row by row with Range support (audio scrubbing, video seeking).
// Only the worker talks to this object, after KartaStore has said who may read or write the file.

import { CORS } from "./lib/util";
import { isInternal } from "./lib/do";

export const CHUNK_BYTES = 4_000_000;
export const MAX_BYTES = 500_000_000; // a full trackout zip can be large
const PART = 1_000_000;

type Sql = { exec: (q: string, ...p: unknown[]) => { toArray(): Record<string, unknown>[]; one(): Record<string, unknown> } };

export class MediaStore {
  private sql: Sql;
  constructor(private ctx: { storage: { sql: Sql } }, _env: unknown) {
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS parts (idx INTEGER PRIMARY KEY, data BLOB)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS chunks (n INTEGER PRIMARY KEY, bytes INTEGER)");
  }

  private meta(k: string): string | null {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  async fetch(req: Request): Promise<Response> {
    if (!isInternal(req)) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // media, :id, (init|chunk/:n)
    if (req.method === "POST" && parts[2] === "init") {
      const { size, mime } = (await req.json()) as { size: number; mime: string };
      this.sql.exec("DELETE FROM parts"); this.sql.exec("DELETE FROM chunks");
      this.setMeta("size", String(size)); this.setMeta("mime", mime); this.setMeta("complete", size === 0 ? "1" : "0");
      return Response.json({ ok: true, chunkBytes: CHUNK_BYTES });
    }
    if (req.method === "PUT" && parts[2] === "chunk") {
      const n = Number(parts[3]);
      const size = Number(this.meta("size") ?? -1);
      if (size < 0) return Response.json({ ok: false, error: "Upload not started" }, { status: 409 });
      const buf = new Uint8Array(await req.arrayBuffer());
      const expected = Math.min(CHUNK_BYTES, size - n * CHUNK_BYTES);
      if (n < 0 || expected <= 0 || buf.length !== expected) {
        return Response.json({ ok: false, error: `Chunk ${n} should be ${expected} bytes, got ${buf.length}` }, { status: 400 });
      }
      for (let i = 0; i * PART < buf.length; i++) {
        this.sql.exec("INSERT OR REPLACE INTO parts (idx, data) VALUES (?, ?)", n * (CHUNK_BYTES / PART) + i, buf.subarray(i * PART, (i + 1) * PART));
      }
      this.sql.exec("INSERT OR REPLACE INTO chunks (n, bytes) VALUES (?, ?)", n, buf.length);
      const got = Number(this.sql.exec("SELECT COALESCE(SUM(bytes), 0) AS b FROM chunks").one().b);
      const complete = got === size;
      if (complete) this.setMeta("complete", "1");
      return Response.json({ ok: true, received: got, complete });
    }
    if (req.method === "DELETE") {
      this.sql.exec("DELETE FROM parts"); this.sql.exec("DELETE FROM chunks"); this.sql.exec("DELETE FROM meta");
      return Response.json({ ok: true });
    }
    if (req.method === "GET" || req.method === "HEAD") return this.stream(req);
    return new Response("Not found", { status: 404 });
  }

  private stream(req: Request): Response {
    const size = Number(this.meta("size") ?? -1);
    if (size < 0 || this.meta("complete") !== "1") return new Response("Not found", { status: 404, headers: CORS });
    const mime = this.meta("mime") ?? "application/octet-stream";
    let start = 0, end = size - 1, status = 200;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("Range") ?? "");
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(size - 1, Number(range[2]));
      if (!range[1] && range[2]) { start = Math.max(0, size - Number(range[2])); end = size - 1; }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...CORS, "Content-Range": `bytes */${size}` } });
      status = 206;
    }
    const headers: Record<string, string> = {
      ...CORS, "Content-Type": mime, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    };
    if (req.method === "HEAD") return new Response(null, { status, headers });
    const first = Math.floor(start / PART), last = Math.floor(end / PART);
    const sql = this.sql;
    let idx = first;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (idx > last) return ctrl.close();
        const row = sql.exec("SELECT data FROM parts WHERE idx = ?", idx).toArray()[0];
        const data = new Uint8Array(row?.data as ArrayBuffer);
        const from = idx === first ? start - first * PART : 0;
        const to = idx === last ? end - last * PART + 1 : data.length;
        ctrl.enqueue(data.subarray(from, to));
        idx++;
      },
    });
    return new Response(body, { status, headers });
  }
}
