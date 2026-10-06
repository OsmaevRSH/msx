import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { load, logged, marktimes, player, q, snapshot, toggles, videoData, waitFor } from "../progress/progress-rig.ts";
import { actions, commit, follow, pick, until } from "./rig.ts";

// Фикс 34b, сценарий e2e E-09 против kpmock: перезапуск серии из панели озвучки поверх плеера, перемотка за 90 %,
// автопереход без `stop`. Свойства запуска — из ответов resolve плагина, как их возвращает MSX в `video:load` и в
// снимках `interaction:commit:video` (msx-platform §4.6, CFX-03), поэтому nonce `kp:r` идёт тем же путём, что `kp:m`.

const SMALL = FIX.SERIAL_SMALL;
/** `SERIAL_SMALL`: 2 сезона по 3 серии по 60 с; две озвучки — студия (играет по умолчанию) и «Оригинал». */
const mid = (season: number, episode: number): number => SMALL * 1000 + (season - 1) * 3 + episode;
const DURATION = 60;

async function resolve(t: TestApp, dataId: string): Promise<Record<string, string>> {
  const res = (await t.request(dataId)) as MsxResolveResponse;
  assert.equal(res.error, undefined, `resolve ${dataId}: ${res.error}`);
  return res.properties ?? {};
}

const s2e1 = (t: TestApp): number[] => marktimes(t).filter((m) => m.season === 2 && m.video === 1).map((m) => m.time);

describe("E-09 (fix 34b): a restart from the player panel, then autonext", () => {
  it("audio change → restart from 20 s → seek to 52 s → 90 % → autonext without stop: toggle and the last marktime of S2E1", async () => {
    const t = await createTestApp({ loggedIn: true });
    try {
      const p1 = await resolve(t, ids.playEp(SMALL, mid(2, 1), 2, 1));
      load(t, p1, 0, DURATION);
      player(t, "play", { state: 1, position: 0, duration: DURATION });
      snapshot(t, 20, p1, DURATION);

      // Кнопка плеера «озвучка» → «Оригинал»: плагин спрашивает позицию у плеера и перезапускает серию с неё.
      const panel = (await t.request(follow(p1["button:content:action"], "panel"))) as MsxContentRoot;
      const row = pick(panel.items, (i) => (i.label ?? "").includes("Оригинал"), "row «Оригинал»");
      t.host.responses.set("video", videoData(20, p1, DURATION));
      t.host.clearActions();
      commit(t, row.action);
      await t.run(until(() => actions(t).some((a) => a.includes("player:eject"))));
      const steps = /^\[(.*)\]$/.exec(actions(t)[0] ?? "")?.[1]?.split("|") ?? [];
      assert.deepEqual(steps.slice(0, 2), ["cleanup", "player:eject"]);
      const restart = follow(steps[2], "video:resolve");
      assert.equal(restart, ids.playEp(SMALL, mid(2, 1), 2, 1, { at: 20 }));

      // `player:eject` закрывает плеер, `video:resolve` запускает ту же серию заново — новый запуск, новый nonce.
      player(t, "stop", { state: 0, position: 20, duration: DURATION });
      const p2 = await resolve(t, restart);
      assert.match(p2["kp:r"] ?? "", /^[0-9a-z]+$/);
      assert.notEqual(p2["kp:r"], p1["kp:r"]);
      assert.equal(p2["kp:m"], p1["kp:m"]);
      assert.equal(p2["resume:position"], "20");
      assert.match(p2["label:extension"] ?? "", /Оригинал/);
      load(t, p2, 20, DURATION);
      player(t, "play", { state: 1, position: 20, duration: DURATION });

      // Перемотка на 52 с: тик; 54 с — `trigger:90%`; 55 с — последний снимок перед концом серии. Всё — в первые 10 с.
      snapshot(t, 52, p2, DURATION);
      await waitFor(t, () => s2e1(t).includes(52), "marktime 52 of the restarted run");
      snapshot(t, 55, p2, DURATION);
      // `trigger:complete` нажимает «следующая» — resolve S2E2; `stop` при автопереходе MSX не шлёт.
      assert.equal(p2["trigger:complete"], "player:button:next:execute");
      const p3 = await resolve(t, follow(p2["button:next:action"], "video:resolve"));
      load(t, p3, 0, DURATION);
      await waitFor(t, () => toggles(t).length === 1 && s2e1(t).includes(55), "toggle and the last marktime of S2E1");

      assert.deepEqual(toggles(t).map((c) => [q(c).get("season"), q(c).get("video")]), [["2", "1"]]);
      assert.deepEqual(s2e1(t), [52, 55]);
      const rec = t.mock.state.watching.get(`${SMALL}:2:1`);
      assert.deepEqual([rec?.status, rec?.time], [1, 55]);
      assert.equal(logged(t, "late_snapshot_ignored"), 0);
      assert.equal(t.ctx.tracker.session()?.mid, mid(2, 2));
      assert.equal(t.ctx.tracker.session()?.run, p3["kp:r"]);
    } finally {
      await t.close();
    }
  });
});
