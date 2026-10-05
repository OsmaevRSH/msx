import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { KvStore } from "../../src/bridge/storage.ts";
import { BUILD, type BuildInfo } from "../../src/config/build.ts";
import { KP_CLIENT } from "../../src/config/client.ts";
import { DEFAULT_FLAGS, FLAG_CHOICES, FlagStore, type Flags } from "../../src/config/flags.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const API = "https://api.service-kp.com";
const API_FALLBACK = "https://api.srvkp.com";

function setup(): { mem: MemoryStorage; kv: KvStore } {
  const mem = new MemoryStorage();
  return { mem, kv: new KvStore(mem) };
}

describe("BUILD", () => {
  it("uses defaults when __KP_BUILD__ is not defined", () => {
    assert.deepEqual(BUILD, {
      version: "0.0.0-dev",
      apiBase: API,
      apiFallbackBase: API_FALLBACK,
      debugHooks: false,
      heartbeatTicks: 60,
    });
  });

  it("takes values substituted by the esbuild define of tools/build.mjs", async () => {
    const info: BuildInfo = { version: "1.2.3", apiBase: "http://127.0.0.1:8787", apiFallbackBase: API_FALLBACK, debugHooks: true, heartbeatTicks: 5 };
    const src = await readFile(new URL("../../src/config/build.ts", import.meta.url), "utf8");
    const out = await transform(src, { loader: "ts", format: "esm", define: { __KP_BUILD__: JSON.stringify(info) } });
    const mod = (await import(`data:text/javascript,${encodeURIComponent(out.code)}`)) as { BUILD: BuildInfo };
    assert.deepEqual(mod.BUILD, info);
  });
});

describe("KP_CLIENT", () => {
  it("is the public xbmc pair", () => {
    assert.equal(KP_CLIENT.id, "xbmc");
    assert.match(KP_CLIENT.secret, /^[a-z0-9]{32}$/);
  });
});

describe("DEFAULT_FLAGS", () => {
  it("matches spec §16.6 defaults", () => {
    assert.deepEqual(DEFAULT_FLAGS, {
      streamMode: "hls1",
      playerPropsIn: "resolve",
      heartbeat: "ticks",
      events: "handleEvent",
      autonext: "button",
      focusPrefetch: "on",
      postBody: "form",
      apiBase: BUILD.apiBase,
      apiFallbackBase: BUILD.apiFallbackBase,
    });
  });

  it("lists choices for every enumerable flag, defaults included", () => {
    assert.deepEqual(Object.keys(FLAG_CHOICES).sort(), ["autonext", "events", "focusPrefetch", "heartbeat", "playerPropsIn", "postBody", "streamMode"]);
    assert.deepEqual(FLAG_CHOICES.streamMode, ["hls1", "hls2"]);
    assert.deepEqual(FLAG_CHOICES.heartbeat, ["ticks", "timer", "percent"]);
    for (const [k, choices] of Object.entries(FLAG_CHOICES)) {
      assert.ok((choices as readonly string[]).includes(DEFAULT_FLAGS[k as keyof Flags] as string), k);
    }
  });

  it("cannot be mutated", () => {
    assert.ok(Object.isFrozen(DEFAULT_FLAGS));
    assert.ok(Object.isFrozen(FLAG_CHOICES));
  });
});

describe("FlagStore", () => {
  it("returns defaults on empty storage", () => {
    const { kv } = setup();
    const flags = new FlagStore(kv);
    assert.deepEqual(flags.get(), DEFAULT_FLAGS);
    assert.deepEqual(flags.overrides(), {});
  });

  it("set survives a new FlagStore on the same storage and is stored as an override in kp.cfg.flags", () => {
    const { mem, kv } = setup();
    new FlagStore(kv).set("streamMode", "hls2");
    const again = new FlagStore(new KvStore(mem));
    assert.equal(again.get().streamMode, "hls2");
    assert.deepEqual(again.overrides(), { streamMode: "hls2" });
    assert.deepEqual(JSON.parse(mem.getItem("kp.cfg.flags") ?? "null"), { streamMode: "hls2" });
    assert.deepEqual({ ...again.get(), streamMode: "hls1" }, DEFAULT_FLAGS);
  });

  it("stores only overrides: setting the default value drops the override", () => {
    const { kv } = setup();
    const flags = new FlagStore(kv);
    flags.set("heartbeat", "timer");
    flags.set("postBody", "query");
    flags.set("heartbeat", "ticks");
    assert.deepEqual(flags.overrides(), { postBody: "query" });
  });

  it("reset drops all overrides", () => {
    const { mem, kv } = setup();
    const flags = new FlagStore(kv);
    flags.set("streamMode", "hls2");
    flags.set("events", "triggers");
    flags.reset();
    assert.deepEqual(flags.get(), DEFAULT_FLAGS);
    assert.equal(mem.getItem("kp.cfg.flags"), null);
  });

  it("ignores an invalid value", () => {
    const { kv } = setup();
    const flags = new FlagStore(kv);
    flags.set("streamMode", "hls9" as Flags["streamMode"]);
    flags.set("autonext", "resolve");
    flags.set("autonext", "nope" as Flags["autonext"]);
    assert.equal(flags.get().streamMode, "hls1");
    assert.equal(flags.get().autonext, "resolve");
    assert.deepEqual(flags.overrides(), { autonext: "resolve" });
  });

  it("allows only the two build hosts for apiBase and apiFallbackBase", () => {
    const { kv } = setup();
    const flags = new FlagStore(kv);
    flags.set("apiBase", "https://evil.example");
    assert.equal(flags.get().apiBase, API);
    flags.set("apiBase", API_FALLBACK);
    flags.set("apiFallbackBase", API);
    assert.equal(flags.get().apiBase, API_FALLBACK);
    assert.equal(flags.get().apiFallbackBase, API);
    flags.set("apiFallbackBase", "http://127.0.0.1:1");
    assert.equal(flags.get().apiFallbackBase, API);
  });

  it("uses the given defaults", () => {
    const { kv } = setup();
    const defaults: Flags = { ...DEFAULT_FLAGS, streamMode: "hls2", apiBase: "http://127.0.0.1:8787" };
    const flags = new FlagStore(kv, defaults);
    assert.deepEqual(flags.get(), defaults);
    flags.set("apiBase", API_FALLBACK);
    assert.equal(flags.get().apiBase, API_FALLBACK);
    flags.set("apiBase", "http://127.0.0.1:8787");
    assert.deepEqual(flags.overrides(), {});
    flags.set("apiBase", API);
    assert.equal(flags.get().apiBase, "http://127.0.0.1:8787");
  });

  it("filters stored garbage: unknown keys, invalid values, non-object JSON", () => {
    const { mem, kv } = setup();
    kv.set("cfg", "flags", { streamMode: "hls9", heartbeat: "timer", bogus: 1, apiBase: "https://evil.example", focusPrefetch: 1 });
    const flags = new FlagStore(kv);
    assert.deepEqual(flags.overrides(), { heartbeat: "timer" });
    assert.deepEqual(flags.get(), { ...DEFAULT_FLAGS, heartbeat: "timer" });
    flags.set("events", "triggers");
    assert.deepEqual(JSON.parse(mem.getItem("kp.cfg.flags") ?? "null"), { heartbeat: "timer", events: "triggers" });

    for (const raw of ["[1]", '"hls2"', "null", "{broken"]) {
      mem.setItem("kp.cfg.flags", raw);
      assert.deepEqual(flags.get(), DEFAULT_FLAGS, raw);
    }
  });

  it("returns a fresh object from get", () => {
    const { kv } = setup();
    const flags = new FlagStore(kv);
    const a = flags.get();
    a.streamMode = "hls2";
    assert.equal(flags.get().streamMode, "hls1");
  });
});
