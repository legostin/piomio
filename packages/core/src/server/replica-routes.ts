// What replicas of this hub ask of each other (cluster.ts), on the device app: TLS with the hub's certificate, every
// request signed by a replica's key (join alone takes an invite instead). Bodies stay raw strings so the signature can
// be checked over exactly what was sent.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { Hub } from "../app.ts";
import { LINK_PATH } from "../replica-link.ts";

export async function registerReplicaRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  // A peer's lasting link (replica-link.ts): signed at the upgrade, then RPC both ways.
  app.get(LINK_PATH, { websocket: true }, (socket, req) => {
    const from = hub.cluster.verify("GET", LINK_PATH, "", req.headers.authorization);
    if (!from) return socket.close(4401, "not a replica of this hub");
    hub.cluster.accept(socket as unknown as WebSocket, from);
  });

  await app.register(async (r) => {
    r.removeAllContentTypeParsers();
    r.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const signed = (req: FastifyRequest, reply: FastifyReply): { from: string; body: any } | undefined => {
      const raw = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
      const from = hub.cluster.verify(req.method, req.url, raw, req.headers.authorization);
      if (!from) {
        void reply.code(401).send({ error: "not a replica of this hub" });
        return undefined;
      }
      let body: any = {};
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          void reply.code(400).send({ error: "bad json" });
          return undefined;
        }
      }
      return { from, body };
    };

    r.get("/api/replica/hello", async (req, reply) => {
      if (!signed(req, reply)) return reply;
      return hub.cluster.hello();
    });

    r.post("/api/replica/changes", async (req, reply) => {
      const s = signed(req, reply);
      if (!s) return reply;
      return hub.cluster.changes(s.body.db === "vault" ? "vault" : "main", s.body.vector ?? {}, Number(s.body.wait) || 0);
    });

    r.post("/api/replica/files/changes", async (req, reply) => {
      const s = signed(req, reply);
      if (!s) return reply;
      return hub.cluster.files.changesSince(Number(s.body.cursor) || 0, Math.min(Number(s.body.limit) || 500, 2_000));
    });

    r.post("/api/replica/files/read", async (req, reply) => {
      const s = signed(req, reply);
      if (!s) return reply;
      const bytes = await hub.cluster.files.read(String(s.body.root ?? ""), String(s.body.path ?? ""), String(s.body.sha ?? ""));
      if (!bytes) return reply.code(404).send({ error: "gone" });
      return reply.type("application/octet-stream").send(Buffer.from(bytes));
    });

    r.post("/api/replica/vault-key", async (req, reply) => {
      const s = signed(req, reply);
      if (!s) return reply;
      hub.cluster.receiveKey(s.from, String(s.body.key ?? ""));
      return { ok: true };
    });

    // The leader asks this replica to update itself to its version (cluster.ts serveUpdate; over the link as a rule).
    r.post("/api/replica/update", async (req, reply) => {
      const s = signed(req, reply);
      if (!s) return reply;
      const a = await hub.cluster.serveUpdate(s.from, s.body);
      return reply.code(a.status).send(a.body);
    });

    r.post("/api/replica/join", async (req, reply) => {
      let body: any;
      try {
        body = JSON.parse(((req.body as Buffer | undefined) ?? Buffer.alloc(0)).toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "bad json" });
      }
      try {
        return hub.cluster.join({
          code: String(body.code ?? ""),
          publicKey: String(body.publicKey ?? ""),
          name: String(body.name ?? ""),
          urls: Array.isArray(body.urls) ? body.urls.map(String) : [],
          nodeUrls: Array.isArray(body.nodeUrls) ? body.nodeUrls.map(String) : [],
        });
      } catch (e: any) {
        return reply.code(403).send({ error: e?.message ?? String(e) });
      }
    });
  });
}
