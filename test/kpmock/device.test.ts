import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";

const ACAO = "access-control-allow-origin";

interface Setting { label: string; value: unknown; type: string }
interface DeviceJson { id: number; title: string; hardware: string; software: string; created: number; updated: number;
  last_seen: number; is_browser: boolean; settings: Record<string, Setting> }

describe("kpmock device, user and references", () => {
  let mock: MockServer;
  let access: string;
  let refresh: string;

  const get = async (path: string, token = access): Promise<{ status: number; acao: string | null; body: any }> => {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${mock.url}${path}${sep}access_token=${token}`);
    return { status: r.status, acao: r.headers.get(ACAO), body: await r.json() };
  };
  const post = async (path: string, body?: URLSearchParams | string, headers?: Record<string, string>, token = access): Promise<{ status: number; body: any }> => {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${mock.url}${path}${sep}access_token=${token}`, { method: "POST", body, headers });
    return { status: r.status, body: await r.json() };
  };
  const info = async (): Promise<DeviceJson> => {
    const r = await get("/v1/device/info");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 200);
    return r.body.device as DeviceJson;
  };

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    ({ access, refresh } = mock.issueToken());
  });

  it("returns the current device with wrapped settings", async () => {
    const d = await info();
    assert.equal(d.id, mock.state.tokens.get(access)?.deviceId);
    assert.equal(d.title, "kpmock TV");
    assert.equal(d.is_browser, false);
    assert.ok(d.created > 0 && d.updated >= d.created && d.last_seen >= d.created);
    assert.deepEqual(d.settings.supportSsl, { label: "Use SSL", value: 1, type: "bool" });
    for (const k of ["supportHevc", "supportHdr", "support4k", "mixedPlaylist"]) {
      assert.equal(d.settings[k].type, "bool", k);
      assert.equal(d.settings[k].value, 0, k);
    }
    assert.equal(d.settings.serverLocation.type, "list");
    const locs = d.settings.serverLocation.value as { id: number; selected: number }[];
    assert.deepEqual(locs.filter((l) => l.selected === 1).map((l) => l.id), [1]);
  });

  it("notify with a form body updates title, hardware and software", async () => {
    const r = await post("/v1/device/notify", new URLSearchParams({ title: "MSX QE55", hardware: "Samsung Tizen", software: "kpmsx-client/1.0.0" }));
    assert.deepEqual(r, { status: 200, body: { status: 200 } });
    const d = await info();
    assert.deepEqual([d.title, d.hardware, d.software], ["MSX QE55", "Samsung Tizen", "kpmsx-client/1.0.0"]);
  });

  it("notify with a text/plain body answers 200 but changes nothing (Apple trap)", async () => {
    const body = new URLSearchParams({ title: "MSX QE55" }).toString();
    const r = await post("/v1/device/notify", body, { "Content-Type": "text/plain" });
    assert.deepEqual(r, { status: 200, body: { status: 200 } });
    assert.equal((await info()).title, "kpmock TV");
  });

  it("notify accepts parameters in the query", async () => {
    const r = await post(`/v1/device/notify?${new URLSearchParams({ title: "MSX Q", hardware: "Samsung Tizen", software: "kpmsx" })}`);
    assert.equal(r.status, 200);
    assert.equal((await info()).title, "MSX Q");
  });

  it("requires a token for device, user and references", async () => {
    for (const path of ["/v1/device/info", "/v1/device", "/v1/user", "/v1/genres", "/v1/countries", "/v1/references/server-location"]) {
      const r = await get(path, "nope");
      assert.equal(r.status, 401, path);
      assert.equal(r.acao, "*", path);
    }
    assert.equal((await post("/v1/device/notify", new URLSearchParams({ title: "x" }), undefined, "nope")).status, 401);
  });

  it("saves device settings from a form, ignores a text/plain body", async () => {
    const id = (await info()).id;
    const saved = await post(`/v1/device/${id}/settings`, new URLSearchParams({ supportHevc: "1", mixedPlaylist: "1", serverLocation: "3" }));
    assert.deepEqual(saved, { status: 200, body: { status: 200 } });
    const r = await get(`/v1/device/${id}/settings`);
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.supportHevc.value, 1);
    assert.equal(r.body.settings.mixedPlaylist.value, 1);
    const sel = (r.body.settings.serverLocation.value as { id: number; selected: number }[]).find((l) => l.selected === 1);
    assert.equal(sel?.id, 3);
    assert.equal((await info()).settings.supportHevc.value, 1);

    const ignored = await post(`/v1/device/${id}/settings`, "supportHevc=0", { "Content-Type": "text/plain" });
    assert.deepEqual(ignored, { status: 200, body: { status: 200 } });
    assert.equal((await info()).settings.supportHevc.value, 1);
  });

  it("saves device settings from the query and ignores invalid values", async () => {
    const id = (await info()).id;
    await post(`/v1/device/${id}/settings?support4k=1&supportSsl=7&streamingType=99`);
    const s = (await info()).settings;
    assert.equal(s.support4k.value, 1);
    assert.equal(s.supportSsl.value, 1);
    const st = (s.streamingType.value as { id: number; selected: number }[]).find((t) => t.selected === 1);
    assert.equal(st?.id, 4);
  });

  it("answers 404 for settings of an unknown device", async () => {
    assert.equal((await get("/v1/device/999999/settings")).status, 404);
    assert.equal((await post("/v1/device/abc/settings", new URLSearchParams({ supportHevc: "1" }))).status, 404);
  });

  it("lists all devices of the account", async () => {
    const other = mock.issueToken();
    const r = await get("/v1/device");
    assert.equal(r.status, 200);
    const ids = (r.body.devices as DeviceJson[]).map((d) => d.id);
    assert.ok(ids.includes(mock.state.tokens.get(access)?.deviceId as number));
    assert.ok(ids.includes(mock.state.tokens.get(other.access)?.deviceId as number));
  });

  it("unlink removes the device and invalidates its tokens only", async () => {
    const other = mock.issueToken();
    const id = (await info()).id;
    const r = await post("/v1/device/unlink");
    assert.deepEqual(r, { status: 200, body: { status: 200 } });
    assert.equal((await get("/v1/device/info")).status, 401);
    assert.equal(mock.state.devices.has(id), false);
    assert.equal(mock.state.refreshTokens.has(refresh), false);
    const listed = await get("/v1/device", other.access);
    assert.equal(listed.status, 200);
    assert.ok(!(listed.body.devices as DeviceJson[]).some((d) => d.id === id));
  });

  it("returns an active subscription for /v1/user", async () => {
    const r = await get("/v1/user");
    assert.equal(r.status, 200);
    const u = r.body.user;
    assert.equal(u.username, "tester");
    assert.equal(u.subscription.active, true);
    assert.equal(u.subscription.days, 30);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(u.subscription.end_time - (now + 30 * 86_400)) < 60);
    assert.equal(u.profile.name, "Тестер");
    assert.equal(typeof u.settings, "object");
  });

  it("returns 3 server locations", async () => {
    const r = await get("/v1/references/server-location");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [
      { id: 1, location: "nl", name: "Netherlands" }, { id: 2, location: "de", name: "Germany" }, { id: 3, location: "ru", name: "Russia" },
    ]);
  });

  it("returns voiceover types, streaming types and video qualities", async () => {
    assert.deepEqual((await get("/v1/references/voiceover-type")).body.items, [
      { id: 1, title: "Дубляж" }, { id: 2, title: "Многоголосый" }, { id: 3, title: "Двухголосый" }, { id: 4, title: "Одноголосый" }, { id: 6, title: "Оригинал" },
    ]);
    const st = (await get("/v1/references/streaming-type")).body.items as { id: number; code: string }[];
    assert.deepEqual(st.map((t) => t.code), ["http", "hls", "hls2", "hls4"]);
    const vq = (await get("/v1/references/video-quality")).body.items as { id: number; title: string }[];
    assert.deepEqual(vq.map((q) => [q.id, q.title]), [[1, "480p"], [2, "720p"], [3, "1080p"], [4, "2160p"]]);
    assert.equal((await get("/v1/references/nope")).status, 404);
  });

  it("returns genres by genre group or content type, and countries", async () => {
    const movie = (await get("/v1/genres?type=movie")).body.items as { id: number; title: string; type: string }[];
    assert.ok(movie.some((g) => g.id === 23 && g.title === "Мультфильм" && g.type === "movie"));
    const serial = (await get("/v1/genres?type=serial")).body.items as { id: number }[];
    assert.deepEqual(serial.map((g) => g.id), movie.map((g) => g.id));
    const docu = (await get("/v1/genres?type=documovie")).body.items as { type: string }[];
    assert.ok(docu.length > 0 && docu.every((g) => g.type === "docu"));
    const all = (await get("/v1/genres")).body.items as { type: string }[];
    assert.deepEqual([...new Set(all.map((g) => g.type))].sort(), ["docu", "movie", "music", "tvshow"]);
    assert.deepEqual((await get("/v1/genres?type=unknown")).body.items, []);
    const countries = (await get("/v1/countries")).body.items as { id: number; title: string }[];
    assert.ok(countries.some((c) => c.title === "Россия"));
  });
});
