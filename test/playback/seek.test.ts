import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/app/context.ts";
import { Logger } from "../../src/core/log.ts";
import { SEEK_BURST_MS, SEEK_SETTLE_MS, Seeker } from "../../src/playback/seek.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { FakeHost } from "../helpers/fake-host.ts";

// ◀◀/▶▶ и ⏪/⏩ (спец. §9.4): переход считает плагин от позиции плеера. Относительный `player:seek:±N` MSX отбрасывает,
// пока плеер буферизует (на ТВ — после каждого перехода и «Продолжить»), поэтому кнопки шлют абсолютный.

let clock: FakeClock;
let host: FakeHost;
let log: Logger;
let seeker: Seeker;
/** Позиция и nonce запуска, которые MSX отдаёт на `requestData("video")`; `undefined` — ответа нет. */
let player: { position: number; run?: string } | undefined;

beforeEach(() => {
  clock = new FakeClock();
  host = new FakeHost();
  log = new Logger(clock);
  player = { position: 100, run: "r1" };
  host.responses.set("video", () => player === undefined ? undefined : {
    video: { info: { properties: player.run === undefined ? {} : { "kp:r": player.run } }, data: { state: 1, position: player.position, duration: 3600 } },
  });
  // Seeker читает только часы, хост, журнал и сессию трекера (поля ctx — лениво, как у FallbackChain).
  const tracker = { session: () => (player?.run === undefined ? undefined : { run: player.run }) };
  seeker = new Seeker({ clock, host, log, tracker } as unknown as AppContext);
});

const seeks = (): string[] => host.actions.map((a) => a.action);
/** Нажатие и всё, что оно успело сделать к этому моменту поддельного времени. */
async function press(delta: number): Promise<void> {
  seeker.press(delta);
  await clock.advance(0);
}

describe("Seeker: ◀◀/▶▶ — an absolute seek from the player position (spec §9.4)", () => {
  for (const step of [5, 10, 15, 30]) {
    it(`step ${step} s: back and forward alike — player:seek to the position ∓ the step, not player:seek:∓${step}`, async () => {
      await press(-step);
      assert.deepEqual(seeks(), [`player:seek:${100 - step}`]);
      await clock.advance(SEEK_BURST_MS);
      player = { position: 100 - step, run: "r1" };
      await press(step);
      assert.deepEqual(seeks(), [`player:seek:${100 - step}`, "player:seek:100"]);
      assert.deepEqual(host.requests, ["video", "video"]);
    });
  }

  it("quick presses add up: the first seeks at once, the rest as one seek after a pause — from the first one's target", async () => {
    await press(-10);
    await clock.advance(100);
    await press(-10);
    await clock.advance(100);
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:90"], "until the presses pause — only the first seek");
    // AVPlay ещё буферизует после первого перехода и отвечает прежней позицией.
    await clock.advance(SEEK_BURST_MS);
    assert.deepEqual(seeks(), ["player:seek:90", "player:seek:70"]);
    await clock.advance(SEEK_BURST_MS * 3);
    assert.equal(seeks().length, 2, "nothing more after the pause");
  });

  it("◀◀ and ▶▶ in one window cancel out: no extra seek", async () => {
    await press(-10);
    await press(-10);
    await press(10);
    await clock.advance(SEEK_BURST_MS);
    assert.deepEqual(seeks(), ["player:seek:90"]);
  });

  it("a press while the player still reports the old position counts from the last target — it does not repeat the last seek", async () => {
    await press(-10);
    await clock.advance(3000);
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:90", "player:seek:80"]);
  });

  it("the player is at the new place — from its position: at the target when paused, further by the elapsed time when playing", async () => {
    await press(-10);
    await clock.advance(1000);
    player = { position: 90, run: "r1" };
    await press(-10);
    await clock.advance(3000);
    player = { position: 83, run: "r1" };
    await press(30);
    assert.deepEqual(seeks(), ["player:seek:90", "player:seek:80", "player:seek:113"]);
  });

  it(`after ${SEEK_SETTLE_MS / 1000} s the last target is forgotten: the player position wins`, async () => {
    await press(-10);
    await clock.advance(SEEK_SETTLE_MS + 1000);
    player = { position: 300, run: "r1" };
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:90", "player:seek:290"]);
  });

  it("another launch (its own kp:r nonce) — the last target does not count", async () => {
    await press(-10);
    await clock.advance(1000);
    player = { position: 5, run: "r2" };
    await press(10);
    assert.deepEqual(seeks(), ["player:seek:90", "player:seek:15"]);
  });

  it("near the start — a seek to 0: MSX would read a negative number as a relative step back", async () => {
    player = { position: 4, run: "r1" };
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:0"]);
  });

  it("no position — MSX's own relative seek (player:seek:±N), no_position in the log", async () => {
    player = undefined;
    await press(-15);
    await clock.advance(SEEK_BURST_MS);
    await press(30);
    assert.deepEqual(seeks(), ["player:seek:-15", "player:seek:+30"]);
    assert.equal(log.entries().filter((e) => e.tag === "seek" && e.msg === "no_position").length, 2);
  });

  it("requestData rejects — MSX's relative seek too, nothing thrown", async () => {
    host.responses.set("video", () => Promise.reject(new Error("no host")));
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:-10"]);
  });

  it("«Продолжить»: right after video:load with resume:position ◀◀ counts from it, not from the old position MSX still reports", async () => {
    player = { position: 2, run: "r1" };
    seeker.onEvent({ event: "video:load", info: { properties: { "resume:position": "1200", "kp:r": "r1" } }, data: { position: 0 } });
    await clock.advance(3000);
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:1190"]);
  });

  it("a start from the beginning (resume:position none or 0) changes nothing", async () => {
    for (const r of ["none", "0"]) seeker.onEvent({ event: "video:load", info: { properties: { "resume:position": r, "kp:r": "r1" } } });
    await press(-10);
    assert.deepEqual(seeks(), ["player:seek:90"]);
  });

  it("MSX's own seek (video:seek, the marker): its target is in `position`, `data` holds the old position", async () => {
    seeker.onEvent({ event: "video:seek", position: 500, data: { position: 100 } });
    await clock.advance(500);
    await press(-10);
    await clock.advance(SEEK_BURST_MS + 2000);
    player = { position: 492, run: "r1" };
    await press(10);
    assert.deepEqual(seeks(), ["player:seek:490", "player:seek:502"]);
  });

  it("every seek is logged: position, base, step, target", async () => {
    await press(-10);
    const e = log.entries().find((x) => x.tag === "seek" && x.msg === "seek");
    assert.deepEqual(e?.data, { pos: 100, base: 100, delta: -10, target: 90 });
  });
});
