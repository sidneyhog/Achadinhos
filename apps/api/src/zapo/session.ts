import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { q } from "../db";

export type LiveSession = {
  client: {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    message: {
      send: (jid: string, content: unknown) => Promise<unknown>;
    };
    status?: {
      send: (input: { content: unknown; recipients: readonly string[] }) => Promise<unknown>;
    };
    group?: {
      queryAllGroups?: () => Promise<Array<{ jid: string; subject?: string; size?: number; participants?: unknown[] }>>;
      queryGroupMetadata?: (jid: string) => Promise<{
        subject?: string;
        owner?: string;
        participants?: Array<{
          jid?: string;
          id?: string;
          isAdmin?: boolean;
          isSuperAdmin?: boolean;
          phoneNumber?: string;
          lid?: string;
        }>;
      }>;
      addParticipants?: (jid: string, participants: string[]) => Promise<Array<{ jid?: string; status?: string; code?: number }>>;
      queryInviteCode?: (jid: string) => Promise<string>;
    };
    profile?: {
      getLidsByPhoneNumbers?: (phones: string[]) => Promise<Array<{ exists?: boolean }>>;
    };
    getCredentials?: () => { meJid?: string; meLid?: string } | null;
    auth?: { getCredentials?: () => { meJid?: string; meLid?: string } | null };
    lowlevel?: {
      query: (node: { tag: string; attrs: Record<string, string>; content?: unknown[] }, timeoutMs?: number) => Promise<{
        tag?: string;
        attrs?: Record<string, string>;
        content?: unknown;
      }>;
    };
    on: (event: string, handler: (payload: never) => void) => void;
  };
};

const live = new Map<number, LiveSession>();
const booting = new Set<number>();
const stopping = new Set<number>();

const authDir = () => process.env.ZAPO_AUTH_DIR || join(process.cwd(), ".zapo-auth");

const setStatus = async (id: number, patch: Record<string, unknown>) => {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((key, index) => `${key} = $${index + 2}`).join(", ");
  await q(`UPDATE whatsapp_sessions SET ${sets} WHERE id = $1`, [id, ...keys.map(key => patch[key])]);
};

export const getLive = (id: number) => live.get(id) ?? null;
export const liveIds = () => [...live.keys()];

export const startSession = async (row: { id: number; company_id: number; name: string }) => {
  if (live.has(row.id) || booting.has(row.id) || stopping.has(row.id)) return;
  booting.add(row.id);
  try {
    const { createPinoLogger, createStore, WaClient } = await import("zapo-js");
    const { createSqliteStore } = await import("@zapo-js/store-sqlite");
    const dir = authDir();
    await mkdir(dir, { recursive: true });
    const logger = await createPinoLogger({ level: "warn", pretty: false });
    const store = createStore({
      backends: {
        sqlite: createSqliteStore({
          path: join(dir, `${row.company_id}-${row.id}.sqlite`),
          driver: "auto"
        })
      },
      providers: {
        auth: "sqlite",
        signal: "sqlite",
        preKey: "sqlite",
        session: "sqlite",
        identity: "sqlite",
        senderKey: "sqlite",
        appState: "sqlite",
        privacyToken: "sqlite",
        messages: "none",
        threads: "none",
        contacts: "none"
      }
    });
    const client = new WaClient(
      {
        store,
        sessionId: `${row.company_id}-${row.id}`,
        connectTimeoutMs: 120_000,
        nodeQueryTimeoutMs: 30_000
      },
      logger
    );
    const session = { client } as unknown as LiveSession;
    client.on("auth_qr", async (event: { qr?: string }) => {
      if (!event?.qr) return;
      const qrcode = await import("qrcode");
      const toDataURL = qrcode.toDataURL || qrcode.default?.toDataURL;
      const image = event.qr.startsWith("data:") ? event.qr : await toDataURL(event.qr, { margin: 1, width: 280 });
      await setStatus(row.id, { status: "qrcode", qr: image, qr_at: new Date(), last_error: null });
    });
    client.on("auth_paired", async (event: { credentials?: { meJid?: string } }) => {
      const phone = String(event?.credentials?.meJid || "").split("@")[0].split(":")[0];
      await setStatus(row.id, { phone, qr: "" });
    });
    client.on("connection", async (event: { status?: string; reason?: string; isLogout?: boolean }) => {
      if (stopping.has(row.id)) return;
      if (event.status === "open") {
        await setStatus(row.id, { status: "connected", qr: "", qr_at: null, connected_at: new Date(), last_error: null });
        return;
      }
      await setStatus(row.id, {
        status: event.isLogout ? "disconnected" : "reconnecting",
        last_error: event.reason || null
      });
      if (!event.isLogout) {
        setTimeout(() => {
          client.connect().catch(err => {
            void setStatus(row.id, { status: "disconnected", last_error: String(err?.message || err).slice(0, 300) });
          });
        }, 5000);
      }
    });
    await setStatus(row.id, { status: "opening", qr: "", qr_at: null, last_error: null });
    live.set(row.id, session);
    void client.connect().catch(err => {
      live.delete(row.id);
      void setStatus(row.id, {
        status: "error",
        last_error: String((err as Error)?.message || err).slice(0, 300)
      });
    });
  } catch (err) {
    live.delete(row.id);
    await setStatus(row.id, {
      status: "error",
      last_error: String((err as Error)?.message || err).slice(0, 300)
    });
  } finally {
    booting.delete(row.id);
  }
};

export const stopSession = async (id: number) => {
  stopping.add(id);
  const session = live.get(id);
  live.delete(id);
  if (session) {
    await session.client.disconnect().catch(() => undefined);
  }
  await setStatus(id, { status: "disconnected", qr: "" });
  setTimeout(() => stopping.delete(id), 1500);
};

export const sendText = async (whatsappId: number, jid: string, text: string) => {
  const session = live.get(whatsappId);
  if (!session) throw new Error("WhatsApp desconectado");
  await session.client.message.send(jid, text);
};

export const sendImage = async (whatsappId: number, jid: string, media: Buffer, caption: string) => {
  const session = live.get(whatsappId);
  if (!session) throw new Error("WhatsApp desconectado");
  await session.client.message.send(jid, { type: "image", media, mimetype: "image/jpeg", caption });
};

/** Publica no Status (status@broadcast); o WhatsApp só entrega a quem está em `recipients`. */
export const sendStatus = async (whatsappId: number, recipients: string[], media: Buffer | null, caption: string) => {
  const session = live.get(whatsappId);
  if (!session) throw new Error("WhatsApp desconectado");
  if (!session.client.status?.send) throw new Error("Esta versão do zapo-js não publica Status");
  if (!recipients.length) throw new Error("Status sem destinatários: os grupos da conexão não têm participantes");
  const content = media ? { type: "image", media, mimetype: "image/jpeg", caption } : caption;
  await session.client.status.send({ content, recipients });
};
