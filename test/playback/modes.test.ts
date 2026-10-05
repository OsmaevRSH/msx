import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/app/context.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import { FlagStore } from "../../src/config/flags.ts";
import { FallbackChain, RETRY_AFTER_MS } from "../../src/playback/modes.ts";
import type { ChainStep } from "../../src/playback/modes.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const MID = 2001004;

let clock: FakeClock;
let flags: FlagStore;
let chain: FallbackChain;

beforeEach(() => {
  clock = new FakeClock();
  flags = new FlagStore(new KvStore(new MemoryStorage()));
  // FallbackChain читает только часы и переключатели (план §0.6.8: поля ctx — лениво).
  chain = new FallbackChain({ clock, flags } as unknown as AppContext);
});

const step = (s: ChainStep["step"], mode: ChainStep["mode"], freshLinks: boolean): ChainStep => ({ step: s, mode, freshLinks });

describe("FallbackChain (Plan B §5.11, D-27), streamMode hls1", () => {
  it("first resolve → step 1: hls1 from cached links", () => {
    assert.deepEqual(chain.next(MID), step(1, "hls1", false));
  });

  it("two resolves within 5 s → step 1 both times (impatient press)", async () => {
    assert.equal(chain.next(MID).step, 1);
    await clock.advance(5_000);
    assert.deepEqual(chain.next(MID), step(1, "hls1", false));
  });

  it("9 s without start → 2 (fresh links), then 3 (hls2), then 4 (none)", async () => {
    chain.next(MID);
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(2, "hls1", true));
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(3, "hls2", true));
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(4, "none", false));
  });

  it("exactly 8 s is already a failure; 7.999 s is not", async () => {
    chain.next(MID);
    await clock.advance(RETRY_AFTER_MS - 1);
    assert.equal(chain.next(MID).step, 1);
    await clock.advance(RETRY_AFTER_MS);
    assert.equal(chain.next(MID).step, 2);
  });

  it("the 8 s window counts from the latest resolve", async () => {
    chain.next(MID);
    await clock.advance(5_000);
    chain.next(MID);
    await clock.advance(5_000);
    assert.equal(chain.next(MID).step, 1, "5 s after the second resolve");
  });

  it("markStarted → step 1 again", async () => {
    chain.next(MID);
    await clock.advance(9_000);
    assert.equal(chain.next(MID).step, 2);
    chain.markStarted(MID);
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(1, "hls1", false));
  });

  it("chains of different mids are independent", async () => {
    chain.next(MID);
    await clock.advance(9_000);
    assert.equal(chain.next(MID + 1).step, 1);
    assert.equal(chain.next(MID).step, 2);
    chain.markStarted(MID + 1);
    await clock.advance(9_000);
    assert.equal(chain.next(MID).step, 3);
  });

  it("after step 4 a quick retry repeats 4, a later one starts over", async () => {
    chain.next(MID);
    for (let i = 0; i < 3; i++) {
      await clock.advance(9_000);
      chain.next(MID);
    }
    await clock.advance(2_000);
    assert.equal(chain.next(MID).step, 4);
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(1, "hls1", false));
  });

  it("advance moves to the next step at once (API error during resolve)", () => {
    assert.equal(chain.next(MID).step, 1);
    assert.deepEqual(chain.advance(MID), step(2, "hls1", true));
    assert.deepEqual(chain.advance(MID), step(3, "hls2", true));
    assert.deepEqual(chain.advance(MID), step(4, "none", false));
  });

  it("advance restarts the 8 s window", async () => {
    chain.next(MID);
    await clock.advance(7_000);
    chain.advance(MID);
    await clock.advance(5_000);
    assert.equal(chain.next(MID).step, 2);
  });
});

describe("FallbackChain: streamMode hls2 or a manual mode", () => {
  it("flag hls2 → 1 hls2 (cache), 2 hls2 (fresh), then 4", async () => {
    flags.set("streamMode", "hls2");
    assert.deepEqual(chain.next(MID), step(1, "hls2", false));
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(2, "hls2", true));
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID), step(4, "none", false));
  });

  it("manual hls1 → no hls2 fallback", async () => {
    assert.deepEqual(chain.next(MID, "hls1"), step(1, "hls1", false));
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID, "hls1"), step(2, "hls1", true));
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID, "hls1"), step(4, "none", false));
  });

  it("manual hls2 wins over flag hls1", () => {
    assert.deepEqual(chain.next(MID, "hls2"), step(1, "hls2", false));
    assert.deepEqual(chain.advance(MID, "hls2"), step(2, "hls2", true));
    assert.deepEqual(chain.advance(MID, "hls2"), step(4, "none", false));
  });

  it("changing the mode starts the chain over", async () => {
    chain.next(MID);
    await clock.advance(9_000);
    assert.equal(chain.next(MID).step, 2);
    await clock.advance(9_000);
    assert.deepEqual(chain.next(MID, "hls2"), step(1, "hls2", false));
  });
});
