// A plugin's key-value storage (table plugin_kv): what ctx.storage reads and writes, and what core reads for work that
// moved from a plugin into core (signals/core-host.ts keeps the triggers where the plugin kept them).

import type { Db } from "../db.ts";

export interface PluginKv {
  /** The stored value, or null when there is none. */
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Rows whose key starts with `prefix` ("_" and "%" are literal), in key order. */
  list(prefix?: string): Array<{ key: string; value: unknown }>;
}

export function pluginKv(db: Db, pluginId: string): PluginKv {
  return {
    get(key) {
      const r = db.prepare("select value from plugin_kv where plugin_id = ? and key = ?").get(pluginId, key) as { value: string } | undefined;
      return r ? JSON.parse(r.value) : null;
    },
    set(key, value) {
      db.prepare("insert into plugin_kv(plugin_id, key, value) values (?,?,?) on conflict(plugin_id, key) do update set value = excluded.value").run(
        pluginId,
        key,
        JSON.stringify(value ?? null),
      );
    },
    delete(key) {
      db.prepare("delete from plugin_kv where plugin_id = ? and key = ?").run(pluginId, key);
    },
    list(prefix = "") {
      const pattern = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = db.prepare("select key, value from plugin_kv where plugin_id = ? and key like ? escape '\\' order by key").all(pluginId, pattern) as Array<{
        key: string;
        value: string;
      }>;
      return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
    },
  };
}
