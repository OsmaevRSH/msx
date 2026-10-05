import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";

const ACAO = "access-control-allow-origin";

interface Folder { id: number; title: string; count: number; views: number; created: number; updated: number }
interface FolderPage { status: number; folder: Folder; items: { id: number; type: string; title: string; posters: Record<string, string> }[];
  pagination: { total: number; current: number; perpage: number; total_items: number } }

describe("kpmock bookmarks", () => {
  let mock: MockServer;
  let tok = "";
  const url = (path: string, q: Record<string, string | number> = {}): string =>
    `${mock.url}${path}?${new URLSearchParams({ access_token: tok, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) })}`;
  const getJson = async <T>(path: string, q: Record<string, string | number> = {}): Promise<T> => {
    const r = await fetch(url(path, q));
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  /** POST с телом-формой (`URLSearchParams` даёт `application/x-www-form-urlencoded`). */
  const postForm = (path: string, form: Record<string, string | number>): Promise<Response> =>
    fetch(url(path), { method: "POST", body: new URLSearchParams(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]))) });
  const folders = async (): Promise<Folder[]> => (await getJson<{ items: Folder[] }>("/v1/bookmarks")).items;
  const folder = (id: number, q: Record<string, number> = {}): Promise<FolderPage> => getJson<FolderPage>(`/v1/bookmarks/${id}`, q);

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    tok = mock.issueToken().access;
  });

  it("requires a token (401 with CORS)", async () => {
    tok = "";
    const r = await fetch(url("/v1/bookmarks"));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get(ACAO), "*");
  });

  it("starts with the folder «Избранное» holding 2 titles", async () => {
    const list = await folders();
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].id, list[0].title, list[0].count], [1, "Избранное", 2]);
    assert.equal(typeof list[0].created, "number");
    assert.equal(typeof list[0].updated, "number");
    assert.equal(typeof list[0].views, "number");
    const page = await folder(1);
    assert.equal(page.status, 200);
    assert.deepEqual([page.folder.id, page.folder.title, page.folder.count], [1, "Избранное", 2]);
    assert.deepEqual(page.items.map((i) => i.id).sort(), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE]);
    assert.match(page.items[0].posters.medium, /\/poster\/medium\/\d+\.svg$/);
    assert.deepEqual(page.pagination, { total: 1, current: 1, perpage: 20, total_items: 2 });
  });

  it("paginates a folder and answers 404 for an unknown one", async () => {
    const p2 = await folder(1, { page: 2, perpage: 1 });
    assert.equal(p2.items.length, 1);
    assert.deepEqual(p2.pagination, { total: 2, current: 2, perpage: 1, total_items: 2 });
    const r = await fetch(url("/v1/bookmarks/777"));
    assert.equal(r.status, 404);
    assert.equal(r.headers.get(ACAO), "*");
  });

  it("create makes a new empty folder", async () => {
    const r = await postForm("/v1/bookmarks/create", { title: "Позже" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(ACAO), "*");
    const body = (await r.json()) as { status: number; folder: Folder };
    assert.equal(body.status, 200);
    assert.deepEqual([body.folder.title, body.folder.count], ["Позже", 0]);
    const list = await folders();
    assert.deepEqual(list.map((f) => f.title), ["Избранное", "Позже"]);
    assert.equal(list[1].id, body.folder.id);
    assert.deepEqual((await folder(body.folder.id)).items, []);
  });

  it("add and remove-item change count", async () => {
    const add = await postForm("/v1/bookmarks/add", { item: FIX.MOVIE_MULTI, folder: 1 });
    assert.deepEqual(await add.json(), { status: 200 });
    assert.equal((await folders())[0].count, 3);
    assert.ok((await folder(1)).items.some((i) => i.id === FIX.MOVIE_MULTI));

    const again = await postForm("/v1/bookmarks/add", { item: FIX.MOVIE_MULTI, folder: 1 });
    assert.deepEqual(await again.json(), { status: 200, exists: true });
    assert.equal((await folders())[0].count, 3);

    const rm = await postForm("/v1/bookmarks/remove-item", { item: FIX.SERIAL_BIG, folder: 1 });
    assert.deepEqual(await rm.json(), { status: 200 });
    const page = await folder(1);
    assert.equal(page.folder.count, 2);
    assert.deepEqual(page.items.map((i) => i.id).sort(), [FIX.MOVIE_MULTI, FIX.MOVIE_SIMPLE]);
  });

  it("add answers 404 for an unknown folder or title", async () => {
    assert.equal((await postForm("/v1/bookmarks/add", { item: FIX.MOVIE_MULTI, folder: 777 })).status, 404);
    assert.equal((await postForm("/v1/bookmarks/add", { item: 99_999, folder: 1 })).status, 404);
    assert.equal((await folders())[0].count, 2);
  });

  it("remove-folder deletes the folder", async () => {
    const created = (await (await postForm("/v1/bookmarks/create", { title: "Временная" })).json()) as { folder: Folder };
    assert.deepEqual(await (await postForm("/v1/bookmarks/remove-folder", { folder: created.folder.id })).json(), { status: 200 });
    assert.deepEqual((await folders()).map((f) => f.id), [1]);
    assert.equal((await fetch(url(`/v1/bookmarks/${created.folder.id}`))).status, 404);
  });

  it("silently ignores a text/plain body with {status:200} (Apple trap)", async () => {
    const send = (path: string, body: string): Promise<Response> =>
      fetch(url(path), { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body });
    for (const [path, body] of [
      ["/v1/bookmarks/create", "title=Тайком"],
      ["/v1/bookmarks/add", `item=${FIX.MOVIE_MULTI}&folder=1`],
      ["/v1/bookmarks/remove-item", `item=${FIX.SERIAL_BIG}&folder=1`],
      ["/v1/bookmarks/remove-folder", "folder=1"],
    ]) {
      const r = await send(path, body);
      assert.equal(r.status, 200, path);
      assert.deepEqual(await r.json(), { status: 200 }, path);
    }
    const list = await folders();
    assert.deepEqual(list.map((f) => [f.id, f.count]), [[1, 2]]);
    assert.ok(mock.calls().some((c) => c.contentType?.startsWith("text/plain")));
  });

  it("accepts parameters in the query as well (postBody: query)", async () => {
    const r = await fetch(url("/v1/bookmarks/add", { item: FIX.MOVIE_AUDIO12, folder: 1 }), { method: "POST" });
    assert.deepEqual(await r.json(), { status: 200 });
    assert.equal((await folders())[0].count, 3);
  });

  it("is reflected in the folder list after reset", async () => {
    await postForm("/v1/bookmarks/create", { title: "Лишняя" });
    mock.reset();
    tok = mock.issueToken().access;
    assert.deepEqual((await folders()).map((f) => f.title), ["Избранное"]);
  });
});
